"use client";

import { localizeApiError } from "@/lib/i18n/api-errors";
import { Select } from "@/components/ui/Select";
import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { AlertTriangle, Trash2, CalendarDays } from "lucide-react";
import { Bar, Btn, Grams, Notice, OpsBanner, OpsEmpty, OpsLoading, OpsPane, OpsRoot, PageHeader, SecHead, StatusDot, Kg, gUnit, opsDate } from "@/components/ops/ui";
import EditDateModal, { type EditableBatch } from "@/components/EditDateModal";
import WorkflowFilterBar, { type FilterOption } from "@/components/WorkflowFilterBar";
import { useI18n } from "@/lib/i18n/context";
import { useUser } from "../user-context";
import { hasSubPrivilege } from "@/lib/auth-shared";
import { createRequestKeyHolder } from "@/lib/request-key";

import { RestockReason, restockReasonOk } from "@/components/ops/RestockReason";
import { AutoRow, Cta, NumIn, Stepper } from "@/components/ops/station";
import { PrintDialog } from "@/components/print/PrintDialog";
import { PRINT_GATE_NOTE_ID, PrintNotCertifiedNotice, usePrintCertified } from "@/components/print/Certification";
type Batch = {
  id: string; batchNumber: string; date: string; status: string;
  productId: string | null;
  // Roasted coffee from this batch not yet packed. Every packaging line draws on it, so it
  // is what caps the whole operation.
  roastedAvailableKg: number;
  greenBeanQuantity: number; roastedBeanQuantity: number;
  roastProfile: string | null; blendTiming: string | null;
  bags3kg: number; bags1kg: number; bags250g: number; bags150g: number; samplesGrams: number;
  /** Last change (the packing time, for the history block); every scalar is in the payload. */
  updatedAt?: string;
  parentBatchId: string | null;
  parentBatch: { id: string; batchNumber: string } | null;
  greenBean: { beanType: string } | null;
  // Nullable since roast-to-stock: a batch roasted for the shelf has no order behind it.
  orderItem: { beanTypeName: string; productId: string | null; productSkuId: string | null; order: { orderNumber: number; customer: { name: string } } } | null;
};

/** An open partial package this roast may legally be poured into. */
type OpenPartial = {
  lotId: string;
  batchNumber: string;
  skuId: string | null;
  skuCode: string;
  actualGrams: number;
  nominalGrams: number;
  fromThisBatch: boolean;
};

/** One size of this roast's coffee, with the count suggested from open demand (GET …/pack). */
type PlanRow = { id: string; skuCode: string; name: string; weightGrams: number; hasBom: boolean; suggested: number; outstandingUnits: number; forOrders: number[] };

type BatchPackState = {
  batchNumber: string;
  status: string;
  availableGrams: number;
  openPartials: OpenPartial[];
  /** The packaging plan (production simplification item 6): this coffee's sizes only. */
  plan?: { ok: true; productId: string; productNameEn: string; productNameAr: string | null; rows: PlanRow[] } | { ok: false; error: string };
};

// ── The server's reconciliation, mirrored as types only ─────────────────────
// Deliberately NOT recomputed on the client. The same previewPackaging that answers this
// screen is the one the commit path runs inside its transaction, so what the operator is
// shown and what the server will enforce come from one implementation. A second, local
// arithmetic here would be a second opinion, and the two would eventually disagree.
type LineOutcome = {
  lineIndex: number;
  kind: "pack" | "topUp" | "loss";
  productSkuId: string;
  skuCode: string;
  nominalGrams: number;
  actualGramsEach: number;
  packages: number;
  gramsConsumed: number;
  classification: "STANDARD" | "PARTIAL" | "LOSS";
  standardUnitsCreated: number;
  lotId?: string;
  becomesStandard?: boolean;
  reason?: string;
};

type MaterialRequirement = {
  materialItemId: string;
  label: string;
  required: number;
  available: number;
  missing: number;
};

type PackagingPreview = {
  availableGrams: number;
  lines: LineOutcome[];
  totalConsumedGrams: number;
  standardGrams: number;
  partialGrams: number;
  lossGrams: number;
  remainingGrams: number;
  standardUnits: number;
  partialPackages: number;
  materials: MaterialRequirement[];
  problems: string[];
};

/**
 * One row of the packaging sheet.
 *
 * The three kinds are the three things that can physically happen to roasted coffee at the
 * bench: it goes into new packages, it tops up a package that is already open, or it is
 * lost. Nothing here describes HOW inventory stores the result — that distinction used to
 * be the operator's to make and was never theirs to know.
 */
type UiLine =
  | { uid: string; kind: "pack"; productSkuId: string; packages: number; gramsEach: number }
  | { uid: string; kind: "topUp"; lotId: string; gramsAdded: number }
  | { uid: string; kind: "loss"; grams: number; reason: string };

/** Whether a row says enough to be sent to the server at all. */
function isComplete(l: UiLine): boolean {
  if (l.kind === "pack") return !!l.productSkuId && l.packages >= 1 && l.gramsEach >= 1;
  if (l.kind === "topUp") return !!l.lotId && l.gramsAdded >= 1;
  return l.grams >= 1 && l.reason.trim().length >= 3;
}

/** The wire shape — exactly the fields the route reads, and nothing the UI invented. */
function toPayload(l: UiLine): Record<string, unknown> {
  if (l.kind === "pack") return { kind: "pack", productSkuId: l.productSkuId, packages: l.packages, gramsEach: l.gramsEach };
  if (l.kind === "topUp") return { kind: "topUp", lotId: l.lotId, gramsAdded: l.gramsAdded };
  return { kind: "loss", grams: l.grams, reason: l.reason.trim() };
}

