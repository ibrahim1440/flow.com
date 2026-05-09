"use client";

import { useState, useEffect, useCallback } from "react";
import {
  ClipboardCheck, Plus, Search, CheckCircle2, XCircle, Eye, Merge,
  Users, Link2, AlertTriangle, Clock, Loader2,
} from "lucide-react";
import { formatDate } from "@/lib/utils";
import { useUser } from "../layout";
import { hasSubPrivilege } from "@/lib/auth";
import { useI18n } from "@/lib/i18n/context";
import type { TranslationKey } from "@/lib/i18n/translations";
import toast from "react-hot-toast";

type TesterRecord = {
  id: string;
  testerName: string | null;
  isExternal: boolean;
  decision: string;
  color: number | null;
  remarks: string | null;
  underDeveloped: boolean;
  overDeveloped: boolean;
  date: string;
  employee: { id: string; name: string } | null;
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
  orderItem: { beanTypeName: string; order: { orderNumber: number; customer: { name: string } } };
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

const BLANK_FORM = {
  batchId: "", coffeeOrigin: "", processing: "", serialNumber: "",
  decision: "" as "Accept" | "Reject" | "",
  underDeveloped: false, overDeveloped: false, color: "", remarks: "",
};

export default function QCPage() {
  const user = useUser();
  const { t } = useI18n();
  const canCreate = hasSubPrivilege(user?.permissions ?? {}, "qc", "create_record");
  const canManage = hasSubPrivilege(user?.permissions ?? {}, "qc", "manage");

  const [batches, setBatches] = useState<Batch[]>([]);
  const [records, setRecords] = useState<LegacyRecord[]>([]);
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<"backlog" | "history">("backlog");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Panel submission form
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(BLANK_FORM);
  const [submitting, setSubmitting] = useState(false);

  // Finalize confirmation modal
  const [confirmFinalizeId, setConfirmFinalizeId] = useState<string | null>(null);
  const [finalizing, setFinalizing] = useState(false);

  // Invite link modal
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [generatingInvite, setGeneratingInvite] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    const [batchRes, qcRes] = await Promise.all([
      fetch("/api/roasting-batches"),
      fetch("/api/qc-records"),
    ]);
    if (batchRes.ok) setBatches(await batchRes.json());
    if (qcRes.ok) setRecords(await qcRes.json());
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  function startQcForBatch(batch: Batch) {
    setForm({
      ...BLANK_FORM,
      batchId: batch.id,
      coffeeOrigin: batch.greenBean?.beanType || batch.orderItem.beanTypeName,
      processing: batch.greenBean?.process || "",
      serialNumber: batch.batchNumber,
    });
    setShowForm(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.decision) { toast.error(t("verdict")); return; }
    setSubmitting(true);
    try {
      const res = await fetch(`/api/qc/${form.batchId}/records`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision: form.decision,
          coffeeOrigin: form.coffeeOrigin,
          processing: form.processing,
          serialNumber: form.serialNumber,
          color: form.color || null,
          remarks: form.remarks || null,
          underDeveloped: form.underDeveloped,
          overDeveloped: form.overDeveloped,
        }),
      });
      const data = await res.json();
      if (!res.ok) { toast.error(data.error || t("error")); return; }
      toast.success(t("saveRecord"));
      setShowForm(false);
      setForm(BLANK_FORM);
      loadData();
    } finally {
      setSubmitting(false);
    }
  }

  async function handleFinalize(batchId: string) {
    setFinalizing(true);
    try {
      const res = await fetch(`/api/qc/${batchId}/finalize`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) { toast.error(data.error || t("error")); return; }
      toast.success(`${data.status}: ${data.acceptCount}/${data.total} ${t("accepted")}`);
      setConfirmFinalizeId(null);
      loadData();
    } finally {
      setFinalizing(false);
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

  const backlogBatches = batches.filter((b) => b.status === "Pending QC");
  const historyBatches = batches.filter((b) => b.status === "Passed" || b.status === "Rejected" || b.status === "Blended");
  const onProfileCount = records.filter((r) => r.decision === "Accept" || r.onProfile).length;
  const offProfileCount = records.filter((r) => r.decision === "Reject" || (!r.decision && !r.onProfile)).length;
  const filtered = records.filter((r) =>
    `${r.coffeeOrigin} ${r.processing} ${r.serialNumber} ${r.remarks || ""} ${r.testerName || ""}`.toLowerCase().includes(search.toLowerCase())
  );
  const now = new Date();

  function deadlineDisplay(deadline: string | null) {
    if (!deadline) return null;
    const d = new Date(deadline);
    const isOverdue = d < now;
    const isUrgent = !isOverdue && d < new Date(now.getTime() + 6 * 60 * 60 * 1000);
    return {
      label: isOverdue ? t("overdue") : isUrgent ? t("dueSoon") : formatDate(deadline),
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

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-extrabold text-charcoal">{t("qc")}</h1>
          <p className="text-brown text-sm font-medium">
            {t("panelCupping")} — {onProfileCount} {t("accepted")}, {offProfileCount} {t("rejected")}
          </p>
        </div>
        {canCreate && tab === "backlog" && (
          <button onClick={() => setShowForm(true)} className="flex items-center gap-2 px-4 py-2 bg-orange text-white rounded-lg hover:bg-orange-dark shadow-md shadow-orange/20 hover:shadow-orange/35 active:scale-[0.98] transition-all duration-200 font-bold">
            <Plus size={18} /> {t("newQcRecord")}
          </button>
        )}
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-white rounded-2xl border p-4 text-center hover:shadow-lg hover:shadow-charcoal/5 transition-all duration-300">
          <p className="text-3xl font-bold text-brown">{records.length}</p>
          <p className="text-xs text-brown">{t("totalRecords")}</p>
        </div>
        <div className="bg-green-50 rounded-2xl border border-green-200 p-4 text-center hover:shadow-lg hover:shadow-charcoal/5 transition-all duration-300">
          <p className="text-3xl font-bold text-green-600">{onProfileCount}</p>
          <p className="text-xs text-green-700">{t("acceptedLabel")}</p>
        </div>
        <div className="bg-red-50 rounded-2xl border border-red-200 p-4 text-center hover:shadow-lg hover:shadow-charcoal/5 transition-all duration-300">
          <p className="text-3xl font-bold text-red-600">{offProfileCount}</p>
          <p className="text-xs text-red-700">{t("rejectedLabel")}</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-2">
        <button onClick={() => setTab("backlog")}
          className={`px-4 py-2 rounded-xl text-sm font-bold transition-all ${tab === "backlog" ? "bg-charcoal text-white" : "bg-white border border-border text-brown hover:border-slate"}`}>
          {t("qcBacklog")} ({backlogBatches.length})
        </button>
        <button onClick={() => setTab("history")}
          className={`px-4 py-2 rounded-xl text-sm font-bold transition-all ${tab === "history" ? "bg-charcoal text-white" : "bg-white border border-border text-brown hover:border-slate"}`}>
          {t("qcHistory")} ({historyBatches.length})
        </button>
      </div>

      {/* Tab 1: QC Backlog */}
      {tab === "backlog" && (
        <div className="space-y-4">
          {backlogBatches.length === 0 ? (
            <div className="text-center py-12 bg-white rounded-2xl border border-border text-brown/40">
              <ClipboardCheck size={40} className="mx-auto mb-3 opacity-50" />
              <p className="font-semibold text-lg">{t("noBatchesAwaitingQc")}</p>
              <p className="text-sm mt-1">{t("batchesAfterRoasting")}</p>
            </div>
          ) : (
            <div className="space-y-3">
              {backlogBatches.map((batch) => {
                const dl = deadlineDisplay(batch.qcDeadline);
                const acceptCount = batch.qcRecords.filter((r) => r.decision === "Accept").length;
                const rejectCount = batch.qcRecords.filter((r) => r.decision === "Reject").length;
                const total = batch.qcRecords.length;
                const alreadySubmitted = batch.qcRecords.some((r) => !r.isExternal && r.employee?.id === user?.id);
                const isExpanded = expandedId === batch.id;

                return (
                  <div key={batch.id} className={`rounded-xl border p-4 transition-all duration-300 hover:shadow-md ${dl?.isOverdue ? "bg-red-50 border-red-200" : dl?.isUrgent ? "bg-amber-50 border-amber-200" : "bg-amber-50 border-amber-200"}`}>
                    {/* Batch header */}
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="font-bold text-charcoal font-mono text-sm">{batch.batchNumber}</p>
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-warning-bg text-yellow-800">
                            {t("statusPendingQc")}
                          </span>
                          {dl && (
                            <span className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold ${dl.isOverdue ? "bg-red-200 text-red-800" : dl.isUrgent ? "bg-amber-200 text-amber-800" : "bg-gray-100 text-gray-600"}`}>
                              <Clock size={9} />
                              {dl.label}
                            </span>
                          )}
                          {batch.blendTiming && (
                            <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-200 text-amber-800">
                              {t("statusBlended")} {batch.blendTiming === "Before QC" ? t("blendBeforeQc") : t("blendAfterQc")}
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-brown mt-0.5">
                          {batch.greenBean?.beanType || batch.orderItem.beanTypeName} — #{batch.orderItem.order.orderNumber} ({batch.orderItem.order.customer.name})
                        </p>
                        <p className="text-xs text-gray-400 mt-0.5">
                          {batch.roastedBeanQuantity}kg {t("roastedLabel")}{batch.roastProfile ? ` · ${batch.roastProfile}` : ""}
                        </p>
                      </div>
                      <button onClick={() => setExpandedId(isExpanded ? null : batch.id)}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-all flex-shrink-0 ${isExpanded ? "bg-charcoal text-white" : "bg-white border border-border text-brown hover:bg-cream"}`}>
                        <Eye size={12} /> {isExpanded ? t("collapse") : t("panel")}
                      </button>
                    </div>

                    {/* Tester summary bar */}
                    <div className="flex items-center gap-3 mt-3 pt-3 border-t border-amber-200/60">
                      <div className="flex items-center gap-1.5">
                        <Users size={13} className="text-brown/60" />
                        <span className="text-xs font-semibold text-brown">
                          {total} {total !== 1 ? t("testers") : t("tester")}
                        </span>
                      </div>
                      {total > 0 && (
                        <>
                          <span className="flex items-center gap-1 text-xs font-bold text-green-600">
                            <CheckCircle2 size={11} /> {acceptCount}
                          </span>
                          <span className="flex items-center gap-1 text-xs font-bold text-red-600">
                            <XCircle size={11} /> {rejectCount}
                          </span>
                        </>
                      )}
                      <div className="ltr:ml-auto rtl:mr-auto flex items-center gap-2">
                        {canManage && (
                          <button
                            onClick={() => handleGenerateInvite(batch.id)}
                            disabled={generatingInvite === batch.id}
                            className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-bold bg-white border border-border text-brown hover:bg-cream transition-all"
                          >
                            {generatingInvite === batch.id ? <Loader2 size={11} className="animate-spin" /> : <Link2 size={11} />}
                            {t("guestLink")}
                          </button>
                        )}
                        {canCreate && !alreadySubmitted && (
                          <button onClick={() => startQcForBatch(batch)}
                            className="flex items-center gap-1.5 px-3 py-1.5 bg-orange text-white rounded-lg text-xs hover:bg-orange-dark shadow-md shadow-orange/20 active:scale-[0.98] transition-all font-bold">
                            <ClipboardCheck size={12} /> {t("addMyRecord")}
                          </button>
                        )}
                        {canCreate && alreadySubmitted && (
                          <span className="flex items-center gap-1 text-xs font-bold text-green-600 bg-green-50 px-2.5 py-1 rounded-lg border border-green-200">
                            <CheckCircle2 size={11} /> {t("submitted")}
                          </span>
                        )}
                        {canManage && total > 0 && (
                          <button
                            onClick={() => total === 1 ? setConfirmFinalizeId(batch.id) : handleFinalize(batch.id)}
                            className="flex items-center gap-1.5 px-3 py-1.5 bg-charcoal text-white rounded-lg text-xs hover:bg-charcoal/80 shadow-md active:scale-[0.98] transition-all font-bold"
                          >
                            {t("finalizeQc")}
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Expanded tester list */}
                    {isExpanded && total > 0 && (
                      <div className="mt-3 pt-3 border-t border-amber-200/60 space-y-1.5">
                        <p className="text-xs font-bold text-charcoal mb-2">{t("testerRecords")}</p>
                        {batch.qcRecords.map((r) => (
                          <div key={r.id} className="flex items-center justify-between bg-white/70 rounded-lg px-3 py-2">
                            <div>
                              <span className="text-xs font-semibold text-charcoal">
                                {r.testerName || r.employee?.name || "—"}
                                {r.isExternal && (
                                  <span className="ltr:ml-1 rtl:mr-1 text-[10px] font-bold text-purple-600 bg-purple-50 px-1.5 rounded-full">
                                    {t("guestBadge")}
                                  </span>
                                )}
                              </span>
                              {r.color && <span className="ltr:ml-2 rtl:mr-2 text-[10px] text-brown/50">{t("colorLabel")} {r.color}</span>}
                              {r.remarks && <span className="ltr:ml-2 rtl:mr-2 text-[10px] text-brown/50 truncate max-w-[120px] inline-block">{r.remarks}</span>}
                            </div>
                            <span className={`flex items-center gap-1 text-xs font-bold ${r.decision === "Accept" ? "text-green-600" : "text-red-600"}`}>
                              {r.decision === "Accept" ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
                              {r.decision === "Accept" ? t("accept") : t("reject")}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                    {isExpanded && total === 0 && (
                      <div className="mt-3 pt-3 border-t border-amber-200/60 text-center text-xs text-brown/50 py-2">
                        {t("noTesterRecords")}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* QC Records search + table */}
          <div className="relative">
            <Search size={18} className="absolute ltr:left-3 rtl:right-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input type="text" placeholder={t("searchQcRecords")} value={search} onChange={(e) => setSearch(e.target.value)}
              className="w-full ltr:pl-10 rtl:pr-10 px-4 py-2.5 border-2 border-border rounded-xl bg-white focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors" />
          </div>

          <div className="bg-white rounded-2xl border border-border shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-cream">
                  <tr>
                    <th className="text-start px-4 py-3 font-semibold">{t("date")}</th>
                    <th className="text-start px-4 py-3 font-semibold">{t("tester")}</th>
                    <th className="text-start px-4 py-3 font-semibold">{t("origin")}</th>
                    <th className="text-start px-4 py-3 font-semibold">{t("serialNumberShort")}</th>
                    <th className="text-center px-4 py-3 font-semibold">{t("decision")}</th>
                    <th className="text-center px-4 py-3 font-semibold">{t("colorLabel")}</th>
                    <th className="text-start px-4 py-3 font-semibold">{t("remarks")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {filtered.map((r) => (
                    <tr key={r.id} className="hover:bg-cream/50">
                      <td className="px-4 py-3 text-brown">{formatDate(r.date)}</td>
                      <td className="px-4 py-3 text-charcoal font-medium">
                        {r.testerName || r.employee?.name || "—"}
                        {r.isExternal && (
                          <span className="ltr:ml-1 rtl:mr-1 text-[10px] font-bold text-purple-600 bg-purple-50 px-1.5 rounded-full">
                            {t("guestBadge")}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 font-medium">{r.coffeeOrigin}</td>
                      <td className="px-4 py-3 font-mono text-xs">{r.serialNumber}</td>
                      <td className="px-4 py-3 text-center">
                        {(r.decision === "Accept" || (!r.decision && r.onProfile))
                          ? <span className="inline-flex items-center gap-1 text-green-600 font-bold"><CheckCircle2 size={14} />{t("accept")}</span>
                          : <span className="inline-flex items-center gap-1 text-red-600 font-bold"><XCircle size={14} />{t("reject")}</span>}
                      </td>
                      <td className="px-4 py-3 text-center">{r.color || "—"}</td>
                      <td className="px-4 py-3 text-gray-600 max-w-[200px] truncate">{r.remarks || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {filtered.length === 0 && (
              <div className="text-center py-12 text-gray-400">
                <ClipboardCheck size={40} className="mx-auto mb-2" /><p>{t("noQcRecordsFound")}</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Tab 2: QC History */}
      {tab === "history" && (
        <div className="space-y-2">
          {historyBatches.length === 0 ? (
            <div className="text-center py-12 bg-white rounded-2xl border border-border text-brown/40">
              <ClipboardCheck size={40} className="mx-auto mb-3 opacity-50" />
              <p className="font-semibold text-lg">{t("noQcHistoryYet")}</p>
              <p className="text-sm mt-1">{t("finalizedBatchesHere")}</p>
            </div>
          ) : (
            historyBatches.map((batch) => {
              const isPassed = batch.status === "Passed";
              const isRejected = batch.status === "Rejected";
              const isBlended = batch.status === "Blended";
              const isExpanded = expandedId === batch.id;
              const acceptCount = batch.qcRecords.filter((r) => r.decision === "Accept").length;
              const rejectCount = batch.qcRecords.filter((r) => r.decision === "Reject").length;
              return (
                <div key={batch.id} className={`rounded-xl border p-4 transition-all duration-300 hover:shadow-md ${isRejected ? "bg-red-50 border-red-200" : isBlended ? "bg-purple-50 border-purple-200" : "bg-green-50 border-green-200"}`}>
                  <div className="flex items-center justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-bold text-charcoal font-mono text-sm">{batch.batchNumber}</p>
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${isRejected ? "bg-red-200 text-red-800" : isBlended ? "bg-purple-200 text-purple-800" : "bg-green-200 text-green-800"}`}>
                          {statusBadgeLabel(batch.status)}
                        </span>
                        {batch.blendTiming && (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-800">
                            {t("statusBlended")} {batch.blendTiming === "Before QC" ? t("blendBeforeQc") : t("blendAfterQc")}
                          </span>
                        )}
                        {isBlended && batch.parentBatch && (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-purple-200 text-purple-800 flex items-center gap-1">
                            <Merge size={10} /> {t("mergedInto")} {batch.parentBatch.batchNumber}
                          </span>
                        )}
                        {batch.qcRecords.length > 0 && (
                          <span className="text-[10px] text-brown/50 font-medium">
                            {t("panel")}: {acceptCount}✓ {rejectCount}✗
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-brown mt-0.5">
                        {batch.greenBean?.beanType || batch.orderItem.beanTypeName} — #{batch.orderItem.order.orderNumber} ({batch.orderItem.order.customer.name})
                      </p>
                    </div>
                    <button onClick={() => setExpandedId(isExpanded ? null : batch.id)}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${isExpanded ? "bg-charcoal text-white" : "bg-white border border-border text-brown hover:bg-cream"}`}>
                      <Eye size={12} /> {isExpanded ? t("collapse") : t("details")}
                    </button>
                  </div>
                  {isExpanded && (
                    <div className="mt-3 pt-3 border-t border-current/10 space-y-1">
                      <p className="text-xs text-brown">
                        <span className="font-bold">{t("roastedLabel")}:</span> {batch.roastedBeanQuantity}kg |{" "}
                        <span className="font-bold">{t("date")}:</span> {formatDate(batch.date)}
                        {batch.roastProfile && <> | <span className="font-bold">{t("roastProfileLabel")}:</span> {batch.roastProfile}</>}
                      </p>
                      {batch.childBatches.length > 0 && (
                        <p className="text-xs text-brown">
                          <span className="font-bold">{t("sourceBatches")}:</span> {batch.childBatches.map((c) => c.batchNumber).join(", ")}
                        </p>
                      )}
                      {batch.qcRecords.length > 0 && (
                        <div className="mt-2">
                          <p className="text-xs font-bold text-charcoal mb-1">{t("testerRecords")}:</p>
                          {batch.qcRecords.map((r) => (
                            <div key={r.id} className="text-xs text-brown bg-white/50 rounded-lg px-2 py-1.5 mb-1 flex items-center justify-between">
                              <span className="font-semibold">
                                {r.testerName || r.employee?.name || "—"}
                                {r.isExternal && (
                                  <span className="ltr:ml-1 rtl:mr-1 text-[10px] font-bold text-purple-600">
                                    ({t("guestBadge")})
                                  </span>
                                )}
                              </span>
                              <span className={`font-bold ${r.decision === "Accept" ? "text-green-600" : "text-red-600"}`}>
                                {r.decision === "Accept" ? t("accept") : t("reject")}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                      {isBlended && (
                        <p className="text-xs text-purple-700 font-bold mt-1">{t("blendedNoQcNeeded")}</p>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}

      {/* QC Submission Form Modal */}
      {showForm && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setShowForm(false)}>
          <div className="bg-white rounded-2xl p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-extrabold text-charcoal mb-1">{t("submitQcRecord")}</h2>
            <p className="text-xs text-brown/60 mb-4">{t("qcFormSubtitle")}</p>
            <form onSubmit={handleSubmit} className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-charcoal mb-1">{t("roastingBatchLabel")}</label>
                <select value={form.batchId} onChange={(e) => {
                  const batch = backlogBatches.find((b) => b.id === e.target.value);
                  if (batch) setForm({ ...form, batchId: batch.id, coffeeOrigin: batch.greenBean?.beanType || batch.orderItem.beanTypeName, processing: batch.greenBean?.process || "", serialNumber: batch.batchNumber });
                }}
                  className="w-full px-3 py-2 border-2 border-border rounded-xl focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors" required>
                  <option value="">{t("selectBatch")}</option>
                  {backlogBatches.map((b) => (
                    <option key={b.id} value={b.id}>{b.batchNumber} — {b.orderItem.beanTypeName} (#{b.orderItem.order.orderNumber})</option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-charcoal mb-1">{t("coffeeOrigin")}</label>
                  <input type="text" value={form.coffeeOrigin} onChange={(e) => setForm({ ...form, coffeeOrigin: e.target.value })}
                    className="w-full px-3 py-2 border-2 border-border rounded-xl focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors" required />
                </div>
                <div>
                  <label className="block text-sm font-medium text-charcoal mb-1">{t("process")}</label>
                  <select value={form.processing} onChange={(e) => setForm({ ...form, processing: e.target.value })}
                    className="w-full px-3 py-2 border-2 border-border rounded-xl focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors">
                    <option value="">—</option>
                    <option>Natural</option><option>Washed</option><option>Honey</option>
                    <option>Anaerobic</option><option>Innoculated</option><option>Co-Fermented</option>
                    <option>Extended Natural</option>
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-charcoal mb-1">{t("serialNumberShort")} ({t("roastingBatchLabel")})</label>
                  <input type="text" value={form.serialNumber} onChange={(e) => setForm({ ...form, serialNumber: e.target.value })}
                    className="w-full px-3 py-2 border-2 border-border rounded-xl focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors" required />
                </div>
                <div>
                  <label className="block text-sm font-medium text-charcoal mb-1">{t("colorAgtron")}</label>
                  <input type="number" value={form.color} onChange={(e) => setForm({ ...form, color: e.target.value })}
                    className="w-full px-3 py-2 border-2 border-border rounded-xl focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors" placeholder="e.g., 65" />
                </div>
              </div>
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
              <div className="flex gap-3 pt-2">
                <button type="submit" disabled={submitting}
                  className="flex-1 py-2 bg-orange text-white rounded-lg hover:bg-orange-dark shadow-md shadow-orange/20 hover:shadow-orange/35 active:scale-[0.98] transition-all duration-200 font-bold disabled:opacity-50 flex items-center justify-center gap-2">
                  {submitting ? <><Loader2 size={15} className="animate-spin" /> {t("saving")}</> : t("saveRecord")}
                </button>
                <button type="button" onClick={() => setShowForm(false)} className="flex-1 py-2 border rounded-lg hover:bg-gray-50">
                  {t("cancel")}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Single-tester warning modal */}
      {confirmFinalizeId && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setConfirmFinalizeId(null)}>
          <div className="bg-white rounded-2xl p-6 w-full max-w-sm text-center" onClick={(e) => e.stopPropagation()}>
            <AlertTriangle size={40} className="text-amber-500 mx-auto mb-3" />
            <h2 className="text-lg font-extrabold text-charcoal mb-2">{t("onlyOneTester")}</h2>
            <p className="text-sm text-brown/70 mb-5">{t("oneTesterWarning")}</p>
            <div className="flex gap-3">
              <button onClick={() => setConfirmFinalizeId(null)} className="flex-1 py-2 border rounded-lg hover:bg-gray-50 font-medium text-sm">
                {t("addMoreTesters")}
              </button>
              <button
                onClick={() => handleFinalize(confirmFinalizeId)}
                disabled={finalizing}
                className="flex-1 py-2 bg-charcoal text-white rounded-lg hover:bg-charcoal/80 font-bold text-sm disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {finalizing ? <><Loader2 size={14} className="animate-spin" /> {t("finalizing")}</> : t("finalizeAnyway")}
              </button>
            </div>
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
    </div>
  );
}
