"use client";

import { useState, useEffect, useCallback, use } from "react";
import Link from "next/link";
import { ArrowLeft, Flame, Loader2, AlertTriangle, Link2, Unlink } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { useUser } from "@/app/dashboard/user-context";
import { hasSubPrivilege } from "@/lib/auth-shared";
import { formatDate } from "@/lib/utils";
import { ProductionStatusBadge, ProgressBar, type ProductionProgress } from "../shared";

type LinkedBatch = {
  id: string; batchNumber: string; status: string; isBlend: boolean;
  greenBeanQuantity: number; roastedBeanQuantity: number; wasteQuantity: number;
  roastedAvailableKg: number; date: string; packedUnits: number;
  greenBean: { id: string; serialNumber: string; beanType: string } | null;
};

type Detail = {
  id: string; productionNumber: string; status: string;
  targetUnits: number; targetWeightKg: number; expectedGreenBeanKg: number;
  createdAt: string; updatedAt: string;
  productSku: {
    id: string; skuCode: string; name: string; weightGrams: number;
    product: { id: string; productNameEn: string; countryEn: string | null; expectedRoastLoss: number };
  };
  greenBean: { id: string; serialNumber: string; beanType: string; quantityKg: number } | null;
  sourceOrderItem: {
    id: string; quantityUnits: number | null; deliveredUnits: number; preparationDecision: string | null;
    order: { id: string; orderNumber: number; status: string; customer: { id: string; name: string } | null };
  } | null;
  roastingBatches: LinkedBatch[];
  progress: ProductionProgress;
  allowedActions: string[];
};

type CandidateBatch = {
  id: string; batchNumber: string; status: string; isBlend: boolean;
  roastedBeanQuantity: number; productionOrderId: string | null; productId: string | null;
  orderItem: { productSku: { productId: string } | null } | null;
};

const Figure = ({ label, value, hint }: { label: string; value: string; hint?: string }) => (
  <div className="bg-white rounded-xl border border-border px-4 py-3">
    <p className="text-[11px] font-bold uppercase tracking-wide text-brown/60">{label}</p>
    <p className="text-lg font-extrabold text-charcoal tabular-nums mt-0.5">{value}</p>
    {hint && <p className="text-[11px] text-brown/60 mt-0.5">{hint}</p>}
  </div>
);

