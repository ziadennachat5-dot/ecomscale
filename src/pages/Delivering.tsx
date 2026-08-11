import { useMemo, useState, useEffect, useRef, useCallback } from "react";
import {
  Inbox,
  Download,
  RefreshCw,
  Truck,
  FileText,
  Eye,
  MoreVertical,
  Copy,
  ChevronLeft,
  ChevronRight,
  Phone,
  MessageCircle,
  MapPin,
  AlertTriangle,
  CheckCircle,
  Clock,
  ExternalLink,
  Printer,
  X,
  ScanLine,
} from "lucide-react";
import { OzonSendButton } from "../components/OzonSendButton";
import { PageHeader } from "../components/PageHeader";

import { EmptyState } from "../components/EmptyState";
import { useOrders } from "../hooks/useOrders";
import type { Order } from "../lib/types";
import { toast } from "../components/Toast";
import { supabase } from "../lib/supabase";
import { useAuth } from "../hooks/useAuth";
import { StatusBadge } from "../components/StatusBadge";
import { ShippingStatusBadge } from "../components/ShippingStatusBadge";
import { getStatusLabel, type CanonicalStatus, type StatusLanguage } from "../lib/statusEngine";
import { getShippingStatusLabel, normalizeShippingStatus, getShippingStatusColors, type ShippingLanguage } from "../lib/shippingStatus";
import { calculateOrderShipping } from "../utils/shipping";

// ─────────────────────────────────────────────────────────────────────────────
// Auto Refresh System - Final Statuses
// ─────────────────────────────────────────────────────────────────────────────

const FINAL_SHIPPING_STATUSES = [
  'Livré', 'Delivered',
  'Refusé', 'Refused',
  'Cancelled', 'Annulé',
  'Returned', 'Returned To Sender', 'Returned To Inventory',
  'Return Done', 'RETURN_DONE',
  'Lost',
  'Failed Delivery',
  'Archived'
].map(s => s.toLowerCase());

const isFinalShippingStatus = (status: string | null | undefined): boolean => {
  if (!status) return false;
  const normalized = normalizeShippingStatus(status) || status.toLowerCase();
  return FINAL_SHIPPING_STATUSES.includes(normalized);
};

// ─────────────────────────────────────────────────────────────────────────────
// Delivery Progress System
// ─────────────────────────────────────────────────────────────────────────────

interface ProgressStep {
  step: string;
  time: string;
  state: 'complete' | 'current' | 'pending';
}

interface DeliveryProgress {
  steps: ProgressStep[];
  currentStep: string;
  isFailed: boolean;
  isReturned: boolean;
  isCancelled: boolean;
}

/**
 * Get delivery progress based on real shipping status
 * This is the single source of truth for delivery timeline
 */
function getDeliveryProgress(order: Order): DeliveryProgress {
  const shippingStatus = order.shipping_status;
  const normalizedStatus = normalizeShippingStatus(shippingStatus);

  // Base timeline steps
  const baseSteps: ProgressStep[] = [
    { step: 'Order Created', time: formatDate(order.created_at), state: 'complete' },
    { step: 'Confirmed', time: formatDate((order as any).confirmed_at || order.created_at), state: 'complete' },
    { step: 'Ready To Send', time: '', state: 'pending' },
    { step: 'Warehouse', time: '', state: 'pending' },
    { step: 'In Transit', time: '', state: 'pending' },
    { step: 'Out For Delivery', time: '', state: 'pending' },
    { step: 'Delivered', time: '', state: 'pending' },
  ];

  // Check for special terminal states
  if (normalizedStatus === 'REFUSED' || normalizedStatus === 'DELIVERY_FAILED') {
    return {
      steps: [
        ...baseSteps.slice(0, 2),
        { step: 'Delivery Failed', time: formatDate(order.updated_at), state: 'current' }
      ],
      currentStep: 'Delivery Failed',
      isFailed: true,
      isReturned: false,
      isCancelled: false
    };
  }

  if (normalizedStatus === 'RETURNED_TO_SENDER' || normalizedStatus === 'RETURNED_TO_AGENCY') {
    return {
      steps: [
        ...baseSteps.slice(0, 2),
        { step: 'Returned', time: formatDate(order.updated_at), state: 'current' }
      ],
      currentStep: 'Returned',
      isFailed: false,
      isReturned: true,
      isCancelled: false
    };
  }

  if (normalizedStatus === 'CANCELED') {
    return {
      steps: [
        ...baseSteps.slice(0, 2),
        { step: 'Cancelled', time: formatDate(order.updated_at), state: 'current' }
      ],
      currentStep: 'Cancelled',
      isFailed: false,
      isReturned: false,
      isCancelled: true
    };
  }

  // If no shipping status, order is ready to send
  if (!shippingStatus || String(shippingStatus).trim() === '' || String(shippingStatus).trim() === '-') {
    const steps = [...baseSteps];
    steps[2].state = 'current'; // Ready To Send is current
    return {
      steps,
      currentStep: 'Ready To Send',
      isFailed: false,
      isReturned: false,
      isCancelled: false
    };
  }

  // Map normalized statuses to progress steps
  const statusToStepMap: Record<string, number> = {
    'NEW_PARCEL': 2, // Ready To Send
    'WAITING_PICKUP': 3, // Warehouse
    'PICKED_UP': 3, // Warehouse
    'RECEIVED_AT_WAREHOUSE': 3, // Warehouse
    'IN_DISTRIBUTION': 4, // In Transit
    'IN_TRANSIT': 4, // In Transit
    'OUT_FOR_DELIVERY': 5, // Out For Delivery
    'DELIVERED': 6, // Delivered
    'CUSTOMER_UNREACHABLE': 5, // Out For Delivery (still attempting)
    'NO_ANSWER': 5, // Out For Delivery (still attempting)
    'PHONE_OFF': 5, // Out For Delivery (still attempting)
    'WRONG_ADDRESS': 5, // Out For Delivery (still attempting)
    'RESCHEDULE_REQUESTED': 5, // Out For Delivery (rescheduled)
  };

  const currentStepIndex = statusToStepMap[normalizedStatus || ''] || 2;

  // Mark steps before current as complete, current as current, after as pending
  const steps = baseSteps.map((step, index) => {
    if (index < currentStepIndex) {
      return { ...step, state: 'complete' as const };
    } else if (index === currentStepIndex) {
      return { ...step, state: 'current' as const };
    } else {
      return { ...step, state: 'pending' as const };
    }
  });

  const stepNames = ['Order Created', 'Confirmed', 'Ready To Send', 'Warehouse', 'In Transit', 'Out For Delivery', 'Delivered'];

  return {
    steps,
    currentStep: stepNames[currentStepIndex] || 'Ready To Send',
    isFailed: false,
    isReturned: false,
    isCancelled: false
  };
}
import {
  createOzonParcel,
  initializeOzonCities,
  validateOzonConfig,
  trackOzonParcel,
  getOzonParcelInfo,
  createOzonDeliveryNote,
  createOzonDeliveryNoteOnly,
  formatOzonAddress,
} from "../services/ozonService";
import { syncOrderTracking } from "../services/ozonTrackingSync";
import { syncColiatyTracking } from "../services/coliatyTrackingSync";
import type { OzonParcelRequest } from "../types/ozon";
import { SUPABASE_URL } from "../lib/supabase";
import { getShippingPrice, formatPrice, calculateNetCOD, preloadCityPrices, getShippingPriceSync } from "../services/shippingPriceService";
import { isRefusedStatus, getRefusedPrice } from "../services/shippingPricingEngine";

// ─────────────────────────────────────────────────────────────────────────────
// Dynamic Filter Types
// ─────────────────────────────────────────────────────────────────────────────

interface DynamicFilter {
  id: string; // 'ready', 'all', or the actual shipping_status value
  label: string;
  count: number;
  alwaysShow: boolean;
  originalStatus?: string; // The original raw status from database
}

type DeliveringTab = string; // Changed to string to support dynamic values

// ─────────────────────────────────────────────────────────────────────────────
// Delivery Workflow Order
// ─────────────────────────────────────────────────────────────────────────────

// This defines the canonical delivery workflow order
const DELIVERY_WORKFLOW_ORDER = [
  { id: 'ready', normalizedStatus: null, label: 'READY TO SEND' },
  { id: 'new_parcel', normalizedStatus: 'NEW_PARCEL', label: 'NEW PARCEL' },
  { id: 'waiting_pickup', normalizedStatus: 'WAITING_PICKUP', label: 'AWAITING PICKUP' },
  { id: 'picked_up', normalizedStatus: 'PICKED_UP', label: 'PICKED UP' },
  { id: 'preparing', normalizedStatus: 'PREPARING', label: 'PREPARING' },
  { id: 'shipped', normalizedStatus: 'SHIPPED', label: 'SHIPPED' },
  { id: 'in_transit', normalizedStatus: 'IN_TRANSIT', label: 'IN TRANSIT' },
  { id: 'arrived_agency', normalizedStatus: 'RECEIVED_AT_WAREHOUSE', label: 'ARRIVED AT AGENCY' },
  { id: 'out_for_delivery', normalizedStatus: 'OUT_FOR_DELIVERY', label: 'OUT FOR DELIVERY' },
  { id: 'delivered', normalizedStatus: 'DELIVERED', label: 'DELIVERED' },
  { id: 'refused', normalizedStatus: 'REFUSED', label: 'REFUSED' },
  { id: 'returned', normalizedStatus: 'RETURNED_TO_SENDER', label: 'RETURNED' },
  { id: 'return_done', normalizedStatus: 'RETURN_DONE', label: 'RETURN DONE' },
  { id: 'canceled', normalizedStatus: 'CANCELED', label: 'CANCELLED' },
];

