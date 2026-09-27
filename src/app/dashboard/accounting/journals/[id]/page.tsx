"use client";

// Figma: ACC-04 (pending approval with timeline), ACC-10 "posted-readonly", ACC-11 (mobile).
// Which actions appear depends on status, the user's duties and whether they prepared the
// entry; the server enforces the same rules and answers 403/409 if the screen is bypassed.
import { use, useState } from "react";
import Link from "next/link";
import { ArrowRight, CheckCircle2, Send, Trash2, Undo2, XCircle, Upload } from "lucide-react";
import { ApiError, Badge, Button, Card, CardTitle, Dialog, ErrorState, Field, INPUT, LoadingState, Notice, Table, Td, Th, api, useApi, useL } from "../../../finance/_components/ui";
import { JournalStatus, JournalType, riyadhToday, useAutoText, useCan, useDay } from "../../_components/kit";
import { JournalEditor, type EditorValue } from "../../_components/journal-editor";

type Line = { id: string; lineNo: number; description: string | null; debitMinor: number; creditMinor: number; partyType: string | null; partyName: string | null;
  account: { id: string; code: string; nameEn: string; nameAr: string | null }; branch: { id: string; nameEn: string; nameAr: string | null } | null; costCenter: { id: string; nameEn: string; nameAr: string | null } | null;
  debit: string; credit: string; branchId: string | null; costCenterId: string | null };
type Entry = {
  id: string; entryNo: number; entryDate: string; type: string; status: string; description: string | null; sourceModule: string; sourceDocumentId: string | null;
  totalDebitMinor: number; totalCreditMinor: number; isProvisional: boolean; policyKey: string | null; policyVersion: number | null; reversalReason: string | null;
  createdBy: string | null; submittedBy: string | null; approvedBy: string | null; postedBy: string | null; rejectedBy: string | null; rejectionReason: string | null;
  createdAt: string; submittedAt: string | null; approvedAt: string | null; postedAt: string | null; rejectedAt: string | null;
  fiscalPeriod: { year: number; periodNo: number; status: string }; reversesEntry: { id: string; entryNo: number } | null; reversedByEntry: { id: string; entryNo: number; status: string } | null;
  originEvent: { id: string; eventType: string; sourceDocumentId: string; occurredAt: string } | null; names: Record<string, string>; lines: Line[];
  audit: { id: string; action: string; createdAt: string; userId: string | null; reason: string | null }[];
};

const ACTION_LABEL: Record<string, [string, string]> = {
  "journal.create": ["إنشاء", "Created"], "journal.edit": ["تعديل المسودة", "Draft edited"], "journal.submit": ["تقديم للاعتماد", "Submitted"],
  "journal.approve": ["اعتماد", "Approved"], "journal.reject": ["رفض وإرجاع", "Rejected"], "journal.post": ["ترحيل", "Posted"],
  "journal.reversal_request": ["طلب عكس", "Reversal requested"], "journal.discard": ["حذف المسودة", "Draft discarded"],
};

