"use client";

import { Select } from "@/components/ui/Select";
import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { AlertTriangle, Trash2, CalendarDays, X, Plus } from "lucide-react";
import { Bar, Btn, Grams, Notice, OpsBanner, OpsEmpty, OpsLoading, OpsPane, OpsRoot, PageHeader, SecHead, StatusDot, Kg, gUnit, opsDate } from "@/components/ops/ui";
import EditDateModal, { type EditableBatch } from "@/components/EditDateModal";
import WorkflowFilterBar, { type FilterOption } from "@/components/WorkflowFilterBar";
import { useI18n } from "@/lib/i18n/context";
import { useUser } from "../user-context";
import { hasSubPrivilege } from "@/lib/auth-shared";
import { createRequestKeyHolder } from "@/lib/request-key";

import { RestockReason, restockReasonOk } from "@/components/ops/RestockReason";
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

// The Finished Products catalog, for packing a roast into packages of a SKU.
type CatalogSku = {
  id: string;
  skuCode: string;
  name: string;
  packSize: string;
  weightGrams: number;
  isActive: boolean;
  hasBom: boolean;
  availableUnits: number;
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

type BatchPackState = {
  batchNumber: string;
  status: string;
  availableGrams: number;
  openPartials: OpenPartial[];
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

let uidSeq = 0;
const nextUid = () => `l${++uidSeq}`;

function blankLine(kind: UiLine["kind"]): UiLine {
  const uid = nextUid();
  if (kind === "topUp") return { uid, kind, lotId: "", gramsAdded: 0 };
  if (kind === "loss") return { uid, kind, grams: 0, reason: "" };
  return { uid, kind: "pack", productSkuId: "", packages: 1, gramsEach: 0 };
}

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
  const [catalog, setCatalog] = useState<CatalogSku[]>([]);
  const [lines, setLines] = useState<UiLine[]>([]);
  const [preview, setPreview] = useState<PackagingPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [partialAck, setPartialAck] = useState(false);
  const [packError, setPackError] = useState("");
  const [packing, setPacking] = useState(false);

  // Names the packaging operation being attempted. A ref rather than state: the key must
  // survive a re-render and changing it must not cause one. All of the retry rules live in
  // the holder, which harness-selftest asserts directly — see src/lib/request-key.ts.
  const packKeyHolder = useRef(createRequestKeyHolder());

  useEffect(() => { loadData(); loadCatalog(); }, []);

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

  async function loadCatalog() {
    const res = await fetch("/api/products");
    if (res.ok) setCatalog(await res.json());
  }

  const loadPackState = useCallback(async (batchId: string) => {
    const res = await fetch(`/api/roasting-batches/${batchId}/pack`);
    setPackState(res.ok ? await res.json() : null);
  }, []);

  function openPacking(batch: Batch) {
    setPackBatch(batch);
    setPackState(null);
    setPreview(null);
    setPartialAck(false);
    setPackError("");
    setLines([blankLine("pack")]);
    setError(""); setSuccess("");
    packKeyHolder.current = createRequestKeyHolder();
    loadPackState(batch.id);
  }

  function closePacking() {
    setPackBatch(null);
    setPackState(null);
    setPreview(null);
    setLines([]);
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
      try { const d = await res.json(); setError(d.error || t("cancelFailed")); }
      catch { setError(t("cancelFailed")); }
    } else {
      setSuccess(t("batchCancelled"));
      setCancelBatch(null);
      loadData();
    }
  }

  // Only complete rows are worth asking the server about. A half-typed row is not a
  // refusal, it is an unfinished sentence.
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
        setPackError(res.ok ? "" : (data?.error ?? ""));
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
        setPackError(data.error || "Failed to pack.");
        return;
      }
      const parts = [`${data.standardUnitsCreated} ${t("pkgSellableUnits")}`];
      if (data.partialPackagesCreated > 0) parts.push(`${data.partialPackagesCreated} ${t("pkgPartialPackage")}`);
      if (data.partialPackagesCompleted > 0) parts.push(`${data.partialPackagesCompleted} ${t("pkgWillComplete")}`);
      if (data.lossGrams > 0) parts.push(`${data.lossGrams} ${gUnit(lang)} ${t("pkgReconLoss")}`);
      setSuccess(`${t("pkgDone")}: ${parts.join(" · ")}`);
      closePacking();
      loadData();
      // Finished stock changed, so the catalog's availableUnits is now stale.
      loadCatalog();
    } finally {
      setPacking(false);
    }
  }

  function updateLine(uid: string, patch: Record<string, unknown>) {
    setLines((prev) => prev.map((l) => (l.uid === uid ? ({ ...l, ...patch } as UiLine) : l)));
  }

  function changeLineKind(uid: string, kind: UiLine["kind"]) {
    setLines((prev) => prev.map((l) => (l.uid === uid ? { ...blankLine(kind), uid } : l)));
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

  const sellable = useMemo(() => catalog.filter((c) => c.isActive && c.hasBom), [catalog]);

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
      {success && <OpsBanner tone="success" onClose={() => setSuccess("")}>{success}</OpsBanner>}

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
        footer={
          <>
            <Btn variant="primary" onClick={submitPackaging} disabled={blocked}>{packing ? "…" : t("pkgConfirmBtn")}</Btn>
            <Btn onClick={closePacking} disabled={packing}>{t("cancel")}</Btn>
          </>
        }
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

              {sellable.length === 0 ? (
                <p className="text-sm font-semibold text-red-700">{t("packSkuNoProducts")}</p>
              ) : (
                <>
                  {/* ── The packaging sheet ───────────────────────────────── */}
                  <div className="space-y-2">
                    {lines.map((line, idx) => {
                      // Matched by the index the server reports, never by position in the
                      // returned array: a line the server refused produces no outcome, and
                      // position-matching would then show each later row its neighbour's verdict.
                      const completeIdx = completeLines.findIndex((c) => c.uid === line.uid);
                      const outcome = completeIdx >= 0
                        ? preview?.lines.find((o) => o.lineIndex === completeIdx)
                        : undefined;
                      const sku = line.kind === "pack" ? catalog.find((c) => c.id === line.productSkuId) : undefined;
                      const partial = line.kind === "topUp"
                        ? packState?.openPartials.find((p) => p.lotId === line.lotId)
                        : undefined;
                      return (
                        <div key={line.uid} data-testid={`pack-line-${idx}`} className="rounded-xl border border-border p-3 space-y-2">
                          <div className="flex items-center gap-2">
                            <Select
                              aria-label={t("pkgLineType")}
                              value={line.kind}
                              onChange={(e) => changeLineKind(line.uid, e.target.value as UiLine["kind"])}
                              className="px-2 py-1.5 rounded-lg border-2 border-border text-xs font-bold"
                            >
                              <option value="pack">{t("pkgLineTypeNew")}</option>
                              <option value="topUp">{t("pkgLineTypeTopUp")}</option>
                              <option value="loss">{t("pkgLineTypeLoss")}</option>
                            </Select>
                            <div className="flex-1" />
                            {lines.length > 1 && (
                              <button
                                type="button"
                                aria-label={t("pkgRemoveLine")}
                                title={t("pkgRemoveLine")}
                                onClick={() => setLines((prev) => prev.filter((l) => l.uid !== line.uid))}
                                className="p-1.5 rounded-lg text-brown/40 hover:text-red-600 hover:bg-red-50 transition-colors"
                              >
                                <X size={14} />
                              </button>
                            )}
                          </div>

                          {line.kind === "pack" && (
                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                              <label className="block sm:col-span-3">
                                <span className="text-[11px] font-bold text-brown">{t("productNameLabel")}</span>
                                <Select
                                  value={line.productSkuId}
                                  onChange={(e) => {
                                    const chosen = catalog.find((c) => c.id === e.target.value);
                                    // Default the fill to the SKU's nominal weight: a complete
                                    // package is the ordinary case, so a partial one is always
                                    // a deliberate departure the operator typed.
                                    updateLine(line.uid, {
                                      productSkuId: e.target.value,
                                      gramsEach: chosen ? Math.round(chosen.weightGrams) : 0,
                                    });
                                  }}
                                  className="w-full px-3 py-2 rounded-xl border-2 border-border text-sm"
                                >
                                  <option value="">—</option>
                                  {sellable.map((c) => (
                                    <option key={c.id} value={c.id}>{c.name} ({c.skuCode})</option>
                                  ))}
                                </Select>
                              </label>
                              <label className="block">
                                <span className="text-[11px] font-bold text-brown">{t("pkgPackagesCount")}</span>
                                <input
                                  type="number" min={1} step={1} value={line.packages || ""}
                                  onChange={(e) => updateLine(line.uid, { packages: parseInt(e.target.value, 10) || 0 })}
                                  className="w-full px-3 py-2 rounded-xl border-2 border-border text-sm tabular-nums"
                                />
                              </label>
                              <label className="block">
                                <span className="text-[11px] font-bold text-brown">{t("pkgGramsEach")}</span>
                                <input
                                  type="number" min={1} step={1} value={line.gramsEach || ""}
                                  onChange={(e) => updateLine(line.uid, { gramsEach: parseInt(e.target.value, 10) || 0 })}
                                  className="w-full px-3 py-2 rounded-xl border-2 border-border text-sm tabular-nums"
                                />
                              </label>
                              <div className="flex flex-col justify-end pb-2">
                                {sku && (
                                  <span className="text-[11px] text-brown/60">
                                    {t("pkgNominalWeight")}: <Grams strong v={Math.round(sku.weightGrams)} />
                                  </span>
                                )}
                              </div>
                            </div>
                          )}

                          {line.kind === "topUp" && (
                            packState && packState.openPartials.length === 0 ? (
                              <p className="text-xs font-semibold text-brown/60">{t("pkgNoOpenPartials")}</p>
                            ) : (
                              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                                <label className="block sm:col-span-2">
                                  <span className="text-[11px] font-bold text-brown">{t("pkgChoosePackage")}</span>
                                  <Select
                                    value={line.lotId}
                                    onChange={(e) => {
                                      const p = packState?.openPartials.find((o) => o.lotId === e.target.value);
                                      // Default to exactly what the package is short of. The
                                      // common intent is to finish the bag; anything else the
                                      // operator types over.
                                      updateLine(line.uid, {
                                        lotId: e.target.value,
                                        gramsAdded: p ? Math.max(0, p.nominalGrams - p.actualGrams) : 0,
                                      });
                                    }}
                                    className="w-full px-3 py-2 rounded-xl border-2 border-border text-sm"
                                  >
                                    <option value="">—</option>
                                    {(packState?.openPartials ?? []).map((p) => (
                                      <option key={p.lotId} value={p.lotId}>
                                        {p.skuCode} · {p.actualGrams}/{p.nominalGrams} {gUnit(lang)} · {t("pkgFromBatch")} {p.fromThisBatch ? t("pkgThisBatch") : p.batchNumber}
                                      </option>
                                    ))}
                                  </Select>
                                </label>
                                <label className="block">
                                  <span className="text-[11px] font-bold text-brown">{t("pkgGramsAdded")}</span>
                                  <input
                                    type="number" min={1} step={1} value={line.gramsAdded || ""}
                                    onChange={(e) => updateLine(line.uid, { gramsAdded: parseInt(e.target.value, 10) || 0 })}
                                    className="w-full px-3 py-2 rounded-xl border-2 border-border text-sm tabular-nums"
                                  />
                                </label>
                                {partial && (
                                  <p className="sm:col-span-3 text-[11px] text-brown/60">
                                    {t("pkgActualWeight")}: <Grams strong v={partial.actualGrams} /> ·{" "}
                                    {t("pkgNominalWeight")}: <Grams strong v={partial.nominalGrams} />
                                  </p>
                                )}
                              </div>
                            )
                          )}

                          {line.kind === "loss" && (
                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                              <label className="block">
                                <span className="text-[11px] font-bold text-brown">{t("pkgLossGramsLabel")}</span>
                                <input
                                  type="number" min={1} step={1} value={line.grams || ""}
                                  onChange={(e) => updateLine(line.uid, { grams: parseInt(e.target.value, 10) || 0 })}
                                  className="w-full px-3 py-2 rounded-xl border-2 border-border text-sm tabular-nums"
                                />
                              </label>
                              <label className="block sm:col-span-2">
                                <span className="text-[11px] font-bold text-brown">{t("pkgLossReasonLabel")}</span>
                                <input
                                  type="text" value={line.reason}
                                  onChange={(e) => updateLine(line.uid, { reason: e.target.value })}
                                  className="w-full px-3 py-2 rounded-xl border-2 border-border text-sm"
                                />
                              </label>
                            </div>
                          )}

                          {/* What this row will actually produce, decided by the server. */}
                          {outcome && (
                            <div data-testid="line-outcome" className="flex items-center gap-2 flex-wrap text-[11px] font-bold">
                              {outcome.classification === "STANDARD" && (
                                <span className="px-2 py-0.5 rounded-full bg-green-100 text-green-800">
                                  {outcome.kind === "topUp" ? t("pkgWillComplete") : t("pkgCompletePackage")}
                                </span>
                              )}
                              {outcome.classification === "PARTIAL" && (
                                <span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-800">
                                  {outcome.kind === "topUp" ? t("pkgStaysPartial") : t("pkgPartialPackage")}
                                </span>
                              )}
                              {outcome.classification === "LOSS" && (
                                <span className="px-2 py-0.5 rounded-full bg-red-100 text-red-800">{t("pkgReconLoss")}</span>
                              )}
                              <span className="text-brown/60 tabular-nums">
                                <Grams v={outcome.gramsConsumed} />
                                {outcome.kind !== "loss" && outcome.nominalGrams > 0 && (
                                  <> · {t("pkgActualWeight")} <bdi dir="ltr"><span className="hr-num">{outcome.actualGramsEach} / {outcome.nominalGrams}</span></bdi> {gUnit(lang)}</>
                                )}
                              </span>
                            </div>
                          )}
                        </div>
                      );
                    })}

                    <button
                      type="button"
                      onClick={() => setLines((prev) => [...prev, blankLine("pack")])}
                      className="flex items-center gap-1.5 px-3 py-2 rounded-xl border-2 border-dashed border-border text-xs font-bold text-brown hover:border-orange/60 hover:text-orange transition-colors"
                    >
                      <Plus size={14} /> {t("pkgAddLine")}
                    </button>
                  </div>

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
