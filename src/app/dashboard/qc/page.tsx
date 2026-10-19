"use client";

import { Select } from "@/components/ui/Select";
import { useState, useEffect, useCallback, useMemo } from "react";
import { Plus, Coffee, CheckCircle2, XCircle, Link2, AlertTriangle, Loader2, Trash2, CalendarDays } from "lucide-react";
import EditDateModal, { type EditableBatch } from "@/components/EditDateModal";
import WorkflowFilterBar, { type FilterOption } from "@/components/WorkflowFilterBar";
import { useUser } from "../user-context";
import Link from "next/link";
import { hasSubPrivilege, hasModuleAccess } from "@/lib/auth-shared";
import { useI18n } from "@/lib/i18n/context";
import type { TranslationKey } from "@/lib/i18n/translations";
import toast from "react-hot-toast";
import { Btn, KV, Notice, OpsEmpty, OpsError, OpsLoading, OpsPane, OpsRoot, PageHeader, SecHead, StatusDot, Tabs, Kg, kg, opsDate, countNoun, BATCH_FORMS, CUP_FORMS, SCORE_FORMS } from "@/components/ops/ui";

import { RestockReason, restockReasonOk } from "@/components/ops/RestockReason";
type CustomerPref = {
  id: string;
  greenBeanId: string;
  profileName: string;
  targetColorWhole:      number | null;
  targetToleranceWhole:  number | null;
  targetColorGround:     number | null;
  targetToleranceGround: number | null;
  targetDeltaMin:        number | null;
  targetDeltaMax:        number | null;
};

type TesterRecord = {
  id: string;
  testerName: string | null;
  isExternal: boolean;
  decision: string;
  color: number | null;
  colorWhole: number | null;
  colorGround: number | null;
  remarks: string | null;
  underDeveloped: boolean;
  overDeveloped: boolean;
  date: string;
  employee: { id: string; name: string } | null;
  coffeeOrigin: string;
  processing: string;
  serialNumber: string;
  _count?: { correctionHistory: number };
};

type CorrectionFieldChange = {
  id: string;
  fieldName: string;
  oldValue: string | null;
  newValue: string | null;
};

type CorrectionEvent = {
  id: string;
  correctionReason: string;
  changedById: string;
  changedByName: string;
  changedAt: string;
  fieldChanges: CorrectionFieldChange[];
};

type Batch = {
  id: string;
  batchNumber: string;
  date: string;
  status: string;
  blendTiming: string | null;
  roastedBeanQuantity: number;
  greenBeanQuantity: number;
  roastProfile: string | null;
  parentBatchId: string | null;
  qcDeadline: string | null;
  qcToken: string | null;
  // Nullable since roast-to-stock: a batch roasted for the shelf has no order behind it.
  orderItem: {
    beanTypeName: string;
    greenBeanId: string | null;
    order: { orderNumber: number; customer: { name: string; roastPreferences: CustomerPref[] } };
  } | null;
  greenBean: { beanType: string; process: string } | null;
  qcRecords: TesterRecord[];
  childBatches: { id: string; batchNumber: string }[];
  parentBatch: { id: string; batchNumber: string } | null;
};

type LegacyRecord = {
  id: string;
  date: string;
  coffeeOrigin: string;
  processing: string;
  serialNumber: string;
  onProfile: boolean;
  underDeveloped: boolean;
  overDeveloped: boolean;
  color: number | null;
  remarks: string | null;
  testerName: string | null;
  isExternal: boolean;
  decision: string;
  employee: { id: string; name: string } | null;
};