// Additional workflow steps that may appear in data (placed after main workflow)
const ADDITIONAL_WORKFLOW_STEPS = [
  { id: 'in_distribution', normalizedStatus: 'IN_DISTRIBUTION', label: 'IN DISTRIBUTION' },
  { id: 'customer_unreachable', normalizedStatus: 'CUSTOMER_UNREACHABLE', label: 'CUSTOMER UNREACHABLE' },
  { id: 'no_answer', normalizedStatus: 'NO_ANSWER', label: 'NO ANSWER' },
  { id: 'phone_off', normalizedStatus: 'PHONE_OFF', label: 'PHONE OFF' },
  { id: 'wrong_address', normalizedStatus: 'WRONG_ADDRESS', label: 'WRONG ADDRESS' },
  { id: 'reschedule_requested', normalizedStatus: 'RESCHEDULE_REQUESTED', label: 'RESCHEDULE REQUESTED' },
  { id: 'delivery_failed', normalizedStatus: 'DELIVERY_FAILED', label: 'DELIVERY FAILED' },
  { id: 'returned_to_agency', normalizedStatus: 'RETURNED_TO_AGENCY', label: 'RETURNED TO AGENCY' },
  { id: 'return_in_progress', normalizedStatus: 'RETURN_IN_PROGRESS', label: 'RETURN IN PROGRESS' },
];

// Combined workflow order
const COMPLETE_WORKFLOW_ORDER = [...DELIVERY_WORKFLOW_ORDER, ...ADDITIONAL_WORKFLOW_STEPS];

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

function mad(n: number) {
  return `${Number(n).toLocaleString("fr-MA", { maximumFractionDigits: 0 })} MAD`;
}

function isConfirmedOrderStatus(status?: string | null) {
  if (!status) return false;
  const normalizedStatus = String(status).trim().toLowerCase();
  return normalizedStatus === 'confirmed' || normalizedStatus === 'confirmé';
}

