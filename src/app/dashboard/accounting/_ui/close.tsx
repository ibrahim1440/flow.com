"use client";

// Accounting A5 — the month-end close checklist (Figma ACC-80 الفترات, ACC-81 الإقفال السنوي: the conditions table
// with a status per row and the closing-entry preview), the SoD exceptions report for the auditor, and the VAT return
// (the «الضريبة» tab). Every control is a convenience: the API re-checks each duty and records each close.
import Link from "next/link";
import { useState } from "react";
import { OpsLoading, Btn, Field } from "@/components/ops/ui";
import { Dialog } from "@/components/hr/ui";
import { Msg, money, useApi, useLang, useWrite } from "./shell";

export type Check = { key: string; status: "PASS" | "WARN" | "FAIL" | "NA"; count: number | null; amount: string | null; ar: string; en: string; href: string };
type Checklist = { period: { id: string; year: number; periodNo: number; status: string; from: string; to: string }; checks: Check[]; blocking: number; warnings: number; ready: boolean; active: boolean;
  history: { id: string; action: string; blocking: number; warnings: number; note: string | null; actorId: string; at: string }[] };

const STATUS: Record<Check["status"], [string, string]> = { PASS: ["متحقق", "Passed"], WARN: ["للمراجعة", "Review"], FAIL: ["غير متحقق", "Failed"], NA: ["لا ينطبق", "N/A"] };
const ACTION: Record<string, [string, string]> = { REVIEW: ["مراجعة", "Review"], SOFT_CLOSE: ["إقفال مؤقت", "Soft close"], CLOSE: ["إقفال نهائي", "Final close"], YEAR_END: ["إقفال السنة", "Year-end close"] };

export function CheckStatus({ s }: { s: Check["status"] }) {
  const { L } = useLang();
  return <span className={`acct-status is-${s}`}>{L(STATUS[s][0], STATUS[s][1])}</span>;
}