function AgtronTable({
  records, pref, t,
}: {
  records: TesterRecord[];
  pref: CustomerPref | null;
  t: (k: TranslationKey) => string;
}) {
  const passCheck = (actual: number | null, target: number | null, tol: number | null) => {
    if (actual == null || target == null || tol == null) return null;
    return Math.abs(actual - target) <= tol;
  };

  return (
    <div className="hr-tablewrap" style={{ marginTop: 8 }}>
      <p className="hr-label" style={{ margin: "0 0 4px" }}>
        {t("agtronResults")}{pref ? ` · ${pref.profileName}` : ""}
      </p>
      <table className="hr-table ops-prep" aria-label={t("agtronResults")}>
        <thead>
          <tr>
            <th>{t("tester")}</th>
            <th className="num">{t("colorWholeLabel")}</th>
            <th className="num">{t("colorGroundLabel")}</th>
            <th className="num">{t("colorDeltaLabel")}</th>
          </tr>
        </thead>
        <tbody>
          {pref && (pref.targetColorWhole != null || pref.targetColorGround != null) && (
            <tr>
              <td className="hr-muted" data-label={t("tester")}>{t("targetHint")}</td>
              <td className="num hr-num hr-muted" data-label={t("colorWholeLabel")}>
                {pref.targetColorWhole ?? "—"}{pref.targetToleranceWhole != null ? ` ±${pref.targetToleranceWhole}` : ""}
              </td>
              <td className="num hr-num hr-muted" data-label={t("colorGroundLabel")}>
                {pref.targetColorGround ?? "—"}{pref.targetToleranceGround != null ? ` ±${pref.targetToleranceGround}` : ""}
              </td>
              <td className="num hr-num hr-muted" data-label={t("colorDeltaLabel")}>
                {(pref.targetDeltaMin != null && pref.targetDeltaMax != null) ? `${pref.targetDeltaMin}–${pref.targetDeltaMax}` : "—"}
              </td>
            </tr>
          )}
          {records.map((r) => {
            const delta = (r.colorWhole != null && r.colorGround != null)
              ? Math.abs(r.colorGround - r.colorWhole) : null;
            const wholePass  = pref ? passCheck(r.colorWhole,  pref.targetColorWhole,  pref.targetToleranceWhole)  : null;
            const groundPass = pref ? passCheck(r.colorGround, pref.targetColorGround, pref.targetToleranceGround) : null;
            const deltaPass  = pref && delta != null && pref.targetDeltaMin != null && pref.targetDeltaMax != null
              ? (delta >= pref.targetDeltaMin && delta <= pref.targetDeltaMax) : null;
            if (r.colorWhole == null && r.colorGround == null) return null;
            const badge = (pass: boolean | null) => pass === true
              ? <span className="hr-dot tone-success"><span>{t("passLabel")}</span></span>
              : pass === false
              ? <span className="hr-dot tone-danger"><span>{t("failLabel")}</span></span>
              : null;
            return (
              <tr key={r.id}>
                <td data-label={t("tester")}>{r.testerName || r.employee?.name || "—"}</td>
                <td className="num" data-label={t("colorWholeLabel")}><span className="hr-num">{r.colorWhole ?? "—"}</span> {badge(wholePass)}</td>
                <td className="num" data-label={t("colorGroundLabel")}><span className="hr-num">{r.colorGround ?? "—"}</span> {badge(groundPass)}</td>
                <td className="num" data-label={t("colorDeltaLabel")}><strong className="hr-num">{delta != null ? delta.toFixed(1) : "—"}</strong> {badge(deltaPass)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const BLANK_FORM = {
  batchId: "", coffeeOrigin: "", processing: "", serialNumber: "",
  decision: "" as "Accept" | "Reject" | "",
  underDeveloped: false, overDeveloped: false,
  color: "", colorWhole: "", colorGround: "",
  remarks: "",
  correctionReason: "",
};

const FIELD_LABELS: Record<string, string> = {
  decision: "Decision",
  onProfile: "On Profile",
  underDeveloped: "Under Developed",
  overDeveloped: "Over Developed",
  color: "Color (Agtron)",
  colorWhole: "Color Whole",
  colorGround: "Color Ground",
  remarks: "Remarks",
  coffeeOrigin: "Coffee Origin",
  processing: "Processing",
  serialNumber: "Serial Number",
};

function formatFieldValue(raw: string | null): string {
  if (raw === null || raw === "null") return "—";
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "boolean") return parsed ? "Yes" : "No";
    if (parsed === null) return "—";
    return String(parsed);
  } catch {
    return raw;
  }
}

type QcCuppingSession = {
  id: string; name: string; status: string;
  batch: { batchNumber: string } | null;
  sessionBatches: { id: string }[];
  _count: { scores: number };
};

export default function QCPage() {
  const user = useUser();
  const { t, lang } = useI18n();
  const canCreate = hasSubPrivilege(user?.permissions ?? {}, "qc", "create_record");
  const canManage = hasSubPrivilege(user?.permissions ?? {}, "qc", "manage");
  const canEditRecord = hasSubPrivilege(user?.permissions ?? {}, "qc", "edit_record");
  const canCancelBatch = hasSubPrivilege(user?.permissions ?? {}, "production", "cancel_batch");
  const canEditDate = hasSubPrivilege(user?.permissions ?? {}, "production", "edit_date");
  const canOverrideInventory = hasSubPrivilege(user?.permissions ?? {}, "inventory", "override");

  const [backlogBatches, setBacklogBatches] = useState<Batch[]>([]);
  const [historyBatches, setHistoryBatches] = useState<Batch[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [records, setRecords] = useState<LegacyRecord[]>([]);
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<"backlog" | "history" | "records">("backlog");

  // Backlog filter state
  const [backlogSearch, setBacklogSearch] = useState("");
  const [backlogBean, setBacklogBean] = useState("");
  const [backlogOrder, setBacklogOrder] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Correction history
  const [expandedCorrectionId, setExpandedCorrectionId] = useState<string | null>(null);
  const [correctionsCache, setCorrectionsCache] = useState<Record<string, CorrectionEvent[]>>({});
  const [loadingCorrectionId, setLoadingCorrectionId] = useState<string | null>(null);

  // Batch serial superseded lookup
  const [serialLookup, setSerialLookup] = useState<{
    found: boolean;
    query: string;
    currentMatches: { id: string; batchNumber: string; date: string; status: string; beanType: string | null }[];
    superseded: { oldBatchNumber: string; newBatchNumber: string; batchId: string; currentBatchNumber: string | null; date: string | null; status: string | null; beanType: string | null; changedAt: string; reason: string | null }[];
  } | null>(null);

  // Panel submission form
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(BLANK_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [editingRecordId, setEditingRecordId] = useState<string | null>(null);

  // Finalize modal (single batch)
  const [finalizeBatch, setFinalizeBatch] = useState<Batch | null>(null);
  const [finalizeOutcome, setFinalizeOutcome] = useState<"Passed" | "Rejected" | "">("");
  const [finalizeReason, setFinalizeReason] = useState("");
  const [finalizing, setFinalizing] = useState(false);

  // Invite link modal
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [generatingInvite, setGeneratingInvite] = useState<string | null>(null);
  const [cancelBatch, setCancelBatch] = useState<Batch | null>(null);
  const [cancelling, setCancelling] = useState(false);
  // The restock reason belongs to the batch being cancelled: opening another batch starts empty.
  const [restockDraft, setRestockDraft] = useState<{ batchId: string; text: string }>({ batchId: "", text: "" });
  const restockReason = cancelBatch && restockDraft.batchId === cancelBatch.id ? restockDraft.text : "";
  const setRestockReason = (text: string) => setRestockDraft({ batchId: cancelBatch?.id ?? "", text });
  const [editDateBatch, setEditDateBatch] = useState<EditableBatch | null>(null);

  // Bulk finalize
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showBulkWarning, setShowBulkWarning] = useState(false);
  const [showBulkModal, setShowBulkModal] = useState(false);
  const [bulkOutcome, setBulkOutcome] = useState<"Passed" | "Rejected">("Passed");
  const [bulkFinalizeReason, setBulkFinalizeReason] = useState("");
  const [isBulkFinalizing, setIsBulkFinalizing] = useState(false);

  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  // N-10: the latest cupping sessions under the queue (GET /api/cupping/sessions, unchanged).
  const canCuppingRead = hasModuleAccess(user?.permissions ?? {}, "cupping");
  const [sessions, setSessions] = useState<QcCuppingSession[] | null>(null);
  useEffect(() => {
    if (!canCuppingRead) return;
    let live = true;
    fetch("/api/cupping/sessions")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (live && Array.isArray(j)) setSessions(j); })
      .catch(() => {});
    return () => { live = false; };
  }, [canCuppingRead]);
  const loadBacklog = useCallback(async () => {
    const [batchRes, qcRes] = await Promise.all([
      fetch("/api/roasting-batches?statuses=Pending+QC"),
      fetch("/api/qc-records"),
    ]);
    const take = async (r: Response) => (r.ok ? r.json() : (await r.text(), null));
    const [batchJ, qcJ] = await Promise.all([batchRes, qcRes].map(take));
    setLoadError(batchJ === null);
    if (batchJ) setBacklogBatches(batchJ);
    if (qcJ) setRecords(qcJ);
    setLoaded(true);
  }, []);

  const loadHistory = useCallback(async () => {
    const res = await fetch("/api/roasting-batches?statuses=Passed,Rejected,Blended");
    if (res.ok) { setHistoryBatches(await res.json()); setHistoryLoaded(true); }
  }, []);

  useEffect(() => { loadBacklog(); }, [loadBacklog]);

  useEffect(() => {
    if (tab === "history" && !historyLoaded) loadHistory();
  }, [tab, historyLoaded, loadHistory]);

  useEffect(() => {
    const q = backlogSearch.trim();
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
  }, [backlogSearch]);

  function closeForm() {
    setShowForm(false);
    setForm(BLANK_FORM);
    setEditingRecordId(null);
  }

  async function toggleCorrectionHistory(recordId: string) {
    if (expandedCorrectionId === recordId) {
      setExpandedCorrectionId(null);
      return;
    }
    setExpandedCorrectionId(recordId);
    if (correctionsCache[recordId]) return;
    setLoadingCorrectionId(recordId);
    try {
      const res = await fetch(`/api/qc-records/${recordId}/corrections`);
      if (res.ok) {
        const data = await res.json();
        setCorrectionsCache((prev) => ({ ...prev, [recordId]: data.corrections }));
      }
    } finally {
      setLoadingCorrectionId(null);
    }
  }

  function startQcForBatch(batch: Batch) {
    setEditingRecordId(null);
    setForm({
      ...BLANK_FORM,
      batchId: batch.id,
      coffeeOrigin: batch.greenBean?.beanType || (batch.orderItem?.beanTypeName ?? ""),
      processing: batch.greenBean?.process || "",
      serialNumber: batch.batchNumber,
    });
    setShowForm(true);
  }

  function startEditRecord(record: TesterRecord, batch: Batch) {
    setEditingRecordId(record.id);
    setForm({
      batchId: batch.id,
      coffeeOrigin: record.coffeeOrigin || batch.greenBean?.beanType || (batch.orderItem?.beanTypeName ?? ""),
      processing: record.processing || "",
      serialNumber: record.serialNumber || batch.batchNumber,
      decision: (record.decision === "Accept" || record.decision === "Reject") ? record.decision : "",
      underDeveloped: record.underDeveloped,
      overDeveloped: record.overDeveloped,
      color: record.color != null ? String(record.color) : "",
      colorWhole: record.colorWhole != null ? String(record.colorWhole) : "",
      colorGround: record.colorGround != null ? String(record.colorGround) : "",
      remarks: record.remarks ?? "",
      correctionReason: "",
    });
    setShowForm(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.decision) { toast.error(t("verdict")); return; }
    const hasRejectReason =
      form.underDeveloped ||
      form.overDeveloped ||
      Boolean(form.remarks?.trim());
    if (form.decision === "Reject" && !hasRejectReason) {
      toast.error("Please select a rejection reason or write a remark.");
      return;
    }
    if (editingRecordId && !form.correctionReason.trim()) {
      toast.error("Correction reason is required.");
      return;
    }
    setSubmitting(true);
    try {
      const basePayload = {
        decision: form.decision,
        coffeeOrigin: form.coffeeOrigin,
        processing: form.processing,
        serialNumber: form.serialNumber,
        color: form.color || null,
        colorWhole:  form.colorWhole  ? form.colorWhole  : null,
        colorGround: form.colorGround ? form.colorGround : null,
        remarks: form.remarks || null,
        underDeveloped: form.underDeveloped,
        overDeveloped: form.overDeveloped,
      };

      const res = editingRecordId
        ? await fetch(`/api/qc-records/${editingRecordId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...basePayload, correctionReason: form.correctionReason.trim() }),
          })
        : await fetch(`/api/qc/${form.batchId}/records`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(basePayload),
          });

      const data = await res.json();
      if (!res.ok) { toast.error(data.error || t("error")); return; }
      toast.success(editingRecordId ? "QC record corrected." : t("saveRecord"));
      if (editingRecordId) {
        setCorrectionsCache((prev) => {
          const next = { ...prev };
          delete next[editingRecordId];
          return next;
        });
      }
      closeForm();
      loadBacklog();
    } finally {
      setSubmitting(false);
    }
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
      try { const d = await res.json(); toast.error(d.error || "Failed to cancel batch"); }
      catch { toast.error("Failed to cancel batch"); }
    } else {
      toast.success("Batch cancelled");
      setCancelBatch(null);
      loadBacklog();
    }
  }

  async function handleFinalize(batch: Batch, outcome: "Passed" | "Rejected", reason: string) {
    setFinalizing(true);
    try {
      const res = await fetch(`/api/qc/${batch.id}/finalize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ outcome, ...(reason.trim() ? { finalDecisionReason: reason.trim() } : {}) }),
      });
      const data = await res.json();
      if (!res.ok) { toast.error(data.error || t("error")); return; }
      toast.success(`${data.status}: ${data.acceptCount}/${data.total} ${t("accepted")}`);
      setFinalizeBatch(null);
      setFinalizeOutcome("");
      setFinalizeReason("");
      loadBacklog();
      if (historyLoaded) loadHistory();
    } finally {
      setFinalizing(false);
    }
  }

  function toggleBatch(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function handleBulkFinalizeClick() {
    const selected = filteredBacklog.filter((b) => selectedIds.has(b.id));
    const hasLowTesters = selected.some((b) => b.qcRecords.length <= 1);
    if (hasLowTesters) {
      setShowBulkWarning(true);
    } else {
      setShowBulkModal(true);
    }
  }

  async function executeBulkFinalize() {
    setIsBulkFinalizing(true);
    try {
      const res = await fetch("/api/qc-records/bulk-finalize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          batchIds: Array.from(selectedIds),
          outcome: bulkOutcome,
          ...(bulkFinalizeReason.trim() ? { finalDecisionReason: bulkFinalizeReason.trim() } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) { toast.error(data.error || t("error")); return; }
      toast.success(t("bulkDone").replace("{n}", String(data.finalized)));
      setSelectedIds(new Set());
      setShowBulkModal(false);
      setShowBulkWarning(false);
      setBulkFinalizeReason("");
      loadBacklog();
      if (historyLoaded) loadHistory();
    } finally {
      setIsBulkFinalizing(false);
    }
  }

  async function handleGenerateInvite(batchId: string) {
    setGeneratingInvite(batchId);
    try {
      const res = await fetch(`/api/qc/${batchId}/invite`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) { toast.error(data.error || t("error")); return; }
      const link = `${window.location.origin}/guest-qc/${batchId}/${data.token}`;
      setInviteLink(link);
    } finally {
      setGeneratingInvite(null);
    }
  }

  function copyToClipboard(text: string) {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text)
        .then(() => toast.success(t("copyLink")))
        .catch(() => fallbackCopy(text));
    } else {
      fallbackCopy(text);
    }
  }

  function fallbackCopy(text: string) {
    const el = document.createElement("textarea");
    el.value = text;
    el.style.position = "fixed"; el.style.opacity = "0";
    document.body.appendChild(el);
    el.select();
    document.execCommand("copy");
    document.body.removeChild(el);
    toast.success(t("copyLink"));
  }

  // N-10 (prd-qc-closed-1024): the page meta is the queue — «4 دفعات بانتظار القرار · 17.03 كغ».
  const backlogKg = backlogBatches.reduce((a, b) => a + (Number(b.roastedBeanQuantity) || 0), 0);
  const filtered = records.filter((r) =>
    `${r.coffeeOrigin} ${r.processing} ${r.serialNumber} ${r.remarks || ""} ${r.testerName || ""}`.toLowerCase().includes(search.toLowerCase())
  );
  const now = new Date();

  const backlogBeanOptions = useMemo<FilterOption[]>(() => {
    const seen = new Set<string>();
    const opts: FilterOption[] = [];
    for (const b of backlogBatches) {
      const v = b.greenBean?.beanType || (b.orderItem?.beanTypeName ?? "");
      if (!seen.has(v)) { seen.add(v); opts.push({ label: v, value: v }); }
    }
    return opts;
  }, [backlogBatches]);

  const backlogOrderOptions = useMemo<FilterOption[]>(() => {
    const seen = new Set<string>();
    const opts: FilterOption[] = [];
    for (const b of backlogBatches) {
      const v = String((b.orderItem?.order.orderNumber ?? t("stockBatchLabel")));
      if (!seen.has(v)) { seen.add(v); opts.push({ label: `#${v} – ${(b.orderItem?.order.customer.name ?? t("stockBatchLabel"))}`, value: v }); }
    }
    return opts;
  }, [backlogBatches, t]);

  const filteredBacklog = useMemo(() => {
    const q = backlogSearch.toLowerCase();
    return backlogBatches.filter((b) => {
      const beanType = b.greenBean?.beanType || (b.orderItem?.beanTypeName ?? "");
      if (backlogBean && beanType !== backlogBean) return false;
      if (backlogOrder && String((b.orderItem?.order.orderNumber ?? t("stockBatchLabel"))) !== backlogOrder) return false;
      if (q) {
        const haystack = `${b.batchNumber} ${(b.orderItem?.order.orderNumber ?? t("stockBatchLabel"))} ${(b.orderItem?.order.customer.name ?? t("stockBatchLabel"))} ${beanType}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [backlogBatches, backlogSearch, backlogBean, backlogOrder, t]);

  function deadlineDisplay(deadline: string | null) {
    if (!deadline) return null;
    const d = new Date(deadline);
    const isOverdue = d < now;
    const isUrgent = !isOverdue && d < new Date(now.getTime() + 6 * 60 * 60 * 1000);
    return {
      label: isOverdue ? t("overdue") : isUrgent ? t("dueSoon") : opsDate(deadline, lang),
      isOverdue,
      isUrgent,
    };
  }

  // Translate status badge label — display only, don't affect comparison logic
  function statusBadgeLabel(status: string): string {
    const map: Record<string, TranslationKey> = {
      "Passed":   "statusPassed",
      "Rejected": "rejectedLabel",
      "Blended":  "statusBlended",
    };
    return map[status] ? t(map[status]) : status;
  }

  const tone = (d: string) => (d === "Accept" ? "success" : "danger");
  const allSelected = filteredBacklog.length > 0 && filteredBacklog.every((b) => selectedIds.has(b.id));

  return (
    <OpsRoot>
    <div className={`hr-split${finalizeBatch ? " has-preview" : ""}`}>
    <div className="hr-page">
      <PageHeader
        title={t("opsQcTitle")}
        // N-10: the reference's one header action is «جلسة تذوق» (to the cupping sessions). The
        // «سجل جودة جديد» create action stays beside it as a secondary button: no decision
        // removed it, and it is the way to record against a batch chosen in the form.
        actions={(canCuppingRead || (canCreate && tab === "backlog")) ? (
          <>
            {canCuppingRead ? (
              <Link href="/dashboard/cupping" className="hr-btn"><Coffee size={16} aria-hidden="true" /> {t("opsQcCuppingSession")}</Link>
            ) : null}
            {canCreate && tab === "backlog" ? (
              <Btn onClick={() => setShowForm(true)}>
                <Plus size={16} aria-hidden="true" /> {t("newQcRecord")}
              </Btn>
            ) : null}
          </>
        ) : null}
      >
        <span>{countNoun(backlogBatches.length, lang, BATCH_FORMS)} {t("opsQcAwaiting")}</span>
        <span aria-hidden="true">·</span>
        <Kg v={backlogKg} />
      </PageHeader>

      <Tabs
        label={t("qc")}
        value={tab}
        onChange={(k) => setTab(k)}
        items={[
          { key: "backlog", label: t("qcBacklog"), count: backlogBatches.length },
          { key: "history", label: t("qcHistory"), count: historyBatches.length },
          { key: "records", label: t("opsTesterRecordsTab"), count: records.length },
        ]}
      />

      {loadError ? <OpsError message={t("opsLoadFailed")} onRetry={loadBacklog} /> : null}
      {!loaded && !loadError ? <OpsLoading /> : null}

      {/* Tab 1: QC Backlog */}
      {loaded && tab === "backlog" && (
        <>
          {backlogBatches.length > 0 && (
            <WorkflowFilterBar
              searchQuery={backlogSearch} onSearchChange={setBacklogSearch}
              beanOptions={backlogBeanOptions} selectedBean={backlogBean} onBeanChange={setBacklogBean}
              orderOptions={backlogOrderOptions} selectedOrder={backlogOrder} onOrderChange={setBacklogOrder}
              resultCount={filteredBacklog.length} totalCount={backlogBatches.length}
            />
          )}
          {/* Select All + Bulk Finalize row */}
          {canManage && filteredBacklog.length > 0 && (
            // Q-3: beside the decision pane the row checkboxes are hidden, so «تحديد الكل» is too.
            <div className="hr-filterbar hr-hide-preview" style={{ justifyContent: "space-between" }}>
              <label style={{ display: "inline-flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 13.5 }}>
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={(e) => {
                    if (e.target.checked) setSelectedIds(new Set(filteredBacklog.map((b) => b.id)));
                    else setSelectedIds(new Set());
                  }}
                />
                {allSelected ? t("deselectAll") : t("selectAll")}
              </label>
              {selectedIds.size > 0 && (
                <Btn onClick={handleBulkFinalizeClick}>{t("bulkFinalize")} ({selectedIds.size})</Btn>
              )}
            </div>
          )}
          {serialLookup?.query === backlogSearch.trim() && serialLookup.superseded.length > 0 && (
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
          {filteredBacklog.length === 0 ? (
            <OpsEmpty title={t("noBatchesAwaitingQc")} body={t("batchesAfterRoasting")} />
          ) : (
            <div className="hr-tablewrap is-bleed">
              <table className="hr-table is-mrow ops-qc ops-qcq" aria-label={t("qcBacklog")}>
                <thead>
                  <tr>
                    {canManage ? <th className="hr-hide-preview" aria-label={t("selectAll")} /> : null}
                    <th>{t("opsBatchCol")}</th>
                    <th>{t("opsProductOrderCol")}</th>
                    <th className="num">{t("opsRoastedOutCol")}</th>
                    <th>{t("opsDeadlineCol")}</th>
                    <th>{t("opsRecordsCol")}</th>
                    <th className="hr-hide-preview" aria-label={t("opsActions")} />
                  </tr>
                </thead>
                {filteredBacklog.map((batch) => {
                  const dl = deadlineDisplay(batch.qcDeadline);
                  const acceptCount = batch.qcRecords.filter((r) => r.decision === "Accept").length;
                  const rejectCount = batch.qcRecords.filter((r) => r.decision === "Reject").length;
                  const total = batch.qcRecords.length;
                  const alreadySubmitted = batch.qcRecords.some((r) => !r.isExternal && r.employee?.id === user?.id);
                  const isExpanded = expandedId === batch.id;
                  const cols = canManage ? 7 : 6;
                  // prd-qc: with the decision pane open, choosing another row moves the pane to it —
                  // by mouse, or by keyboard (Q-2: the row takes focus, Enter / Space pick it).
                  const pickable = !!finalizeBatch && canManage && total > 0 && finalizeBatch.id !== batch.id && !finalizing;
                  const pick = () => { setFinalizeBatch(batch); setFinalizeOutcome(""); setFinalizeReason(""); };
                  return (
                    <tbody key={batch.id} data-testid={`qc-batch-${batch.batchNumber}`}>
                      <tr aria-selected={isExpanded || finalizeBatch?.id === batch.id} className={`${dl?.isOverdue ? "is-overdue" : ""}${finalizeBatch && canManage && total > 0 ? " ops-rowpick" : ""}`}
                        tabIndex={pickable ? 0 : undefined}
                        onKeyDown={pickable ? (e) => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); pick(); } } : undefined}
                        onClick={pickable ? pick : undefined}>
                        {canManage ? (
                          <td className="hr-hide-preview">
                            <input type="checkbox" aria-label={batch.batchNumber} checked={selectedIds.has(batch.id)} onChange={() => toggleBatch(batch.id)} />
                          </td>
                        ) : null}
                        <td>
                          <span className="ops-serial">{batch.batchNumber}</span>
                          {canEditDate && (
                            <button type="button" className="hr-btn is-ghost is-sm" style={{ height: 24, padding: "0 4px", marginInlineStart: 4 }} onClick={(e) => { e.stopPropagation(); setEditDateBatch(batch); }} title={t("editDateBtn")} aria-label={t("editDateBtn")}>
                              <CalendarDays size={13} aria-hidden="true" />
                            </button>
                          )}
                        </td>
                        <td className="m-title">
                          <span className="strong">{batch.greenBean?.beanType || (batch.orderItem?.beanTypeName ?? "")}</span>
                          {/* Beside the pane the product cell is one line, «product · #order» (prd-qc-1440). */}
                          {finalizeBatch ? <span className="hr-caption ops-split-only"> · {batch.orderItem ? <span className="hr-id">#{batch.orderItem.order.orderNumber}</span> : t("stockBatchLabel")}</span> : null}
                          <span className="ops-line hr-hide-preview">
                            <span className="hr-mobile-only"><span className="ops-serial">{batch.batchNumber}</span> · </span>
                            {batch.orderItem ? <><span className="hr-id">#{batch.orderItem.order.orderNumber}</span> · {batch.orderItem.order.customer.name}</> : t("stockBatchLabel")}
                            {batch.roastProfile ? <> · {batch.roastProfile}</> : null}
                            {batch.blendTiming ? <> · {t("statusBlended")} {batch.blendTiming === "Before QC" ? t("blendBeforeQc") : t("blendAfterQc")}</> : null}
                          </span>
                          <span className="hr-msub">
                            {dl ? <>{dl.label} · </> : null}<span className="hr-num">{total}</span> {total !== 1 ? t("testers") : t("tester")}
                          </span>
                        </td>
                        <td className="num"><span className="hr-num">{kg(batch.roastedBeanQuantity)}</span></td>
                        <td>
                          {dl ? (
                            dl.isOverdue ? <span className="hr-flag tone-danger"><span>{dl.label}</span></span>
                              : dl.isUrgent ? <span className="hr-flag tone-warning"><span>{dl.label}</span></span>
                              : <span>{dl.label}</span>
                          ) : <span className="hr-muted">—</span>}
                        </td>
                        <td style={{ whiteSpace: "nowrap" }}>
                          <span className="hr-num">{total}</span> {total !== 1 ? t("testers") : t("tester")}
                          {total > 0 ? <span className="hr-caption hr-hide-preview"> · <span style={{ color: "var(--status-success)" }}>{acceptCount} {t("accept")}</span> · <span style={{ color: rejectCount ? "var(--status-danger)" : undefined }}>{rejectCount} {t("reject")}</span></span> : null}
                        </td>
                        <td className="m-end ops-actions hr-hide-preview">
                          {canCreate && !alreadySubmitted && (
                            <Btn size="sm" variant="primary" onClick={() => startQcForBatch(batch)}>{t("addMyRecord")}</Btn>
                          )}
                          {canCreate && alreadySubmitted && (
                            <span className="hr-dot tone-success"><span>{t("submitted")}</span></span>
                          )}
                          {canManage && total > 0 && (
                            <Btn size="sm" onClick={() => { setFinalizeBatch(batch); setFinalizeOutcome(""); setFinalizeReason(""); }}>{t("finalizeQc")}</Btn>
                          )}
                          {canManage && (
                            <Btn size="sm" variant="ghost" onClick={() => handleGenerateInvite(batch.id)} busy={generatingInvite === batch.id}>{t("guestLink")}</Btn>
                          )}
                          <Btn size="sm" variant="ghost" aria-expanded={isExpanded} onClick={() => setExpandedId(isExpanded ? null : batch.id)}>
                            {isExpanded ? t("collapse") : t("panel")}
                          </Btn>
                          {canCancelBatch && (
                            <button type="button" className="hr-btn is-ghost is-sm" onClick={() => setCancelBatch(batch)} title={t("cancelBatchTitle")} aria-label={t("cancelBatchTitle")}>
                              <Trash2 size={15} aria-hidden="true" />
                            </button>
                          )}
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr className="ops-detailrow">
                          <td colSpan={cols}>
                            {total === 0 ? (
                              <p className="hr-caption" style={{ margin: 0 }}>{t("noTesterRecords")}</p>
                            ) : (() => {
                              const batchGbId = (batch.orderItem?.greenBeanId ?? null);
                              const batchPref = (batch.orderItem?.order.customer.roastPreferences ?? []).find(
                                (p) => p.greenBeanId === batchGbId
                              ) ?? null;
                              const hasAgtron = batch.qcRecords.some((r) => r.colorWhole != null || r.colorGround != null);
                              return (
                                <div className="hr-stack" style={{ gap: 8 }}>
                                  <p className="hr-label" style={{ margin: 0 }}>{t("testerRecords")}</p>
                                  <ul className="ops-list">
                                    {batch.qcRecords.map((r) => {
                                      const corrCount = r._count?.correctionHistory ?? 0;
                                      const isCorrExpanded = expandedCorrectionId === r.id;
                                      const cachedCorrs = correctionsCache[r.id];
                                      const isLoadingCorr = loadingCorrectionId === r.id;
                                      return (
                                        <li key={r.id} style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
                                          <span style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "baseline" }}>
                                            <span>
                                              {r.testerName || r.employee?.name || "—"}
                                              {r.isExternal ? <> <span className="hr-flag tone-info"><span>{t("guestBadge")}</span></span></> : null}
                                              {corrCount > 0 ? <> <span className="hr-flag tone-warning"><span>{t("opsEdited")}</span></span></> : null}
                                              {r.color ? <span className="hr-caption"> · {t("colorLabel")} <span className="hr-num">{r.color}</span></span> : null}
                                              {r.remarks ? <span className="ops-sub">{r.remarks}</span> : null}
                                            </span>
                                            <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
                                              {corrCount > 0 && (
                                                <button type="button" className="hr-btn is-ghost is-sm" onClick={() => toggleCorrectionHistory(r.id)}>
                                                  {isCorrExpanded ? t("opsHideHistory") : `${t("opsHistory")} (${corrCount})`}
                                                </button>
                                              )}
                                              {canEditRecord && (r.employee?.id === user?.id || canManage) && (
                                                <button type="button" className="hr-btn is-sm" onClick={() => startEditRecord(r, batch)}>{t("opsCorrect")}</button>
                                              )}
                                              <span className={`hr-dot tone-${tone(r.decision)}`}><span>{r.decision === "Accept" ? t("accept") : t("reject")}</span></span>
                                            </span>
                                          </span>
                                          {isCorrExpanded && (
                                            <div className="ops-panel" style={{ marginTop: 0 }}>
                                              {isLoadingCorr && <p className="hr-caption" style={{ margin: 0 }}>{t("loading")}</p>}
                                              {!isLoadingCorr && cachedCorrs && cachedCorrs.length === 0 && (
                                                <p className="hr-caption" style={{ margin: 0 }}>{t("opsNoCorrections")}</p>
                                              )}
                                              {!isLoadingCorr && cachedCorrs && cachedCorrs.length > 0 && cachedCorrs.map((ev) => (
                                                <div key={ev.id} className="hr-stack" style={{ gap: 4, marginBottom: 8 }}>
                                                  <span className="hr-caption" style={{ margin: 0 }}>
                                                    <strong style={{ fontWeight: 500, color: "var(--text-primary)" }}>{ev.changedByName}</strong> · {new Date(ev.changedAt).toLocaleString()} · “{ev.correctionReason}”
                                                  </span>
                                                  {ev.fieldChanges.length > 0 ? (
                                                    <table className="hr-table ops-prep">
                                                      <thead>
                                                        <tr><th>{t("opsField")}</th><th>{t("opsFrom")}</th><th>{t("opsTo")}</th></tr>
                                                      </thead>
                                                      <tbody>
                                                        {ev.fieldChanges.map((fc) => (
                                                          <tr key={fc.id}>
                                                            <td data-label={t("opsField")}>{FIELD_LABELS[fc.fieldName] ?? fc.fieldName}</td>
                                                            <td data-label={t("opsFrom")} className="hr-num">{formatFieldValue(fc.oldValue)}</td>
                                                            <td data-label={t("opsTo")} className="hr-num">{formatFieldValue(fc.newValue)}</td>
                                                          </tr>
                                                        ))}
                                                      </tbody>
                                                    </table>
                                                  ) : (
                                                    <p className="hr-caption" style={{ margin: 0 }}>{t("opsNoFieldChanges")}</p>
                                                  )}
                                                </div>
                                              ))}
                                            </div>
                                          )}
                                        </li>
                                      );
                                    })}
                                  </ul>
                                  {hasAgtron && <AgtronTable records={batch.qcRecords} pref={batchPref} t={t} />}
                                </div>
                              );
                            })()}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  );
                })}
              </table>
            </div>
          )}
          <p className="hr-caption" style={{ margin: 0 }}>{t("opsQcFoot")}</p>
          {/* N-10 (prd-qc-closed-1024 «جلسات التذوق»): the latest cupping sessions, read from the
              existing sessions list, for viewers who may open cupping. */}
          {canCuppingRead && sessions && sessions.length > 0 ? (
            <section className="hr-stack hr-hide-preview" style={{ gap: 8, marginTop: 24 }} aria-label={t("opsQcSessionsTitle")}>
              <SecHead title={t("opsQcSessionsTitle")} caption={t("opsQcSessionsSub")} action={<Link href="/dashboard/cupping" className="ops-link ops-lk">{t("opsQcAllSessions")}</Link>} />
              <div className="hr-tablewrap">
                <table className="hr-table is-mrow ops-rows" aria-label={t("opsQcSessionsTitle")}>
                  <thead>
                    <tr>
                      <th>{t("opsQcSessionCol")}</th>
                      <th className="hr-hide-compact">{t("opsQcCupsCol")}</th>
                      <th>{t("opsStatusCol")}</th>
                      <th style={{ textAlign: "end" }}>{t("opsQcResultCol")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sessions.slice(0, 5).map((ss) => (
                      <tr key={ss.id}>
                        <td className="m-title">
                          <Link href={`/dashboard/cupping/${ss.id}`} className="ops-link">{ss.name}</Link>
                          {/* QA P3: the phone row keeps the open / closed status. */}
                          <span className="hr-msub"><StatusDot map={{ Open: [t("opsQcSessionOpen"), "info"], Closed: [t("opsQcSessionClosed"), "success"] }} value={ss.status} /></span>
                        </td>
                        <td className="hr-hide-compact hr-hide-mobile">{ss.sessionBatches.length > 0 ? countNoun(ss.sessionBatches.length, lang, CUP_FORMS) : ss.batch ? <span className="ops-serial">{ss.batch.batchNumber}</span> : <span className="hr-muted">—</span>}</td>
                        <td><StatusDot map={{ Open: [t("opsQcSessionOpen"), "info"], Closed: [t("opsQcSessionClosed"), "success"] }} value={ss.status} /></td>
                        <td className="m-end" style={{ textAlign: "end" }}><span className="hr-caption">{countNoun(ss._count.scores, lang, SCORE_FORMS)}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}
        </>
      )}

      {/* Tab 2: QC History */}
      {tab === "history" && (
        historyBatches.length === 0 ? (
          <OpsEmpty title={t("noQcHistoryYet")} body={t("finalizedBatchesHere")} />
        ) : (
          <div className="hr-tablewrap is-bleed">
            <table className="hr-table is-mrow ops-qc" aria-label={t("qcHistory")}>
              <thead>
                <tr>
                  <th>{t("opsBatchCol")}</th>
                  <th>{t("opsProductOrderCol")}</th>
                  <th>{t("opsStatusCol")}</th>
                  <th>{t("opsRecordsCol")}</th>
                  <th>{t("date")}</th>
                  <th aria-label={t("opsActions")} />
                </tr>
              </thead>
              {historyBatches.map((batch) => {
                const isBlended = batch.status === "Blended";
                const isExpanded = expandedId === batch.id;
                const acceptCount = batch.qcRecords.filter((r) => r.decision === "Accept").length;
                const rejectCount = batch.qcRecords.filter((r) => r.decision === "Reject").length;
                return (
                  <tbody key={batch.id} data-testid={`qc-history-${batch.batchNumber}`}>
                    <tr aria-selected={isExpanded}>
                      <td><span className="ops-serial">{batch.batchNumber}</span></td>
                      <td className="m-title">
                        <span className="strong">{batch.greenBean?.beanType || (batch.orderItem?.beanTypeName ?? "")}</span>
                        <span className="ops-line">
                          <span className="hr-mobile-only"><span className="ops-serial">{batch.batchNumber}</span> · </span>
                          {batch.orderItem ? <><span className="hr-id">#{batch.orderItem.order.orderNumber}</span> · {batch.orderItem.order.customer.name}</> : t("stockBatchLabel")}
                          {batch.blendTiming ? <> · {t("statusBlended")} {batch.blendTiming === "Before QC" ? t("blendBeforeQc") : t("blendAfterQc")}</> : null}
                          {isBlended && batch.parentBatch ? <> · {t("mergedInto")} <span className="ops-serial">{batch.parentBatch.batchNumber}</span></> : null}
                        </span>
                      </td>
                      <td className="m-end is-stack">
                        <StatusDot map={{ Passed: [statusBadgeLabel("Passed"), "success"], Rejected: [statusBadgeLabel("Rejected"), "danger"], Blended: [statusBadgeLabel("Blended"), "neutral"] }} value={batch.status} />
                      </td>
                      <td>{batch.qcRecords.length > 0 ? <span className="hr-caption">{t("panel")}: <span className="hr-num">{acceptCount}</span> {t("accept")} · <span className="hr-num">{rejectCount}</span> {t("reject")}</span> : <span className="hr-muted">—</span>}</td>
                      <td>{opsDate(batch.date, lang)}</td>
                      <td>
                        <Btn size="sm" variant="ghost" aria-expanded={isExpanded} onClick={() => setExpandedId(isExpanded ? null : batch.id)}>
                          {isExpanded ? t("collapse") : t("details")}
                        </Btn>
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr className="ops-detailrow">
                        <td colSpan={6}>
                          <div className="hr-stack" style={{ gap: 8 }}>
                            <KV rows={[
                              [t("roastedLabel"), <Kg key="r" v={batch.roastedBeanQuantity} />],
                              [t("date"), opsDate(batch.date, lang)],
                              ...(batch.roastProfile ? [[t("roastProfileLabel"), batch.roastProfile] as [string, string]] : []),
                              ...(batch.childBatches.length > 0 ? [[t("sourceBatches"), batch.childBatches.map((c) => c.batchNumber).join(", ")] as [string, string]] : []),
                            ]} />
                            {batch.qcRecords.length > 0 && (() => {
                              const batchGbId = (batch.orderItem?.greenBeanId ?? null);
                              const batchPref = (batch.orderItem?.order.customer.roastPreferences ?? []).find(
                                (p) => p.greenBeanId === batchGbId
                              ) ?? null;
                              const hasAgtron = batch.qcRecords.some((r) => r.colorWhole != null || r.colorGround != null);
                              return (
                                <>
                                  <p className="hr-label" style={{ margin: 0 }}>{t("testerRecords")}</p>
                                  <ul className="ops-list">
                                    {batch.qcRecords.map((r) => (
                                      <li key={r.id}>
                                        <span>{r.testerName || r.employee?.name || "—"}{r.isExternal ? <span className="hr-caption"> ({t("guestBadge")})</span> : null}</span>
                                        <span className={`hr-dot tone-${tone(r.decision)}`}><span>{r.decision === "Accept" ? t("accept") : t("reject")}</span></span>
                                      </li>
                                    ))}
                                  </ul>
                                  {hasAgtron && <AgtronTable records={batch.qcRecords} pref={batchPref} t={t} />}
                                </>
                              );
                            })()}
                            {isBlended && <p className="hr-caption" style={{ margin: 0 }}>{t("blendedNoQcNeeded")}</p>}
                          </div>
                        </td>
                      </tr>
                    )}
                  </tbody>
                );
              })}
            </table>
          </div>
        )
      )}

      {/* Tab 3: every tester record (the flat register) */}
      {tab === "records" && (
        <>
          <div className="hr-filterbar">
            <input type="text" placeholder={t("searchQcRecords")} aria-label={t("searchQcRecords")} value={search} onChange={(e) => setSearch(e.target.value)} className="hr-input hr-search" />
          </div>
          {filtered.length === 0 ? (
            <OpsEmpty title={t("noQcRecordsFound")} />
          ) : (
            <div className="hr-tablewrap">
              <table className="hr-table is-mrow" aria-label={t("opsTesterRecordsTab")}>
                <thead>
                  <tr>
                    <th>{t("date")}</th>
                    <th>{t("tester")}</th>
                    <th>{t("origin")}</th>
                    <th>{t("serialNumberShort")}</th>
                    <th>{t("decision")}</th>
                    <th className="num">{t("colorLabel")}</th>
                    <th>{t("remarks")}</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r) => {
                    const ok = r.decision === "Accept" || (!r.decision && r.onProfile);
                    return (
                      <tr key={r.id}>
                        <td>{opsDate(r.date, lang)}</td>
                        <td className="m-title">
                          <span className="strong">{r.testerName || r.employee?.name || "—"}</span>
                          {r.isExternal ? <span className="hr-caption"> · {t("guestBadge")}</span> : null}
                          <span className="hr-msub">{r.coffeeOrigin} · <span className="ops-serial">{r.serialNumber}</span> · {opsDate(r.date, lang)}</span>
                        </td>
                        <td>{r.coffeeOrigin}</td>
                        <td><span className="ops-serial">{r.serialNumber}</span></td>
                        <td className="m-end"><span className={`hr-dot tone-${ok ? "success" : "danger"}`}><span>{ok ? t("accept") : t("reject")}</span></span></td>
                        <td className="num"><span className="hr-num">{r.color || "—"}</span></td>
                        <td style={{ maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis" }}>{r.remarks || "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* QC Submission Form Modal */}
      {showForm && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={closeForm}>
          <div className="bg-white rounded-2xl p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-extrabold text-charcoal mb-1">
              {editingRecordId ? "Correct QC Record" : t("submitQcRecord")}
            </h2>
            <p className="text-xs text-brown/60 mb-4">{t("qcFormSubtitle")}</p>
            <form onSubmit={handleSubmit} className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-charcoal mb-1">{t("roastingBatchLabel")}</label>
                {editingRecordId ? (
                  <p className="px-3 py-2 bg-cream/60 border-2 border-border rounded-xl text-sm text-charcoal font-mono">
                    {backlogBatches.find((b) => b.id === form.batchId)?.batchNumber ?? form.batchId}
                  </p>
                ) : (
                  <Select value={form.batchId} onChange={(e) => {
                    const batch = backlogBatches.find((b) => b.id === e.target.value);
                    if (batch) setForm({ ...form, batchId: batch.id, coffeeOrigin: batch.greenBean?.beanType || (batch.orderItem?.beanTypeName ?? ""), processing: batch.greenBean?.process || "", serialNumber: batch.batchNumber });
                  }}
                    className="w-full px-3 py-2 border-2 border-border rounded-xl focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors" required>
                    <option value="">{t("selectBatch")}</option>
                    {backlogBatches.map((b) => (
                      <option key={b.id} value={b.id}>{b.batchNumber} — {(b.orderItem?.beanTypeName ?? "")} (#{(b.orderItem?.order.orderNumber ?? t("stockBatchLabel"))})</option>
                    ))}
                  </Select>
                )}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-charcoal mb-1">{t("coffeeOrigin")}</label>
                  <input type="text" value={form.coffeeOrigin} onChange={(e) => setForm({ ...form, coffeeOrigin: e.target.value })}
                    className="w-full px-3 py-2 border-2 border-border rounded-xl focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors" required />
                </div>
                <div>
                  <label className="block text-sm font-medium text-charcoal mb-1">{t("process")}</label>
                  <Select value={form.processing} onChange={(e) => setForm({ ...form, processing: e.target.value })}
                    className="w-full px-3 py-2 border-2 border-border rounded-xl focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors">
                    <option value="">—</option>
                    <option>Natural</option><option>Washed</option><option>Honey</option>
                    <option>Anaerobic</option><option>Innoculated</option><option>Co-Fermented</option>
                    <option>Extended Natural</option>
                  </Select>
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-charcoal mb-1">{t("serialNumberShort")} ({t("roastingBatchLabel")})</label>
                <input type="text" value={form.serialNumber} onChange={(e) => setForm({ ...form, serialNumber: e.target.value })}
                  className="w-full px-3 py-2 border-2 border-border rounded-xl focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors" required />
              </div>
              {/* Agtron Color Inputs */}
              {(() => {
                const selBatch = backlogBatches.find((b) => b.id === form.batchId);
                const batchGreenBeanId = selBatch?.orderItem?.greenBeanId ?? null;
                // A stock batch has no customer, so no roast preference to honour.
                const pref = selBatch?.orderItem?.order.customer.roastPreferences.find(
                  (p) => p.greenBeanId === batchGreenBeanId
                ) ?? null;
                const whole = parseFloat(form.colorWhole);
                const ground = parseFloat(form.colorGround);
                const delta = (!isNaN(whole) && !isNaN(ground)) ? Math.abs(ground - whole) : null;

                const passCheck = (actual: number | null, target: number | null, tol: number | null) => {
                  if (actual == null || target == null || tol == null) return null;
                  return Math.abs(actual - target) <= tol;
                };
                const wholePass  = pref ? passCheck(!isNaN(whole) ? whole : null,  pref.targetColorWhole,  pref.targetToleranceWhole)  : null;
                const groundPass = pref ? passCheck(!isNaN(ground) ? ground : null, pref.targetColorGround, pref.targetToleranceGround) : null;
                const deltaPass  = pref && delta != null && pref.targetDeltaMin != null && pref.targetDeltaMax != null
                  ? (delta >= pref.targetDeltaMin && delta <= pref.targetDeltaMax) : null;

                return (
                  <div className="space-y-2">
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-sm font-medium text-charcoal mb-1">{t("colorWholeLabel")}</label>
                        <input type="number" step="0.1" min="0" max="100"
                          value={form.colorWhole} onChange={(e) => setForm({ ...form, colorWhole: e.target.value })}
                          className="w-full px-3 py-2 border-2 border-border rounded-xl focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors" placeholder="e.g. 68" />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-charcoal mb-1">{t("colorGroundLabel")}</label>
                        <input type="number" step="0.1" min="0" max="100"
                          value={form.colorGround} onChange={(e) => setForm({ ...form, colorGround: e.target.value })}
                          className="w-full px-3 py-2 border-2 border-border rounded-xl focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors" placeholder="e.g. 74" />
                      </div>
                    </div>
                    {delta != null && (
                      <div className="flex items-center gap-2 px-3 py-2 bg-cream rounded-xl text-sm font-semibold text-charcoal">
                        <span className="text-brown/60">{t("colorDeltaLabel")}:</span>
                        <span className="font-mono font-bold text-orange">{delta.toFixed(1)}</span>
                        {deltaPass === true && <span className="text-[10px] font-bold text-green-600 bg-green-50 px-1.5 py-0.5 rounded-full">{t("passLabel")}</span>}
                        {deltaPass === false && <span className="text-[10px] font-bold text-red-600 bg-red-50 px-1.5 py-0.5 rounded-full">{t("failLabel")}</span>}
                        {pref && pref.targetDeltaMin != null && pref.targetDeltaMax != null && (
                          <span className="text-xs text-brown/50">{t("targetHint")}: {pref.targetDeltaMin}–{pref.targetDeltaMax}</span>
                        )}
                      </div>
                    )}
                    {pref && (wholePass != null || groundPass != null) && (
                      <div className="border border-orange/20 rounded-xl p-3 bg-orange/5">
                        <p className="text-[10px] font-extrabold text-orange/70 uppercase tracking-widest mb-2">{t("liveTargets")}: {pref.profileName}</p>
                        <div className="grid grid-cols-2 gap-2 text-xs">
                          {wholePass != null && (
                            <div className={`rounded-lg px-2.5 py-2 flex items-center justify-between ${wholePass ? "bg-green-50 border border-green-200" : "bg-red-50 border border-red-200"}`}>
                              <span className="font-medium text-charcoal">{t("colorWholeLabel")}</span>
                              <div className="text-end">
                                <p className="font-bold font-mono">{whole.toFixed(1)}</p>
                                <p className="text-[10px] text-brown/50">{t("targetHint")}: {pref.targetColorWhole} ±{pref.targetToleranceWhole}</p>
                                <span className={`text-[10px] font-bold ${wholePass ? "text-green-600" : "text-red-600"}`}>{wholePass ? t("passLabel") : t("failLabel")}</span>
                              </div>
                            </div>
                          )}
                          {groundPass != null && (
                            <div className={`rounded-lg px-2.5 py-2 flex items-center justify-between ${groundPass ? "bg-green-50 border border-green-200" : "bg-red-50 border border-red-200"}`}>
                              <span className="font-medium text-charcoal">{t("colorGroundLabel")}</span>
                              <div className="text-end">
                                <p className="font-bold font-mono">{ground.toFixed(1)}</p>
                                <p className="text-[10px] text-brown/50">{t("targetHint")}: {pref.targetColorGround} ±{pref.targetToleranceGround}</p>
                                <span className={`text-[10px] font-bold ${groundPass ? "text-green-600" : "text-red-600"}`}>{groundPass ? t("passLabel") : t("failLabel")}</span>
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}
              <div>
                <label className="block text-sm font-medium text-charcoal mb-2">{t("verdict")} *</label>
                <div className="grid grid-cols-2 gap-3">
                  <button type="button" onClick={() => setForm({ ...form, decision: "Accept", underDeveloped: false, overDeveloped: false })}
                    className={`flex items-center justify-center gap-2 py-3 rounded-lg border-2 font-semibold text-sm transition-all ${form.decision === "Accept" ? "border-green-500 bg-green-50 text-green-700" : "border-gray-200 bg-white text-gray-400 hover:border-green-300"}`}>
                    <CheckCircle2 size={20} /> {t("acceptedLabel")}
                  </button>
                  <button type="button" onClick={() => setForm({ ...form, decision: "Reject" })}
                    className={`flex items-center justify-center gap-2 py-3 rounded-lg border-2 font-semibold text-sm transition-all ${form.decision === "Reject" ? "border-red-500 bg-red-50 text-red-700" : "border-gray-200 bg-white text-gray-400 hover:border-red-300"}`}>
                    <XCircle size={20} /> {t("rejectedLabel")}
                  </button>
                </div>
              </div>
              {form.decision === "Reject" && (
                <div className="space-y-2">
                  <label className="block text-sm font-medium text-charcoal">{t("rejectionReason")}</label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="radio" name="roastAssessment" checked={form.underDeveloped}
                      onChange={() => setForm({ ...form, underDeveloped: true, overDeveloped: false })} className="w-4 h-4 text-amber-500" />
                    <span className="text-sm font-medium text-amber-700">{t("underDeveloped")}</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="radio" name="roastAssessment" checked={form.overDeveloped}
                      onChange={() => setForm({ ...form, underDeveloped: false, overDeveloped: true })} className="w-4 h-4 text-red-500" />
                    <span className="text-sm font-medium text-red-700">{t("overDeveloped")}</span>
                  </label>
                </div>
              )}
              <div>
                <label className="block text-sm font-medium text-charcoal mb-1">{t("remarks")}</label>
                <textarea value={form.remarks} onChange={(e) => setForm({ ...form, remarks: e.target.value })}
                  className="w-full px-3 py-2 border-2 border-border rounded-xl focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors" rows={3}
                  placeholder={t("cuppingNotesPlaceholder")} />
              </div>
              {editingRecordId && (
                <div>
                  <label className="block text-sm font-medium text-charcoal mb-1">
                    Correction reason <span className="text-red-500">*</span>
                  </label>
                  <textarea
                    value={form.correctionReason}
                    onChange={(e) => setForm({ ...form, correctionReason: e.target.value })}
                    className="w-full px-3 py-2 border-2 border-border rounded-xl focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors"
                    rows={2}
                    placeholder="Why is this record being corrected?"
                    required
                  />
                </div>
              )}
              <div className="flex gap-3 pt-2">
                <button type="submit" disabled={submitting}
                  className="flex-1 py-2 bg-orange text-white rounded-lg hover:bg-orange-dark shadow-md shadow-orange/20 hover:shadow-orange/35 active:scale-[0.98] transition-all duration-200 font-bold disabled:opacity-50 flex items-center justify-center gap-2">
                  {submitting ? <><Loader2 size={15} className="animate-spin" /> {t("saving")}</> : t("saveRecord")}
                </button>
                <button type="button" onClick={closeForm} className="flex-1 py-2 border rounded-lg hover:bg-gray-50">
                  {t("cancel")}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Invite link modal */}
      {inviteLink && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setInviteLink(null)}>
          <div className="bg-white rounded-2xl p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 mb-4">
              <Link2 size={20} className="text-orange" />
              <h2 className="text-lg font-extrabold text-charcoal">{t("externalTesterLink")}</h2>
            </div>
            <p className="text-sm text-brown/70 mb-3">{t("guestLinkHint")}</p>
            <div className="bg-cream rounded-xl p-3 break-all text-xs font-mono text-charcoal border border-border mb-4">
              {inviteLink}
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => copyToClipboard(inviteLink)}
                className="flex-1 py-2 bg-orange text-white rounded-lg hover:bg-orange-dark font-bold text-sm"
              >
                {t("copyLink")}
              </button>
              <button onClick={() => setInviteLink(null)} className="flex-1 py-2 border rounded-lg hover:bg-gray-50 text-sm">
                {t("close")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Cancel Batch Modal */}
      {cancelBatch && (() => {
        const isPendingQc = cancelBatch.status === "Pending QC";
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
              {isPendingQc ? (
                <>
                  <p className="text-sm text-brown mb-5">{t("cancelBatchMsgPre")}</p>
                  <RestockReason value={restockReason} onChange={setRestockReason} label={t("restockReasonLabel")} hint={t("restockReasonHint")} disabled={cancelling} />
                  <div className="flex gap-3">
                    <button onClick={() => handleCancelBatch(true)} disabled={cancelling || !restockReasonOk(restockReason)}
                      className="flex-1 py-3 bg-red-600 text-white rounded-xl font-bold hover:bg-red-700 disabled:opacity-50 active:scale-[0.98] transition-all">
                      {cancelling ? "…" : t("cancelConfirmRestock")}
                    </button>
                    <button onClick={() => setCancelBatch(null)} disabled={cancelling}
                      className="flex-1 py-3 border-2 border-border rounded-xl font-bold text-brown hover:bg-cream transition-colors">
                      {t("cancel")}
                    </button>
                  </div>
                </>
              ) : (
                <>
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
                </>
              )}
            </div>
          </div>
        );
      })()}

      {/* Bulk Finalize — Low-Tester Warning Modal */}
      {showBulkWarning && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-2xl">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center flex-shrink-0">
                <AlertTriangle size={20} className="text-amber-600" />
              </div>
              <div>
                <h2 className="font-extrabold text-charcoal">{t("bulkWarningTitle")}</h2>
                <p className="text-xs text-brown/60">{selectedIds.size} {t("bulkFinalizeCount")}</p>
              </div>
            </div>
            <p className="text-sm text-brown mb-6">{t("bulkWarningMsg")}</p>
            <div className="flex gap-3">
              <button
                onClick={() => { setShowBulkWarning(false); setShowBulkModal(true); }}
                className="flex-1 py-3 bg-charcoal text-white rounded-xl font-bold hover:bg-charcoal/80 active:scale-[0.98] transition-all"
              >
                {t("finalizeAnyway")}
              </button>
              <button
                onClick={() => setShowBulkWarning(false)}
                className="flex-1 py-3 border-2 border-border rounded-xl font-bold text-brown hover:bg-cream transition-colors"
              >
                {t("cancel")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bulk Finalize — Outcome Modal */}
      {showBulkModal && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-2xl">
            <h2 className="font-extrabold text-charcoal mb-1">{t("bulkFinalizeTitle")}</h2>
            <p className="text-xs text-brown/60 mb-5">{selectedIds.size} {t("bulkFinalizeCount")}</p>
            <p className="text-sm font-semibold text-charcoal mb-3">{t("bulkOutcomeLabel")}</p>
            <div className="flex gap-3 mb-6">
              <button
                onClick={() => setBulkOutcome("Passed")}
                className={`flex-1 py-3 rounded-xl font-bold border-2 transition-all ${bulkOutcome === "Passed" ? "bg-green-600 text-white border-green-600" : "bg-white text-green-700 border-green-300 hover:bg-green-50"}`}
              >
                <CheckCircle2 size={16} className="inline ltr:mr-1.5 rtl:ml-1.5" />
                {t("bulkPassAll")}
              </button>
              <button
                onClick={() => setBulkOutcome("Rejected")}
                className={`flex-1 py-3 rounded-xl font-bold border-2 transition-all ${bulkOutcome === "Rejected" ? "bg-red-600 text-white border-red-600" : "bg-white text-red-600 border-red-300 hover:bg-red-50"}`}
              >
                <XCircle size={16} className="inline ltr:mr-1.5 rtl:ml-1.5" />
                {t("bulkFailAll")}
              </button>
            </div>
            {bulkOutcome === "Passed" && (() => {
              const selectedBatches = filteredBacklog.filter((b) => selectedIds.has(b.id));
              const hasAnyReject = selectedBatches.some((b) => b.qcRecords.some((r) => r.decision === "Reject"));
              return (
                <div className="mb-5">
                  <label className="block text-sm font-semibold text-charcoal mb-1">
                    {hasAnyReject ? "Override reason (required)" : "Decision notes (optional)"}
                  </label>
                  <textarea
                    value={bulkFinalizeReason}
                    onChange={(e) => setBulkFinalizeReason(e.target.value)}
                    rows={2}
                    placeholder={hasAnyReject ? "State reason for passing despite rejected records…" : "Optional notes…"}
                    className="w-full px-3 py-2 border-2 border-border rounded-xl focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors text-sm resize-none"
                  />
                </div>
              );
            })()}
            <div className="flex gap-3">
              <button
                onClick={executeBulkFinalize}
                disabled={isBulkFinalizing || (bulkOutcome === "Passed" && filteredBacklog.filter((b) => selectedIds.has(b.id)).some((b) => b.qcRecords.some((r) => r.decision === "Reject")) && !bulkFinalizeReason.trim())}
                className="flex-1 py-3 bg-charcoal text-white rounded-xl font-bold hover:bg-charcoal/80 disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.98] transition-all flex items-center justify-center gap-2"
              >
                {isBulkFinalizing ? <><Loader2 size={16} className="animate-spin" />{t("bulkFinalizing")}</> : t("confirm")}
              </button>
              <button
                onClick={() => setShowBulkModal(false)}
                disabled={isBulkFinalizing}
                className="flex-1 py-3 border-2 border-border rounded-xl font-bold text-brown hover:bg-cream transition-colors"
              >
                {t("cancel")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Date Modal */}
      {editDateBatch && (
        <EditDateModal
          batch={editDateBatch}
          onClose={() => setEditDateBatch(null)}
          onSuccess={({ newBatchNumber, parentBatchId, newParentBatchNumber }) => {
            setBacklogBatches((prev) =>
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
            toast.success(msg);
            setEditDateBatch(null);
          }}
        />
      )}
    </div>

    {/* prd-qc 315:2095 / 318:2258 / 347:3558: the final decision is a pane beside the queue
        at 1440, a drawer at 1024 and a bottom sheet on the phone. Same state, validation and
        request as the dialog it replaces. */}
    {finalizeBatch && (() => {
      const fb = finalizeBatch;
      const fbAccept = fb.qcRecords.filter((r) => r.decision === "Accept").length;
      const fbReject = fb.qcRecords.filter((r) => r.decision === "Reject").length;
      const fbTotal = fb.qcRecords.length;
      const reasonRequired = finalizeOutcome === "Passed" && fbReject > 0;
      const canConfirm = finalizeOutcome !== "" && !(reasonRequired && !finalizeReason.trim());
      const product = fb.greenBean?.beanType || fb.orderItem?.beanTypeName || "";
      const outcomeLabel = finalizeOutcome === "Passed" ? t("accept") : finalizeOutcome === "Rejected" ? t("reject") : null;
      return (
        <OpsPane
          testId="qc-finalize-pane"
          label={t("finalizeQc")}
          title={<><span className="ops-serial">{fb.batchNumber}</span> <span>{product}</span></>}
          sub={t("finalizeQc")}
          busy={finalizing}
          onClose={() => setFinalizeBatch(null)}
          footer={
            <>
              <Btn variant="primary" onClick={() => handleFinalize(fb, finalizeOutcome as "Passed" | "Rejected", finalizeReason)} disabled={!canConfirm} busy={finalizing}>
                {finalizing ? t("finalizing") : outcomeLabel ? `${t("qcFinishInspection")} · ${outcomeLabel}` : t("qcFinishInspection")}
              </Btn>
              <Btn onClick={() => setFinalizeBatch(null)} disabled={finalizing}>{t("cancel")}</Btn>
            </>
          }
        >
          <dl className="ops-props ops-qc-props" style={{ gridTemplateColumns: "110px minmax(0, 1fr)" }}>
            <dt>{t("opsOrderCol")}</dt>
            <dd>{fb.orderItem ? <><span className="hr-id">#{fb.orderItem.order.orderNumber}</span> · {fb.orderItem.order.customer.name}</> : t("stockBatchLabel")}</dd>
            <dt>{t("opsRoastedOutCol")}</dt>
            <dd><Kg v={fb.roastedBeanQuantity} /></dd>
            <dt>{t("opsDeadlineCol")}</dt>
            <dd>{fb.qcDeadline ? <span className="hr-num">{opsDate(fb.qcDeadline, lang, true)}</span> : <span className="hr-muted">—</span>}</dd>
          </dl>

          <div>
            <p className="ops-lbl">{t("opsRecordsCol")} · <span className="hr-num">{fbTotal}</span> · <span style={{ color: "var(--status-success)" }}><span className="hr-num">{fbAccept}</span> {t("accept")}</span> · <span style={{ color: fbReject ? "var(--status-danger)" : undefined }}><span className="hr-num">{fbReject}</span> {t("reject")}</span></p>
            <ul className="ops-recs">
              {fb.qcRecords.map((r) => (
                <li key={r.id}>
                  <span>{r.employee?.name ?? r.testerName ?? "—"}</span>
                  <span className="hr-num">{r.colorWhole ?? r.color ?? "—"}{r.colorGround != null ? <> / {r.colorGround}</> : null}</span>
                  <span className={`hr-dot tone-${r.decision === "Accept" ? "success" : "danger"}`}><span>{r.decision === "Accept" ? t("accept") : t("reject")}</span></span>
                  <span className="ops-recs-sub">{r.isExternal ? t("guestLink") : null}{r.isExternal ? " · " : null}{opsDate(r.date, lang, true)}</span>
                </li>
              ))}
            </ul>
            {fbTotal === 1 ? <p className="ops-hint ops-onetester">{t("oneTesterWarning")}</p> : null}
          </div>

          <div>
            <p className="ops-lbl" id="qc-final-decision">{t("qcFinalDecision")}</p>
            <div className="ops-seg" role="group" aria-labelledby="qc-final-decision">
              <button type="button" aria-pressed={finalizeOutcome === "Passed"} onClick={() => setFinalizeOutcome("Passed")} data-autofocus="">{t("accept")}</button>
              <button type="button" aria-pressed={finalizeOutcome === "Rejected"} className="is-negative" onClick={() => setFinalizeOutcome("Rejected")}>{t("reject")}</button>
            </div>
            <p className="ops-hint">{t("qcFinalizeHint")}</p>
          </div>

          {finalizeOutcome === "Passed" && (
            <label className="hr-field" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span className="hr-caption">{reasonRequired ? t("qcOverrideReasonRequired") : t("qcDecisionNotesOptional")}</span>
              <textarea
                value={finalizeReason}
                onChange={(e) => setFinalizeReason(e.target.value)}
                rows={2}
                placeholder={reasonRequired ? t("qcOverrideReasonPlaceholder") : t("qcDecisionNotesPlaceholder")}
                className="hr-input"
                style={{ height: "auto", padding: "8px 10px", resize: "none" }}
              />
            </label>
          )}
        </OpsPane>
      );
    })()}
    </div>
    </OpsRoot>
  );
}
