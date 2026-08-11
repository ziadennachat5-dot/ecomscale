// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const FORCELOG_BASE_URL = "https://api.forcelog.ma";
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type Integration = { api_key: string; key_last4: string; enabled: boolean };
type Access = { userId: string; workspaceId: string; canManage: boolean };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...corsHeaders, "Content-Type": "application/json" },
});

const clean = (value: unknown) => String(value ?? "").trim();
const normalize = (value: unknown) => clean(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[’'`-]/g, " ").replace(/\s+/g, " ");
const numberOrNull = (value: unknown) => {
  const parsed = Number(String(value ?? "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
};

function safeProviderResponse(input: any) {
  const parcel = input?.["ADD-PARCEL"]?.["NEW-PARCEL"] ?? input?.["NEW_PARCEL"] ?? input?.parcel ?? input?.data ?? {};
  return {
    result: input?.["ADD-PARCEL"]?.RESULT ?? input?.RESULT ?? input?.result ?? null,
    message: input?.["ADD-PARCEL"]?.MESSAGE ?? input?.MESSAGE ?? input?.message ?? null,
    tracking_number: parcel?.TRACKING_NUMBER ?? parcel?.["TRACKING-NUMBER"] ?? parcel?.tracking_number ?? input?.TRACKING_NUMBER ?? null,
    status: parcel?.STATUS ?? parcel?.status ?? input?.STATUS ?? input?.status ?? null,
    delivery_fees: parcel?.DELIVERY_FEES ?? parcel?.delivery_fees ?? input?.DELIVERY_FEES ?? null,
  };
}

function mapForceLogStatus(raw: unknown): string | null {
  const value = normalize(raw).replace(/\s+/g, "_").toUpperCase();
  const aliases: Record<string, string> = {
    NEW: "NEW_PARCEL", NEW_PARCEL: "NEW_PARCEL", NOUVEAU_COLIS: "NEW_PARCEL",
    WAITING_PICKUP: "WAITING_PICKUP", WAITING_FOR_PICKUP: "WAITING_PICKUP", EN_ATTENTE_DE_RAMASSAGE: "WAITING_PICKUP",
    PICKED_UP: "PICKED_UP", RAMASSE: "PICKED_UP", RAMASSÉ: "PICKED_UP",
    RECEIVED_AT_AGENCY: "RECEIVED_AT_AGENCY", RECU_EN_AGENCE: "RECEIVED_AT_AGENCY",
    IN_DISTRIBUTION: "IN_DISTRIBUTION", MISE_EN_DISTRIBUTION: "IN_DISTRIBUTION",
    OUT_FOR_DELIVERY: "OUT_FOR_DELIVERY", EN_COURS_DE_LIVRAISON: "OUT_FOR_DELIVERY",
    DELIVERED: "DELIVERED", LIVRE: "DELIVERED", LIVRÉ: "DELIVERED",
    REFUSED: "REFUSED", REFUSE: "REFUSED", REFUSÉ: "REFUSED",
    RETURNED: "RETURNED", RETURNED_TO_SENDER: "RETURNED", RETOURNE: "RETURNED", RETOURNÉ: "RETURNED",
    CANCELLED: "CANCELLED", CANCELED: "CANCELLED",
  };
  return aliases[value] ?? null;
}

async function authenticate(req: Request, service: any, workspaceId: string, needsManage = false): Promise<Access> {
  const token = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) throw new Error("Authentication is required.");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!anonKey) throw new Error("Function authentication is not configured.");
  const authClient = createClient(Deno.env.get("SUPABASE_URL")!, anonKey, { global: { headers: { Authorization: `Bearer ${token}` } } });
  const { data: { user }, error: authError } = await authClient.auth.getUser();
  if (authError || !user) throw new Error("Invalid or expired session.");

  const [{ data: workspace }, { data: membership }, { data: profile }] = await Promise.all([
    service.from("workspaces").select("id, created_by").eq("id", workspaceId).maybeSingle(),
    service.from("profile_workspaces").select("workspace_id").eq("workspace_id", workspaceId).eq("profile_id", user.id).maybeSingle(),
    service.from("profiles").select("role, allowed_sections").eq("id", user.id).maybeSingle(),
  ]);
  if (!workspace || (workspace.created_by !== user.id && !membership)) throw new Error("You do not have access to this workspace.");

  const role = clean(profile?.role).toLowerCase();
  const ownerLike = workspace.created_by === user.id || ["owner", "admin", "supervisor", "founder", "super_admin"].includes(role);
  const sections = Array.isArray(profile?.allowed_sections) ? profile.allowed_sections.map((item: unknown) => clean(item).toLowerCase()) : [];
  const canManage = ownerLike;
  if (needsManage && !canManage) throw new Error("Only workspace administrators can manage ForceLog credentials.");
  if (!needsManage && !ownerLike && sections.length > 0 && !sections.some((section: string) => ["shipping", "delivering", "orders"].includes(section))) {
    throw new Error("You do not have permission to manage shipments.");
  }
  return { userId: user.id, workspaceId, canManage };
}

async function integrationFor(service: any, workspaceId: string): Promise<Integration> {
  const { data, error } = await service.from("workspace_forcelog_integrations")
    .select("api_key, key_last4, enabled").eq("workspace_id", workspaceId).maybeSingle();
  if (error || !data?.enabled || !data.api_key) throw new Error("ForceLog API key is not configured for this workspace.");
  return data as Integration;
}

async function forceLogFetch(integration: Integration, path: string, init: RequestInit = {}) {
  const startedAt = Date.now();
  const response = await fetch(`${FORCELOG_BASE_URL}${path}`, {
    ...init,
    headers: { "X-API-Key": integration.api_key, ...(init.headers ?? {}) },
  });
  const text = await response.text();
  let data: any = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text.slice(0, 500) }; }
  return { response, data, duration: Date.now() - startedAt };
}