export function ChecksTable({ checks, testId }: { checks: Check[]; testId?: string }) {
  const { L } = useLang();
  return (
    <div className="hr-tablewrap">
      <table className="hr-table is-dense" data-testid={testId}>
        <thead><tr><th>{L("الشرط", "Check")}</th><th>{L("الحالة", "Status")}</th><th className="num acct-hide-m">{L("العدد / المبلغ", "Count / amount")}</th><th>{L("المعالجة", "Fix")}</th></tr></thead>
        <tbody>
          {checks.map((c) => (
            <tr key={c.key} data-check={c.key} data-status={c.status}>
              <td>{L(c.ar, c.en)}</td>
              <td><CheckStatus s={c.status} /></td>
              <td className="num hr-num acct-hide-m">{c.count !== null ? c.count : ""}{c.count !== null && c.amount !== null ? " · " : ""}{c.amount !== null ? money(c.amount) : ""}</td>
              <td>{c.status === "PASS" || c.status === "NA" ? <span className="acct-hint">—</span> : <Link href={c.href} className="hr-btn is-sm">{L("فتح", "Open")}</Link>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The close checklist of one month, with review / soft close / final close (recorded with the note). */
export function CloseChecklist({ periodId, can, onChanged }: { periodId: string; can: { lock: boolean; close: boolean }; onChanged: () => void }) {
  const { L } = useLang();
  const r = useApi<Checklist>(`/api/accounting/close?periodId=${encodeURIComponent(periodId)}`);
  const w = useWrite();
  const [dialog, setDialog] = useState<null | "review" | "soft-close" | "close">(null);
  const [note, setNote] = useState("");
  if (r.error) return <p role="alert" className="hr-err">{r.error}</p>;
  if (!r.data) return <OpsLoading rows={4} />;
  const d = r.data;
  const needsNote = dialog === "close" && d.warnings > 0;
  async function act() {
    if (!dialog) return;
    const ok = { review: L("سُجّلت المراجعة.", "The review is recorded."), "soft-close": L("أُقفلت الفترة مؤقتًا وسُجّلت القائمة.", "Soft-closed; the checklist is recorded."), close: L("أُقفلت الفترة نهائيًا وسُجّلت القائمة.", "Closed; the checklist is recorded.") }[dialog];
    const res = await w.run(dialog, `/api/accounting/close/${encodeURIComponent(periodId)}/${dialog}`, "POST", { note: note.trim() || null }, ok);
    if (res) { setDialog(null); setNote(""); r.reload(); onChanged(); }
  }
  const title = dialog ? { review: L("تسجيل مراجعة الإقفال", "Record a close review"), "soft-close": L("إقفال مؤقت", "Soft close"), close: L("إقفال نهائي", "Final close") }[dialog] : "";
  return (
    <section className="acct-card" data-testid="close-checklist">
      <div className="acct-foot" style={{ borderTop: 0, paddingTop: 0 }}>
        <h2>{L(`قائمة إقفال ${d.period.year}-${String(d.period.periodNo).padStart(2, "0")}`, `Close checklist ${d.period.year}-${String(d.period.periodNo).padStart(2, "0")}`)}</h2>
        <span className="acct-actions">
          {can.lock ? <Btn onClick={() => setDialog("review")} data-testid="close-review">{L("تسجيل مراجعة", "Record review")}</Btn> : null}
          {d.period.status === "OPEN" && can.lock ? <Btn onClick={() => setDialog("soft-close")} data-testid="close-soft">{L("إقفال مؤقت", "Soft close")}</Btn> : null}
          {d.period.status === "LOCKED" && can.close ? <Btn variant="primary" disabled={!d.ready} onClick={() => setDialog("close")} data-testid="close-final">{L("إقفال نهائي", "Final close")}</Btn> : null}
        </span>
      </div>
      <Msg error={w.error} done={w.done} onClose={() => { w.setError(null); w.setDone(null); }} />
      <p className={`acct-balanced ${d.blocking ? "is-bad" : "is-ok"}`} data-testid="close-summary">
        {d.blocking ? L(`● ${d.blocking} بند مانع — لا يُقفل نهائيًا حتى يُعالج`, `● ${d.blocking} blocking — no final close until fixed`) : L("● لا بنود مانعة", "● Nothing blocking")}
        {d.warnings ? <span className="acct-warn"> · {L(`${d.warnings} للمراجعة (الإقفال النهائي يطلب ملاحظة)`, `${d.warnings} to review (a final close needs a note)`)}</span> : null}
      </p>
      <ChecksTable checks={d.checks} testId="close-checks" />
      {d.history.length ? (
        <details>
          <summary className="acct-hint">{L(`السجل (${d.history.length})`, `Record (${d.history.length})`)}</summary>
          <ul className="acct-issues" data-testid="close-history">
            {d.history.map((h) => <li key={h.id}><span className="hr-num">{new Date(h.at).toLocaleString("en-GB", { timeZone: "Asia/Riyadh", dateStyle: "medium", timeStyle: "short" })}</span><span>{L(ACTION[h.action]?.[0] ?? h.action, ACTION[h.action]?.[1] ?? h.action)} · {L(`مانع ${h.blocking}، للمراجعة ${h.warnings}`, `blocking ${h.blocking}, review ${h.warnings}`)}{h.note ? ` · «${h.note}»` : ""}</span><span className="acct-code">{h.actorId}</span></li>)}
          </ul>
        </details>
      ) : null}
      <Dialog open={!!dialog} title={title} onClose={() => setDialog(null)}
        actions={<><Btn variant={dialog === "close" ? "danger" : "primary"} disabled={needsNote && note.trim().length < 3} busy={!!w.busy} onClick={act} data-testid="close-confirm">{title}</Btn><Btn onClick={() => setDialog(null)}>{L("إلغاء", "Cancel")}</Btn></>}>
        <p>{dialog === "close" ? L("تُسجَّل القائمة كما هي الآن ثم ترفض قاعدة البيانات أي ترحيل إلى الفترة.", "The checklist is recorded as it stands, then the database refuses every posting into the period.") : dialog === "soft-close" ? L("تُسجَّل القائمة ثم يتوقف الترحيل إلى الفترة؛ العمليات اليومية ترحّل إلى الفترة المفتوحة التالية.", "The checklist is recorded, then posting into the period stops; daily operations post into the next open period.") : L("تُسجَّل القائمة كما هي الآن دون تغيير حالة الفترة.", "The checklist is recorded as it stands; the period does not change.")}</p>
        <Field label={needsNote ? L("ملاحظة (مطلوبة: في القائمة بنود للمراجعة)", "Note (required: the checklist has items to review)") : L("ملاحظة (اختيارية، تُسجَّل)", "Note (optional, recorded)")}>
          <textarea className="hr-input hr-textarea" value={note} onChange={(e) => setNote(e.target.value)} data-testid="close-note" />
        </Field>
      </Dialog>
    </section>
  );
}

type Sod = { from: string; to: string; counts: Record<string, number>; rows: { kind: string; at: string; day: string; ref: string; amount: string | null; actorId: string | null; detail: string; href: string }[] };
const SOD_KIND: Record<string, [string, string]> = {
  JOURNAL_SELF_APPROVED: ["قيد اعتمده مُعدّه", "Journal approved by its preparer"],
  JOURNAL_APPROVER_POSTED: ["قيد رحّله معتمِده", "Journal posted by its approver"],
  NOTE_SELF_ISSUED: ["إشعار أصدره مُعدّه", "Note issued by its preparer"],
  BUDGET_SELF_APPROVED: ["موازنة اعتمدها مُعدّها", "Budget approved by its preparer"],
  AP_SELF_POSTED: ["فاتورة مورد رحّلها مُعدّها", "Supplier invoice posted by its preparer"],
  FA_SELF_POSTED: ["مستند أصل ثابت رحّله مُعدّه", "Fixed-asset document posted by its preparer"],
  PERIOD_REOPENED: ["إعادة فتح فترة مقفلة", "Closed period reopened"],
  RECURRING_SELF_AUTHORISED: ["ترحيل تلقائي فعّله مُعدّ المعاملة المتكررة", "Recurring auto-post authorised by its preparer"],
};

/** «استثناءات فصل المهام» — for the auditor: every act where one person held two separated duties, and every reopen. */
export function SodExceptions({ from, to }: { from: string; to: string }) {
  const { L } = useLang();
  const r = useApi<Sod>(`/api/accounting/sod/exceptions?from=${from}&to=${to}`);
  if (r.error) return <p role="alert" className="hr-err">{r.error}</p>;
  if (!r.data) return <OpsLoading />;
  const d = r.data;
  return (
    <>
      <div className="acct-metrics" data-testid="sod-counts">
        {Object.keys(SOD_KIND).map((k) => <div key={k} className="acct-metric"><span className="k">{L(SOD_KIND[k][0], SOD_KIND[k][1])}</span><span className="v">{d.counts[k] ?? 0}</span></div>)}
      </div>
      {d.rows.length === 0 ? <p className="acct-hint" data-testid="sod-empty">{L("لا استثناءات في الفترة.", "No exceptions in the period.")}</p> : (
        <div className="hr-tablewrap">
          <table className="hr-table is-dense" data-testid="sod-table">
            <thead><tr><th>{L("اليوم", "Day")}</th><th>{L("النوع", "Kind")}</th><th>{L("المرجع", "Reference")}</th><th className="num">{L("المبلغ", "Amount")}</th><th className="acct-hide-m">{L("المستخدم", "User")}</th><th className="acct-hide-m">{L("التفصيل", "Detail")}</th></tr></thead>
            <tbody>{d.rows.map((x, i) => <tr key={i}><td className="hr-num">{x.day}</td><td>{L(SOD_KIND[x.kind]?.[0] ?? x.kind, SOD_KIND[x.kind]?.[1] ?? x.kind)}</td><td><Link className="acct-code" href={x.href}>{x.ref}</Link></td><td className="num hr-num">{x.amount ? money(x.amount) : "—"}</td><td className="acct-hide-m acct-code">{x.actorId ?? "—"}</td><td className="acct-hide-m">{x.detail}</td></tr>)}</tbody>
          </table>
        </div>
      )}
      <p className="acct-hint">{L("يُقرأ من المستندات نفسها (قيود ومستندات مرحّلة لا تتغير). السماح بهذه الحالات إعداد في «الإعدادات › فصل المهام».", "Read from the documents themselves (posted, immutable). Whether these acts are allowed is a setting under Settings › Segregation of duties.")}</p>
    </>
  );
}

type Year = { id: string; year: number; status: string; periods: { id: string; periodNo: number; status: string }[] };
/** «الإقفال السنوي» (ACC-81): the conditions, then the closing entry through the engine. */
export function YearEndClose({ y, canClose, onDone }: { y: Year; canClose: boolean; onDone: () => void }) {
  const { L } = useLang();
  const w = useWrite();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const dec = y.periods.find((p) => p.periodNo === 12);
  const conds = [
    { ok: y.periods.length === 12 && y.periods.every((p) => p.status !== "OPEN"), ar: "كل أشهر السنة مقفلة (مؤقتًا أو نهائيًا)", en: "Every month locked or closed" },
    { ok: dec?.status === "LOCKED", ar: "ديسمبر مقفل مؤقتًا (قيد الإقفال آخر ما يُرحَّل فيه)", en: "December soft-closed (the closing entry is its last posting)" },
    { ok: y.status !== "CLOSED", ar: "السنة لم تُقفل بعد", en: "The year is not closed yet" },
  ];
  const ready = conds.every((c) => c.ok);
  async function go() {
    const r = await w.run("year", `/api/accounting/fiscal-years/${y.year}/close`, "POST", { note: note.trim() || null }, L("أُقفلت السنة: نُقلت الإيرادات والمصروفات إلى الأرباح المبقاة، وفُتحت السنة التالية.", "The year is closed: revenue and expenses moved to retained earnings; the next year is open."));
    if (r) { setOpen(false); setNote(""); onDone(); }
  }
  if (y.status === "CLOSED") return <p className="acct-hint" data-testid={`ye-done-${y.year}`}>{L(`السنة ${y.year} مقفلة: قيد الإقفال نقل صافي الربح إلى الأرباح المبقاة.`, `${y.year} is closed: the closing entry moved the net profit to retained earnings.`)}</p>;
  return (
    <div data-testid={`ye-${y.year}`}>
      <Msg error={w.error} done={w.done} onClose={() => { w.setError(null); w.setDone(null); }} />
      <ul className="acct-checks">{conds.map((c, i) => <li key={i}><span className={c.ok ? "ok" : "no"} aria-hidden="true">{c.ok ? "●" : "○"}</span>{L(c.ar, c.en)}</li>)}</ul>
      {canClose ? <Btn variant="primary" disabled={!ready} onClick={() => setOpen(true)} data-testid={`ye-close-${y.year}`}>{L(`إقفال السنة ${y.year}`, `Close ${y.year}`)}</Btn> : null}
      <Dialog open={open} title={L(`إقفال السنة المالية ${y.year}`, `Close fiscal year ${y.year}`)} onClose={() => setOpen(false)}
        actions={<><Btn variant="danger" busy={!!w.busy} onClick={go} data-testid="ye-confirm">{L("إقفال السنة", "Close the year")}</Btn><Btn onClick={() => setOpen(false)}>{L("إلغاء", "Cancel")}</Btn></>}>
        <p>{L("يُرحَّل قيد إقفال بتاريخ 31 ديسمبر: كل رصيد إيراد ومصروف إلى الأرباح المبقاة، ثم يُقفل ديسمبر والسنة نهائيًا وتُنشأ السنة التالية. قائمة إقفال ديسمبر تُسجَّل.", "A closing entry dated 31 December moves every revenue and expense balance to retained earnings; December and the year are then closed and the next year created. December's checklist is recorded.")}</p>
        <Field label={L("ملاحظة (مطلوبة إن كانت في قائمة ديسمبر بنود للمراجعة)", "Note (required if December's checklist has items to review)")}><textarea className="hr-input hr-textarea" value={note} onChange={(e) => setNote(e.target.value)} data-testid="ye-note" /></Field>
      </Dialog>
    </div>
  );
}
