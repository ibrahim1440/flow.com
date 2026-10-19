"use client";

import { Select } from "@/components/ui/Select";
import { useState, useEffect, useCallback, use } from "react";
import Link from "next/link";
import { useI18n } from "@/lib/i18n/context";
import { useUser } from "@/app/dashboard/user-context";
import { hasSubPrivilege } from "@/lib/auth-shared";
import { ProductionStatusBadge, type ProductionProgress } from "../shared";
import { OrderStatusBadge } from "@/components/OrderLifecyclePanel";
import { Btn, LossTrack, Metrics, kg, OpsBanner, OpsEmpty, OpsLoading, OpsRoot, PageHeader, SecHead, Stages, StatusDot, Timeline, type Tone, Kg, opsDate } from "@/components/ops/ui";

type LinkedBatch = {
  id: string; batchNumber: string; status: string; isBlend: boolean;
  greenBeanQuantity: number; roastedBeanQuantity: number; wasteQuantity: number;
  roastedAvailableKg: number; date: string; createdAt: string; packedUnits: number;
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
  /** QC records with their tester: the order log's QC events (prd-order «سجل الأمر»). */
  qcRecords?: { id: string; decision: string; createdAt: string; testerName: string | null; isExternal: boolean; employee: { name: string } | null }[];
};

