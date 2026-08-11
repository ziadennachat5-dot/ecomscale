import {
  Inbox,
  Phone,
  RefreshCw,
  CheckCircle2,
  ChevronDown,
  MessageCircle,
  MapPin,
  User,
  Clock,
  AlertCircle,
  Save,
} from "lucide-react";
import { useState, useRef, useMemo } from "react";
import { PageHeader } from "../components/PageHeader";
import { EmptyState } from "../components/EmptyState";
import { toast } from "../components/Toast";
import { useConfirmationFilter, TAB_CONFIG } from "../hooks/useConfirmationFilter";
import { useAuth } from "../hooks/useAuth";
import { StatusBadge } from "../components/StatusBadge";
import { StatusSelect } from "../components/StatusSelect";
import { normalizeStatus, getStatusLabel, type CanonicalStatus, type StatusLanguage } from "../lib/statusEngine";
import { formatOzonAddress } from "../services/ozonService";
import { supabase } from "../lib/supabase";
import { useGlobalOrders } from "../contexts/OrdersContext";


// ─── Helpers ─────────────────────────────────────────────────────────────────

function mad(n: number) {
  return `${Number(n).toLocaleString("fr-MA", { maximumFractionDigits: 0 })} MAD`;
}

function isConfirmedOrderStatus(status: string) {
  return normalizeStatus(status) === 'confirmed';
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function Confirmation() {
  const { globalOrders: orders, loading, reloadGlobalOrders: reload } = useGlobalOrders();
  const { workspace } = useAuth();
  const language: StatusLanguage = (workspace?.status_language as StatusLanguage) || 'en';

  const { activeTab, setActiveTab } = useConfirmationFilter();

  const [draftStatus, setDraftStatus] = useState<Record<string, string>>({});
  const [draftAddress, setDraftAddress] = useState<Record<string, string>>({});
  const [savingOrders, setSavingOrders] = useState<Record<string, boolean>>({});
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [expandedOrder, setExpandedOrder] = useState<string | null>(null);
  const dismissTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const handleDraftChange = (orderNumber: string, newStatus: string) => {
    setDraftStatus(prev => ({ ...prev, [orderNumber]: newStatus }));
  };

  const handleAddressChange = (orderNumber: string, newAddress: string) => {
    setDraftAddress(prev => ({ ...prev, [orderNumber]: newAddress }));
  };

  const isMissingAddressColumnError = (error: { message?: string } | null | undefined) => {
    return Boolean(error?.message && /address/i.test(error.message) && /(schema cache|column)/i.test(error.message));
  };

  const updateOrderSafely = async (orderId: string, workspaceId: string, payload: Record<string, unknown>) => {
    const { data, error } = await supabase
      .from("orders")
      .update(payload)
      .eq("Order ID", orderId)
      .eq("workspace_id", workspaceId)
      .select('"Order ID", order_number, status, address, confirmed_at, cancelled_at')
      .maybeSingle();

    if (!error && data) return data;
    if (!error) throw new Error("This order no longer exists in the current workspace. Nothing was saved.");

    if (isMissingAddressColumnError(error)) {
      const fallbackPayload: Record<string, unknown> = {};
      if ("status" in payload) fallbackPayload.status = payload.status;
      if ("confirmed_at" in payload) fallbackPayload.confirmed_at = payload.confirmed_at;
      if ("cancelled_at" in payload) fallbackPayload.cancelled_at = payload.cancelled_at;

      const { data: fallbackData, error: fallbackError } = await supabase
        .from("orders")
        .update(fallbackPayload)
        .eq("Order ID", orderId)
        .eq("workspace_id", workspaceId)
        .select('"Order ID", order_number, status, confirmed_at, cancelled_at')
        .maybeSingle();

      if (fallbackError) throw fallbackError;
      if (!fallbackData) throw new Error("This order no longer exists in the current workspace. Nothing was saved.");
      return fallbackData;
    }

    throw error;
  };

  const displayStatus = (o: any): string => {
    if (draftStatus[o.order_number]) return draftStatus[o.order_number];
    return normalizeStatus(o.status);
  };

  const handleSave = async (o: any) => {
    const orderNumber = o.order_number as string;
    const status = normalizeStatus(displayStatus(o));

    if (savingOrders[orderNumber]) return;
    setSavingOrders(prev => ({ ...prev, [orderNumber]: true }));

    try {
      const nowStr = new Date().toISOString();
      const payload: Record<string, unknown> = { status };
      const addressValue = draftAddress[orderNumber] ?? (o.address ?? "");

      // Enforce minimum address length for confirmed orders (for Ozon & delivery compatibility)
      if (status === "confirmed") {
        const fullAddress = formatOzonAddress(addressValue, o.city);
        if (!fullAddress || fullAddress.length < 5) {
          toast.error(`Impossible de confirmer la commande #${orderNumber}: l'adresse est trop courte (minimum 5 caractères requis). Veuillez la compléter.`);
          setSavingOrders(prev => ({ ...prev, [orderNumber]: false }));
          return;
        }
      }

      if (addressValue !== undefined) payload.address = addressValue || null;
      if (status === "confirmed") payload.confirmed_at = nowStr;
      if (status === "cancelled") payload.cancelled_at = nowStr;

      // Optimistic UI update - update local state immediately
      const oldStatus = o.status;
      setDraftStatus(prev => {
        const next = { ...prev };
        delete next[orderNumber];
        return next;
      });
      setDraftAddress(prev => {
        const next = { ...prev };
        delete next[orderNumber];
        return next;
      });

      try {
        const orderId = o.id ?? o["Order ID"];
        if (!orderId || !workspace?.id) throw new Error("Order identity or workspace is missing.");
        await updateOrderSafely(orderId, workspace.id, payload);
        await reload(true);
        toast.success(`Order ${orderNumber} successfully saved ✓`);
      } catch (err: any) {
        // Rollback on error
        toast.error(`Error : ${err.message ?? "Unable to save."}`);
        setDraftStatus(prev => ({ ...prev, [orderNumber]: displayStatus(o) }));
        return;
      }

      const tabConfig = TAB_CONFIG.find(t => t.id === activeTab);
      const stillMatches =
        !tabConfig ||
        tabConfig.canonicalIds.length === 0 ||
        tabConfig.canonicalIds.includes(status);

      if (!stillMatches) {
        setDismissed(prev => new Set(prev).add(orderNumber));
        dismissTimers.current[orderNumber] = setTimeout(() => {
          setDismissed(prev => {
            const next = new Set(prev);
            next.delete(orderNumber);
            return next;
          });
          reload();
        }, 450);
      }
    } finally {
      setSavingOrders(prev => ({ ...prev, [orderNumber]: false }));
    }
  };

  const filteredOrders = useMemo(() => {
    const tabConfig = TAB_CONFIG.find(t => t.id === activeTab);
    if (!tabConfig || tabConfig.canonicalIds.length === 0) return orders;
    return orders.filter((o) => tabConfig.canonicalIds.includes(normalizeStatus(o.status)));
  }, [orders, activeTab]);

  const tabCount = useMemo(() => {
    const counts: Record<string, number> = {};
    TAB_CONFIG.forEach(tab => {
      if (!tab.canonicalIds.length) {
        counts[tab.id] = orders.length;
      } else {
        counts[tab.id] = orders.filter(o => tab.canonicalIds.includes(normalizeStatus(o.status))).length;
      }
    });
    return (tabId: string) => counts[tabId] || 0;
  }, [orders]);

  // ─── Render ─────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full">

      <PageHeader
        title="Confirmation CRM"
        subtitle="Manage and confirm COD orders efficiently."
      />

      <div
        className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1"
        style={{ scrollbarWidth: "none" }}
      >
        {TAB_CONFIG.map((tab) => {
          const isActive = activeTab === tab.id;
          const count = tabCount(tab.id);
          let label: string;
          if (tab.id === 'all') {
            label = language === 'fr' ? 'Tous' : 'All';
          } else {
            label = getStatusLabel(tab.canonicalIds[0] as CanonicalStatus, language);
          }

          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`
                shrink-0 flex items-center gap-2 px-4 py-2 rounded-lg border text-[12.5px] font-medium transition-all
                ${isActive
                  ? 'bg-brand text-white border-brand shadow-sm'
                  : 'bg-base-surface border-base-border text-ink-muted hover:border-brand/30 hover:text-ink'
                }
              `}
            >
              {label}
              {count > 0 && (
                <span className={`
                  px-1.5 py-0.5 rounded-md text-[11px] font-semibold
                  ${isActive ? 'bg-white/20' : 'bg-base-raised text-ink-muted'}
                `}
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="flex-1 min-h-0">
        {loading && orders.length === 0 ? (
          <div className="flex flex-col gap-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className="h-[140px] rounded-xl bg-base-surface border border-base-border animate-pulse"
              />
            ))}
          </div>
        ) : filteredOrders.length === 0 ? (
          <div className="bg-base-surface border border-base-border rounded-xl">
            <EmptyState
              icon={<Inbox size={20} />}
              title={`No orders — "${activeTab}"`}
              subtitle="Statuses will update here as they are processed."
            />
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {filteredOrders.map((o: any) => {
              const orderNumber = o.order_number as string;
              const customerName = o.customer?.name ?? o.customer_name ?? "—";
              const phone = o.phone ?? o.customer?.phone ?? "—";
              const city = o.city ?? "—";
              const dateStr = new Date(o.created_at).toLocaleDateString("en-US", {
                month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
              });

              // ─── Formatting WhatsApp Link ──────────────────────────────
              const cleanPhone = phone.replace(/\D/g, "");
              const waPhone = cleanPhone.startsWith("0") ? "212" + cleanPhone.substring(1) : cleanPhone;
              const waMessage = encodeURIComponent("Hello, we are trying to reach you to confirm your order. Please reply to this message.");
              // ───────────────────────────────────────────────────────────

              const currentStatus = displayStatus(o);
              const currentAddress = draftAddress[orderNumber] ?? (o.address ?? "");
              const isDirty = currentStatus !== o.status || draftAddress[orderNumber] !== (o.address ?? "");
              const isSaving = savingOrders[orderNumber] ?? false;
              const isDismissing = dismissed.has(orderNumber);
              const isExpanded = expandedOrder === orderNumber;
              
              return (
                <div
                  key={orderNumber}
                  id={`order-row-${orderNumber}`}
                  style={{
                    transition: "opacity 400ms ease, transform 400ms ease",
                    opacity: isDismissing ? 0 : 1,
                    transform: isDismissing ? "translateX(24px)" : "translateX(0)",
                    pointerEvents: isDismissing ? "none" : undefined,
                  }}
                  className="
                    group relative overflow-hidden rounded-xl border border-base-border bg-base-surface
                    hover:border-brand-accent/30 hover:bg-base-raised/30
                    shadow-sm transition-all duration-200
                  "
                >
                  {/* Header Row - Always Visible */}
                  <div className="p-4 border-b border-base-border/50">
                    <div className="flex items-start justify-between gap-4">
                      {/* Left: Order Info */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-3 mb-2">
                          <span className="font-mono font-bold text-[14px] text-ink tracking-tight">
                            #{orderNumber}
                          </span>
                          <StatusBadge status={o.tracking_number && o.tracking_number.trim() !== "" ? o.shipping_status : o.status} size="sm" />
                          {isDirty && (
                            <span className="flex items-center gap-1 text-[11px] text-amber-600 font-medium bg-amber-500/10 px-2 py-0.5 rounded-full">
                              <AlertCircle size={11} />
                              Unsaved
                            </span>
                          )}
                        </div>
                        
                        <div className="flex items-center gap-3 text-[13px]">
                          <div className="flex items-center gap-1.5 text-ink font-medium">
                            <User size={14} className="text-ink-muted" />
                            {customerName}
                          </div>
                          <div className="flex items-center gap-1.5 text-ink-muted">
                            <Phone size={14} />
                            {phone}
                          </div>
                          <div className="flex items-center gap-1.5 text-ink-muted">
                            <MapPin size={14} />
                            {city}
                          </div>
                        </div>
                      </div>

                      {/* Right: Quick Actions */}
                      <div className="flex items-center gap-2 shrink-0">
                        <a
                          href={phone !== "—" ? `tel:${phone}` : undefined}
                          className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-sky-500/10 border border-sky-500/20 text-sky-500 hover:bg-sky-500/20 hover:border-sky-500/30 text-[12.5px] font-semibold transition-all"
                        >
                          <Phone size={13} />
                          Call
                        </a>
                        <a
                          href={phone !== "—" ? `https://wa.me/${waPhone}?text=${waMessage}` : undefined}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-brand-accent/10 border border-brand-accent/20 text-brand-accent hover:bg-brand-accent/20 hover:border-brand-accent/30 text-[12.5px] font-semibold transition-all"
                        >
                          <MessageCircle size={13} />
                          WhatsApp
                        </a>
                        <button
                          onClick={() => setExpandedOrder(isExpanded ? null : orderNumber)}
                          className="p-2 rounded-lg hover:bg-base-raised text-ink-muted transition-colors"
                        >
                          <ChevronDown size={16} className={`transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Expanded Content - Order Details */}
                  {isExpanded && (
                    <div className="p-4 border-b border-base-border/50 bg-base-raised/30">
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                        <div className="space-y-1">
                          <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Order Amount</div>
                          <div className="text-[15px] font-bold text-brand-accent">{mad(o.total)}</div>
                        </div>
                        <div className="space-y-1">
                          <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Product</div>
                          <div className="text-[13px] text-ink">{o.product_variant || o.sku || "—"}</div>
                        </div>
                        <div className="space-y-1">
                          <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Order Date</div>
                          <div className="text-[13px] text-ink flex items-center gap-1">
                            <Clock size={12} />
                            {dateStr}
                          </div>
                        </div>
                        <div className="space-y-1">
                          <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Tags</div>
                          <div className="flex flex-wrap gap-1">
                            {o.product_variant && (
                              <span className="text-[11px] px-2 py-0.5 rounded-md bg-brand/10 text-brand border border-brand/20">
                                {o.product_variant}
                              </span>
                            )}
                            {o.sku && (
                              <span className="text-[11px] px-2 py-0.5 rounded-md bg-base-border/30 text-ink-muted">
                                {o.sku}
                              </span>
                            )}
                            {!o.product_variant && !o.sku && (
                              <span className="text-[11px] text-ink-muted italic">No tags</span>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Action Row - Status, Address, Save */}
                  <div className="p-4">
                    <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
                      {/* Status Select */}
                      <div className="md:col-span-3 space-y-1.5">
                        <label className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Confirmation Status</label>
                        <StatusSelect
                          value={currentStatus}
                          onChange={(val) => handleDraftChange(orderNumber, val)}
                          language={language}
                          className={`
                            appearance-none w-full rounded-lg px-3 py-2.5
                            text-[13px] font-semibold cursor-pointer
                            outline-none transition-all
                            ${isDirty ? "!border-red-500/60 shadow-[0_0_10px_rgba(239,68,68,0.4)]" : ""}
                          `}
                        />
                      </div>

                      {/* Address Input */}
                      <div className="md:col-span-6 space-y-1.5">
                        <label className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Delivery Address</label>
                        <textarea
                          value={currentAddress}
                          onChange={(e) => handleAddressChange(orderNumber, e.target.value)}
                          rows={2}
                          className="w-full rounded-lg border border-base-border bg-base-raised px-3 py-2 text-[13px] text-ink focus:border-brand-accent/50 focus:ring-2 focus:ring-brand-accent/10 outline-none transition-all resize-none"
                          placeholder="Enter delivery address (city + full address)"
                        />
                      </div>

                      {/* Save Button */}
                      <div className="md:col-span-3 flex items-end">
                        <button
                          id={`btn-save-${orderNumber}`}
                          onClick={() => handleSave(o)}
                          disabled={isSaving}
                          className={`
                            w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg
                            text-[13px] font-semibold border transition-all duration-200
                            disabled:opacity-60 disabled:cursor-not-allowed
                            ${isDirty ? 'bg-brand text-white border-brand hover:bg-brand/90 shadow-sm' : 'bg-base-raised text-ink border-base-border hover:bg-base-border hover:border-brand/30'}
                          `}
                        >
                          {isSaving ? (
                            <>
                              <RefreshCw size={13} className="animate-spin" />
                              Saving…
                            </>
                          ) : (
                            <>
                              <Save size={13} />
                              Save Changes
                            </>
                          )}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