async function logAction(service: any, values: Record<string, unknown>) {
  const { error } = await service.from("shipping_logs").insert(values);
  if (error) console.error("[ForceLog] shipping log insert failed", { message: error.message });
}

async function refreshCities(service: any, integration: Integration, workspaceId: string) {
  const { response, data } = await forceLogFetch(integration, "/customer/Cities");
  if (!response.ok) throw new Error(`ForceLog rejected the city request (${response.status}).`);
  const rows = Object.entries(data ?? {}).map(([id, city]: [string, any]) => ({
    workspace_id: workspaceId,
    provider_city_id: Number(id ?? city?.ID),
    code: clean(city?.CODE),
    name: clean(city?.NAME),
    delivered_price: numberOrNull(city?.D_FEES),
    same_city_price: numberOrNull(city?.D_FEES_SAME_CITY),
    raw_data: { CODE: city?.CODE ?? null, NAME: city?.NAME ?? null, D_FEES: city?.D_FEES ?? null, D_FEES_SAME_CITY: city?.D_FEES_SAME_CITY ?? null },
    updated_at: new Date().toISOString(),
  })).filter(row => Number.isFinite(row.provider_city_id) && row.code && row.name);
  if (!rows.length) throw new Error("ForceLog returned no usable cities.");
  const { error } = await service.from("forcelog_cities").upsert(rows, { onConflict: "workspace_id,provider_city_id" });
  if (error) throw new Error("Could not cache ForceLog cities.");
  return rows;
}