export default function ProductionOrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { t, lang } = useI18n();
  const user = useUser();
  const canRun = hasSubPrivilege(user?.permissions ?? {}, "production", "start_batch");
  const canCancel = hasSubPrivilege(user?.permissions ?? {}, "production", "cancel_batch");

  const [order, setOrder] = useState<Detail | null>(null);
  const [candidates, setCandidates] = useState<CandidateBatch[]>([]);
  const [qcByBatch, setQcByBatch] = useState<Record<string, NonNullable<CandidateBatch["qcRecords"]>>>({});
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
      // Rejected is included only so the order log can show the QC records of a rejected
      // linked batch; the candidate filter below already excludes rejected batches.
      fetch("/api/roasting-batches?statuses=Pending QC,Passed,Partially Packaged,Packaged,Rejected"),
    ]);

    const data = detailRes.ok ? await detailRes.json() : null;
    setOrder(data);

    if (!data) { setCandidates([]); return; }

    // Candidates are narrowed client-side purely as a convenience for the operator. The
    // server re-checks every one of these rules on link, and it is the enforcement.
    const all: CandidateBatch[] = batchRes.ok ? await batchRes.json() : [];
    const linked = new Set((data.roastingBatches as { id: string }[]).map((b) => b.id));
    setQcByBatch(Object.fromEntries(all.filter((b) => linked.has(b.id)).map((b) => [b.id, b.qcRecords ?? []])));
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
    return <OpsRoot><div className="hr-page"><OpsLoading rows={5} /></div></OpsRoot>;
  }
  if (!order) {
    return (
      <OpsRoot>
        <div className="hr-page">
          <Link href="/dashboard/production-orders" className="ops-link">← {t("poBackToList")}</Link>
          <OpsEmpty title={t("poNone")} />
        </div>
      </OpsRoot>
    );
  }

  const p = order.progress;
  const expectedLoss = order.productSku.product.expectedRoastLoss;
  const accepted = order.roastingBatches.filter((b) => b.status === "Passed" || b.status === "Partially Packaged" || b.status === "Packaged").length;
  const waitingQc = order.roastingBatches.filter((b) => b.status === "Pending QC").length;
  const rejected = order.roastingBatches.filter((b) => b.status === "Rejected").length;
  const packableKg = order.roastingBatches.filter((b) => b.status === "Passed" || b.status === "Partially Packaged").reduce((s, b) => s + b.roastedAvailableKg, 0);
  const closed = order.status === "COMPLETED" || order.status === "CANCELLED";
  // prd-order five stages from the order's status and its batches. Reservation (stock
  // allocation against the sales order) is not in this payload yet → pending + «غير متوفر بعد».
  const stage = (done: boolean, current: boolean) => (done ? "done" : current ? "current" : "pending") as "done" | "current" | "pending";
  const stages = [
    { key: "planned", title: t("poStagePlanned"), a: <>{t("poExpectedGreen")} <Kg v={order.expectedGreenBeanKg} /></>, b: <>{t("poProductLoss")} <span className="hr-num">{expectedLoss}%</span></>, state: stage(order.status !== "PENDING", order.status === "PENDING") },
    { key: "roasting", title: t("poStageRoasting"), a: <><span className="hr-num">{p.batchCount}</span> {t("poBatches").toLowerCase()} · <Kg v={p.roastedOutputKg} /> {t("poCountedWord")}</>, b: <>{t("poTargetWord")} <Kg v={order.targetWeightKg} /></>, state: stage(p.batchCount > 0 && (accepted > 0 || closed), order.status === "IN_PRODUCTION" && p.batchCount === 0 || (p.batchCount > 0 && accepted === 0 && !closed)) },
    { key: "qc", title: t("poStageQc"), a: <>{t("poAcceptedWord")} <span className="hr-num">{accepted}</span> · {t("poWaitingWord")} <span className="hr-num">{waitingQc}</span></>, b: <>{t("poRejectedWord")} <span className="hr-num">{rejected}</span></>, state: stage(accepted > 0 && waitingQc === 0, waitingQc > 0) },
    { key: "packing", title: t("poStagePacking"), a: <><span className="hr-num">{p.producedUnits}</span> {t("poOfWord")} <span className="hr-num">{order.targetUnits}</span> {t("poUnitsWord")}</>, b: <>{t("poPackableKg")} <Kg v={packableKg} /></>, state: stage(p.producedUnits >= order.targetUnits && order.targetUnits > 0, p.producedUnits > 0 && p.producedUnits < order.targetUnits) },
    // «الحجز»: the demand line this order serves (units for the sales order and how many were
    // delivered). The allocation count and the delivery date are not in this payload.
    order.sourceOrderItem
      ? { key: "reserve", title: t("poStageReserve"),
          a: <><span className="hr-num">{order.sourceOrderItem.quantityUnits ?? order.targetUnits}</span> {t("poUnitsWord")} {t("poForOrder")} <span className="hr-id">#{order.sourceOrderItem.order.orderNumber}</span></>,
          b: <>{t("poDeliveredWord")} <span className="hr-num">{order.sourceOrderItem.deliveredUnits}</span></>,
          state: stage((order.sourceOrderItem.quantityUnits ?? 0) > 0 && order.sourceOrderItem.deliveredUnits >= (order.sourceOrderItem.quantityUnits ?? 0), p.producedUnits > 0 && order.sourceOrderItem.deliveredUnits < (order.sourceOrderItem.quantityUnits ?? order.targetUnits)) }
      : { key: "reserve", title: t("poStageReserve"), a: <span className="hr-muted">{t("poForStock")}</span>, state: "pending" as const },
  ];
  // «سجل الأمر»: the order's own milestones, every linked batch, and each QC record on them
  // with its tester, newest first. Packaging events are not readable here (noted under it).
  const arrow = (a: number, b: number) => lang === "ar"
    ? <><span className="hr-num">{kg(a, 2)}</span> ← <Kg v={b} /></>
    : <bdi dir="ltr"><span className="hr-num">{kg(a, 2)}</span> → <span className="hr-num">{kg(b, 2)}</span> kg</bdi>;
  const statusEvent = order.status === "IN_PRODUCTION" ? t("poLogReleased") : order.status === "COMPLETED" ? t("poLogCompleted") : order.status === "CANCELLED" ? t("poLogCancelled") : null;
  const log = [
    ...(statusEvent && order.updatedAt !== order.createdAt ? [{ key: "status", at: order.updatedAt, who: null as string | null, text: statusEvent, tone: order.status === "CANCELLED" ? "danger" as const : order.status === "COMPLETED" ? "success" as const : undefined }] : []),
    ...order.roastingBatches.map((b) => ({ key: b.id, at: b.createdAt, who: null as string | null, text: <>{t("opsBatchWord")} <span className="ops-serial">{b.batchNumber}</span> · {arrow(b.greenBeanQuantity, b.roastedBeanQuantity)}{b.status === "Rejected" ? <> · {t("rejectedLabel")}</> : null}</>, tone: b.status === "Rejected" ? "danger" as const : undefined })),
    ...order.roastingBatches.flatMap((b) => (qcByBatch[b.id] ?? []).map((r) => ({
      key: r.id, at: r.createdAt, who: r.employee?.name ?? r.testerName ?? null,
      text: <>{r.decision === "Accept" ? t("poLogQcAccept") : t("poLogQcReject")} <span className="ops-serial">{b.batchNumber}</span>{r.isExternal ? <> · {t("guestLink")}</> : null}</>,
      tone: r.decision === "Accept" ? undefined : "danger" as const,
    }))),
    { key: "created", at: order.createdAt, who: null as string | null, text: <>{t("poLogCreated")}{order.sourceOrderItem ? <> · {t("poFromLineShortfall")} (<span className="hr-num">{order.targetUnits}</span> {t("poUnitsWord")})</> : null}</>, tone: undefined },
  ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  const canAct = (a: string) => order.allowedActions.includes(a) && (a === "cancel" ? canCancel : canRun);
  const BATCH_STATUS: Record<string, [string, Tone]> = {
    "Pending QC": [t("statusPendingQc"), "warning"],
    "Passed": [t("statusPassed"), "success"],
    "Partially Packaged": [t("statusPartiallyPkg"), "info"],
    "Packaged": [t("statusPackaged"), "success"],
    "Blended": [t("statusBlended"), "neutral"],
    "Rejected": [t("rejectedLabel"), "danger"],
  };

  return (
    <OpsRoot>
      <div className="hr-page">
        <Link href="/dashboard/production-orders" className="ops-link" style={{ width: "fit-content" }}>← {t("poBackToList")}</Link>

        <PageHeader
          title={<span className="ops-serial" style={{ fontFamily: "var(--f-mono)", fontSize: "inherit", color: "inherit" }}>{order.productionNumber}</span>}
          actions={
            <>
              {canAct("cancel") && (
                <Btn onClick={() => setShowCancel((v) => !v)} disabled={busy !== null}>{t("poCancel")}</Btn>
              )}
              {canAct("complete") && (
                <Btn onClick={() => act("complete")} busy={busy === "complete"} disabled={busy !== null}>{t("poComplete")}</Btn>
              )}
              {canAct("release") && (
                <Btn variant="primary" onClick={() => act("release")} busy={busy === "release"} disabled={busy !== null}>{t("poRelease")}</Btn>
              )}
            </>
          }
        >
          <ProductionStatusBadge status={order.status} />
          <span><span className="ops-serial">{order.productSku.skuCode}</span> — {order.productSku.name}<span className="hr-hide-mobile"> · {order.productSku.product.productNameEn}</span></span>
          {order.sourceOrderItem && (
            <span>
              {t("poDemandSource")}:{" "}
              <Link href="/dashboard/workstation/preparation" className="ops-link">#{order.sourceOrderItem.order.orderNumber}</Link>
              {" "}— {order.sourceOrderItem.order.customer?.name} · <OrderStatusBadge status={order.sourceOrderItem.order.status} />
            </span>
          )}
          <span className="hr-hide-mobile">{t("poCreatedAt")}: {opsDate(order.createdAt, lang)}</span>
        </PageHeader>

        <Stages items={stages} />
        {/* prd-390c-2: the phone shows one «stage» line in place of the five-stage tracker. */}
        {(() => {
          const now = stages.find((st) => st.state === "current") ?? [...stages].reverse().find((st) => st.state === "done") ?? stages[0];
          return <p className="ops-stage-now"><span className="hr-muted">{t("poStageWord")}</span><span>{now.title}{now.a ? <> · {now.a}</> : null}</span></p>;
        })()}

        {order.allowedActions.length === 0 && <p className="hr-caption" style={{ margin: 0 }}>{t("poNoActions")}</p>}

        {error && <OpsBanner tone="danger" onClose={() => setError(null)}>{error}</OpsBanner>}

        {showCancel && (
          <div className="hr-stack" style={{ gap: 8, maxWidth: 520 }}>
            <p className="hr-caption" style={{ margin: 0 }}>{t("poCancelKeepsStock")}</p>
            <input
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              placeholder={t("poCancelReason")}
              aria-label={t("poCancelReason")}
              className="hr-input"
            />
            <div>
              <Btn variant="danger" onClick={() => act("cancel", cancelReason)} busy={busy === "cancel"} disabled={busy !== null || cancelReason.trim().length === 0}>
                {t("poCancel")}
              </Btn>
            </div>
          </div>
        )}

        {/* Plan versus actual: what was planned when the order was raised, then what the
            roaster actually did. */}
        {/* prd-order: one row of four tiles — required, green consumed (against the plan),
            roasted counted, packed (of the target) — the remaining figures in the captions. */}
        <Metrics className="is-3-mobile" items={[
          [t("poRequired"), order.targetUnits, <><span className="ops-serial">{order.productSku.skuCode}</span> · <Kg v={order.targetWeightKg} digits={1} /></>, "hr-hide-mobile"],
          [t("poActualGreen"), kg(p.greenConsumedKg, 1), <>{t("opsKgUnit")} · {t("poPlannedGreen")} <Kg v={order.expectedGreenBeanKg} digits={1} /></>],
          [t("poActualRoasted"), kg(p.roastedOutputKg, 1), <>{t("opsKgUnit")} · {t("poBatches").toLowerCase()} <span className="hr-num">{p.batchCount}</span></>],
          [t("poPackedUnits"), <span key="pk">{p.producedUnits}<span className="ops-of"> / {order.targetUnits}</span></span>, <>{t("poRemaining")} <span className="hr-num">{p.remainingUnits}</span> {t("poUnitsWord")} · <Kg v={p.remainingKg} digits={1} /></>],
        ]} />

        {/* Linked batches */}
        <SecHead title={t("poBatches")} caption={<><span className="hr-num">{order.roastingBatches.length}</span></>} />
        {order.roastingBatches.length === 0 ? (
          <OpsEmpty title={t("poNoBatches")} />
        ) : (
          <div className="hr-tablewrap">
            <table className="hr-table is-mrow" aria-label={t("poBatches")}>
              <thead>
                <tr>
                  <th>{t("opsBatchCol")}</th>
                  <th>{t("opsRecordedCol")}</th>
                  <th className="hr-hide-compact">{t("opsGreenLotCol")}</th>
                  <th className="num">{t("opsGreenInCol")}</th>
                  <th className="num">{t("opsRoastedOutCol")}</th>
                  <th className="num hr-hide-compact">{t("opsLossCol")}</th>
                  <th>{t("poStatus")}</th>
                  <th className="num">{t("poPackedUnits")}</th>
                  <th aria-label={t("opsActions")} />
                </tr>
              </thead>
              <tbody>
                {order.roastingBatches.map((b) => {
                  const loss = b.greenBeanQuantity > 0 ? (1 - b.roastedBeanQuantity / b.greenBeanQuantity) * 100 : 0;
                  const bad = b.status === "Rejected";
                  return (
                  <tr key={b.id}>
                    <td className="m-title">
                      <span className="ops-serial">{b.batchNumber}</span>
                      <span className="hr-msub">{b.greenBean?.beanType ?? "—"} · {opsDate(b.createdAt, lang, true)} · <StatusDot map={BATCH_STATUS} value={b.status} /></span>
                    </td>
                    <td className="hr-hide-mobile"><span className="hr-num">{opsDate(b.createdAt, lang, true)}</span></td>
                    <td className="hr-hide-compact">{b.greenBean ? <span className="ops-serial">{b.greenBean.serialNumber}</span> : <span className="hr-muted">—</span>}</td>
                    <td className="num"><span className="hr-num">{kg(b.greenBeanQuantity, 2)}</span></td>
                    <td className="num m-end"><span className="hr-num hr-hide-mobile" style={bad ? { textDecoration: "line-through", color: "var(--text-muted)" } : undefined}>{kg(b.roastedBeanQuantity, 2)}</span><span className="ops-only-mobile"><Kg strong v={b.roastedBeanQuantity} /></span></td>
                    <td className="num hr-hide-compact" style={{ whiteSpace: "nowrap" }}><span className="hr-num" style={bad ? { color: "var(--status-danger)", fontWeight: 600 } : undefined}>{loss.toFixed(1)}%</span><LossTrack pct={loss} expected={expectedLoss} tone={bad ? "danger" : undefined} /></td>
                    <td className="hr-hide-mobile"><StatusDot map={BATCH_STATUS} value={b.status} />{bad ? <span className="ops-line">{t("poQuarantined")}</span> : null}</td>
                    <td className="num"><span className="hr-num">{b.packedUnits}</span></td>
                    <td>
                      {canRun && order.allowedActions.length > 0 && b.packedUnits === 0 && (
                        <Btn size="sm" onClick={() => linkBatch(b.id, true)} disabled={busy !== null}>{t("poUnlinkAction")}</Btn>
                      )}
                    </td>
                  </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={3}><span className="hr-num">{order.roastingBatches.length}</span> {t("poBatches").toLowerCase()} · <Kg v={p.roastedOutputKg} /> {t("poCountedWord")}</td>
                  <td className="num"><span className="hr-num">{kg(p.greenConsumedKg, 2)}</span></td>
                  <td className="num"><span className="hr-num">{order.roastingBatches.reduce((s, b) => s + b.roastedBeanQuantity, 0).toFixed(2)}</span></td>
                  <td colSpan={4} />
                </tr>
              </tfoot>
            </table>
          </div>
        )}

        {/* prd-order «سجل الأمر» */}
        <section className="hr-stack" style={{ gap: 8, maxWidth: 560 }} aria-label={t("poOrderLog")}>
          <SecHead title={t("poOrderLog")} />
          <Timeline items={log.map((e) => ({ key: e.key, text: e.text, when: e.who ? <>{opsDate(e.at, lang, true)} · {e.who}</> : opsDate(e.at, lang, true), tone: e.tone }))} />
          <p className="hr-caption" style={{ margin: 0 }}>{t("poLogPartial")}</p>
        </section>

        {/* Link a batch. Hidden once the order is closed: the server refuses linking on a
            terminal order. */}
        {canRun && order.allowedActions.length > 0 && (
          <section className="hr-stack" style={{ gap: 8 }}>
            <SecHead title={t("poLinkBatch")} />
            {candidates.length === 0 ? (
              <p className="hr-caption" style={{ margin: 0 }}>{t("poNoLinkable")}</p>
            ) : (
              <div className="hr-filterbar">
                <Select value={pickBatch} onChange={(e) => setPickBatch(e.target.value)} className="hr-input" style={{ minWidth: 260, width: "auto" }} aria-label={t("poLinkBatch")}>
                  <option value="">—</option>
                  {candidates.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.batchNumber} · {b.roastedBeanQuantity} {t("opsKgUnit")} · {BATCH_STATUS[b.status]?.[0] ?? b.status}
                    </option>
                  ))}
                </Select>
                <Btn variant="primary" onClick={() => linkBatch(pickBatch)} disabled={!pickBatch || busy !== null}>{t("poLinkAction")}</Btn>
              </div>
            )}
          </section>
        )}
      </div>
    </OpsRoot>
  );
}
