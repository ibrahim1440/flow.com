"use client";

// One journal entry (Figma ACC-21 / 21d / 22 / 26): its lines and dimensions, totals, status, who prepared /
// approved / posted it, the source document link, the reversal link, the audit trail — and the actions the
// viewer holds (edit a draft, submit, approve or reject, post, reverse with a reason).
import Link from "next/link";
import { use, useState } from "react";
import { OpsLoading, Btn, Field } from "@/components/ops/ui";
import { Dialog } from "@/components/hr/ui";
import { AcctShell, Msg, StatusTag, STATUS_AR, TYPE_AR, money, todayRiyadh, useApi, useLang, useWrite, type Setup } from "../../_ui/shell";
import { JournalEditor } from "../../_ui/journal-editor";

type Line = { id: string; lineNo: number | null; debit: string; credit: string; description: string | null; branchId: string | null; costCenterId: string | null; partyType: string | null; partyId: string | null; itemType: string | null; itemId: string | null; account: { id: string; code: string; nameAr: string | null; nameEn: string; controlType: string | null } };
type Entry = {
  id: string; ref: string | null; entryNo: number; entryDate: string; type: string; status: string; description: string | null; sourceModule: string; sourceType: string | null; sourceId: string | null; sourceEvent: string | null; sourceHref: string | null;
  totalDebit: string; totalCredit: string; createdBy: string | null; submittedBy: string | null; approvedBy: string | null; postedBy: string | null; postedAt: string | null; reversedBy: string | null; rejectReason: string | null; rejectedBy: string | null; reversalReason: string | null; sodBypass: boolean; roundingAmount: string | null;
  idempotencyKey: string | null; fiscalPeriod: { year: number; periodNo: number; status: string };
  reversesEntry: { id: string; ref: string | null; entryNo: number } | null; reversedByEntry: { id: string; ref: string | null; entryNo: number; entryDate: string } | null;
  lines: Line[]; people: Record<string, string>; audit: { id: string; at: string; actorId: string | null; action: string; reason: string | null }[];
};

const ACTION_AR: Record<string, [string, string]> = {
  INSERT: ["أُنشئ", "Created"], UPDATE: ["عُدّل", "Changed"], DELETE: ["حُذف", "Deleted"], STATUS_SUBMITTED: ["قُدّم للاعتماد", "Submitted"], STATUS_APPROVED: ["اعتُمد", "Approved"],
  STATUS_POSTED: ["رُحّل", "Posted"], STATUS_REVERSED: ["عُكس", "Reversed"], STATUS_DRAFT: ["أُعيد مسودة", "Returned to draft"],
};