const gToKg = (g: number) => +(g / 1000).toFixed(3);

function packagedKg(b: { bags3kg: number; bags1kg: number; bags250g: number; bags150g: number; samplesGrams: number }) {
  return +(b.bags3kg * 3 + b.bags1kg * 1 + b.bags250g * 0.25 + b.bags150g * 0.15 + b.samplesGrams / 1000).toFixed(3);
}

export default function PackagingPage() {
  const user = useUser();
  const { t } = useI18n();
  const canCancelBatch = hasSubPrivilege(user?.permissions ?? {}, "production", "cancel_batch");
  const canEditDate = hasSubPrivilege(user?.permissions ?? {}, "production", "edit_date");
  const canOverrideInventory = hasSubPrivilege(user?.permissions ?? {}, "inventory", "override");
  const lang = user?.preferredLanguage ?? "ar";

  const [batches, setBatches] = useState<Batch[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [cancelBatch, setCancelBatch] = useState<Batch | null>(null);
  const [cancelling, setCancelling] = useState(false);
  // The restock reason belongs to the batch being cancelled: opening another batch starts empty.
  const [restockDraft, setRestockDraft] = useState<{ batchId: string; text: string }>({ batchId: "", text: "" });
  const restockReason = cancelBatch && restockDraft.batchId === cancelBatch.id ? restockDraft.text : "";
  const setRestockReason = (text: string) => setRestockDraft({ batchId: cancelBatch?.id ?? "", text });
  const [editDateBatch, setEditDateBatch] = useState<EditableBatch | null>(null);

  // Filter state
  const [filterSearch, setFilterSearch] = useState("");
  const [filterBean, setFilterBean] = useState("");
  const [filterOrder, setFilterOrder] = useState("");

  // Batch serial superseded lookup
  const [serialLookup, setSerialLookup] = useState<{
    found: boolean;
    query: string;
    currentMatches: { id: string; batchNumber: string; date: string; status: string; beanType: string | null }[];
    superseded: { oldBatchNumber: string; newBatchNumber: string; batchId: string; currentBatchNumber: string | null; date: string | null; status: string | null; beanType: string | null; changedAt: string; reason: string | null }[];
  } | null>(null);

  // ── The one packaging operation ──────────────────────────────────────────
  const [packBatch, setPackBatch] = useState<Batch | null>(null);
  const [packState, setPackState] = useState<BatchPackState | null>(null);
  // The plan the operator adjusts: a count per size, and the exceptions (a partial package, a
  // top-up of an open package, a packing loss) under «more». The packaging lines sent to the
  // server are derived from these; the request and its idempotency are exactly as before.
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [partial, setPartial] = useState<{ skuId: string; grams: string } | null>(null);
  const [topUps, setTopUps] = useState<Record<string, number>>({});
  const [loss, setLoss] = useState<{ grams: string; reason: string }>({ grams: "", reason: "" });
  // Labels are printed on request after packing (owner decision O3), never automatically.
  const [lastPacked, setLastPacked] = useState<{ productId: string; label: string } | null>(null);
  const [printOpen, setPrintOpen] = useState(false);
  const printing = usePrintCertified();
  const canPrintLabels = hasSubPrivilege(user?.permissions ?? {}, "labels", "print");
  const [preview, setPreview] = useState<PackagingPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [partialAck, setPartialAck] = useState(false);
  const [packError, setPackError] = useState("");
  const [packing, setPacking] = useState(false);

  // Names the packaging operation being attempted. A ref rather than state: the key must
  // survive a re-render and changing it must not cause one. All of the retry rules live in
  // the holder, which harness-selftest asserts directly — see src/lib/request-key.ts.
  const packKeyHolder = useRef(createRequestKeyHolder());

  useEffect(() => { loadData(); }, []);

  useEffect(() => {
    const q = filterSearch.trim();
    if (q.length < 8 || !/^\d+$/.test(q)) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/roasting-batches/serial-lookup?q=${encodeURIComponent(q)}`, {
          signal: controller.signal,
        });
        if (res.ok) setSerialLookup(await res.json());
        else setSerialLookup(null);
      } catch {
        // aborted or network error — silently ignore
      }
    }, 400);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [filterSearch]);

  async function loadData() {
    const res = await fetch("/api/roasting-batches?statuses=Passed,Partially+Packaged");
    if (res.ok) setBatches(await res.json());
    setLoading(false);
  }

  const loadPackState = useCallback(async (batchId: string) => {
    const res = await fetch(`/api/roasting-batches/${batchId}/pack`);
    const state: BatchPackState | null = res.ok ? await res.json() : null;
    setPackState(state);
    // The counts start from the suggestion; the operator changes what differs from reality.
    setCounts(state?.plan?.ok ? Object.fromEntries(state.plan.rows.map((r) => [r.id, r.suggested])) : {});
  }, []);

  function openPacking(batch: Batch) {
    setPackBatch(batch);
    setPackState(null);
    setPreview(null);
    setPartialAck(false);
    setPackError("");
    setCounts({}); setPartial(null); setTopUps({}); setLoss({ grams: "", reason: "" });
    setError(""); setSuccess(""); setLastPacked(null);
    packKeyHolder.current = createRequestKeyHolder();
    loadPackState(batch.id);
  }

  function closePacking() {
    setPackBatch(null);
    setPackState(null);
    setPreview(null);
    setCounts({}); setPartial(null); setTopUps({}); setLoss({ grams: "", reason: "" });
  }

  async function handleCancelBatch(restock: boolean) {
    if (!cancelBatch) return;
    setCancelling(true);
    // A restock is an inventory override: it carries its reason (owner decision, inventory Option A).
    const res = await fetch(`/api/roasting-batches/${cancelBatch.id}?restock=${restock}`, restock
      ? { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason: restockReason.trim() }) }
      : { method: "DELETE" });
    setCancelling(false);
    if (!res.ok) {
      try { const d = await res.json(); setError(localizeApiError(d, lang === "en" ? "en" : "ar") || t("cancelFailed")); }
      catch { setError(t("cancelFailed")); }
    } else {
      setSuccess(t("batchCancelled"));
      setCancelBatch(null);
      loadData();
    }
  }

  // Only complete rows are worth asking the server about. A half-typed row is not a
  // refusal, it is an unfinished sentence.
  const planRows = useMemo(() => (packState?.plan?.ok ? packState.plan.rows : []), [packState]);
  const lines = useMemo<UiLine[]>(() => {
    const out: UiLine[] = [];
    for (const r of planRows) {
      const n = counts[r.id] ?? 0;
      // Weight defaults to the size's nominal weight: a full package is the ordinary case.
      if (n > 0) out.push({ uid: `pack:${r.id}`, kind: "pack", productSkuId: r.id, packages: n, gramsEach: r.weightGrams });
    }
    if (partial) {
      const g = parseInt(partial.grams, 10) || 0;
      out.push({ uid: "partial", kind: "pack", productSkuId: partial.skuId, packages: 1, gramsEach: g });
    }
    for (const [lotId, g] of Object.entries(topUps)) out.push({ uid: `top:${lotId}`, kind: "topUp", lotId, gramsAdded: g });
    const lg = parseInt(loss.grams, 10) || 0;
    if (lg > 0 || loss.reason) out.push({ uid: "loss", kind: "loss", grams: lg, reason: loss.reason });
    return out;
  }, [planRows, counts, partial, topUps, loss]);
  const completeLines = useMemo(() => lines.filter(isComplete), [lines]);
  const hasIncompleteLine = lines.length > completeLines.length;
  const payloadKey = useMemo(() => JSON.stringify(completeLines.map(toPayload)), [completeLines]);

  // ── Live reconciliation, answered by the server ──────────────────────────
  // Debounced because it runs on every keystroke in a weight field, and aborted on change
  // so a slow earlier answer can never overwrite a newer one.
  useEffect(() => {
    if (!packBatch) return;
    const payload = JSON.parse(payloadKey) as unknown[];
    if (payload.length === 0) { setPreview(null); setPreviewing(false); return; }

    const controller = new AbortController();
    setPreviewing(true);
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/roasting-batches/${packBatch.id}/pack`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ preview: true, lines: payload }),
          signal: controller.signal,
        });
        const data = await res.json().catch(() => null);
        if (controller.signal.aborted) return;
        setPreview(res.ok ? data : null);
        setPackError(res.ok ? "" : (localizeApiError(data, lang === "en" ? "en" : "ar") ?? ""));
      } catch {
        // aborted or offline; the confirm button stays disabled without a preview
      } finally {
        if (!controller.signal.aborted) setPreviewing(false);
      }
    }, 350);

    return () => { clearTimeout(timer); controller.abort(); };
  }, [packBatch, payloadKey]);

  // Any outcome below nominal leaves stock that cannot be sold, whether it is a new
  // package or a top-up that did not reach the line. Both are acknowledged.
  const createsPartial = !!preview?.lines.some((l) => l.classification === "PARTIAL");
  useEffect(() => { if (!createsPartial) setPartialAck(false); }, [createsPartial]);

  const blocked =
    packing ||
    previewing ||
    completeLines.length === 0 ||
    hasIncompleteLine ||
    !preview ||
    preview.problems.length > 0 ||
    (createsPartial && !partialAck);

  async function submitPackaging() {
    if (!packBatch || blocked) return;
    setPackError("");
    setPacking(true);
    try {
      const res = await fetch(`/api/roasting-batches/${packBatch.id}/pack`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": packKeyHolder.current.keyForAttempt(),
        },
        body: JSON.stringify({ lines: completeLines.map(toPayload) }),
      });
      // Retires the key only if the server actually decided. A 5xx leaves it in place, so
      // the operator's next click is recognised as the same operation rather than packing
      // the coffee a second time; a thrown fetch never reaches this line at all.
      packKeyHolder.current.recordResponse(res.status);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setPackError(localizeApiError(data, lang === "en" ? "en" : "ar") || (lang === "en" ? "Failed to pack." : "تعذّرت التعبئة."));
        return;
      }
      const parts = [`${data.standardUnitsCreated} ${t("pkgSellableUnits")}`];
      if (data.partialPackagesCreated > 0) parts.push(`${data.partialPackagesCreated} ${t("pkgPartialPackage")}`);
      if (data.partialPackagesCompleted > 0) parts.push(`${data.partialPackagesCompleted} ${t("pkgWillComplete")}`);
      if (data.lossGrams > 0) parts.push(`${data.lossGrams} ${gUnit(lang)} ${t("pkgReconLoss")}`);
      if (data.reservedUnits > 0) parts.push(lang === "ar" ? `حُجز ${data.reservedUnits} للطلب` : `${data.reservedUnits} reserved to the order`);
      setSuccess(`${t("pkgDone")}: ${parts.join(" · ")}`);
      if (packState?.plan?.ok) setLastPacked({ productId: packState.plan.productId, label: (lang === "ar" ? packState.plan.productNameAr : null) || packState.plan.productNameEn });
      closePacking();
      loadData();
    } finally {
      setPacking(false);
    }
  }

  const beanOptions = useMemo<FilterOption[]>(() => {
    const seen = new Set<string>();
    const opts: FilterOption[] = [];
    for (const b of batches) {
      const v = b.greenBean?.beanType || (b.orderItem?.beanTypeName ?? "");
      if (!seen.has(v)) { seen.add(v); opts.push({ label: v, value: v }); }
    }
    return opts;
  }, [batches]);

  const orderOptions = useMemo<FilterOption[]>(() => {
    const seen = new Set<string>();
    const opts: FilterOption[] = [];
    for (const b of batches) {
      const v = String((b.orderItem?.order.orderNumber ?? t("stockBatchLabel")));
      if (!seen.has(v)) { seen.add(v); opts.push({ label: `#${v} – ${(b.orderItem?.order.customer.name ?? t("stockBatchLabel"))}`, value: v }); }
    }
    return opts;
  }, [batches, t]);

  const filteredBatches = useMemo(() => {
    const q = filterSearch.toLowerCase();
    return batches.filter((b) => {
      const beanType = b.greenBean?.beanType || (b.orderItem?.beanTypeName ?? "");
      if (filterBean && beanType !== filterBean) return false;
      if (filterOrder && String((b.orderItem?.order.orderNumber ?? t("stockBatchLabel"))) !== filterOrder) return false;
      if (q) {
        const haystack = `${b.batchNumber} ${(b.orderItem?.order.orderNumber ?? t("stockBatchLabel"))} ${(b.orderItem?.order.customer.name ?? t("stockBatchLabel"))} ${beanType}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [batches, filterSearch, filterBean, filterOrder, t]);


  if (loading) {
    return <OpsRoot><div className="hr-page"><OpsLoading rows={5} /></div></OpsRoot>;
  }

  return (
    <OpsRoot>
    <div className={`hr-split${packBatch ? " has-preview" : ""}`}>
    <div className="hr-page">
      <PageHeader title={t("packaging")}>
        <span><span className="hr-num">{batches.length}</span> {t("batchesReadyPackage")}</span>
      </PageHeader>

      {error && <OpsBanner tone="danger" onClose={() => setError("")}>{error}</OpsBanner>}
      {success && <OpsBanner tone="success" onClose={() => { setSuccess(""); setLastPacked(null); }}>{success}</OpsBanner>}
      {/* O3: labels are a separate action after packing, never printed automatically, and follow
          the PRINT_CERTIFIED gate (disabled with the standing notice while printing is off). */}
      {lastPacked && canPrintLabels ? (
        <div className="hr-filterbar" style={{ justifyContent: "flex-start", gap: 12 }} data-testid="pack-print-labels">
          <Btn variant="primary" disabled={printing !== true} aria-describedby={printing === true ? undefined : PRINT_GATE_NOTE_ID} onClick={() => { if (printing === true) setPrintOpen(true); }}>
            {lang === "ar" ? "طباعة الملصقات" : "Print labels"}
          </Btn>
          <span className="hr-caption">{lastPacked.label}</span>
        </div>
      ) : null}
      {lastPacked && canPrintLabels && printing === false ? <PrintNotCertifiedNotice /> : null}
      {printOpen && lastPacked ? (
        <PrintDialog open={printOpen} onClose={() => setPrintOpen(false)} initialTemplate="COFFEE_ORIGIN"
          items={[{ kind: "product", productId: lastPacked.productId, label: lastPacked.label }]} subtitle={lastPacked.label} />
      ) : null}

      {batches.length > 0 && (
        <WorkflowFilterBar
          searchQuery={filterSearch} onSearchChange={setFilterSearch}
          beanOptions={beanOptions} selectedBean={filterBean} onBeanChange={setFilterBean}
          orderOptions={orderOptions} selectedOrder={filterOrder} onOrderChange={setFilterOrder}
          resultCount={filteredBatches.length} totalCount={batches.length}
        />
      )}

      {serialLookup?.query === filterSearch.trim() && serialLookup.superseded.length > 0 && (
        <Notice tone="warning">
          <strong style={{ fontWeight: 600 }}>{lang === "ar" ? "الرقم التسلسلي تم استبداله" : "Batch serial superseded"}</strong>
          {serialLookup.superseded.map((s, i) => (
            <div key={i}>
              {lang === "ar" ? (
                <>
                  الرقم <span className="ops-serial">{s.oldBatchNumber}</span> تم استبداله بـ{" "}
                  <span className="ops-serial">{s.newBatchNumber}</span>
                  {s.beanType && <> · {s.beanType}</>}
                  {s.reason && <> · {s.reason}</>}
                </>
              ) : (
                <>
                  Batch serial <span className="ops-serial">{s.oldBatchNumber}</span> has been superseded by{" "}
                  <span className="ops-serial">{s.newBatchNumber}</span>
                  {s.beanType && <> · {s.beanType}</>}
                  {s.reason && <> · <em>{s.reason}</em></>}
                </>
              )}
            </div>
          ))}
        </Notice>
      )}
      {filteredBatches.length === 0 ? (
        <OpsEmpty title={t("noBatchesToPackage")} body={t("batchesAfterQc")} />
      ) : (
        <div className="hr-tablewrap">
          <table className="hr-table is-mrow" aria-label={t("packaging")}>
            <thead>
              <tr>
                <th>{t("opsBatchCol")}</th>
                <th>{t("opsProductOrderCol")}</th>
                <th className="num">{t("opsRoastedOutCol")}</th>
                <th>{t("opsPackedCol")}</th>
                <th className="num">{t("opsLeftCol")}</th>
                <th>{t("opsStatusCol")}</th>
                <th aria-label={t("opsActions")} />
              </tr>
            </thead>
            <tbody>
              {filteredBatches.map((batch) => {
                const total = batch.roastedBeanQuantity;
                // What the roast has actually given up, from the one column that knows. The
                // legacy bag counters only ever described one of the old paths, and a roast
                // packed through the unified operation does not touch them at all.
                const packed = +Math.max(0, total - batch.roastedAvailableKg).toFixed(3);
                const pct = total > 0 ? Math.min((packed / total) * 100, 100) : 0;
                const remaining = +batch.roastedAvailableKg.toFixed(3);
                const legacyBags = packagedKg(batch);
                const bags = legacyBags > 0 ? [
                  batch.bags3kg > 0 ? `${batch.bags3kg}× 3kg` : null,
                  batch.bags1kg > 0 ? `${batch.bags1kg}× 1kg` : null,
                  batch.bags250g > 0 ? `${batch.bags250g}× 250g` : null,
                  batch.bags150g > 0 ? `${batch.bags150g}× 150g` : null,
                  batch.samplesGrams > 0 ? `${batch.samplesGrams} ${gUnit(lang)} ${t("samplesGramsLabel")}` : null,
                ].filter(Boolean) : [];
                return (
                  <tr key={batch.id} data-testid={`pack-batch-${batch.batchNumber}`}>
                    <td>
                      <span className="ops-serial">{batch.batchNumber}</span>
                      {canEditDate && (
                        <button type="button" className="hr-btn is-ghost is-sm" style={{ height: 24, padding: "0 4px", marginInlineStart: 4 }} onClick={() => setEditDateBatch(batch)} title={t("editDateBtn")} aria-label={t("editDateBtn")}>
                          <CalendarDays size={13} aria-hidden="true" />
                        </button>
                      )}
                    </td>
                    <td className="m-title">
                      <span className="strong">{batch.greenBean?.beanType || (batch.orderItem?.beanTypeName ?? "")}</span>
                      <span className="ops-line">
                        {batch.orderItem ? <><span className="hr-id">#{batch.orderItem.order.orderNumber}</span> · {batch.orderItem.order.customer.name}</> : t("stockBatchLabel")}
                        <span className="hr-mobile-only"> · <span className="ops-serial">{batch.batchNumber}</span> · <bdi dir="ltr"><span className="hr-num">{packed}</span> / <span className="hr-num">{total}</span></bdi> {t("opsKgUnit")}</span>
                        {" · "}<Kg v={batch.greenBeanQuantity} /> {t("greenLabel")} · {opsDate(batch.date, lang)}
                        {batch.roastProfile ? <> · {batch.roastProfile}</> : null}
                        {batch.blendTiming ? <> · {t("blendedLabel")} {batch.blendTiming === "Before QC" ? t("blendBeforeQc") : t("blendAfterQc")}</> : null}
                      </span>
                      {/* Bags recorded before the unified workflow: historical, shown only where
                          they exist so an old batch's record stays readable. */}
                      {bags.length > 0 ? <span className="ops-line">{bags.join(" · ")}</span> : null}
                    </td>
                    <td className="num"><span className="hr-num">{total}</span></td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      <Bar pct={pct} tone={pct >= 99.5 ? "success" : undefined} label={`${packed} / ${total} ${t("opsKgUnit")}`} />{" "}
                      <span className="hr-caption"><bdi dir="ltr"><span className="hr-num">{packed}</span> / <span className="hr-num">{total}</span></bdi> {t("opsKgUnit")} {t("statusPackaged")}</span>
                    </td>
                    <td className="num">{remaining > 0 ? <Kg v={remaining} /> : <span className="hr-muted">—</span>}</td>
                    <td><StatusDot map={{ "Partially Packaged": [t("statusPartiallyPkg"), "info"], "Passed": [t("statusPassed"), "success"] }} value={batch.status} /></td>
                    <td className="m-end">
                      <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
                        {canCancelBatch && (
                          <button type="button" className="hr-btn is-ghost is-sm" onClick={() => setCancelBatch(batch)} title={t("cancelBatchTitle")} aria-label={t("cancelBatchTitle")}>
                            <Trash2 size={15} aria-hidden="true" />
                          </button>
                        )}
                        {/* ONE packaging action, named for whether this roast has been touched yet. */}
                        <Btn size="sm" variant={batch.status === "Partially Packaged" ? "secondary" : "primary"} onClick={() => openPacking(batch)}>
                          {batch.status === "Partially Packaged" ? t("continuePackaging") : t("startPackaging")}
                        </Btn>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* prd-pack «آخر عمليات التعبئة» lists packaging OPERATIONS (output × SKU, loss, who). The
          operations are not readable by this screen yet (no list endpoint in this phase), so the
          block shows the approved «not available yet» pattern rather than a list of batches. */}
      <section className="hr-stack" style={{ gap: 8, marginTop: 8 }} aria-label={t("opsPackHistory")}>
        <SecHead title={t("opsPackHistory")} />
        <p className="hr-caption" style={{ margin: 0 }}>{t("opsNotAvailableYet")} · {t("opsPackHistoryLater")}</p>
      </section>

      {/* ── The unified packaging operation ──────────────────────────────── */}

      {/* Cancel Batch Modal */}
      {cancelBatch && (() => {
        const hasBean = !!cancelBatch.greenBean;
        return (
          <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => !cancelling && setCancelBatch(null)}>
            <div className="bg-white rounded-2xl p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center gap-3 mb-4">
                <div className="p-2 bg-red-100 rounded-xl"><Trash2 size={20} className="text-red-600" /></div>
                <div>
                  <h2 className="font-extrabold text-charcoal">{t("cancelBatchTitle")}</h2>
                  <p className="text-sm text-brown font-mono">{cancelBatch.batchNumber}</p>
                </div>
              </div>
              <p className="text-sm text-brown mb-5">{t("cancelBatchMsgPost")}</p>
              <div className="flex flex-col gap-2">
                <button onClick={() => handleCancelBatch(false)} disabled={cancelling}
                  className="w-full py-3 bg-charcoal text-white rounded-xl font-bold hover:bg-charcoal/80 disabled:opacity-50 active:scale-[0.98] transition-all">
                  {cancelling ? "…" : t("cancelMarkWasted")}
                </button>
                {hasBean && canOverrideInventory && <RestockReason value={restockReason} onChange={setRestockReason} label={t("restockReasonLabel")} hint={t("restockReasonHint")} disabled={cancelling} />}
                {hasBean && (
                  <button onClick={() => handleCancelBatch(true)} disabled={cancelling || !canOverrideInventory || !restockReasonOk(restockReason)}
                    title={!canOverrideInventory ? t("noOverridePermission") : undefined}
                    className="w-full py-3 bg-red-600 text-white rounded-xl font-bold hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed active:scale-[0.98] transition-all">
                    {cancelling ? "…" : t("cancelRestock")}
                  </button>
                )}
                <button onClick={() => setCancelBatch(null)} disabled={cancelling}
                  className="w-full py-3 border-2 border-border rounded-xl font-bold text-brown hover:bg-cream transition-colors">
                  {t("cancel")}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Edit Date Modal */}
      {editDateBatch && (
        <EditDateModal
          batch={editDateBatch}
          onClose={() => setEditDateBatch(null)}
          onSuccess={({ newBatchNumber, parentBatchId, newParentBatchNumber }) => {
            setBatches((prev) =>
              prev.map((b) => {
                if (b.id === editDateBatch.id) return { ...b, batchNumber: newBatchNumber };
                if (parentBatchId && b.id === parentBatchId && newParentBatchNumber)
                  return { ...b, batchNumber: newParentBatchNumber };
                return b;
              })
            );
            const msg = newParentBatchNumber
              ? `${t("dateUpdatedMsg")} ${newBatchNumber}. ${t("blendAlsoUpdated")}`
              : `${t("dateUpdatedMsg")} ${newBatchNumber}`;
            setSuccess(msg);
            setEditDateBatch(null);
          }}
        />
      )}
    </div>
    {/* prd-pack 328:2742 / 332:2917 / 348:3593: packaging is a pane beside the list at 1440, a
        drawer at 1024 and a full-screen view with a sticky action bar on the phone. Same lines,
        preview, validation and request as the dialog it replaces. */}
    {packBatch && (
      <OpsPane
        testId="packaging-dialog"
        phone="page"
        label={packBatch.status === "Partially Packaged" ? t("continuePackaging") : t("startPackaging")}
        title={<><span>{packBatch.status === "Partially Packaged" ? t("continuePackaging") : t("startPackaging")}</span> <span className="ops-serial">{packBatch.batchNumber}</span></>}
        sub={packBatch.greenBean?.beanType || (packBatch.orderItem?.beanTypeName ?? "")}
        busy={packing}
        onClose={closePacking}
        footer={(() => {
          const bags = lines.reduce((a, l) => a + (l.kind === "pack" ? l.packages : 0), 0);
          return (
            <Cta testId="pack-confirm" onClick={submitPackaging} disabled={blocked} busy={packing}>
              {bags > 0 ? (lang === "ar" ? `أكّد ${bags} كيس` : `Confirm ${bags} package${bags === 1 ? "" : "s"}`) : completeLines.length ? t("pkgConfirmBtn") : (lang === "ar" ? "اختر عددًا" : "Choose a count")}
            </Cta>
          );
        })()}
      >
        <div className="space-y-3 ops-pack-body">
              {/* What this roast still holds, before anything is entered. */}
              <div className="rounded-xl bg-cream px-3 py-2 text-sm space-y-0.5">
                {packBatch.roastedBeanQuantity - packBatch.roastedAvailableKg > 0.001 && (
                  <p>
                    <span className="text-brown">{t("pkgAlreadyPackedLabel")}: </span>
                    <b className="text-charcoal"><Kg v={(+(packBatch.roastedBeanQuantity - packBatch.roastedAvailableKg)).toFixed(3)} /></b>
                  </p>
                )}
                <p>
                  <span className="text-brown">{t("pkgReconAvailable")}: </span>
                  <b className="text-charcoal tabular-nums">
                    {packState ? <Grams v={packState.availableGrams} /> : <Kg v={packBatch.roastedAvailableKg} />}
                  </b>
                </p>
              </div>

              {packState && packState.plan && !packState.plan.ok ? (
                <p className="hr-notice tone-danger" role="alert" style={{ margin: 0 }}>{packState.plan.error}</p>
              ) : !packState ? null : planRows.length === 0 ? (
                <p className="text-sm font-semibold text-red-700">{t("packSkuNoProducts")}</p>
              ) : (
                <>
                  <AutoRow title={lang === "ar" ? "الخطة مقترحة من الطلبات المفتوحة" : "The plan comes from the open orders"}
                    sub={lang === "ar" ? "تظهر أحجام قهوة هذه الدفعة فقط. عدّل العدد إن اختلف الواقع." : "Only this roast's coffee is offered. Change a count if reality differs."} />
                  {/* ── The plan: one stepper per size of this coffee ───────── */}
                  <div style={{ display: "grid", gap: 10 }} data-testid="pack-plan">
                    {planRows.map((r) => {
                      const n = counts[r.id] ?? 0;
                      const size = r.weightGrams >= 1000 ? `${(r.weightGrams / 1000).toLocaleString("en-US")} ${lang === "ar" ? "كغ" : "kg"}` : `${r.weightGrams} ${gUnit(lang)}`;
                      return (
                        <div key={r.id} className="st-line" data-testid={`pack-plan-${r.skuCode}`}>
                          <div>
                            <div className="st-l1">{size} <span className="ops-serial" style={{ fontWeight: 400 }}>{r.skuCode}</span></div>
                            <div className="st-l2">{!r.hasBom ? (lang === "ar" ? "لا مكوّنات (BOM) لهذا الحجم" : "No BOM for this size") : r.forOrders.length ? `${lang === "ar" ? "لطلبات" : "For orders"} ${r.forOrders.map((o) => `#${o}`).join("، ")}` : (lang === "ar" ? "للرف" : "For the shelf")}</div>
                          </div>
                          <Stepper value={n} label={size} max={r.hasBom ? undefined : 0} testId={`pack-step-${r.skuCode}`} onChange={(v) => setCounts((c) => ({ ...c, [r.id]: v }))} />
                        </div>
                      );
                    })}
                  </div>
                  {preview ? (() => {
                    const used = preview.totalConsumedGrams, avail = preview.availableGrams, left = avail - used;
                    return (
                      <div>
                        <div className="st-meter" aria-hidden="true"><i className={left < 0 ? "is-over" : ""} style={{ width: `${Math.min(100, avail > 0 ? (used / avail) * 100 : 0)}%` }} /></div>
                        <div className="st-meter-l"><span>{lang === "ar" ? "يُعبّأ" : "Packing"} <Grams v={used} /></span><span>{lang === "ar" ? "يبقى في الدفعة" : "Left in the roast"} <Grams v={Math.max(0, left)} /></span></div>
                      </div>
                    );
                  })() : null}
                  <details className="st-more">
                    <summary>{lang === "ar" ? "كيس ناقص، إكمال كيس مفتوح، أو فاقد تعبئة" : "A partial package, topping up an open one, or a packing loss"}</summary>
                    <div>
                      {/* A package below its nominal weight is the deliberate exception: only here is a weight asked for. */}
                      {partial ? (
                        <div className="st-two">
                          <div className="st-field">
                            <label htmlFor="pk-partial-sku">{lang === "ar" ? "حجم الكيس الناقص" : "Partial package size"}</label>
                            <Select id="pk-partial-sku" value={partial.skuId} onChange={(e) => setPartial({ ...partial, skuId: e.target.value })} className="hr-input" style={{ height: 48, width: "100%" }}>
                              {planRows.filter((r) => r.hasBom).map((r) => <option key={r.id} value={r.id}>{r.skuCode} · {r.weightGrams} {gUnit(lang)}</option>)}
                            </Select>
                          </div>
                          <NumIn id="pk-partial-grams" small inputMode="numeric" label={lang === "ar" ? "وزنه الفعلي" : "Actual weight"} unit={gUnit(lang)} value={partial.grams} onChange={(v) => setPartial({ ...partial, grams: v })} />
                        </div>
                      ) : (
                        <button type="button" className="st-sec" onClick={() => { const first = planRows.find((r) => r.hasBom); if (first) setPartial({ skuId: first.id, grams: "" }); }}>{lang === "ar" ? "+ كيس ناقص" : "+ A partial package"}</button>
                      )}
                      {partial ? <button type="button" className="st-textlink is-sm" onClick={() => setPartial(null)}>{lang === "ar" ? "إزالة الكيس الناقص" : "Remove the partial package"}</button> : null}
                      {(packState.openPartials ?? []).filter((op) => planRows.some((r) => r.id === op.skuId)).map((op) => (
                        <label key={op.lotId} className="st-check">
                          <input type="checkbox" checked={op.lotId in topUps} onChange={(e) => setTopUps((tu) => { const n = { ...tu }; if (e.target.checked) n[op.lotId] = Math.max(1, op.nominalGrams - op.actualGrams); else delete n[op.lotId]; return n; })} />
                          <span>{lang === "ar" ? "إكمال كيس مفتوح" : "Top up an open package"} <span className="ops-serial">{op.skuCode}</span> · <bdi dir="ltr">{op.actualGrams}/{op.nominalGrams}</bdi> {gUnit(lang)} · {t("pkgFromBatch")} {op.fromThisBatch ? t("pkgThisBatch") : op.batchNumber}</span>
                        </label>
                      ))}
                      <div className="st-two">
                        <NumIn id="pk-loss-grams" small inputMode="numeric" label={t("pkgLossGramsLabel")} unit={gUnit(lang)} value={loss.grams} onChange={(v) => setLoss((l) => ({ ...l, grams: v }))} />
                        <NumIn id="pk-loss-reason" small text inputMode="text" label={t("pkgLossReasonLabel")} value={loss.reason} onChange={(v) => setLoss((l) => ({ ...l, reason: v }))} />
                      </div>
                    </div>
                  </details>
                  {/* ── Reconciliation ────────────────────────────────────── */}
                  {preview && (() => {
                    const p = preview;
                    // The identity this whole feature exists to guarantee, checked against
                    // the numbers the server just returned rather than asserted in prose.
                    const balanced =
                      p.standardGrams + p.partialGrams + p.lossGrams + p.remainingGrams === p.availableGrams;
                    const row = (label: string, grams: number, extra?: string, tone = "text-charcoal") => (
                      <>
                        <span className="text-[11px] text-brown/70">{label}</span>
                        <span className={`text-xs font-bold tabular-nums text-end ${tone}`}>
                          <Grams v={grams} />{extra ? ` · ${extra}` : ""}
                        </span>
                      </>
                    );
                    return (
                      <div data-testid="packaging-reconciliation" className="rounded-xl border border-border p-3">
                        <p className="text-[11px] font-bold text-brown/60 uppercase mb-1.5">{t("pkgReconTitle")}</p>
                        <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                          {row(t("pkgReconAvailable"), p.availableGrams)}
                          {row(t("pkgReconStandard"), p.standardGrams, `${p.standardUnits} ${t("pkgSellableUnits")}`, "text-green-800")}
                          {row(t("pkgReconPartial"), p.partialGrams, `${p.partialPackages} ${t("pkgPackagesWord")}`, "text-amber-800")}
                          {row(t("pkgReconLoss"), p.lossGrams, undefined, p.lossGrams > 0 ? "text-red-700" : "text-charcoal")}
                          {row(t("pkgReconRemaining"), p.remainingGrams, `${gToKg(p.remainingGrams)} ${t("opsKgUnit")}`)}
                        </div>
                        <p className={`mt-2 text-[11px] font-bold ${balanced ? "text-green-700" : "text-red-700"}`}>
                          {balanced ? t("pkgReconBalanced") : t("pkgReconUnbalanced")}
                        </p>
                      </div>
                    );
                  })()}

                  {/* Materials, and the shortage that blocks rather than adjusts. */}
                  {preview && preview.materials.length > 0 && (() => {
                    const short = preview.materials.some((m) => m.missing > 0);
                    return (
                      <div
                        className={`rounded-xl border p-2.5 ${short ? "border-red-300 bg-red-50" : "border-border"}`}
                        role={short ? "alert" : undefined}
                      >
                        <p className="text-[11px] font-bold text-brown/60 uppercase mb-1 flex items-center gap-1.5">
                          {short && <AlertTriangle size={13} className="text-red-700" />}
                          {short ? t("pkgShortageTitle") : t("pkgMaterialsTitle")}
                        </p>
                        <ul className="space-y-0.5">
                          {preview.materials.map((m) => (
                            <li key={m.materialItemId} className="text-xs text-brown">
                              {m.label}: <b className="tabular-nums">{m.required}</b>{" "}
                              <span className="text-brown/60">({t("pkgShortageAvailable")} {m.available})</span>
                              {m.missing > 0 && (
                                <span className="text-red-700 font-semibold"> — {t("pkgShortageMissing")}: {m.missing}</span>
                              )}
                            </li>
                          ))}
                        </ul>
                        {short && <p className="text-[11px] font-semibold text-brown/60 mt-1.5">{t("pkgShortageNoChange")}</p>}
                      </div>
                    );
                  })()}

                  {/* Partial packages: allowed, recorded, and acknowledged. */}
                  {createsPartial && (
                    <div className="rounded-xl border border-amber-300 bg-amber-50 p-2.5" role="alert">
                      <p className="text-[11px] font-bold text-amber-900 uppercase mb-1 flex items-center gap-1.5">
                        <AlertTriangle size={13} /> {t("pkgPartialWarnTitle")}
                      </p>
                      <p className="text-xs text-amber-900 leading-relaxed mb-1.5">{t("pkgPartialWarnBody")}</p>
                      <label className="flex items-center gap-2 text-xs font-bold text-amber-900">
                        <input
                          type="checkbox"
                          checked={partialAck}
                          onChange={(e) => setPartialAck(e.target.checked)}
                          className="w-4 h-4"
                        />
                        {t("pkgPartialWarnConfirm")}
                      </label>
                    </div>
                  )}

                  {/* Every reason the server would refuse, stated before it is asked. */}
                  {preview && preview.problems.length > 0 && (
                    <ul className="rounded-xl border border-red-200 bg-red-50 p-2.5 space-y-0.5" role="alert">
                      {preview.problems.map((problem, i) => (
                        <li key={i} className="text-xs font-semibold text-red-700 flex items-start gap-1.5">
                          <AlertTriangle size={13} className="flex-shrink-0 mt-0.5" /> {problem}
                        </li>
                      ))}
                    </ul>
                  )}

                  {hasIncompleteLine && (
                    <p className="text-xs font-semibold text-brown/60">{t("pkgLineIncomplete")}</p>
                  )}

                  {/* Closing warning, next to the action that would close the batch. */}
                  {preview && preview.problems.length === 0 && preview.remainingGrams < 50 && (
                    <p className="text-xs font-bold text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 flex items-start gap-1.5">
                      <AlertTriangle size={13} className="flex-shrink-0 mt-0.5" aria-hidden="true" />
                      {t("pkgClosingWarning")}
                    </p>
                  )}

                  {packError && (
                    <p className="text-xs font-semibold text-red-700 flex items-start gap-1.5" role="alert">
                      <AlertTriangle size={13} className="flex-shrink-0 mt-0.5" /> {packError}
                    </p>
                  )}
                </>
              )}
        </div>
      </OpsPane>
    )}
    </div>
    </OpsRoot>
  );
}