function formatDate(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: Bulk update order statuses
// ─────────────────────────────────────────────────────────────────────────────

async function updateOrdersToPending(orderNumbers: string[]): Promise<boolean> {
  if (!orderNumbers || orderNumbers.length === 0) return true;

  for (const orderNumber of orderNumbers) {
    const res = await supabase
      .from("orders")
      .update({ delivery_status: "pending" })
      .eq("order_number", orderNumber)
      .select("order_number,delivery_status")
      .maybeSingle();

    if (res.error) {
      console.error("Failed to update delivery_status for order_number", orderNumber, res.error);
      return false;
    }
  }
  return true;
}

async function persistTrackingNumberForOrder(
  order: Order,
  ozonResult: { trackingNumber: string; shipmentId?: string | null; status?: string | null },
  workspaceId?: string | null
): Promise<Order | null> {
  const normalizedOrderNumber = String(order.order_number ?? "").trim();
  const orderId = String(order.id ?? "").trim();
  const trackingNumber = ozonResult.trackingNumber;
  const shipmentId = ozonResult.shipmentId ?? null;
  const shipmentStatus = ozonResult.status ?? null;

  console.log("[Delivering] persistTrackingNumberForOrder START", { orderId, normalizedOrderNumber, trackingNumber, shipmentId, shipmentStatus, workspaceId });

  // order_number is the minimum required key; orderId may legitimately be empty for some orders
  if (!normalizedOrderNumber) {
    console.error("[Delivering] Missing orderNumber — cannot persist tracking", { orderId, normalizedOrderNumber });
    return null;
  }

  if (!orderId) {
    console.warn("[Delivering] orderId is empty — will fall back to order_number match", { normalizedOrderNumber });
  }

  const now = new Date().toISOString();
  const orderPayload: Record<string, any> = {
    tracking_number: trackingNumber,
    shipment_id: shipmentId,
    shipping_status: shipmentStatus,
    shipping_provider: "ozon",
    parcel_created_at: now,
    updated_at: now,
  };

  console.log("[Delivering] PERSISTING SHIPMENT: UPDATE orders SET", { tracking_number: trackingNumber, shipping_status: shipmentStatus, shipment_id: shipmentId });
  console.log("[Delivering] Target order:", { orderId, normalizedOrderNumber });

  console.log("[Delivering] QUERY: UPDATE orders SET tracking_number=? WHERE", orderId ? `id=${orderId}` : `order_number=${normalizedOrderNumber}`, { trackingNumber });

  let query = supabase.from("orders").update(orderPayload);
  if (orderId) {
    query = query.eq("Order ID", orderId);
  } else {
    query = query.eq("order_number", normalizedOrderNumber);
  }
  const { data: updateResult, error: updateError } = await query.select("*").maybeSingle();

  console.log("[Delivering] UPDATE RESULT:", { updateResult, updateError });

  if (updateError) {
    console.error(`[Delivering] UPDATE ERROR:`, updateError);
    return null;
  }

  if (!updateResult) {
    console.error(`[Delivering] CRITICAL: 0 rows returned from UPDATE`);
    console.error(`  Possible causes: order doesn't exist, RLS policy blocks it, or network error`);
    const { data: check, error: checkErr } = await supabase.from("orders").select('"Order ID", workspace_id').eq("Order ID", orderId).maybeSingle();
    console.error(`  Order lookup result:`, check, checkErr);
    return null;
  }

  // Re-fetch the single order row to ensure we have the authoritative DB record
  const { data: refreshed, error: refreshError } = await supabase
    .from("orders")
    .select("*")
    .eq("Order ID", orderId)
    .maybeSingle();

  if (refreshError) {
    console.error("[Delivering] Verification query failed:", refreshError);
    return null;
  }

  if (!refreshed || !refreshed.tracking_number) {
    console.error(`[Delivering] VERIFICATION FAILED: tracking_number is still NULL in database!`);
    console.error("Refreshed row:", refreshed);
    return null;
  }

  console.log("[Delivering] VERIFICATION: checking shipping_status in database");
  console.log("[Delivering] Expected shipping_status:", shipmentStatus);
  console.log("[Delivering] Actual shipping_status in DB:", refreshed.shipping_status);

  // Normalize both for comparison to handle legacy values
  const normalizedExpected = normalizeShippingStatus(shipmentStatus);
  const normalizedActual = normalizeShippingStatus(refreshed.shipping_status);

  if (normalizedExpected !== normalizedActual) {
    console.warn("[Delivering] WARNING: shipping_status mismatch!", { expected: normalizedExpected, actual: normalizedActual });
    // Try to update just the shipping_status
    const { error: statusUpdateError } = await supabase
      .from("orders")
      .update({ shipping_status: shipmentStatus })
      .eq("Order ID", orderId);

    if (statusUpdateError) {
      console.error("[Delivering] Failed to update shipping_status separately:", statusUpdateError);
    } else {
      console.log("[Delivering] Successfully updated shipping_status separately");
      // Re-fetch to confirm
      const { data: finalRefresh } = await supabase.from("orders").select("*").eq("Order ID", orderId).maybeSingle();
      if (finalRefresh) {
        return finalRefresh as Order;
      }
    }
  }

  console.log("[Delivering] SUCCESS: tracking and shipping_status persisted to orders table", refreshed);
  return refreshed as Order;
}

// Generic: advance delivery status for given order numbers
async function updateOrdersShippingStatus(orderNumbers: string[], shippingStatus: string): Promise<boolean> {
  if (!orderNumbers || orderNumbers.length === 0) return true;
  for (const orderNumber of orderNumbers) {
    const res = await supabase
      .from("orders")
      .update({ delivery_status: shippingStatus })
      .eq("order_number", orderNumber)
      .select("order_number,delivery_status")
      .maybeSingle();

    if (res.error) {
      console.error("Failed to update delivery_status for order_number", orderNumber, res.error);
      return false;
    }
  }
  return true;
}

function getNextShippingStatus(current?: string | null): string | null {
  const seq = [
    "Awaiting Pickup",
    "Picked Up",
    "In Transit",
    "Out for Delivery",
    "Delivered",
  ];
  if (!current) return seq[0];
  const idx = seq.findIndex((s) => s.toLowerCase() === current.toLowerCase());
  if (idx === -1) return seq[0];
  if (idx >= seq.length - 1) return null;
  return seq[idx + 1];
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export default function Delivering() {
  if (typeof window !== "undefined") {
    (window as any).testOzon = { trackOzonParcel, getOzonParcelInfo, createOzonDeliveryNote };
  }
  const { orders, loading, reload } = useOrders({ status: "all" });
  const { workspace } = useAuth();
  const language = (workspace?.status_language || "en") as StatusLanguage;

  const [activeTab, setActiveTab] = useState<DeliveringTab>("all");
  const [selectedOrderIds, setSelectedOrderIds] = useState<string[]>([]);
  const [sendingToOzon, setSendingToOzon] = useState(false);
  const [generatingNote, setGeneratingNote] = useState(false);
  const [refreshingOrderId, setRefreshingOrderId] = useState<string | null>(null);
  const [isRefreshingAll, setIsRefreshingAll] = useState(false);
  const [refreshingAllCount, setRefreshingAllCount] = useState(0);
  const [isOpeningAllPdfs, setIsOpeningAllPdfs] = useState(false);
  const [isAutoRefreshing, setIsAutoRefreshing] = useState(false);
  const [autoRefreshError, setAutoRefreshError] = useState<string | null>(null);

  const [visibleCount, setVisibleCount] = useState(50);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const autoRefreshTimerRef = useRef<NodeJS.Timeout | null>(null);
  const isAutoRefreshRunningRef = useRef(false);

  const handleScroll = () => {
    const el = scrollContainerRef.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop <= el.clientHeight * 1.5) {
      setVisibleCount(prev => prev + 50);
    }
  };
  const [panelOrder, setPanelOrder] = useState<Order | null>(null);
  const [shippingPrice, setShippingPrice] = useState<number | null>(null);
  const [loadingShippingPrice, setLoadingShippingPrice] = useState(false);

  // ── Preload city prices on mount ───────────────────────────────────────────
  useEffect(() => {
    preloadCityPrices().catch(err => {
      console.error('[Delivering] Failed to preload city prices:', err);
    });
  }, []);

  // ── Load shipping price when panel order changes ───────────────────────────
  useEffect(() => {
    let mounted = true;

    async function loadShippingPrice() {
      if (!panelOrder) {
        if (mounted) setShippingPrice(null);
        return;
      }

      setLoadingShippingPrice(true);
      try {
        const status = panelOrder.shipping_status || panelOrder.delivery_status || panelOrder.status;
        
        // If status is refused, use refused price
        if (isRefusedStatus(status)) {
          const refusedPrice = await getRefusedPrice(panelOrder.city);
          if (mounted) setShippingPrice(refusedPrice);
        } else {
          // Use normal delivery price
          const price = await getShippingPrice(panelOrder.city);
          if (mounted) setShippingPrice(price);
        }
      } catch (error) {
        console.warn('[Delivering] Failed to load shipping price:', error);
        if (mounted) setShippingPrice(null);
      } finally {
        if (mounted) setLoadingShippingPrice(false);
      }
    }

    loadShippingPrice();

    return () => {
      mounted = false;
    };
  }, [panelOrder]);

  // ── Helper: Extract delivery note reference ──────────────────────────────
  const getDeliveryNoteRef = (order: Order): string | null => {
    return order.delivery_note_ref ?? (order.ozon_raw_response as any)?.delivery_note_ref ?? null;
  };

  // ── Auto Refresh System ───────────────────────────────────────────────────
  
  // Filter orders eligible for auto-refresh
  const getEligibleOrdersForAutoRefresh = useCallback((): Order[] => {
    return orders.filter(order => {
      // Must have tracking number
      const orderCarrier = (order as any).shipping_provider || workspace?.carrier || "ozon";
      const trackingField = orderCarrier === "coliaty" ? "coliaty_parcel_code" : "tracking_number";
      const trackingNumber = (order as any)[trackingField];
      
      if (!trackingNumber) return false;
      
      // Must not be in final status
      if (isFinalShippingStatus(order.shipping_status)) return false;
      
      // Must be confirmed or have shipping status
      if (!isConfirmedOrderStatus(order.status) && !order.shipping_status) return false;
      
      return true;
    });
  }, [orders, workspace?.carrier]);

  // ── Unified Shipping Status Refresh Function ─────────────────────────────────
  const refreshShippingStatuses = useCallback(async (ordersToRefresh: Order[] = []) => {
    // Determine which orders to refresh
    const orders = ordersToRefresh.length > 0 
      ? ordersToRefresh 
      : getEligibleOrdersForAutoRefresh();

    if (orders.length === 0) {
      console.log('[Refresh] No eligible orders to refresh');
      return { successCount: 0, failureCount: 0, failedOrders: [] };
    }

    console.log(`[Refresh] Starting refresh for ${orders.length} orders`);

    // Get Ozon config for tracking
    const ozonClientId = localStorage.getItem("ozon_client_id")?.trim() || "";
    const ozonApiKey = localStorage.getItem("ozon_api_key")?.trim() || "";
    const ozonConfig = { clientId: ozonClientId, apiKey: ozonApiKey };

    let successCount = 0;
    let failureCount = 0;
    const failedOrders: string[] = [];

    // Process orders in parallel
    const refreshPromises = orders.map(async (order) => {
      const orderCarrier = (order as any).shipping_provider || workspace?.carrier || "ozon";
      const isColiaty = orderCarrier === "coliaty";
      const trackingField = isColiaty ? "coliaty_parcel_code" : "tracking_number";
      const trackingNumber = (order as any)[trackingField];

      // Skip if no tracking number
      if (!trackingNumber) {
        return { success: false, orderNumber: order.order_number, error: "No tracking number" };
      }

      try {
        if (isColiaty) {
          const syncRes = await syncColiatyTracking(order, order.workspace_id || (workspace?.id ?? ""));
          if (syncRes.success) {
            return { success: true, orderNumber: order.order_number };
          } else {
            return { success: false, orderNumber: order.order_number, error: syncRes.error };
          }
        } else {
          const syncRes = await syncOrderTracking(order, order.workspace_id || (workspace?.id ?? ""), orderCarrier, ozonConfig);
          if (syncRes.success) {
            return { success: true, orderNumber: order.order_number };
          } else {
            return { success: false, orderNumber: order.order_number, error: syncRes.error };
          }
        }
      } catch (err) {
        return { success: false, orderNumber: order.order_number, error: "Technical error" };
      }
    });

    const results = await Promise.all(refreshPromises);

    // Count results
    results.forEach(result => {
      if (result.success) {
        successCount++;
      } else {
        failureCount++;
        failedOrders.push(`#${result.orderNumber} (${result.error})`);
      }
    });

    // Reload data to show updated statuses
    if (successCount > 0) {
      await reload();
      console.log(`[Refresh] ✅ Completed: ${successCount} updated, ${failureCount} errors`);
    }

    return { successCount, failureCount, failedOrders };
  }, [getEligibleOrdersForAutoRefresh, workspace?.id, workspace?.carrier, reload]);

  // Auto refresh function - uses unified refreshShippingStatuses
  const performAutoRefresh = useCallback(async () => {
    // Prevent overlapping refresh cycles
    if (isAutoRefreshRunningRef.current) {
      console.log('[AutoRefresh] Already running, skipping this cycle');
      return;
    }

    console.log('[AutoRefresh] Starting full API synchronization');
    isAutoRefreshRunningRef.current = true;
    setIsAutoRefreshing(true);
    setAutoRefreshError(null);

    try {
      // Use the SAME unified refresh function as manual refresh
      const { successCount, failureCount } = await refreshShippingStatuses();
      
      console.log(`[AutoRefresh] ✅ Completed: ${successCount} updated, ${failureCount} errors`);
    } catch (error) {
      console.error('[AutoRefresh] Fatal error:', error);
      setAutoRefreshError('Auto-refresh failed');
    } finally {
      isAutoRefreshRunningRef.current = false;
      setIsAutoRefreshing(false);
    }
  }, [refreshShippingStatuses]);

  // Start/stop auto-refresh timer
  useEffect(() => {
    // Start timer when component mounts
    console.log('[AutoRefresh] Starting 20-second auto-refresh timer');
    
    autoRefreshTimerRef.current = setInterval(() => {
      performAutoRefresh();
    }, 20000); // 20 seconds

    // Cleanup on unmount
    return () => {
      console.log('[AutoRefresh] Stopping auto-refresh timer');
      if (autoRefreshTimerRef.current) {
        clearInterval(autoRefreshTimerRef.current);
        autoRefreshTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Empty deps - timer starts once on mount

  // Reset timer when manual refresh is triggered
  const resetAutoRefreshTimer = useCallback(() => {
    if (autoRefreshTimerRef.current) {
      clearInterval(autoRefreshTimerRef.current);
      autoRefreshTimerRef.current = setInterval(() => {
        performAutoRefresh();
      }, 20000);
      console.log('[AutoRefresh] Timer reset after manual refresh');
    }
  }, [performAutoRefresh]);

  // ── Derived order lists ──────────────────────────────────────────────────
  const filteredOrders = useMemo(() => {
    return orders.filter((order) => {
      // Handle "all" filter
      if (activeTab === "all") {
        return isConfirmedOrderStatus(order.status) || (order.shipping_status && String(order.shipping_status).trim() !== "");
      }

      // Handle "ready" filter (empty/null shipping status)
      if (activeTab === "ready") {
        return isConfirmedOrderStatus(order.status) &&
          (!order.shipping_status || String(order.shipping_status).trim() === "" || String(order.shipping_status).trim() === "-");
      }

      // Handle dynamic status filters
      const shippingStatus = order.shipping_status;
      const rawStatus = shippingStatus ? String(shippingStatus).trim() : "";
      const normalizedStatus = normalizeShippingStatus(rawStatus) || rawStatus;

      // Match against the active filter ID
      return normalizedStatus === activeTab || rawStatus === activeTab;
    });
  }, [activeTab, orders]);

  const displayOrders = useMemo(() => {
    return filteredOrders.slice(0, visibleCount);
  }, [filteredOrders, visibleCount]);

  const visibleSelectedCount = filteredOrders.filter((o, idx) => {
    const uniqueId = o.id || o.order_number || `temp-${idx}`;
    return selectedOrderIds.includes(uniqueId);
  }).length;
  const allVisibleSelected =
    filteredOrders.length > 0 && visibleSelectedCount === filteredOrders.length;

  const selectedOrdersHasExistingBL = useMemo(() => {
    return orders.some((o) => {
      const uniqueId = o.id || o.order_number;
      return selectedOrderIds.includes(uniqueId) && Boolean(getDeliveryNoteRef(o));
    });
  }, [orders, selectedOrderIds]);

  // Reset visibleCount on filter change
  useMemo(() => {
    setVisibleCount(50);
  }, [activeTab]);

  // ── Dynamic Filter Generation ───────────────────────────────────────────────
  const dynamicFilters = useMemo(() => {
    // Step 1: Group orders by their actual shipping_status values
    const statusGroups = new Map<string, { count: number; originalStatus: string }>();

    // Step 2: Process each order
    let readyCount = 0;
    let totalCount = 0;

    orders.forEach(order => {
      // Check if this order should be included in the deliverable orders
      const isDeliverable = isConfirmedOrderStatus(order.status) ||
        (order.shipping_status && String(order.shipping_status).trim() !== "");

      if (!isDeliverable) return;

      totalCount++;

      // Check for "ready" status (empty/null shipping_status)
      const shippingStatus = order.shipping_status;
      const isReady = !shippingStatus ||
        String(shippingStatus).trim() === "" ||
        String(shippingStatus).trim() === "-";

      if (isReady) {
        readyCount++;
        return;
      }

      // For other statuses, use the actual raw value from database
      const rawStatus = String(shippingStatus).trim();
      const normalizedStatus = normalizeShippingStatus(rawStatus) || rawStatus;

      // Group by normalized status but keep track of original value
      const existing = statusGroups.get(normalizedStatus);
      if (existing) {
        existing.count++;
      } else {
        statusGroups.set(normalizedStatus, {
          count: 1,
          originalStatus: rawStatus
        });
      }
    });

    // Step 3: Build filter array using workflow order
    const filters: DynamicFilter[] = [];

    // Add "READY TO SEND" filter if there are ready orders
    if (readyCount > 0) {
      filters.push({
        id: 'ready',
        label: 'READY TO SEND',
        count: readyCount,
        alwaysShow: false
      });
    }

    // Add dynamic status filters in workflow order
    COMPLETE_WORKFLOW_ORDER.forEach(workflowStep => {
      // Skip 'ready' as it's handled separately
      if (workflowStep.id === 'ready') return;

      const groupData = statusGroups.get(workflowStep.normalizedStatus || '');

      // Only add if this status exists in the data
      if (groupData && groupData.count > 0) {
        // Get the display label using workspace language
        const displayLabel = getShippingStatusLabel(workflowStep.normalizedStatus || '', language as ShippingLanguage).toUpperCase();

        filters.push({
          id: workflowStep.normalizedStatus || workflowStep.id,
          label: displayLabel,
          count: groupData.count,
          alwaysShow: false,
          originalStatus: groupData.originalStatus
        });

        // Remove from statusGroups to mark as processed
        statusGroups.delete(workflowStep.normalizedStatus || '');
      }
    });

    // Add any remaining statuses (unknown/unmapped) at the end
    statusGroups.forEach((data, normalizedStatus) => {
      if (data.count > 0) {
        // Get the display label using workspace language (fallback to original status)
        const displayLabel = getShippingStatusLabel(normalizedStatus, language as ShippingLanguage).toUpperCase() ||
          data.originalStatus.toUpperCase();

        filters.push({
          id: normalizedStatus,
          label: displayLabel,
          count: data.count,
          alwaysShow: false,
          originalStatus: data.originalStatus
        });
      }
    });

    // Add "ALL" filter (always present)
    filters.push({
      id: 'all',
      label: 'ALL',
      count: totalCount,
      alwaysShow: true
    });

    return filters;
  }, [orders, language]);

  // ── Ensure activeTab exists in dynamic filters ───────────────────────────────
  useEffect(() => {
    const filterExists = dynamicFilters.some(f => f.id === activeTab);
    if (!filterExists && dynamicFilters.length > 0) {
      // Fall back to 'all' or the first available filter
      setActiveTab('all');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dynamicFilters]);

  // ── Helper: Get status dot color ─────────────────────────────────────────────
  const getStatusDotColor = (filterId: string) => {
    if (filterId === 'all') {
      return workspace?.primary_color || '#3B82F6';
    }
    if (filterId === 'ready') {
      return '#3B82F6'; // Blue for ready
    }

    // For dynamic statuses, get the color from the shipping status config
    const colors = getShippingStatusColors(filterId);
    return colors.background;
  };

  // ── Helper: Get orders to export based on selected orders ──────────────────
  const getOrdersToExport = () => {
    // Export only selected orders
    const toExport = orders.filter((o) => {
      const uniqueId = o.id || o.order_number;
      return selectedOrderIds.includes(uniqueId);
    });
    return toExport;
  };

  // ── Send to Ozon (Step 1 only) ─────────────────────────────────────────────
  const handleSendToOzon = async (): Promise<boolean> => {
    if (sendingToOzon) return false;

    const toExport = getOrdersToExport();
    if (toExport.length === 0) {
      toast.error("No orders selected. Please check the boxes first.");
      return false;
    }

    setSendingToOzon(true);
    try {
      const ozonClientId = localStorage.getItem("ozon_client_id")?.trim() || "";
      const ozonApiKey = localStorage.getItem("ozon_api_key")?.trim() || "";
      const ozonConfig = { clientId: ozonClientId, apiKey: ozonApiKey };

      if (!ozonConfig.clientId || !ozonConfig.apiKey) {
        toast.error("Configuration missing: Please enter and save your Ozon Client ID and API Key first.");
        setSendingToOzon(false);
        return false;
      }

      const configValidation = validateOzonConfig(ozonConfig);
      if (!configValidation.success) {
        toast.error(configValidation.error || "Configuration missing: Please enter and save your Ozon Client ID and API Key first.");
        setSendingToOzon(false);
        return false;
      }

      await initializeOzonCities();
      let ozonSuccess = 0;
      let ozonFailed = 0;
      const ozonErrors: string[] = [];

      for (const order of toExport) {
        const fullAddress = formatOzonAddress(order.address, order.city);

        if (!fullAddress || fullAddress.length < 5) {
          ozonFailed++;
          const errorMsg = `Adresse trop courte pour la commande #${order.order_number} ("${fullAddress || "vide"}"). Veuillez compléter l'adresse de cette commande (minimum 5 caractères) avant l'envoi à Ozon.`;
          ozonErrors.push(errorMsg);
          toast.error(errorMsg);
          continue;
        }

        // Use ozon_city_id directly instead of getOzonCityId lookup
        const cityId = (order as any).ozon_city_id;
        if (!cityId) {
          ozonFailed++;
          const errorMsg = `Ville non vérifiée pour cette commande #${order.order_number}. Merci de sélectionner la ville via le sélecteur avant l'envoi à Ozon.`;
          ozonErrors.push(errorMsg);
          toast.error(errorMsg);
          continue;
        }

        const ozonData: OzonParcelRequest = {
          "parcel-receiver": String(order.customer?.name ?? (order as any).customer_name ?? (order as any).name ?? "Client"),
          "parcel-phone": String(order.phone ?? order.customer?.phone ?? "").replace(/\s+/g, ""),
          "parcel-city": String(cityId),
          "parcel-address": fullAddress,
          "parcel-price": Number(order.total ?? (order as any).price ?? 0),
          "parcel-stock": 0,
        };

        try {
          const result = await createOzonParcel(
            ozonConfig,
            ozonData,
            workspace?.id,
            order.id,
            order.order_number,
          );

          if (result.success && result.trackingNumber) {
            console.log("[Delivering] Ozon API response:", result.data);
            console.log("[Delivering] Extracted status:", (result.data as any)?.status ?? (result.data as any)?.current_status ?? null);

            (order as any).tracking_number = result.trackingNumber;
            ozonSuccess++;

            const savedOrder = await persistTrackingNumberForOrder(
              order,
              {
                trackingNumber: result.trackingNumber,
                shipmentId:
                  (result.data as any)?.shipment_id ?? (result.data as any)?.shipmentId ?? null,
                status:
                  (result.data as any)?.status ?? (result.data as any)?.current_status ?? null,
              },
              workspace?.id,
            );
            if (savedOrder) {
              console.log("[Delivering] Saved order after shipment creation:", savedOrder);
              try {
                const syncRes = await syncOrderTracking(savedOrder, workspace?.id ?? "", "ozon", ozonConfig);
                console.log("[Delivering] Sync result:", syncRes);
                if (syncRes.success) {
                  (order as any).shipping_status = syncRes.newStatus ?? (order as any).shipping_status;
                  (order as any).delivery_status = syncRes.newStatus ?? (order as any).delivery_status;
                }
              } catch (err) {
                console.warn("[Delivering] syncOrderTracking failed:", err);
              }
            }
          } else {
            ozonFailed++;
            ozonErrors.push(`#${order.order_number}: ${result.error ?? "unknown error"}`);
          }
        } catch (apiError: any) {
          ozonFailed++;
          ozonErrors.push(`#${order.order_number}: unexpected crash - ${apiError?.message || 'unknown'}`);
          console.error("[Delivering] Unexpected error registering Ozon parcel:", apiError);
        }
      }

      if (ozonSuccess > 0) {
        await reload();
        toast.success(`🚚 Ozon: ${ozonSuccess} parcel${ozonSuccess !== 1 ? "s" : ""} registered successfully.`);
      }
      if (ozonFailed > 0) {
        console.warn("[Delivering] Ozon registration failures:", ozonErrors);
        toast.error(`Ozon: ${ozonFailed} order${ozonFailed !== 1 ? "s" : ""} failed to register. Check console for details.`);
      }
      return ozonSuccess > 0;
    } catch (err: any) {
      toast.error(`Ozon error: ${err?.message ?? String(err)}`);
      return false;
    } finally {
      setSendingToOzon(false);
    }
  };

  // ── Send to Coliaty (Step 1 only) ────────────────────────────────────────────
  const handleSendToColiaty = async (): Promise<boolean> => {
    if (sendingToOzon) return false;

    // Check if Coliaty is configured for this workspace
    if (!workspace?.coliaty_enabled || !workspace?.coliaty_public_key || !workspace?.coliaty_secret_key) {
      toast.error("Coliaty n'est pas configuré pour cet espace de travail. Veuillez configurer votre clé API dans Paramètres > Intégrations.");
      return false;
    }

    const toExport = getOrdersToExport();
    if (toExport.length === 0) {
      toast.error("No orders selected. Please check the boxes first.");
      return false;
    }

    setSendingToOzon(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        toast.error("Authentication required");
        setSendingToOzon(false);
        return false;
      }

      let coliatySuccess = 0;
      let coliatyFailed = 0;
      const coliatyErrors: string[] = [];

      for (const order of toExport) {
        // Check if order already has a Coliaty parcel code
        if (order.coliaty_parcel_code) {
          const shouldContinue = confirm(
            `La commande #${order.order_number} a déjà été envoyée à Coliaty (code: ${order.coliaty_parcel_code}). Voulez-vous vraiment créer un nouveau colis ?`
          );
          if (!shouldContinue) {
            coliatyErrors.push(`#${order.order_number}: annulé par l'utilisateur`);
            coliatyFailed++;
            continue;
          }
        }

        // Check if city is resolved for Coliaty
        const cityId = (order as any).coliaty_city_id;
        if (!cityId) {
          coliatyFailed++;
          const errorMsg = `Ville non vérifiée pour cette commande #${order.order_number}. Merci de sélectionner la ville via le sélecteur avant l'envoi à Coliaty.`;
          coliatyErrors.push(errorMsg);
          toast.error(errorMsg);
          continue;
        }

        try {
          const response = await fetch(`${SUPABASE_URL}/functions/v1/coliaty-api/create-parcel`, {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${session.access_token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              workspace_id: workspace?.id,
              order_id: order.id,
              order_number: order.order_number,
              customer_name: order.customer?.name || "",
              phone: order.phone || "",
              city: order.city || "",
              address: order.address || "",
              price: order.total || 0,
            }),
          });

          if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error || "Coliaty API error");
          }

          const result = await response.json();
          if (result.success) {
            (order as any).coliaty_parcel_code = result.parcel_code;
            coliatySuccess++;

            // Immediately sync tracking status with Coliaty so the order reflects real-world state and moves tabs
            try {
              const syncRes = await syncColiatyTracking(order, workspace?.id ?? "");
              if (syncRes.success) {
                (order as any).shipping_status = syncRes.newStatus ?? (order as any).shipping_status;
                (order as any).delivery_status = syncRes.newStatus ?? (order as any).delivery_status;
              }
            } catch (err) {
              console.warn("[Delivering] syncColiatyTracking failed:", err);
            }
          } else {
            coliatyFailed++;
            coliatyErrors.push(`#${order.order_number}: ${result.error ?? "unknown error"}`);
          }
        } catch (apiError: any) {
          coliatyFailed++;
          coliatyErrors.push(`#${order.order_number}: ${apiError?.message || 'unknown'}`);
          console.error("[Delivering] Unexpected error registering Coliaty parcel:", apiError);
        }
      }

      if (coliatySuccess > 0) {
        await reload();
        toast.success(`🚚 Coliaty: ${coliatySuccess} parcel${coliatySuccess !== 1 ? "s" : ""} registered successfully.`);
      }
      if (coliatyFailed > 0) {
        console.warn("[Delivering] Coliaty registration failures:", coliatyErrors);
        toast.error(`Coliaty: ${coliatyFailed} order${coliatyFailed !== 1 ? "s" : ""} failed to register. Check console for details.`);
      }
      return coliatySuccess > 0;
    } catch (err: any) {
      toast.error(`Coliaty error: ${err?.message ?? String(err)}`);
      return false;
    } finally {
      setSendingToOzon(false);
    }
  };

  // ── Generate Delivery Note ──────────────────────────────────────────────────
  const handleGenerateDeliveryNote = async () => {
    if (generatingNote) return;

    const selectedOrders = orders.filter((o) => {
      const uniqueId = o.id || o.order_number;
      return selectedOrderIds.includes(uniqueId);
    });

    if (selectedOrders.length === 0) {
      toast.error("Veuillez sélectionner au moins une commande.");
      return;
    }

    const ordersWithExistingBL = selectedOrders.filter((o) => getDeliveryNoteRef(o));
    if (ordersWithExistingBL.length > 0) {
      const noteType = workspace?.carrier === "coliaty" ? "bon de ramassage" : "bon de livraison";
      toast.error(
        `La commande #${ordersWithExistingBL[0].order_number} possède déjà un ${noteType} généré.`
      );
      return;
    }

    // Check tracking based on carrier
    const trackingField = workspace?.carrier === "coliaty" ? "coliaty_parcel_code" : "tracking_number";
    const carrierName = workspace?.carrier === "coliaty" ? "Coliaty" : "Ozon";
    const ordersWithoutTracking = selectedOrders.filter((o) => !(o as any)[trackingField]);
    if (ordersWithoutTracking.length > 0) {
      toast.error(`Toutes les commandes sélectionnées doivent avoir un numéro de suivi ${carrierName}.`);
      return;
    }

    const trackingNumbers = selectedOrders.map((o) => (o as any)[trackingField] as string);

    // Check if carrier is configured
    if (workspace?.carrier === "coliaty") {
      if (!workspace?.coliaty_enabled || !workspace?.coliaty_public_key || !workspace?.coliaty_secret_key) {
        toast.error("Coliaty n'est pas configuré pour cet espace de travail. Veuillez configurer votre clé API dans Paramètres > Intégrations.");
        return;
      }
    } else {
      const ozonClientId = localStorage.getItem("ozon_client_id")?.trim() || "";
      const ozonApiKey = localStorage.getItem("ozon_api_key")?.trim() || "";
      if (!ozonClientId || !ozonApiKey) {
        toast.error("Ozon n'est pas configuré. Veuillez configurer vos identifiants dans Paramètres > Intégrations.");
        return;
      }
    }

    setGeneratingNote(true);
    try {
      if (workspace?.carrier === "coliaty") {
        // Coliaty Pickup Note flow
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) {
          toast.error("Authentication required");
          setGeneratingNote(false);
          return;
        }

        // Step 1: Create pickup note — must include workspace_id so the edge function
        // loads the correct Coliaty API key (fix: was missing, causing "not configured" error)
        const createRes = await fetch(`${SUPABASE_URL}/functions/v1/coliaty-api/create-pickup-note`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${session.access_token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ workspace_id: workspace?.id }),
        });

        if (!createRes.ok) {
          const errorData = await createRes.json();
          throw new Error(errorData.error || "Failed to create pickup note");
        }

        const createResult = await createRes.json();
        if (!createResult.success || !createResult.reference) {
          throw new Error("Coliaty API did not return a reference for the pickup note");
        }

        const reference = createResult.reference;

        // Step 2: Add parcels to pickup note — workspace_id required for API key lookup
        const addParcelsRes = await fetch(`${SUPABASE_URL}/functions/v1/coliaty-api/add-parcels-to-pickup-note`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${session.access_token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            workspace_id: workspace?.id,
            reference,
            parcel_codes: trackingNumbers,
          }),
        });

        if (!addParcelsRes.ok) {
          const errorData = await addParcelsRes.json();
          // Check for partial failures
          if (errorData.error_parcels && Object.keys(errorData.error_parcels).length > 0) {
            const errorMessages = Object.entries(errorData.error_parcels)
              .map(([code, err]: [string, any]) => `${code}: ${err.message}`)
              .join(", ");
            throw new Error(`Certains colis n'ont pas pu être ajoutés: ${errorMessages}`);
          }
          throw new Error(errorData.error || "Failed to add parcels to pickup note");
        }

        const addParcelsResult = await addParcelsRes.json();
        if (!addParcelsResult.success) {
          throw new Error("Failed to add parcels to pickup note");
        }

        // Step 3: Generate labels/PDF — include workspace_id so the function loads correct API key
        const generateLabelsRes = await fetch(`${SUPABASE_URL}/functions/v1/coliaty-api/generate-pickup-note-labels?reference=${reference}&workspace_id=${workspace?.id}`, {
          method: "GET",
          headers: {
            "Authorization": `Bearer ${session.access_token}`,
          },
        });

        if (!generateLabelsRes.ok) {
          const errorData = await generateLabelsRes.json();
          throw new Error(errorData.error || "Failed to generate pickup note labels");
        }

        // The API returns the PDF directly (binary)
        const pdfBlob = await generateLabelsRes.blob();
        const pdfUrl = URL.createObjectURL(pdfBlob);

        // Open PDF in new tab
        window.open(pdfUrl, "_blank");

        // Save delivery note metadata (note: we don't have a persistent PDF URL since it's generated on-demand)
        const orderNumbers = selectedOrders.map((o) => o.order_number).filter(Boolean);
        await supabase.from("delivery_notes").insert({
          ref: reference,
          pdf_url: null, // PDF is generated on-demand, not stored
          order_ids: orderNumbers,
        });

        await reload();
        toast.success(`Bon de ramassage ${reference} généré avec succès.`);
        setSelectedOrderIds([]);
      } else {
        // Ozon Delivery Note flow (existing)
        const ozonClientId = localStorage.getItem("ozon_client_id")?.trim() || "";
        const ozonApiKey = localStorage.getItem("ozon_api_key")?.trim() || "";
        const ozonConfig = { clientId: ozonClientId, apiKey: ozonApiKey };

        const result = await createOzonDeliveryNote(ozonConfig, trackingNumbers);

        if (result.success && result.ref && result.pdfUrl) {
          // Direct opening of the BL PDF URL
          window.open(result.pdfUrl, "_blank");

          // Collect order IDs strictly
          const orderIds = selectedOrders.map((o) => o.id || (o as any)["Order ID"]).filter(Boolean);

          // Save delivery note metadata
          await supabase.from("delivery_notes").insert({
            ref: result.ref,
            pdf_url: result.pdfUrl,
            order_ids: orderIds,
          });

          // Persist dn-ref on each selected order using unique Order ID (avoid order_number duplicate issue)
          for (const order of selectedOrders) {
            const orderId = order.id || (order as any)["Order ID"];
            if (!orderId) continue;

            const existingRaw = (order as any).ozon_raw_response || {};
            const updatedRaw = { ...existingRaw, delivery_note_ref: result.ref };

            const { error: updateErr } = await supabase
              .from("orders")
              .update({
                ozon_raw_response: updatedRaw,
                updated_at: new Date().toISOString(),
              })
              .eq("Order ID", orderId);

            if (updateErr) {
              console.error(`[Delivering] Failed to update delivery_note_ref for Order ID ${orderId}:`, updateErr);
            }
          }

          await reload();
          const noteType = (workspace?.carrier as "ozon" | "coliaty" | null) === "coliaty" ? "Bon de ramassage" : "Bon de livraison";
          toast.success(`${noteType} ${result.ref} généré avec succès.`);
          setSelectedOrderIds([]);
        } else {
          const noteType = (workspace?.carrier as "ozon" | "coliaty" | null) === "coliaty" ? "bon de ramassage" : "bon de livraison";
          toast.error(result.error || `Erreur lors de la génération du ${noteType}.`);
        }
      }
    } catch (err: any) {
      toast.error(`Erreur: ${err?.message || String(err)}`);
    } finally {
      setGeneratingNote(false);
    }
  };

  // ── Refresh Status (Ozon Tracking) ──────────────────────────────────────────
  const handleRefreshStatus = async (order: Order) => {
    if (refreshingOrderId) return;
    setRefreshingOrderId(order.id);
    try {
      // Determine carrier for this specific order
      const orderCarrier = (order as any).shipping_provider || workspace?.carrier || "ozon";
      const isColiaty = orderCarrier === "coliaty";
      const trackingField = isColiaty ? "coliaty_parcel_code" : "tracking_number";
      const trackingNumber = (order as any)[trackingField];

      // Check if tracking number exists before making API call
      if (!trackingNumber) {
        toast.error(`Commande non envoyée au transporteur. Veuillez d'abord envoyer cette commande.`);
        setRefreshingOrderId(null);
        return;
      }

      if (isColiaty) {
        // Sync with Coliaty
        const syncRes = await syncColiatyTracking(order, order.workspace_id || (workspace?.id ?? ""));
        if (syncRes.success) {
          toast.success(`Statut: ${syncRes.newStatus}`);
          await reload();
        } else {
          // Distinguish between "not sent" and technical error
          if (syncRes.error?.includes("No Coliaty parcel code")) {
            toast.error("Commande non envoyée au transporteur.");
          } else {
            toast.error(syncRes.error || "Failed to track parcel");
          }
        }
      } else {
        // Sync with Ozon
        const ozonClientId = localStorage.getItem("ozon_client_id")?.trim() || "";
        const ozonApiKey = localStorage.getItem("ozon_api_key")?.trim() || "";
        const ozonConfig = { clientId: ozonClientId, apiKey: ozonApiKey };

        const syncRes = await syncOrderTracking(order, workspace?.id ?? "", orderCarrier, ozonConfig);
        if (syncRes.success) {
          toast.success(`Statut: ${syncRes.newStatus}`);
          await reload();
        } else {
          // Distinguish between "not sent" and technical error
          if (syncRes.error?.includes("No Ozon tracking number")) {
            toast.error("Commande non envoyée au transporteur.");
          } else {
            toast.error(syncRes.error || "Failed to track parcel");
          }
        }
      }
    } catch (err: any) {
      toast.error(`Error: ${err?.message || String(err)}`);
    } finally {
      setRefreshingOrderId(null);
    }
  };

  // ── Refresh All Selected Orders ─────────────────────────────────────────────
  const handleRefreshAllSelectedOrders = async () => {
    if (isRefreshingAll || visibleSelectedCount === 0) return;

    // Reset auto-refresh timer when manual refresh is triggered
    resetAutoRefreshTimer();

    const selectedOrders = orders.filter((o) => {
      const uniqueId = o.id || o.order_number;
      return selectedOrderIds.includes(uniqueId);
    });

    // Check tracking based on each order's specific shipping_provider
    const ordersWithoutTracking: Order[] = [];
    const ordersWithTracking: Order[] = [];

    for (const order of selectedOrders) {
      const orderCarrier = (order as any).shipping_provider || workspace?.carrier || "ozon";
      const trackingField = orderCarrier === "coliaty" ? "coliaty_parcel_code" : "tracking_number";

      if (!(order as any)[trackingField]) {
        ordersWithoutTracking.push(order);
      } else {
        ordersWithTracking.push(order);
      }
    }

    if (ordersWithoutTracking.length > 0) {
      const orderNumbers = ordersWithoutTracking.map(o => `#${o.order_number}`).join(", ");
      toast.error(`${ordersWithoutTracking.length} commande${ordersWithoutTracking.length !== 1 ? "s" : ""} non envoyée${ordersWithoutTracking.length !== 1 ? "s" : ""} au transporteur: ${orderNumbers}. Veuillez d'abord envoyer ces commandes.`);
      return;
    }

    if (ordersWithTracking.length === 0) {
      toast.error("Aucune commande sélectionnée avec un numéro de suivi.");
      return;
    }

    setIsRefreshingAll(true);
    setRefreshingAllCount(0);

    try {
      // Use unified refresh function
      const { successCount, failureCount, failedOrders } = await refreshShippingStatuses(ordersWithTracking);

      // Show summary toast
      if (successCount > 0 && failureCount === 0) {
        toast.success(`✅ ${successCount} commande${successCount !== 1 ? "s" : ""} actualisée${successCount !== 1 ? "s" : ""}.`);
      } else if (successCount > 0 && failureCount > 0) {
        toast.error(`Résumé: ${successCount} actualisée${successCount !== 1 ? "s" : ""}, ${failureCount} échec${failureCount !== 1 ? "s" : ""}. Échecs: ${failedOrders.join(", ")}`);
      } else {
        toast.error(`Erreur: ${failureCount} échec${failureCount !== 1 ? "s" : ""}. ${failedOrders.join(", ")}`);
      }
    } catch (err: any) {
      toast.error(`Erreur: ${err?.message ?? String(err)}`);
    } finally {
      setIsRefreshingAll(false);
      setRefreshingAllCount(0);
    }
  };

  // ── View All Selected PDFs ─────────────────────────────────────────────────
  const handleViewAllSelectedPdfs = async () => {
    if (isOpeningAllPdfs || visibleSelectedCount === 0) return;

    const selectedOrders = orders.filter((o) => {
      const uniqueId = o.id || o.order_number;
      return selectedOrderIds.includes(uniqueId);
    });

    if (selectedOrders.length === 0) {
      toast.error("Veuillez sélectionner au moins une commande.");
      return;
    }

    const ordersWithRef = selectedOrders.filter((o) => getDeliveryNoteRef(o));

    if (ordersWithRef.length === 0) {
      const noteType = workspace?.carrier === "coliaty" ? "bon de ramassage" : "bon de livraison";
      toast.error(`Aucune commande sélectionnée n'a de ${noteType}. Vous devez d'abord le générer.`);
      return;
    }

    setIsOpeningAllPdfs(true);
    try {
      const uniqueRefs = new Set<string>();
      for (const order of ordersWithRef) {
        const dnRef = getDeliveryNoteRef(order);
        if (dnRef && !uniqueRefs.has(dnRef)) {
          uniqueRefs.add(dnRef);

          if (workspace?.carrier === "coliaty") {
            // Re-fetch PDF for Coliaty using Edge Function
            const { data: { session } } = await supabase.auth.getSession();
            if (session) {
              const labelsRes = await fetch(`${SUPABASE_URL}/functions/v1/coliaty-api/generate-pickup-note-labels?reference=${dnRef}&workspace_id=${workspace?.id}`, {
                method: "GET",
                headers: { "Authorization": `Bearer ${session.access_token}` },
              });
              if (labelsRes.ok) {
                const pdfBlob = await labelsRes.blob();
                window.open(URL.createObjectURL(pdfBlob), "_blank");
              }
            }
          } else {
            // Ozon explicitly expects the 4x4 ticket format
            const pdfUrl = `https://client.ozoneexpress.ma/pdf-delivery-note-tickets-4-4?dn-ref=${encodeURIComponent(dnRef)}`;
            window.open(pdfUrl, "_blank");
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      toast.success(`${uniqueRefs.size} PDF${uniqueRefs.size !== 1 ? "s" : ""} ouvert${uniqueRefs.size !== 1 ? "s" : ""}.`);
    } catch (err: any) {
      toast.error(`Erreur: ${err?.message || String(err)}`);
    } finally {
      setIsOpeningAllPdfs(false);
    }
  };

  // Ozon integration removed: Send to provider functionality disabled.

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full pt-1 lg:flex-row lg:space-y-0 lg:space-x-4">
      {/* ── Main content (Fluid width) ── */}
      <div className="flex-1 flex flex-col min-w-0 h-full">
        {/* ── Modern Premium Header ── */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
          <div className="flex flex-col gap-0.5">
            <div className="flex items-center gap-3">
              <h1 className="text-[24px] md:text-[26px] font-bold text-gray-900 tracking-tight leading-none">Delivering CRM</h1>
              <div className="h-4 w-px bg-gray-300 hidden md:block"></div>
              <p className="text-[13px] text-gray-500 leading-none hidden md:block">Track confirmed orders and monitor delivery history.</p>
            </div>
            {/* Auto-refresh indicator */}

          </div>

          {/* Action Buttons Toolbar (36px) */}
          <div className="flex flex-wrap items-center gap-2">

            {workspace?.carrier === "coliaty" ? (
              <OzonSendButton onSend={handleSendToColiaty} disabled={sendingToOzon} idleLabel="Send to Coliaty" sendingLabel="Sending..." successLabel="Sent!" errorLabel="Failed" />
            ) : (
              <OzonSendButton onSend={handleSendToOzon} disabled={sendingToOzon} idleLabel="Send to Ozon" sendingLabel="Sending..." successLabel="Sent!" errorLabel="Failed" />
            )}

            <button
              type="button"
              onClick={handleGenerateDeliveryNote}
              disabled={generatingNote || selectedOrderIds.length === 0 || selectedOrdersHasExistingBL}
              className="group flex h-[36px] items-center justify-center gap-2 rounded-lg bg-white border border-gray-200 px-3.5 text-[13px] font-semibold text-gray-700 shadow-sm transition-all focus:outline-none focus:ring-2 focus:ring-indigo-500/30 hover:border-indigo-200 hover:bg-indigo-50/50 hover:text-indigo-700 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <div className="relative flex items-center justify-center">
                {generatingNote ? <RefreshCw size={15} className="animate-spin text-indigo-600" /> : <FileText size={15} className="text-gray-400 group-hover:text-indigo-500 transition-colors" />}
              </div>
              <span className="hidden sm:inline">{workspace?.carrier === "coliaty" ? "Bon de Ramassage" : "Bon de Livraison"}</span>
            </button>

            <button
              type="button"
              onClick={handleRefreshAllSelectedOrders}
              disabled={isRefreshingAll || visibleSelectedCount === 0}
              className="group flex h-[36px] items-center justify-center gap-2 rounded-lg bg-white border border-gray-200 px-3 text-[13px] font-semibold text-gray-700 shadow-sm transition-all focus:outline-none focus:ring-2 focus:ring-gray-900/10 hover:border-gray-300 hover:bg-gray-50 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isRefreshingAll ? <RefreshCw size={15} className="animate-spin text-gray-900" /> : <RefreshCw size={15} className="text-gray-400 group-hover:text-gray-700 transition-colors" />}
              <span className="hidden xl:inline">Actualiser</span>
            </button>

            <button
              type="button"
              onClick={handleViewAllSelectedPdfs}
              disabled={isOpeningAllPdfs || visibleSelectedCount === 0}
              className="relative flex h-[36px] items-center justify-center gap-2 rounded-lg bg-gradient-to-b from-indigo-500 to-indigo-600 border border-indigo-700/80 px-4 text-[13px] font-semibold text-white shadow-[0_1px_2px_rgba(79,70,229,0.3),inset_0_1px_0_rgba(255,255,255,0.2)] transition-all focus:outline-none focus:ring-2 focus:ring-indigo-500/50 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed hover:from-indigo-400 hover:to-indigo-500"
            >
              {isOpeningAllPdfs ? <RefreshCw size={15} className="animate-spin text-indigo-100" /> : <Eye size={15} className="text-indigo-100" />}
              <span className="hidden xl:inline tracking-wide drop-shadow-sm">Voir PDF</span>
            </button>
          </div>
        </div>

        {/* ── Filter Row (Compact) ── */}
        <div className="flex items-center gap-1.5 overflow-x-auto hide-scrollbar" style={{ scrollbarWidth: "none" }}>
          {dynamicFilters.map((filter) => {
            const isActive = activeTab === filter.id;
            const dotColor = getStatusDotColor(filter.id);
            const workspacePrimaryColor = workspace?.primary_color || '#3B82F6';

            return (
              <button
                key={filter.id}
                onClick={() => setActiveTab(filter.id)}
                className={`shrink-0 h-[32px] rounded-full px-[12px] py-[10px] text-[12px] font-medium flex items-center justify-center gap-1.5 transition-all duration-180 border ${isActive
                  ? `shadow-sm`
                  : "bg-white border-gray-200 text-gray-600 hover:bg-gray-50"
                  }`}
                style={isActive ? {
                  backgroundColor: workspacePrimaryColor,
                  borderColor: workspacePrimaryColor,
                  color: 'white'
                } : undefined}
              >
                <div
                  className="w-2 h-2 rounded-full"
                  style={{ backgroundColor: dotColor }}
                />
                <span>{filter.label}</span>
                {filter.count > 0 && (
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${isActive ? 'bg-white/20 text-white' : 'bg-gray-100/80 text-gray-500'}`}>
                    {filter.count}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* ── Enterprise Table Layout ── */}
        <div className="flex-1 flex flex-col min-h-0">
          {loading ? (
            <div className="flex flex-col gap-2 py-4">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="h-[56px] animate-pulse rounded bg-gray-100" />
              ))}
            </div>
          ) : filteredOrders.length === 0 ? (
            <div className="flex-1 flex items-center justify-center py-12">
              <EmptyState icon={<Inbox size={24} />} title={`No orders found`} subtitle="Try adjusting your filters or search." />
            </div>
          ) : (
            <>
              <div className="flex-1 overflow-auto" ref={scrollContainerRef} onScroll={handleScroll}>
                <table className="w-full text-left text-[13px] whitespace-nowrap">
                  <thead className="sticky top-0 z-10 font-semibold text-gray-500 uppercase text-[11px] tracking-wider border-b border-gray-200 bg-white">
                    <tr>
                      <th className="px-4 py-2.5 w-10">
                        <input type="checkbox" checked={allVisibleSelected} onChange={() => {
                          if (allVisibleSelected) setSelectedOrderIds([]);
                          else setSelectedOrderIds(filteredOrders.map(o => o.id || o.order_number || ""));
                        }} className="rounded border-gray-300 text-gray-900 focus:ring-gray-900 cursor-pointer w-3.5 h-3.5" />
                      </th>
                      <th className="px-4 py-2.5">Order ID</th>
                      <th className="px-4 py-2.5">Customer</th>
                      <th className="px-4 py-2.5">City</th>
                      <th className="px-4 py-2.5">COD</th>
                      <th className="px-4 py-2.5">Shipping</th>
                      <th className="px-4 py-2.5 min-w-[120px]">Status</th>
                      <th className="px-4 py-2.5">Tracking</th>
                      <th className="px-4 py-2.5">Updated</th>
                      <th className="px-4 py-2.5 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {displayOrders.map((order, idx) => {
                      const uniqueId = order.id || order.order_number || `temp-${idx}`;
                      const isSelected = selectedOrderIds.includes(uniqueId);
                      const dnRef = getDeliveryNoteRef(order);
                      const currentStatus = order.shipping_status;
                      const trk = order.tracking_number || order.coliaty_parcel_code || "";

                      return (
                        <tr key={`${uniqueId}-${idx}`} className={`h-[56px] transition-colors duration-150 ${isSelected ? "bg-gray-50/80" : "hover:bg-gray-50/50"}`}>
                          <td className="px-4 py-2">
                            <input type="checkbox" checked={isSelected} disabled={Boolean(dnRef)} onChange={() => {
                              setSelectedOrderIds(prev => prev.includes(uniqueId) ? prev.filter(id => id !== uniqueId) : [...prev, uniqueId]);
                            }} className="rounded border-gray-300 text-gray-900 focus:ring-gray-900 cursor-pointer disabled:opacity-50 w-3.5 h-3.5" />
                          </td>
                          <td className="px-4 py-2 font-mono font-medium text-gray-900 w-28">
                            #{order.order_number}
                          </td>
                          <td className="px-4 py-2">
                            <div className="flex flex-col">
                              <span className="font-medium text-gray-900 truncate max-w-[140px]">{order.customer?.name ?? (order as any).customer_name ?? "—"}</span>
                              <span className="text-[12px] text-gray-500 font-mono mt-0.5">{order.phone ?? order.customer?.phone ?? "—"}</span>
                            </div>
                          </td>
                          <td className="px-4 py-2 text-gray-600 max-w-[120px] truncate">{order.city || "—"}</td>
                          <td className="px-4 py-2 font-medium text-gray-900">{mad(order.total)}</td>
                          <td className="px-4 py-2 text-gray-600 text-[12px]">{formatPrice(calculateOrderShipping(order) || null)}</td>
                          <td className="px-4 py-2 whitespace-nowrap">
                            <div className="scale-90 origin-left"><ShippingStatusBadge status={currentStatus} /></div>
                          </td>
                          <td className="px-4 py-2">
                            {trk ? (
                              <div className="flex items-center gap-1.5 group cursor-pointer" onClick={() => { navigator.clipboard.writeText(trk); toast.success("Copied!"); }}>
                                <span className="font-mono text-[13px] text-gray-600">{trk}</span>
                                <Copy size={13} className="text-gray-400 opacity-0 group-hover:opacity-100 transition-opacity" />
                              </div>
                            ) : <span className="text-gray-400">—</span>}
                          </td>
                          <td className="px-4 py-2 text-gray-500 text-[12px]">{formatDate(order.created_at)}</td>
                          <td className="px-4 py-2 text-right">
                            <div className="flex items-center justify-end gap-1 relative">
                              <button onClick={() => setPanelOrder(order)} className="p-1.5 text-gray-400 hover:text-gray-900 hover:bg-gray-100 rounded-md transition-colors" title="View details">
                                <Eye size={16} />
                              </button>
                              <button onClick={() => handleRefreshStatus(order)} disabled={!trk || refreshingOrderId === order.id} className="p-1.5 text-gray-400 hover:text-gray-900 hover:bg-gray-100 rounded-md transition-colors disabled:opacity-50" title="Refresh status">
                                <RefreshCw size={16} className={refreshingOrderId === order.id ? "animate-spin" : ""} />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* ── Progress Footer ── */}
              <div className="h-[44px] flex shrink-0 items-center justify-between px-4 border-t border-gray-200 text-[13px] text-gray-500 font-medium">
                <div>Showing {displayOrders.length} of {filteredOrders.length} Orders</div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── Right Details Panel (Delivery Control Center) ── */}
      {panelOrder && (
        <div className="shrink-0 w-full lg:w-[380px] bg-white border border-gray-200 rounded-xl shadow-sm h-full flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-200">
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 bg-[#F9FAFB]">
            <div>
              <h3 className="font-bold text-gray-900 text-[14px]">Order #{panelOrder.order_number}</h3>
              <div className="flex items-center gap-2 mt-1">
                <div className="flex items-center gap-1.5">
                  <div className="w-2 h-2 rounded-full bg-emerald-500"></div>
                  <span className="text-[11px] font-medium text-emerald-600">Healthy</span>
                </div>
              </div>
            </div>
            <button onClick={() => setPanelOrder(null)} className="p-1 rounded-md text-gray-400 hover:text-gray-900 hover:bg-gray-200 transition-colors">
              <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12" /></svg>
            </button>
          </div>
          <div className="flex-1 overflow-y-auto bg-white">

            {/* Delivery Health Score */}
            <div className="px-4 py-3 border-b border-gray-100">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider">Delivery Health</span>
                {(() => {
                  const progress = getDeliveryProgress(panelOrder);
                  if (progress.isFailed) return <span className="text-[12px] font-bold text-red-600">Failed</span>;
                  if (progress.isReturned) return <span className="text-[12px] font-bold text-orange-600">Returned</span>;
                  if (progress.isCancelled) return <span className="text-[12px] font-bold text-gray-600">Cancelled</span>;
                  if (progress.currentStep === 'Delivered') return <span className="text-[12px] font-bold text-emerald-600">Delivered</span>;
                  if (progress.currentStep === 'Out For Delivery') return <span className="text-[12px] font-bold text-blue-600">In Progress</span>;
                  return <span className="text-[12px] font-bold text-emerald-600">Good</span>;
                })()}
              </div>
              <div className="w-full h-1.5 bg-gray-100 rounded-full overflow-hidden">
                {(() => {
                  const progress = getDeliveryProgress(panelOrder);
                  let healthPercentage = 85;
                  if (progress.isFailed) healthPercentage = 0;
                  else if (progress.isReturned) healthPercentage = 20;
                  else if (progress.isCancelled) healthPercentage = 10;
                  else if (progress.currentStep === 'Delivered') healthPercentage = 100;
                  else if (progress.currentStep === 'Out For Delivery') healthPercentage = 90;
                  else if (progress.currentStep === 'In Transit') healthPercentage = 70;
                  else if (progress.currentStep === 'Warehouse') healthPercentage = 50;
                  else if (progress.currentStep === 'Ready To Send') healthPercentage = 30;

                  const healthColor = progress.isFailed ? 'bg-red-500' :
                    progress.isReturned ? 'bg-orange-500' :
                      progress.isCancelled ? 'bg-gray-500' :
                        progress.currentStep === 'Delivered' ? 'bg-emerald-500' : 'bg-emerald-500';

                  return <div className={`h-full ${healthColor} rounded-full`} style={{ width: `${healthPercentage}%` }}></div>;
                })()}
              </div>
            </div>

            {/* Next Recommended Action */}
            <div className="px-4 py-3 border-b border-gray-100 bg-blue-50/50">
              <div className="flex items-start gap-2">
                <div className="p-1.5 bg-blue-100 rounded-lg">
                  <AlertTriangle size={14} className="text-blue-600" />
                </div>
                <div className="flex-1">
                  <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-1">Next Action</div>
                  <div className="text-[13px] font-medium text-gray-900">
                    {(() => {
                      const progress = getDeliveryProgress(panelOrder);
                      if (progress.isFailed) return 'Handle failed delivery';
                      if (progress.isReturned) return 'Process return';
                      if (progress.isCancelled) return 'Order cancelled';
                      if (progress.currentStep === 'Ready To Send') return 'Send package to warehouse';
                      if (progress.currentStep === 'Warehouse') return 'Wait for carrier pickup';
                      if (progress.currentStep === 'In Transit') return 'Monitor tracking updates';
                      if (progress.currentStep === 'Out For Delivery') return 'Contact customer if needed';
                      if (progress.currentStep === 'Delivered') return 'Await COD settlement';
                      return 'Monitor tracking updates';
                    })()}
                  </div>
                </div>
              </div>
            </div>

            {/* Customer Information */}
            <div className="px-4 py-3 border-b border-gray-100">
              <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-3">Customer Information</div>
              <div className="space-y-2.5">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="text-[12px] text-gray-500 mb-0.5">Name</div>
                    <div className="text-[13px] font-medium text-gray-900">{panelOrder.customer?.name ?? (panelOrder as any).customer_name ?? "—"}</div>
                  </div>
                </div>
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="text-[12px] text-gray-500 mb-0.5">Phone</div>
                    <div className="text-[13px] font-mono text-gray-900">{panelOrder.phone ?? panelOrder.customer?.phone ?? "—"}</div>
                  </div>
                  <div className="flex gap-1">
                    <button
                      onClick={() => {
                        const phone = panelOrder.phone ?? panelOrder.customer?.phone;
                        if (phone) { navigator.clipboard.writeText(phone); toast.success("Phone copied!"); }
                      }}
                      className="p-1.5 text-gray-400 hover:text-gray-900 hover:bg-gray-100 rounded-md transition-colors"
                      title="Copy phone"
                    >
                      <Copy size={14} />
                    </button>
                    <button
                      onClick={() => {
                        const phone = panelOrder.phone ?? panelOrder.customer?.phone;
                        if (phone) window.open(`tel:${phone}`, '_blank');
                      }}
                      className="p-1.5 text-gray-400 hover:text-green-600 hover:bg-green-50 rounded-md transition-colors"
                      title="Call customer"
                    >
                      <Phone size={14} />
                    </button>
                    <button
                      onClick={() => {
                        const phone = panelOrder.phone ?? panelOrder.customer?.phone;
                        if (phone) window.open(`https://wa.me/${phone.replace(/\D/g, '')}`, '_blank');
                      }}
                      className="p-1.5 text-gray-400 hover:text-green-600 hover:bg-green-50 rounded-md transition-colors"
                      title="WhatsApp"
                    >
                      <MessageCircle size={14} />
                    </button>
                  </div>
                </div>
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="text-[12px] text-gray-500 mb-0.5">Address</div>
                    <div className="text-[13px] text-gray-900 leading-snug">{panelOrder.address || "—"}</div>
                    <div className="text-[13px] text-gray-600 mt-0.5">{panelOrder.city || "—"}</div>
                  </div>
                  <button
                    onClick={() => {
                      const address = `${panelOrder.address}, ${panelOrder.city}`;
                      if (address) { navigator.clipboard.writeText(address); toast.success("Address copied!"); }
                    }}
                    className="p-1.5 text-gray-400 hover:text-gray-900 hover:bg-gray-100 rounded-md transition-colors"
                    title="Copy address"
                  >
                    <Copy size={14} />
                  </button>
                </div>
              </div>
            </div>

            {/* Shipping Information */}
            <div className="px-4 py-3 border-b border-gray-100">
              <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-3">Shipping Information</div>
              <div className="space-y-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-[12px] text-gray-500">Provider</span>
                  <span className="text-[13px] font-medium text-gray-900 capitalize">{(panelOrder as any).shipping_provider || workspace?.carrier || "Ozon"}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[12px] text-gray-500">Tracking</span>
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-mono font-medium text-gray-900">{panelOrder.tracking_number || panelOrder.coliaty_parcel_code || "—"}</span>
                    {panelOrder.tracking_number && (
                      <div className="flex gap-1">
                        <button
                          onClick={() => {
                            navigator.clipboard.writeText(panelOrder.tracking_number!);
                            toast.success("Tracking copied!");
                          }}
                          className="p-1 text-gray-400 hover:text-gray-900 hover:bg-gray-100 rounded-md transition-colors"
                          title="Copy tracking"
                        >
                          <Copy size={12} />
                        </button>
                        <button
                          onClick={() => window.open(`https://client.ozoneexpress.ma/tracking/${panelOrder.tracking_number}`, '_blank')}
                          className="p-1 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-md transition-colors"
                          title="View tracking"
                        >
                          <ExternalLink size={12} />
                        </button>
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[12px] text-gray-500">
                    {isRefusedStatus(panelOrder.shipping_status || panelOrder.delivery_status || panelOrder.status) 
                      ? 'Refused Price' 
                      : 'Shipping Price'}
                  </span>
                  <span className="text-[13px] font-medium text-gray-900">
                    {loadingShippingPrice ? '...' : formatPrice(shippingPrice)}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[12px] text-gray-500">Total COD</span>
                  <span className="text-[13px] font-bold text-emerald-600">{mad(panelOrder.total)}</span>
                </div>
                <div className="flex items-center justify-between pt-2 border-t border-gray-100">
                  <span className="text-[12px] text-gray-500">Net COD</span>
                  <span className="text-[13px] font-bold text-gray-900">{formatPrice(calculateNetCOD(panelOrder.total, shippingPrice))}</span>
                </div>
              </div>
            </div>

            {/* Delivery Progress */}
            <div className="px-4 py-3 border-b border-gray-100">
              <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-3">Delivery Progress</div>
              <div className="space-y-3">
                {(() => {
                  const progress = getDeliveryProgress(panelOrder);

                  if (progress.isFailed) {
                    return (
                      <div className="flex items-center gap-3">
                        <div className="w-5 h-5 rounded-full flex items-center justify-center bg-red-500">
                          <AlertTriangle size={12} className="text-white" />
                        </div>
                        <div className="flex-1">
                          <div className="text-[12px] font-medium text-red-600">Delivery Failed</div>
                          <div className="text-[11px] text-gray-500">{progress.steps[0]?.time || ''}</div>
                        </div>
                      </div>
                    );
                  }

                  if (progress.isReturned) {
                    return (
                      <div className="flex items-center gap-3">
                        <div className="w-5 h-5 rounded-full flex items-center justify-center bg-orange-500">
                          <RefreshCw size={12} className="text-white" />
                        </div>
                        <div className="flex-1">
                          <div className="text-[12px] font-medium text-orange-600">Returned</div>
                          <div className="text-[11px] text-gray-500">{progress.steps[0]?.time || ''}</div>
                        </div>
                      </div>
                    );
                  }

                  if (progress.isCancelled) {
                    return (
                      <div className="flex items-center gap-3">
                        <div className="w-5 h-5 rounded-full flex items-center justify-center bg-gray-500">
                          <X size={12} className="text-white" />
                        </div>
                        <div className="flex-1">
                          <div className="text-[12px] font-medium text-gray-600">Cancelled</div>
                          <div className="text-[11px] text-gray-500">{progress.steps[0]?.time || ''}</div>
                        </div>
                      </div>
                    );
                  }

                  return progress.steps.map((item, i) => {
                    const isComplete = item.state === 'complete';
                    const isCurrent = item.state === 'current';
                    return (
                      <div key={i} className="flex items-center gap-3">
                        <div className={`w-5 h-5 rounded-full flex items-center justify-center ${isComplete ? 'bg-emerald-500' : isCurrent ? 'bg-blue-500' : 'bg-gray-200'}`}>
                          {isComplete ? <CheckCircle size={12} className="text-white" /> : isCurrent ? <Clock size={12} className="text-white" /> : <div className="w-2 h-2 rounded-full bg-gray-400" />}
                        </div>
                        <div className="flex-1">
                          <div className={`text-[12px] font-medium ${isComplete ? 'text-gray-900' : isCurrent ? 'text-blue-600' : 'text-gray-400'}`}>{item.step}</div>
                          {item.time && <div className="text-[11px] text-gray-500">{item.time}</div>}
                        </div>
                      </div>
                    );
                  });
                })()}
              </div>
            </div>

            {/* Quick Actions */}
            <div className="px-4 py-3">
              <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-3">Quick Actions</div>
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => {
                    const phone = panelOrder.phone ?? panelOrder.customer?.phone;
                    if (phone) window.open(`tel:${phone}`, '_blank');
                  }}
                  className="flex items-center justify-center gap-2 px-3 py-2 bg-gray-50 hover:bg-gray-100 rounded-lg text-[12px] font-medium text-gray-700 transition-colors"
                >
                  <Phone size={14} />
                  <span>Call</span>
                </button>
                <button
                  onClick={() => {
                    const phone = panelOrder.phone ?? panelOrder.customer?.phone;
                    if (phone) window.open(`https://wa.me/${phone.replace(/\D/g, '')}`, '_blank');
                  }}
                  className="flex items-center justify-center gap-2 px-3 py-2 bg-green-50 hover:bg-green-100 rounded-lg text-[12px] font-medium text-green-700 transition-colors"
                >
                  <MessageCircle size={14} />
                  <span>WhatsApp</span>
                </button>
                <button
                  onClick={() => {
                    const address = `${panelOrder.address}, ${panelOrder.city}`;
                    if (address) { navigator.clipboard.writeText(address); toast.success("Address copied!"); }
                  }}
                  className="flex items-center justify-center gap-2 px-3 py-2 bg-gray-50 hover:bg-gray-100 rounded-lg text-[12px] font-medium text-gray-700 transition-colors"
                >
                  <MapPin size={14} />
                  <span>Copy Address</span>
                </button>
                <button
                  onClick={() => {
                    if (panelOrder.tracking_number) {
                      navigator.clipboard.writeText(panelOrder.tracking_number);
                      toast.success("Tracking copied!");
                    }
                  }}
                  className="flex items-center justify-center gap-2 px-3 py-2 bg-gray-50 hover:bg-gray-100 rounded-lg text-[12px] font-medium text-gray-700 transition-colors"
                >
                  <Copy size={14} />
                  <span>Copy Tracking</span>
                </button>
              </div>
            </div>

          </div>
        </div>
      )}

    </div>
  );
}