export default function JournalPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { L } = useLang();
  const setup = useApi<Setup>("/api/accounting/setup");
  const je = useApi<Entry>(`/api/accounting/journals/${id}`);
  const w = useWrite();
  const [dialog, setDialog] = useState<null | "reject" | "reverse">(null);
  const [reason, setReason] = useState("");
  const [revDate, setRevDate] = useState(todayRiyadh());
  const [editing, setEditing] = useState(false);
  const e = je.data;
  const can = setup.data?.can;
  const me = setup.data?.viewer.id;
  const who = (x: string | null) => (x ? e?.people[x] ?? x : "—");
  const act = async (step: string, ok: string, json?: unknown) => {
    const r = await w.run(step, `/api/accounting/journals/${id}/${step}`, "PATCH", json, ok);
    if (r) { setDialog(null); setReason(""); je.reload(); }
    return r;
  };
  const selfApproval = !!e && (e.createdBy === me || e.submittedBy === me) && !(setup.data?.sod?.allowSelfApproval ?? setup.data?.simpleMode);
  const isEngine = !!e?.idempotencyKey;
  const isHr = (e?.sourceModule ?? "").toLowerCase() === "hr";

  return (
    <AcctShell setup={setup.data} title={e ? `${L("قيد", "Entry")} ${e.ref ?? `#${e.entryNo}`}` : L("القيد", "Entry")}
      meta={e ? (
        <span className="acct-meta">
          <Link href="/dashboard/accounting/journals">→ {L("القيود", "Journals")}</Link>
          <span aria-hidden="true">·</span><StatusTag map={STATUS_AR} value={e.status} />
          <span aria-hidden="true">·</span><span>{L(TYPE_AR[e.type]?.[0] ?? e.type, TYPE_AR[e.type]?.[1] ?? e.type)}</span>
          <span aria-hidden="true">·</span><span className="hr-num">{e.entryDate}</span>
          <span aria-hidden="true">·</span><span>{L("الفترة", "Period")} <span className="hr-num">{e.fiscalPeriod.year}-{String(e.fiscalPeriod.periodNo).padStart(2, "0")}</span></span>
        </span>
      ) : undefined}
      actions={e ? (
        <span className="acct-actions">
          {e.status === "DRAFT" && e.type === "MANUAL" && can?.journalCreate && !editing ? <Btn onClick={() => setEditing(true)} data-testid="je-edit">{L("تعديل المسودة", "Edit draft")}</Btn> : null}
          {e.status === "DRAFT" && e.type === "MANUAL" && can?.journalSubmit ? <Btn variant="primary" busy={w.busy === "submit"} onClick={() => act("submit", L("قُدّم القيد للاعتماد.", "Submitted for approval."))} data-testid="je-do-submit">{L("تقديم للاعتماد", "Submit")}</Btn> : null}
          {e.status === "SUBMITTED" && can?.journalApprove ? <Btn variant="primary" disabled={selfApproval} busy={w.busy === "approve"} onClick={() => act("approve", L("اعتُمد القيد.", "Approved."))} data-testid="je-do-approve" title={selfApproval ? L("لا تعتمد قيدًا أعددته", "You do not approve your own journal") : undefined}>{L("اعتماد", "Approve")}</Btn> : null}
          {(e.status === "SUBMITTED" || e.status === "APPROVED") && can?.journalApprove ? <Btn onClick={() => setDialog("reject")} data-testid="je-do-reject">{L("رفض وإرجاع كمسودة", "Reject to draft")}</Btn> : null}
          {e.status === "APPROVED" && can?.journalPost ? <Btn variant="primary" busy={w.busy === "post"} onClick={() => act("post", L("رُحّل القيد.", "Posted."))} data-testid="je-do-post">{L("ترحيل", "Post")}</Btn> : null}
          {e.status === "POSTED" && can?.journalReverse && !isHr && e.type !== "OPENING" && e.type !== "REVERSAL" ? <Btn variant="danger" onClick={() => { const t = todayRiyadh(); setRevDate(e.entryDate > t ? e.entryDate : t); setDialog("reverse"); }} data-testid="je-do-reverse">{L("عكس القيد", "Reverse")}</Btn> : null}
        </span>
      ) : undefined}>
      <Msg error={w.error ?? je.error} done={w.done} onClose={() => { w.setError(null); w.setDone(null); }} />
      {!e ? <OpsLoading /> : editing ? (
        <JournalEditor entryId={e.id} initial={{
          entryDate: e.entryDate, description: e.description ?? "",
          lines: e.lines.map((l) => ({ accountId: l.account.id, description: l.description ?? "", debit: Number(l.debit) ? l.debit : "", credit: Number(l.credit) ? l.credit : "", branchId: l.branchId ?? "", costCenterId: l.costCenterId ?? "", partyType: l.partyType ?? "", partyId: l.partyId ?? "" })),
        }} />
      ) : (
        <>
          {e.rejectReason && e.status === "DRAFT" ? <p className="hr-err">{L("أُعيد مسودة:", "Returned to draft:")} {e.rejectReason} — {who(e.rejectedBy)}</p> : null}
          <section className="acct-card">
            <dl className="acct-kv-grid">
              <div><dt>{L("الوصف", "Description")}</dt><dd>{e.description ?? "—"}</dd></div>
              <div><dt>{L("المصدر", "Source")}</dt><dd>{e.sourceType ? (e.sourceHref ? <Link href={e.sourceHref} data-testid="je-source">{e.sourceType} · {e.sourceId}</Link> : <span className="acct-code">{e.sourceType} · {e.sourceId}</span>) : (e.sourceModule === "manual" ? L("قيد يدوي", "Manual journal") : e.sourceModule)}{e.sourceEvent ? <span className="acct-hint"> · {e.sourceEvent}</span> : null}</dd></div>
              <div><dt>{L("أعدّه", "Prepared by")}</dt><dd>{who(e.createdBy)}</dd></div>
              <div><dt>{L("اعتمده", "Approved by")}</dt><dd>{who(e.approvedBy)}{e.sodBypass ? <span className="hr-flag tone-warning" style={{ marginInlineStart: 6 }}><span>{L("الوضع المبسّط: اعتمد المُعدّ قيده", "Simple mode: self-approved")}</span></span> : null}</dd></div>
              <div><dt>{L("رحّله", "Posted by")}</dt><dd>{who(e.postedBy)}</dd></div>
              {e.reversesEntry ? <div><dt>{L("يعكس القيد", "Reverses")}</dt><dd><Link href={`/dashboard/accounting/journals/${e.reversesEntry.id}`} className="acct-code">{e.reversesEntry.ref ?? `#${e.reversesEntry.entryNo}`}</Link>{e.reversalReason ? ` — ${e.reversalReason}` : ""}</dd></div> : null}
              {e.reversedByEntry ? <div><dt>{L("عُكس بالقيد", "Reversed by")}</dt><dd><Link href={`/dashboard/accounting/journals/${e.reversedByEntry.id}`} className="acct-code" data-testid="je-reversed-by">{e.reversedByEntry.ref ?? `#${e.reversedByEntry.entryNo}`}</Link> · <span className="hr-num">{e.reversedByEntry.entryDate}</span></dd></div> : null}
              {e.roundingAmount ? <div><dt>{L("فرق تقريب مرحّل", "Rounding posted")}</dt><dd className="hr-num">{money(e.roundingAmount)}</dd></div> : null}
            </dl>
          </section>
          <div className="hr-tablewrap">
            <table className="hr-table is-dense" data-testid="je-detail-lines">
              <thead><tr><th>#</th><th>{L("الحساب", "Account")}</th><th>{L("الوصف", "Description")}</th><th className="acct-hide-m">{L("الأبعاد", "Dimensions")}</th><th className="num">{L("مدين", "Debit")}</th><th className="num">{L("دائن", "Credit")}</th></tr></thead>
              <tbody>
                {e.lines.map((l, i) => (
                  <tr key={l.id}>
                    <td className="hr-num">{l.lineNo ?? i + 1}</td>
                    <td><span className="acct-code">{l.account.code}</span> {L(l.account.nameAr ?? l.account.nameEn, l.account.nameEn)}</td>
                    <td>{l.description ?? "—"}</td>
                    <td className="acct-hide-m acct-hint">{[l.partyType ? `${l.partyType === "CUSTOMER" ? L("عميل", "Customer") : l.partyType === "SUPPLIER" ? L("مورد", "Supplier") : L("موظف", "Employee")} ${l.partyId}` : null, l.branchId ? `${L("فرع", "Branch")} ${l.branchId}` : null, l.costCenterId ? `${L("مركز", "CC")} ${l.costCenterId}` : null, l.itemType ? `${l.itemType} ${l.itemId}` : null].filter(Boolean).join(" · ") || "—"}</td>
                    <td className="num hr-num">{money(l.debit, true)}</td>
                    <td className="num hr-num">{money(l.credit, true)}</td>
                  </tr>
                ))}
                <tr className="is-total"><td /><td colSpan={2}>{L("المجموع", "Total")}</td><td className="acct-hide-m" /><td className="num hr-num">{money(e.totalDebit)}</td><td className="num hr-num">{money(e.totalCredit)}</td></tr>
              </tbody>
            </table>
          </div>
          <section className="acct-card">
            <h3>{L("سجل التدقيق", "Audit trail")}</h3>
            <ol className="acct-checks" data-testid="je-audit">
              {e.audit.map((a) => (
                <li key={a.id}><span className="hr-num">{new Date(a.at).toLocaleString("en-GB", { timeZone: "Asia/Riyadh" })}</span> · {L(ACTION_AR[a.action]?.[0] ?? a.action, ACTION_AR[a.action]?.[1] ?? a.action)} · {who(a.actorId)}{a.reason ? ` — ${a.reason}` : ""}</li>
              ))}
            </ol>
          </section>
          {isEngine ? <p className="acct-hint">{L("قيد آلي من محرك الترحيل: لا يُعدَّل؛ يُصحَّح بعكسه ثم بقيد جديد.", "An automatic entry of the posting engine: never edited; corrected by a reversal and a new entry.")}</p> : null}
        </>
      )}
      <Dialog open={dialog === "reject"} title={L("رفض وإرجاع كمسودة", "Reject to draft")} onClose={() => setDialog(null)}
        actions={<><Btn variant="primary" disabled={reason.trim().length < 3} busy={w.busy === "reject"} onClick={() => act("reject", L("أُعيد القيد مسودة.", "Returned to draft."), { reason })} data-testid="je-reject-confirm">{L("رفض", "Reject")}</Btn><Btn onClick={() => setDialog(null)}>{L("إلغاء", "Cancel")}</Btn></>}>
        <Field label={L("السبب", "Reason")}><textarea className="hr-input hr-textarea" value={reason} onChange={(ev) => setReason(ev.target.value)} data-testid="je-reject-reason" /></Field>
      </Dialog>
      <Dialog open={dialog === "reverse"} title={L("عكس القيد", "Reverse the entry")} onClose={() => setDialog(null)}
        sub={L("يُنشأ قيد عكسي مرحّل بالتاريخ المختار ويبقى الأصل في الدفتر معلَّمًا «معكوس».", "A posted reversing entry is created on the chosen date; the original stays in the books, marked «reversed».")}
        actions={<><Btn variant="danger" disabled={reason.trim().length < 3} busy={w.busy === "reverse"} onClick={() => act("reverse", L("عُكس القيد.", "Reversed."), { reason, date: revDate })} data-testid="je-reverse-confirm">{L("عكس", "Reverse")}</Btn><Btn onClick={() => setDialog(null)}>{L("إلغاء", "Cancel")}</Btn></>}>
        <Field label={L("تاريخ القيد العكسي", "Reversal date")}><input type="date" className="hr-input" value={revDate} onChange={(ev) => setRevDate(ev.target.value)} /></Field>
        <Field label={L("السبب", "Reason")}><textarea className="hr-input hr-textarea" value={reason} onChange={(ev) => setReason(ev.target.value)} data-testid="je-reverse-reason" /></Field>
      </Dialog>
    </AcctShell>
  );
}