export default function ProductionOrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { t } = useI18n();
  const user = useUser();
  const canRun = hasSubPrivilege(user?.permissions ?? {}, "production", "start_batch");
  const canCancel = hasSubPrivilege(user?.permissions ?? {}, "production", "cancel_batch");

  const [order, setOrder] = useState<Detail | null>(null);
  const [candidates, setCandidates] = useState<CandidateBatch[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const [showCancel, setShowCancel] = useState(false);
  const [pickBatch, setPickBatch] = useState("");

  // Refreshing after an action deliberately does not raise the page-level spinner: the
  // button's own busy state already says what is happening, and blanking the record the
  // operator is reading would lose their place.
  const load = useCallback(async () => {
    // Both requests go out together. Fetching the batch list after the detail made every
    // action wait on it: the roasting-batch endpoint returns up to 500 rows with nested
    // QC and blend records, so the status would visibly update while every button stayed
    // disabled behind the second round trip.
    const [detailRes, batchRes] = await Promise.all([
      fetch(`/api/production-orders/${id}`),
      fetch("/api/roasting-batches?statuses=Pending QC,Passed,Partially Packaged,Packaged"),
    ]);

    const data = detailRes.ok ? await detailRes.json() : null;
    setOrder(data);

    if (!data) { setCandidates([]); return; }

    // Candidates are narrowed client-side purely as a convenience for the operator. The
    // server re-checks every one of these rules on link, and it is the enforcement.
    const all: CandidateBatch[] = batchRes.ok ? await batchRes.json() : [];
    const wanted = data.productSku.product.id;
    setCandidates(
      all.filter((b) => {
        if (b.productionOrderId !== null || b.isBlend || b.status === "Rejected") return false;
        const pid = b.productId ?? b.orderItem?.productSku?.productId ?? null;
        return pid === wanted;
      })
    );
  }, [id]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await load();
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [load]);

  async function act(action: string, reason?: string) {
    setBusy(action); setError(null);
    try {
      const res = await fetch(`/api/production-orders/${id}/status`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, reason }),
      });
      if (!res.ok) { setError((await res.json())?.error ?? "Action failed."); return; }
      setShowCancel(false); setCancelReason("");
      await load();
    } finally { setBusy(null); }
  }

  async function linkBatch(batchId: string, unlink = false) {
    setBusy(batchId); setError(null);
    try {
      const res = await fetch(`/api/production-orders/${id}/batches`, {
        method: unlink ? "DELETE" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roastingBatchId: batchId }),
      });
      if (!res.ok) { setError((await res.json())?.error ?? "Action failed."); return; }
      setPickBatch("");
      await load();
    } finally { setBusy(null); }
  }

  if (loading) {
    return <div className="text-center py-16 text-muted-foreground"><Loader2 size={28} className="mx-auto animate-spin" /></div>;
  }
  if (!order) {
    return (
      <div className="space-y-4">
        <Link href="/dashboard/production-orders" className="text-sm text-orange font-bold flex items-center gap-1.5">
          <ArrowLeft size={15} /> {t("poBackToList")}
        </Link>
        <p className="text-muted-foreground">{t("poNone")}</p>
      </div>
    );
  }

  const p = order.progress;
  const canAct = (a: string) => order.allowedActions.includes(a) && (a === "cancel" ? canCancel : canRun);

  return (
    <div className="space-y-6">
      <Link href="/dashboard/production-orders" className="text-sm text-orange font-bold flex items-center gap-1.5 w-fit">
        <ArrowLeft size={15} /> {t("poBackToList")}
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-2xl font-extrabold text-charcoal">{order.productionNumber}</h1>
            <ProductionStatusBadge status={order.status} />
          </div>
          <p className="text-brown text-sm font-medium mt-0.5">
            {order.productSku.skuCode} — {order.productSku.name} · {order.productSku.product.productNameEn}
          </p>
          {order.sourceOrderItem && (
            <p className="text-sm text-brown/70 mt-0.5">
              {t("poDemandSource")}:{" "}
              <Link href="/dashboard/workstation/preparation" className="text-orange font-semibold hover:underline">
                #{order.sourceOrderItem.order.orderNumber}
              </Link>{" "}
              — {order.sourceOrderItem.order.customer?.name} ({order.sourceOrderItem.order.status})
            </p>
          )}
          <p className="text-xs text-brown/60 mt-0.5">{t("poCreatedAt")}: {formatDate(order.createdAt)}</p>
        </div>

        <div className="flex flex-wrap gap-2">
          {canAct("release") && (
            <button onClick={() => act("release")} disabled={busy !== null}
              className="px-4 py-2 bg-orange text-white rounded-lg text-sm font-bold hover:bg-orange-dark disabled:opacity-50 transition-colors">
              {busy === "release" ? <Loader2 size={15} className="animate-spin" /> : t("poRelease")}
            </button>
          )}
          {canAct("complete") && (
            <button onClick={() => act("complete")} disabled={busy !== null}
              className="px-4 py-2 bg-success text-white rounded-lg text-sm font-bold hover:opacity-90 disabled:opacity-50 transition-colors">
              {busy === "complete" ? <Loader2 size={15} className="animate-spin" /> : t("poComplete")}
            </button>
          )}
          {canAct("cancel") && (
            <button onClick={() => setShowCancel((v) => !v)} disabled={busy !== null}
              className="px-4 py-2 bg-white border-2 border-border text-brown rounded-lg text-sm font-bold hover:border-oo-status-blocked/50 disabled:opacity-50 transition-colors">
              {t("poCancel")}
            </button>
          )}
          {order.allowedActions.length === 0 && (
            <p className="text-xs text-brown/60 max-w-[220px]">{t("poNoActions")}</p>
          )}
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2 bg-oo-status-blocked-bg border border-oo-status-blocked/30 rounded-xl p-3">
          <AlertTriangle size={16} className="text-oo-status-blocked shrink-0 mt-0.5" />
          <p className="text-sm text-oo-status-blocked font-semibold">{error}</p>
        </div>
      )}

      {showCancel && (
        <div className="bg-white rounded-2xl border border-border p-4 space-y-3">
          <p className="text-xs text-brown/70">{t("poCancelKeepsStock")}</p>
          <input
            value={cancelReason}
            onChange={(e) => setCancelReason(e.target.value)}
            placeholder={t("poCancelReason")}
            className="w-full px-3 py-2 border-2 border-border rounded-xl bg-white focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors text-sm"
          />
          <button
            onClick={() => act("cancel", cancelReason)}
            disabled={busy !== null || cancelReason.trim().length === 0}
            className="px-4 py-2 bg-oo-status-blocked text-white rounded-lg text-sm font-bold disabled:opacity-40 transition-opacity"
          >
            {busy === "cancel" ? <Loader2 size={15} className="animate-spin" /> : t("poCancel")}
          </button>
        </div>
      )}

      {/* Plan versus actual. The left column is what was planned when the order was
          raised; the right is what the roaster actually did. */}
      <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
        <Figure label={t("poRequired")} value={`${order.targetUnits}`} hint={`${order.targetWeightKg} kg ${t("poTargetWeight").toLowerCase()}`} />
        {/* "Batches: 1" rather than "1 batches" — the label-and-count form reads correctly
            without needing plural rules in two languages. */}
        <Figure label={t("poProduced")} value={`${p.producedUnits}`} hint={`${t("poBatches")}: ${p.batchCount}`} />
        <Figure label={t("poRemaining")} value={`${p.remainingUnits}`} hint={`${p.remainingKg} kg`} />
        <Figure label={t("poPlannedGreen")} value={`${order.expectedGreenBeanKg} kg`} hint={`${order.productSku.product.expectedRoastLoss}% loss`} />
        <Figure label={t("poActualGreen")} value={`${p.greenConsumedKg} kg`} />
        <Figure label={t("poActualRoasted")} value={`${p.roastedOutputKg} kg`} />
        <div className="bg-white rounded-xl border border-border px-4 py-3 col-span-2">
          <p className="text-[11px] font-bold uppercase tracking-wide text-brown/60 mb-2">{t("poProgressLabel")}</p>
          <ProgressBar produced={p.producedUnits} target={order.targetUnits} />
        </div>
      </div>

      {/* Linked batches */}
      <div>
        <h2 className="font-semibold text-charcoal mb-3">{t("poBatches")}</h2>
        {order.roastingBatches.length === 0 ? (
          <div className="text-center py-8 bg-white rounded-2xl border border-border text-muted-foreground">
            <Flame size={28} className="mx-auto mb-2" />
            <p className="text-sm">{t("poNoBatches")}</p>
          </div>
        ) : (
          <div className="bg-white rounded-2xl border border-border overflow-x-auto">
            <table className="w-full text-sm min-w-[680px]">
              <thead className="bg-cream">
                <tr>
                  <th className="text-start px-4 py-3 font-semibold">{t("poBatches")}</th>
                  <th className="text-start px-4 py-3 font-semibold">{t("poStatus")}</th>
                  <th className="text-end px-4 py-3 font-semibold">{t("poActualGreen")}</th>
                  <th className="text-end px-4 py-3 font-semibold">{t("poActualRoasted")}</th>
                  <th className="text-end px-4 py-3 font-semibold">{t("poPackedUnits")}</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {order.roastingBatches.map((b) => (
                  <tr key={b.id} className="border-t border-border">
                    <td className="px-4 py-3">
                      <p className="font-semibold">{b.batchNumber}</p>
                      <p className="text-xs text-brown/70">{b.greenBean?.beanType ?? "—"} · {formatDate(b.date)}</p>
                    </td>
                    <td className="px-4 py-3 text-xs">{b.status}</td>
                    <td className="px-4 py-3 text-end tabular-nums">{b.greenBeanQuantity} kg</td>
                    <td className="px-4 py-3 text-end tabular-nums">{b.roastedBeanQuantity} kg</td>
                    <td className="px-4 py-3 text-end tabular-nums font-semibold">{b.packedUnits}</td>
                    <td className="px-4 py-3 text-end">
                      {canRun && order.allowedActions.length > 0 && b.packedUnits === 0 && (
                        <button
                          onClick={() => linkBatch(b.id, true)}
                          disabled={busy !== null}
                          className="px-2.5 py-1.5 rounded-lg text-xs font-bold border-2 border-border text-brown hover:border-oo-status-blocked/50 disabled:opacity-40 inline-flex items-center gap-1.5 transition-colors"
                        >
                          <Unlink size={13} /> {t("poUnlinkAction")}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Link a batch. Hidden entirely once the order is closed, because there is nothing
          legal to do — the server refuses linking on a terminal order. */}
      {canRun && order.allowedActions.length > 0 && (
        <div className="bg-white rounded-2xl border border-border p-4">
          <h3 className="font-semibold text-charcoal text-sm mb-3">{t("poLinkBatch")}</h3>
          {candidates.length === 0 ? (
            <p className="text-xs text-brown/60">{t("poNoLinkable")}</p>
          ) : (
            <div className="flex flex-wrap gap-2 items-center">
              <select
                value={pickBatch}
                onChange={(e) => setPickBatch(e.target.value)}
                className="px-3 py-2 border-2 border-border rounded-xl bg-white focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none text-sm min-w-[240px]"
              >
                <option value="">—</option>
                {candidates.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.batchNumber} · {b.roastedBeanQuantity} kg · {b.status}
                  </option>
                ))}
              </select>
              <button
                onClick={() => linkBatch(pickBatch)}
                disabled={!pickBatch || busy !== null}
                className="px-4 py-2 bg-orange text-white rounded-lg text-sm font-bold hover:bg-orange-dark disabled:opacity-40 inline-flex items-center gap-1.5 transition-colors"
              >
                <Link2 size={14} /> {t("poLinkAction")}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