export default function JournalDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { L, money, name } = useL();
  const day = useDay();
  const auto = useAutoText();
  const { user, can } = useCan();
  const { data: e, error, reload } = useApi<Entry>(`/api/accounting/journals/${id}`);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [reason, setReason] = useState("");
  const [editing, setEditing] = useState(false);
  const [reverseOpen, setReverseOpen] = useState(false);
  const [revDate, setRevDate] = useState(riyadhToday);
  const [revReason, setRevReason] = useState("");

  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!e) return <LoadingState />;

  const who = (idv: string | null) => (!idv ? "—" : idv.startsWith("system:") ? L("النظام", "System") : e.names[idv] ?? idv);
  const at = (t: string | null) => (t ? new Date(t).toLocaleString("en-GB", { timeZone: "Asia/Riyadh", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : null);
  const mine = user?.id === e.createdBy || user?.id === e.submittedBy;
  const act = async (key: string, path: string, body: unknown = {}) => {
    setBusy(key); setMsg(null);
    try {
      const r = await api<{ id?: string }>(`/api/accounting/journals/${id}/${path}`, { method: "POST", json: body });
      if (path === "reverse" && r?.id) { window.location.href = `/dashboard/accounting/journals/${r.id}`; return; }
      setMsg({ tone: "ok", text: L("تم.", "Done.") }); setReason(""); reload();
    } catch (err) { setMsg({ tone: "bad", text: err instanceof ApiError ? err.message : String(err) }); }
    finally { setBusy(null); }
  };
  const discard = async () => {
    if (!confirm(L("حذف هذه المسودة نهائياً؟", "Discard this draft permanently?"))) return;
    setBusy("discard");
    try { await api(`/api/accounting/journals/${id}`, { method: "DELETE" }); window.location.href = "/dashboard/accounting/journals"; }
    catch (err) { setMsg({ tone: "bad", text: err instanceof ApiError ? err.message : String(err) }); setBusy(null); }
  };

  if (editing && e.status === "DRAFT") {
    const initial: EditorValue = { entryDate: e.entryDate.slice(0, 10), type: e.type as EditorValue["type"], description: e.description ?? "",
      lines: e.lines.map((l) => ({ accountId: l.account.id, description: l.description ?? "", debit: l.debitMinor ? (l.debitMinor / 100).toFixed(2) : "", credit: l.creditMinor ? (l.creditMinor / 100).toFixed(2) : "", branchId: l.branchId ?? "", costCenterId: l.costCenterId ?? "" })) };
    return <JournalEditor initial={initial} entryId={e.id} onSaved={() => { setEditing(false); reload(); }} />;
  }

  const steps: { title: string; who: string; when: string | null; state: "done" | "now" | "todo" }[] = [
    { title: L("أُعدّ", "Prepared"), who: who(e.createdBy), when: at(e.createdAt), state: "done" },
    { title: L("قُدّم للاعتماد", "Submitted"), who: e.submittedBy ? who(e.submittedBy) : "", when: at(e.submittedAt), state: e.submittedAt ? "done" : e.status === "DRAFT" ? "now" : "done" },
    { title: e.status === "SUBMITTED" ? L("بانتظار الاعتماد", "Awaiting approval") : L("اعتُمد", "Approved"), who: e.approvedBy ? who(e.approvedBy) : L("أي معتمد عدا المُعِدّ", "Any approver except the preparer"), when: at(e.approvedAt), state: e.approvedAt ? "done" : e.status === "SUBMITTED" ? "now" : "todo" },
    { title: L("الترحيل", "Posting"), who: e.postedBy ? who(e.postedBy) : L("بعد الاعتماد", "After approval"), when: at(e.postedAt), state: e.postedAt ? "done" : e.status === "APPROVED" ? "now" : "todo" },
  ];
  const canReverse = e.status === "POSTED" && e.type !== "AUTO" && !e.reversedByEntry && can("journal_reverse");
  const periodLabel = `${e.fiscalPeriod.year}-${String(e.fiscalPeriod.periodNo).padStart(2, "0")}`;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3 flex-wrap">
        <Link href="/dashboard/accounting/journals" className="text-brown hover:text-charcoal" aria-label={L("رجوع للقيود", "Back to entries")}><ArrowRight size={18} className="ltr:rotate-180" /></Link>
        <h2 className="text-lg font-extrabold text-charcoal">{L(`قيد #${e.entryNo}`, `Entry #${e.entryNo}`)} — {auto(e.description)}</h2>
        <JournalStatus status={e.status} rejected={!!e.rejectionReason && e.status === "DRAFT"} />
        <JournalType type={e.type} source={e.sourceModule} />
        {e.isProvisional && <Badge tone="warn">{L("مؤقت — قاعدة اختبار", "Provisional — test database")}</Badge>}
      </div>
      <p className="text-[13px] text-brown -mt-2"><b className="text-charcoal text-base tabular-nums">{money(e.totalDebitMinor)} {L("ر.س", "SAR")}</b> · {day(e.entryDate)} · {L("الفترة", "Period")} {periodLabel} ({e.fiscalPeriod.status})</p>

      {e.status === "DRAFT" && e.rejectionReason && <Notice tone="bad">{L("أُرجع من", "Returned by")} {who(e.rejectedBy)}: {e.rejectionReason}</Notice>}
      {e.reversesEntry && <Notice tone="info">{L("هذا قيد عكسي للقيد", "This reverses entry")} <a className="font-bold underline" href={`/dashboard/accounting/journals/${e.reversesEntry.id}`}>#{e.reversesEntry.entryNo}</a>{e.reversalReason ? ` — ${e.reversalReason}` : ""}</Notice>}
      {e.reversedByEntry && <Notice tone="info">{L("عُكس هذا القيد بالقيد", "Reversed by entry")} <a className="font-bold underline" href={`/dashboard/accounting/journals/${e.reversedByEntry.id}`}>#{e.reversedByEntry.entryNo}</a> ({e.reversedByEntry.status})</Notice>}
      {e.type === "AUTO" && e.originEvent && (
        <Notice tone="info">{L("قيد آلي من", "Automatic entry from")} {e.sourceModule} · {e.originEvent.eventType} · {L("المستند", "document")} <code dir="ltr">{e.originEvent.sourceDocumentId}</code>
          {e.policyKey ? ` · ${L("السياسة", "policy")} ${e.policyKey}${e.policyVersion ? " v" + e.policyVersion : ""}` : ""}. {L("يُصحَّح من مصدره.", "Corrected at its source.")}</Notice>
      )}
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}

      <div className="grid gap-4 grid-cols-1 xl:grid-cols-[1fr_358px] items-start">
        <Card>
          <CardTitle title={L("السطور", "Lines")} />
          {/* Phone: stacked lines (ACC-11) so amounts never scroll out of view. */}
          <ul className="sm:hidden flex flex-col divide-y divide-border-light">
            {e.lines.map((l) => (
              <li key={l.id} className="flex items-start justify-between gap-3 py-2">
                <span className="text-[13px] text-charcoal">{l.account.code} · {name(l.account)}{l.description ? <span className="block text-xs text-brown">{auto(l.description)}</span> : null}</span>
                <span className="text-[13px] font-bold text-brown whitespace-nowrap tabular-nums">{l.debitMinor ? `${L("مدين", "Dr")} ${money(l.debitMinor)}` : `${L("دائن", "Cr")} ${money(l.creditMinor)}`}</span>
              </li>
            ))}
            <li className="flex justify-between py-2 font-bold text-[13px]"><span>{L("المجموع", "Total")}</span><span className="tabular-nums">{money(e.totalDebitMinor)}</span></li>
          </ul>
          <div className="hidden sm:block"><Table>
            <thead><tr><Th>#</Th><Th>{L("الحساب", "Account")}</Th><Th>{L("الوصف", "Description")}</Th><Th>{L("الفرع / المركز / الطرف", "Branch / centre / party")}</Th><Th num>{L("مدين", "Debit")}</Th><Th num>{L("دائن", "Credit")}</Th></tr></thead>
            <tbody>
              {e.lines.map((l) => (
                <tr key={l.id}>
                  <Td className="text-brown">{l.lineNo}</Td>
                  <Td><a className="hover:underline" href={`/dashboard/accounting/reports?view=gl&accountId=${l.account.id}`}>{l.account.code} · {name(l.account)}</a></Td>
                  <Td className="text-brown">{auto(l.description)}</Td>
                  <Td className="text-xs text-brown">{[l.branch && name(l.branch), l.costCenter && name(l.costCenter), l.partyName].filter(Boolean).join(" / ") || "—"}</Td>
                  <Td num>{l.debitMinor ? money(l.debitMinor) : ""}</Td>
                  <Td num>{l.creditMinor ? money(l.creditMinor) : ""}</Td>
                </tr>
              ))}
              <tr className="bg-cream-dark font-bold"><Td></Td><Td>{L("المجموع", "Total")}</Td><Td></Td><Td></Td><Td num>{money(e.totalDebitMinor)}</Td><Td num>{money(e.totalCreditMinor)}</Td></tr>
            </tbody>
          </Table></div>
          <div className="flex items-center gap-2">
            {e.totalDebitMinor === e.totalCreditMinor ? <Badge tone="ok">{L("متوازن ✓", "Balanced ✓")}</Badge> : <Badge tone="bad">{L("غير متوازن", "Not balanced")}</Badge>}
            <span className="text-xs text-brown">{["POSTED", "REVERSED"].includes(e.status) ? L("مرحّل — للقراءة فقط", "Posted — read only") : L("لا يُعدّل بعد تقديمه إلا بإرجاعه كمسودة", "Once submitted it changes only by being returned to draft")}</span>
          </div>
        </Card>

        <Card>
          <CardTitle title={L("الاعتماد", "Approval")} sub={L("فصل المهام: من أعدّ القيد لا يعتمده", "Separation of duties: the preparer does not approve")} />
          <ol className="flex flex-col gap-3.5" aria-label={L("مراحل الاعتماد", "Approval steps")}>
            {steps.map((s) => (
              <li key={s.title} className="flex items-start gap-2.5">
                <span aria-hidden className={`mt-1 w-3 h-3 rounded-full flex-shrink-0 ${s.state === "done" ? "bg-green-600" : s.state === "now" ? "bg-amber-600" : "bg-gray-300"}`} />
                <span className="flex flex-col">
                  <span className={`text-[13px] font-bold ${s.state === "todo" ? "text-brown" : "text-charcoal"}`}>{s.title}{s.state === "now" && <span className="sr-only"> ({L("الخطوة الحالية", "current step")})</span>}</span>
                  {s.who && <span className="text-xs text-brown">{s.who}</span>}
                  {s.when && <span className="text-[11px] text-brown">{s.when}</span>}
                </span>
              </li>
            ))}
          </ol>

          {e.status === "DRAFT" && (
            <div className="flex gap-2 flex-wrap">
              {can("journal_submit") && <Button kind="primary" icon={Send} busy={busy === "submit"} onClick={() => act("submit", "submit")}>{L("تقديم للاعتماد", "Submit for approval")}</Button>}
              {can("journal_create") && e.type !== "REVERSAL" && e.type !== "AUTO" && <Button onClick={() => setEditing(true)}>{L("تعديل", "Edit")}</Button>}
              {can("journal_create") && e.type !== "AUTO" && <Button kind="danger" icon={Trash2} busy={busy === "discard"} onClick={discard}>{L("حذف المسودة", "Discard draft")}</Button>}
            </div>
          )}
          {(e.status === "SUBMITTED" || e.status === "APPROVED") && can("journal_approve") && !mine && (
            <>
              <Field label={L("سبب الرفض (مطلوب عند الرفض)", "Reason for rejection (required to reject)")} hint={L("5 أحرف على الأقل — يُحفظ في سجل التدقيق", "At least 5 characters — kept in the audit trail")}>
                <textarea className={INPUT} rows={2} value={reason} onChange={(ev) => setReason(ev.target.value)} />
              </Field>
              <div className="flex gap-2 flex-wrap">
                {e.status === "SUBMITTED" && <Button kind="primary" icon={CheckCircle2} busy={busy === "approve"} onClick={() => act("approve", "approve")}>{L("اعتماد", "Approve")}</Button>}
                <Button kind="danger" icon={XCircle} busy={busy === "reject"} disabled={reason.trim().length < 5} onClick={() => act("reject", "reject", { reason })}>{L("رفض وإرجاع كمسودة", "Reject to draft")}</Button>
              </div>
            </>
          )}
          {(e.status === "SUBMITTED" || e.status === "APPROVED") && mine && <Notice tone="info">{L("أعددت هذا القيد أو قدّمته — يعتمده شخص آخر.", "You prepared or submitted this entry — someone else approves it.")}</Notice>}
          {e.status === "APPROVED" && can("journal_post") && (
            <div><Button kind="primary" icon={Upload} busy={busy === "post"} onClick={() => act("post", "post")}>{L("ترحيل", "Post")}</Button></div>
          )}
          {canReverse && <div><Button icon={Undo2} onClick={() => setReverseOpen(true)}>{L("طلب قيد عكسي", "Request reversal")}</Button></div>}
          {e.status === "POSTED" && e.type === "AUTO" && <p className="text-xs text-brown">{L("القيود الآلية تُصحَّح من الوحدة المصدر (مثلاً: تسوية أو عكس في دفتر العمولات).", "Automatic entries are corrected in the source module (e.g. an adjustment or reversal in the commission ledger).")}</p>}
        </Card>
      </div>

      <Card>
        <CardTitle title={L("سجل التدقيق", "Audit trail")} sub={L("لا يمكن تعديله أو حذفه", "Cannot be edited or deleted")} />
        <Table>
          <thead><tr><Th>{L("الوقت", "Time")}</Th><Th>{L("الإجراء", "Action")}</Th><Th>{L("المستخدم", "User")}</Th><Th>{L("السبب", "Reason")}</Th></tr></thead>
          <tbody>
            {e.audit.map((a) => (
              <tr key={a.id}><Td className="whitespace-nowrap">{at(a.createdAt)}</Td><Td>{ACTION_LABEL[a.action] ? L(...ACTION_LABEL[a.action]) : a.action}</Td><Td>{who(a.userId)}</Td><Td className="text-brown">{a.reason ?? "—"}</Td></tr>
            ))}
            {e.audit.length === 0 && <tr><Td className="text-brown">{L("لا توجد أحداث تدقيق (قيد آلي).", "No audit events (automatic entry).")}</Td><Td /><Td /><Td /></tr>}
          </tbody>
        </Table>
      </Card>

      <Dialog open={reverseOpen} onClose={() => setReverseOpen(false)} title={L(`طلب عكس القيد #${e.entryNo}`, `Request reversal of entry #${e.entryNo}`)} sub={L("يُنشأ قيد معاكس ويُقدَّم للاعتماد؛ لا يُرحّل قبل أن يعتمده شخص آخر.", "A mirror entry is created and submitted; it posts only after someone else approves it.")}>
        <Field label={L("تاريخ القيد العكسي", "Reversal date")} hint={L("لا يسبق تاريخ القيد الأصلي، وفي فترة مفتوحة", "Not before the original, in an open period")}><input type="date" className={INPUT} value={revDate} onChange={(ev) => setRevDate(ev.target.value)} /></Field>
        <Field label={L("السبب (5 أحرف على الأقل)", "Reason (at least 5 characters)")}><textarea className={INPUT} rows={3} value={revReason} onChange={(ev) => setRevReason(ev.target.value)} /></Field>
        <div className="flex gap-2 justify-end">
          <Button kind="ghost" onClick={() => setReverseOpen(false)}>{L("إلغاء", "Cancel")}</Button>
          <Button kind="primary" busy={busy === "reverse"} disabled={revReason.trim().length < 5} onClick={() => act("reverse", "reverse", { reason: revReason, date: revDate })}>{L("إنشاء القيد العكسي", "Create reversal")}</Button>
        </div>
      </Dialog>
    </div>
  );
}