async function resolveCity(service: any, integration: Integration, workspaceId: string, cityValue: string) {
  let { data: cities } = await service.from("forcelog_cities").select("provider_city_id, code, name, delivered_price, same_city_price").eq("workspace_id", workspaceId);
  if (!cities?.length) {
    await refreshCities(service, integration, workspaceId);
    const result = await service.from("forcelog_cities").select("provider_city_id, code, name, delivered_price, same_city_price").eq("workspace_id", workspaceId);
    cities = result.data;
  }
  if (!cities?.length) throw new Error("ForceLog city data is unavailable. Test the integration and try again.");
  const input = normalize(cityValue);
  const { data: mapping } = await service.from("city_arabic_names")
    .select("carrier_city_id").eq("carrier", "forcelog").ilike("arabic_name", cityValue.trim()).limit(2);
  if (mapping?.length === 1 && mapping[0].carrier_city_id) {
    const mapped = cities.find((city: any) => Number(city.provider_city_id) === Number(mapping[0].carrier_city_id));
    if (mapped) return mapped;
  }
  const exact = cities.filter((city: any) => normalize(city.name) === input || normalize(city.code) === input);
  if (exact.length === 1) return exact[0];
  const partial = cities.filter((city: any) => normalize(city.name).includes(input) || input.includes(normalize(city.name)));
  if (partial.length === 1) return partial[0];
  throw new Error(`Could not resolve "${cityValue}" to one ForceLog city. Select or correct the city before sending.`);
}

async function getOrder(service: any, workspaceId: string, orderId: string) {
  const { data, error } = await service.from("orders").select("*").eq("Order ID", orderId).eq("workspace_id", workspaceId).maybeSingle();
  if (error || !data) throw new Error("Order was not found in this workspace.");
  return data;
}

async function resolveReceiver(service: any, order: any) {
  const fromOrder = clean(order.customer_name || [order.first_name, order.last_name].filter(Boolean).join(" ") || order["Customer"]);
  if (fromOrder) return fromOrder;
  if (order.customer_id) {
    const { data } = await service.from("customers").select("name").eq("id", order.customer_id).maybeSingle();
    if (clean(data?.name)) return clean(data.name);
  }
  return "";
}

