import { createContext, useContext, useEffect, useState, useCallback, useRef, useMemo, ReactNode } from "react";
import { supabase } from "../lib/supabase";
import { useAuth } from "../hooks/useAuth";
import type { Order } from "../lib/types";

interface OrdersContextValue {
    globalOrders: Order[];
    loading: boolean;
    reloadGlobalOrders: (forceReload?: boolean) => Promise<void>;
}

export const OrdersContext = createContext<OrdersContextValue>({
    globalOrders: [],
    loading: true,
    reloadGlobalOrders: async (_forceReload?: boolean) => { },
});

/** Debounce helper — returns a function that delays invocation */
function createDebounce(delay: number) {
    let timer: ReturnType<typeof setTimeout> | null = null;
    return (fn: () => void) => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(fn, delay);
    };
}

export function OrdersProvider({ children }: { children: ReactNode }) {
    const { workspace } = useAuth();
    const [globalOrders, setGlobalOrders] = useState<Order[]>([]);
    const [loading, setLoading] = useState(true);
    const isLoadingRef = useRef(false);
    const loadRef = useRef<(() => Promise<void>) | null>(null);
    const hasLoadedRef = useRef(false);

    const load = useCallback(async (forceReload = false) => {
        if (isLoadingRef.current) return;

        if (!workspace?.id) {
            setGlobalOrders([]);
            setLoading(false);
            return;
        }

        // Skip loading if we already have data (state preservation) unless forceReload is true
        if (!forceReload && hasLoadedRef.current) {
            setLoading(false);
            return;
        }

        isLoadingRef.current = true;
        setLoading(true);

        try {
            let { data, error } = await supabase
                .from("orders")
                .select(`
        "Order ID",
        order_number,
        customer_id,
        city,
        city_name,
        address,
        total,
        status,
        delivery_status,
        shipping_status,
        phone,
        sku,
        product_variant,
        tracking_number,
        campaign_id,
        created_at,
        ozon_city_id,
        coliaty_city_id,
        source,
        ozon_raw_response,
        customers(id, name, phone, city),
        ozon_cities(id, name, delivered_price, returned_price, refused_price)
      `)
                .eq("workspace_id", workspace.id)
                .order("created_at", { ascending: false })
                .limit(500);

            if (error) {
                // Fallback: flat query without joins
                const fbRes = await supabase
                    .from("orders")
                    .select('"Order ID", order_number, customer_id, city, city_name, address, total, status, delivery_status, shipping_status, phone, sku, product_variant, tracking_number, campaign_id, created_at, ozon_city_id, coliaty_city_id, source, ozon_raw_response')
                    .eq("workspace_id", workspace.id)
                    .order("created_at", { ascending: false })
                    .limit(500);

                if (!fbRes.error && fbRes.data) {
                    const fallbackData = fbRes.data as any[];
                    const customerIds = fallbackData.map((o) => o.customer_id).filter(Boolean);
                    const phones = fallbackData.map((o) => o.phone).filter(Boolean);

                    let customersMap = new Map();
                    if (customerIds.length > 0 || phones.length > 0) {
                        let custQuery = supabase
                            .from("customers")
                            .select("*")
                            .eq("workspace_id", workspace.id);
                        if (customerIds.length > 0 && phones.length > 0) {
                            custQuery = custQuery.or(
                                `id.in.(${customerIds.map((id) => `"${id}"`).join(",")}), phone.in.(${phones.map((p) => `"${p}"`).join(",")})`
                            );
                        } else if (customerIds.length > 0) {
                            custQuery = custQuery.in("id", customerIds);
                        } else {
                            custQuery = custQuery.in("phone", phones);
                        }

                        const { data: custData } = await custQuery;
                        if (custData) {
                            custData.forEach((c: any) => {
                                customersMap.set(c.id, c);
                                if (c.phone) customersMap.set(c.phone, c);
                            });
                        }
                    }

                    data = fallbackData.map((o) => ({
                        ...o,
                        customer: o.customer_id
                            ? customersMap.get(o.customer_id)
                            : o.phone
                                ? customersMap.get(o.phone)
                                : null,
                    }));
                    error = null;
                } else {
                    console.error("[OrdersContext] Fallback query also failed:", fbRes.error);
                    error = fbRes.error;
                }
            } else if (data) {
                data = (data as any[]).map((o) => {
                    const rawCust = o.customers;
                    const customer = Array.isArray(rawCust) ? rawCust[0] : rawCust;
                    const rawCity = o.ozon_cities;
                    const ozonCity = Array.isArray(rawCity) ? rawCity[0] : rawCity;
                    return {
                        ...o,
                        customer: customer || null,
                        ozon_city: ozonCity || null,
                    };
                });
            }

            if (!error && data) {
                const campaignIds = data.map((o) => o.campaign_id).filter(Boolean);
                const orderIds = (data as any[]).map((o) => o["Order ID"] || o.id).filter(Boolean);

                // ── PARALLEL: fetch campaigns + shipments simultaneously ──
                const [campaignsResult, shipmentsResult] = await Promise.all([
                    campaignIds.length > 0
                        ? supabase
                            .from("meta_campaigns")
                            .select("id, campaign_name")
                            .eq("workspace_id", workspace.id)
                            .in("id", campaignIds)
                        : { data: [], error: null },
                    orderIds.length > 0
                        ? supabase
                            .from("shipments")
                            .select("order_id, tracking_number, delivery_status, pickup_status, provider")
                            .in("order_id", orderIds)
                        : { data: [], error: null },
                ]);

                const campaignsMap = new Map();
                if (campaignsResult.data) {
                    campaignsResult.data.forEach((c: any) => {
                        campaignsMap.set(c.id, c);
                    });
                }

                const shipmentsMap = new Map<string, any>();
                if (!shipmentsResult.error && shipmentsResult.data) {
                    shipmentsResult.data.forEach((shipment: any) => {
                        if (shipment?.order_id) {
                            shipmentsMap.set(shipment.order_id, shipment);
                        }
                    });
                }

                data = data.map((o: any) => {
                    const resolvedId = o["Order ID"] || o.id;
                    const shipment = shipmentsMap.get(resolvedId) || shipmentsMap.get(o.id);

                    let shippingCost = null;
                    if (o.ozon_city) {
                        const status = (o.delivery_status || o.status || "").toLowerCase();
                        if (status.includes('delivered') || status.includes('livre') || status.includes('livré')) {
                            shippingCost = o.ozon_city.delivered_price;
                        } else if (status.includes('returned') || status.includes('retour') || status.includes('retours')) {
                            shippingCost = o.ozon_city.returned_price;
                        } else if (status.includes('refused') || status.includes('refus')) {
                            shippingCost = o.ozon_city.refused_price;
                        } else {
                            shippingCost = o.ozon_city.delivered_price;
                        }
                    }

                    return {
                        ...o,
                        id: resolvedId,
                        city: o.city || null,
                        address: o.address || null,
                        campaign:
                            o.campaign_id && campaignsMap.has(o.campaign_id)
                                ? { name: campaignsMap.get(o.campaign_id)?.campaign_name }
                                : null,
                        tracking_number: o.tracking_number ?? shipment?.tracking_number ?? null,
                        shipment_id: o.shipment_id ?? shipment?.id ?? null,
                        shipping_status: o.shipping_status ?? null,
                        shipping_provider: o.shipping_provider ?? shipment?.provider ?? null,
                        delivery_status: o.delivery_status ?? shipment?.delivery_status ?? null,
                        delivery_note_ref: o.delivery_note_ref ?? o.ozon_raw_response?.delivery_note_ref ?? null,
                        shipping_cost: shippingCost,
                    };
                });

                const sorted = (data as unknown as Order[]).sort((a, b) => {
                    const dateA = new Date(a.created_at).getTime();
                    const dateB = new Date(b.created_at).getTime();
                    if (dateA !== dateB) {
                        return dateB - dateA;
                    }
                    const numA = parseInt(a.order_number.split("-").pop() ?? "", 10);
                    const numB = parseInt(b.order_number.split("-").pop() ?? "", 10);
                    if (!isNaN(numA) && !isNaN(numB)) {
                        return numB - numA;
                    }
                    return b.order_number.localeCompare(a.order_number);
                });
                setGlobalOrders(sorted);
                hasLoadedRef.current = true;
            } else {
                if (error) console.error("[OrdersContext] Failed to load orders:", error);
                setGlobalOrders([]);
            }
        } finally {
            isLoadingRef.current = false;
            setLoading(false);
        }
    }, [workspace?.id]);

    useEffect(() => {
        loadRef.current = load;
    }, [load]);

    useEffect(() => {
        if (!workspace?.id) return;

        // Only load if we don't have data yet (state preservation)
        if (!hasLoadedRef.current) {
            loadRef.current?.();
        }

        // Debounced RT reload — batch rapid events
        const debouncedReload = createDebounce(500);

        // Supabase RT Subscription for Orders — stable channel name
        const uniq = Math.random().toString(36).substring(2, 10);
        const channel = supabase.channel(`orders-ctx-${workspace.id}-${uniq}`);
        channel.on(
            "postgres_changes",
            {
                event: "*",
                schema: "public",
                table: "orders",
                filter: `workspace_id=eq.${workspace.id}`,
            },
            (payload) => {
                // Optimistic in-place updates for instant UI
                if (payload.eventType === "INSERT") {
                    const newOrder = payload.new as any;
                    const isGoogleSheet = newOrder?.order_number?.startsWith("#GS-");
                    if (!isGoogleSheet) {
                        window.dispatchEvent(
                            new CustomEvent("new-orders-toast", {
                                detail: { msg: `New order added: ${newOrder.order_number || "unknown"}`, playCount: 1 }
                            })
                        );
                    }
                    setGlobalOrders(prev => [newOrder, ...prev]);
                } else if (payload.eventType === "UPDATE") {
                    setGlobalOrders(prev => prev.map(order =>
                        (order.id === payload.old.id || order["Order ID"] === payload.old["Order ID"] || order.order_number === payload.old.order_number)
                            ? { ...order, ...payload.new }
                            : order
                    ));
                } else if (payload.eventType === "DELETE") {
                    setGlobalOrders(prev => prev.filter(order =>
                        order.id !== payload.old.id && order["Order ID"] !== payload.old["Order ID"] && order.order_number !== payload.old.order_number
                    ));
                }
            }
        );
        void channel.subscribe();

        const handleNewOrders = () => debouncedReload(() => loadRef.current?.(true)); // Force reload on explicit triggers
        window.addEventListener("new-orders-toast", handleNewOrders);
        window.addEventListener("trigger-order-reload", handleNewOrders);

        return () => {
            void channel.unsubscribe();
            supabase.removeChannel(channel);
            window.removeEventListener("new-orders-toast", handleNewOrders);
            window.removeEventListener("trigger-order-reload", handleNewOrders);
        };
    }, [workspace?.id]);

    // ── Stable context value — only changes when orders/loading actually change ──
    const contextValue = useMemo<OrdersContextValue>(
        () => ({ globalOrders, loading, reloadGlobalOrders: load }),
        [globalOrders, loading, load]
    );

    return (
        <OrdersContext.Provider value={contextValue}>
            {children}
        </OrdersContext.Provider>
    );
}

export function useGlobalOrders() {
    return useContext(OrdersContext);
}