function validateParcel(input: Record<string, any>) {
  const rules: Array<[string, number, boolean]> = [["ORDER_NUM", 20, true], ["RECEIVER", 50, true], ["PHONE", 14, true], ["CITY", 50, true], ["ADDRESS", 100, true], ["COMMENT", 100, false], ["PRODUCT_NATURE", 100, false]];
  for (const [field, maxLength, required] of rules) {
    const value = clean(input[field]);
    if (required && !value) throw new Error(`${field.replaceAll("_", " ")} is required.`);
    if (value.length > maxLength) throw new Error(`${field.replaceAll("_", " ")} exceeds ForceLog's ${maxLength}-character limit.`);
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const body = await req.json().catch(() => ({}));
    const action = clean(body.action);
    const workspaceId = clean(body.workspace_id);
    if (!action || !workspaceId) return json({ success: false, code: "INVALID_REQUEST", message: "action and workspace_id are required." }, 400);
    const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const adminAction = ["status", "set-credentials", "disconnect", "test-connection"].includes(action);
    const access = await authenticate(req, service, workspaceId, adminAction);

    if (action === "status") {
      const { data } = await service.from("workspace_forcelog_integrations").select("enabled, key_last4, last_tested_at, last_test_status").eq("workspace_id", workspaceId).maybeSingle();
      return json({ success: true, connected: Boolean(data?.enabled), key_last4: data?.key_last4 ?? null, last_tested_at: data?.last_tested_at ?? null, last_test_status: data?.last_test_status ?? null });
    }
    if (action === "set-credentials") {
      const apiKey = clean(body.api_key);
      if (apiKey.length < 8) return json({ success: false, code: "INVALID_API_KEY", message: "Enter a valid ForceLog API key." }, 400);
      const { error } = await service.from("workspace_forcelog_integrations").upsert({ workspace_id: workspaceId, api_key: apiKey, key_last4: apiKey.slice(-4), enabled: true, last_test_status: null, updated_at: new Date().toISOString() }, { onConflict: "workspace_id" });
      if (error) throw new Error("Could not save ForceLog credentials.");
      return json({ success: true, connected: true, key_last4: apiKey.slice(-4) });
    }
    if (action === "disconnect") {
      const { error } = await service.from("workspace_forcelog_integrations").delete().eq("workspace_id", workspaceId);
      if (error) throw new Error("Could not disconnect ForceLog.");
      return json({ success: true, connected: false });
    }

    const integration = await integrationFor(service, workspaceId);
    if (action === "test-connection") {
      const { response, data } = await forceLogFetch(integration, "/customer/Cities");
      const success = response.ok && Object.keys(data ?? {}).length > 0;
      await service.from("workspace_forcelog_integrations").update({ last_tested_at: new Date().toISOString(), last_test_status: success ? "connected" : `http_${response.status}`, updated_at: new Date().toISOString() }).eq("workspace_id", workspaceId);
      return json(success ? { success: true, message: "Connected successfully." } : { success: false, code: "CONNECTION_FAILED", message: data?.message || `ForceLog connection failed (${response.status}).` }, success ? 200 : 400);
    }
    if (action === "cities") {
      const cities = await refreshCities(service, integration, workspaceId);
      return json({ success: true, cities: cities.map(({ api_key: _ignored, raw_data, ...city }) => city) });
    }
    if (action === "create-parcel") {
      const orderId = clean(body.order_id);
      if (!orderId) return json({ success: false, code: "INVALID_REQUEST", message: "order_id is required." }, 400);
      const order = await getOrder(service, workspaceId, orderId);
      if (order.shipping_provider === "forcelog" && clean(order.tracking_number)) return json({ success: false, code: "PARCEL_EXISTS", message: "Parcel already exists for this order.", tracking_number: order.tracking_number }, 409);
      const receiver = await resolveReceiver(service, order);
      const phone = clean(order.phone).replace(/\s+/g, "");
      const city = await resolveCity(service, integration, workspaceId, clean(order.city || order.city_name || order.raw_city));
      const payload = {
        ORDER_NUM: clean(order.order_number), RECEIVER: receiver, PHONE: phone, CITY: clean(city.code), ADDRESS: clean(order.address),
        COMMENT: clean(order.notes).slice(0, 100), PRODUCT_NATURE: clean(order.product_name || order.product || order.product_variant || order.sku || "Commande").slice(0, 100),
        COD: Number(order.cod_amount ?? order.total_price ?? order.total ?? 0),
      };
      validateParcel(payload);
      const { response, data, duration } = await forceLogFetch(integration, "/customer/Parcels/AddParcel", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const provider = safeProviderResponse(data);
      const trackingNumber = clean(provider.tracking_number);
      const success = response.ok && clean(provider.result).toUpperCase() === "SUCCESS" && trackingNumber;
      await logAction(service, { workspace_id: workspaceId, provider: "forcelog", order_id: orderId, order_number: order.order_number, action: "create-parcel", request_payload: { order_id: orderId, order_number: order.order_number, city_code: city.code }, response_payload: provider, http_status: response.status, error: success ? null : clean(provider.message) || `HTTP ${response.status}` });
      if (!success) return json({ success: false, provider: "forcelog", code: "PARCEL_REJECTED", message: clean(provider.message) || "ForceLog did not return a tracking number." }, 400);
      const { data: saved, error } = await service.from("orders").update({ tracking_number: trackingNumber, shipment_id: trackingNumber, shipment_status: clean(provider.status) || "NEW_PARCEL", shipping_provider: "forcelog", shipping_company: "forcelog", shipping_status: mapForceLogStatus(provider.status) || "NEW_PARCEL", parcel_created_at: new Date().toISOString(), shipping_status_raw: provider, shipping_updated_at: new Date().toISOString(), last_tracking_sync: new Date().toISOString(), shipping_cost: numberOrNull(provider.delivery_fees) ?? city.delivered_price ?? order.shipping_cost }).eq("Order ID", orderId).eq("workspace_id", workspaceId).select('"Order ID", tracking_number, shipping_status, shipping_provider').maybeSingle();
      if (error || !saved) throw new Error(`ForceLog created parcel ${trackingNumber}, but Ecom OS could not save it. Do not resend; contact support with this tracking number.`);
      console.log("[ForceLog] parcel created", { workspaceId, orderId, orderNumber: order.order_number, trackingNumber, duration });
      return json({ success: true, provider: "forcelog", tracking_number: trackingNumber, order: saved });
    }
    if (action === "tracking" || action === "get-parcel") {
      const order = await getOrder(service, workspaceId, clean(body.order_id));
      const trackingNumber = clean(order.tracking_number);
      if (!trackingNumber || order.shipping_provider !== "forcelog") return json({ success: false, code: "NO_FORCELOG_PARCEL", message: "This order has no ForceLog parcel." }, 400);
      const endpoint = action === "tracking" ? `/customer/Parcels/GetTracking?Code=${encodeURIComponent(trackingNumber)}` : `/customer/Parcels/GetParcel?Code=${encodeURIComponent(trackingNumber)}`;
      const { response, data } = await forceLogFetch(integration, endpoint);
      if (!response.ok) return json({ success: false, code: "PROVIDER_ERROR", message: data?.message || `ForceLog request failed (${response.status}).` }, 400);
      const provider = safeProviderResponse(data);
      const rawStatus = provider.status ?? data?.TRACKING?.LAST_TRACKING?.STATUS ?? data?.data?.status;
      const mappedStatus = mapForceLogStatus(rawStatus);
      if (action === "tracking" && mappedStatus) {
        const { error } = await service.from("orders").update({ shipping_status: mappedStatus, shipment_status: clean(rawStatus) || order.shipment_status, shipping_status_raw: provider, shipping_updated_at: new Date().toISOString(), last_tracking_sync: new Date().toISOString(), shipping_cost: numberOrNull(provider.delivery_fees) ?? order.shipping_cost }).eq("Order ID", order["Order ID"]).eq("workspace_id", workspaceId);
        if (error) throw new Error("Could not save the ForceLog tracking update.");
      }
      return json({ success: true, provider: "forcelog", tracking_number: trackingNumber, shipping_status: mappedStatus ?? order.shipping_status, data: provider });
    }
    if (action === "label" || action === "sticker") {
      const order = await getOrder(service, workspaceId, clean(body.order_id));
      const trackingNumber = clean(order.tracking_number);
      if (!trackingNumber || order.shipping_provider !== "forcelog") return json({ success: false, code: "NO_FORCELOG_PARCEL", message: "This order has no ForceLog parcel." }, 400);
      const endpoint = action === "label" ? `/customer/Parcels/GetParcelLabel?Code=${encodeURIComponent(trackingNumber)}` : `/customer/PDF/ParcelSticker?parcelCode=${encodeURIComponent(trackingNumber)}`;
      const response = await fetch(`${FORCELOG_BASE_URL}${endpoint}`, { headers: { "X-API-Key": integration.api_key } });
      if (!response.ok) return json({ success: false, code: "LABEL_FAILED", message: `ForceLog could not generate the label (${response.status}).` }, 400);
      return new Response(await response.arrayBuffer(), { headers: { ...corsHeaders, "Content-Type": response.headers.get("content-type") || "application/pdf", "Content-Disposition": `inline; filename="forcelog-${trackingNumber}.pdf"` } });
    }
    return json({ success: false, code: "INVALID_ACTION", message: "Unsupported ForceLog action." }, 400);
  } catch (error: any) {
    console.error("[ForceLog] request failed", { message: error?.message });
    return json({ success: false, provider: "forcelog", code: "FORCELOG_ERROR", message: clean(error?.message) || "ForceLog request failed." }, 400);
  }
});
