"use client";

// «الفترات» (Figma ACC-80): Gregorian years and their months — open, soft-closed («مقفلة مؤقتًا», unlocked with a
// reason) and closed («مقفلة نهائيًا»: the database refuses every posting; reopened only by the reopen duty, with
// a reason, recorded). «إنشاء سنة مالية» makes the twelve months at once.
// A5: «قائمة الإقفال» opens the month's close checklist; the soft close and the final close run from it (recorded
// with the checklist); each year card carries the year-end close (ACC-81).
import { useState } from "react";
import { OpsLoading, Btn, Field } from "@/components/ops/ui";
import { Dialog } from "@/components/hr/ui";
import { AcctShell, Msg, PERIOD_AR, StatusTag, useApi, useLang, useWrite, type Setup } from "../_ui/shell";
import { CloseChecklist, YearEndClose } from "../_ui/close";

type Period = { id: string; year: number; periodNo: number; startDate: string; endDate: string; status: string; lockedAt: string | null; closedAt: string | null; reopenedAt: string | null; reopenReason: string | null; reopenCount: number; entries: Record<string, number> };
type Year = { id: string; year: number; status: string; periods: Period[] };
const MONTHS_AR = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
const MONTHS_EN = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export default function PeriodsPage() {
  const { L } = useLang();
  const setup = useApi<Setup>("/api/accounting/setup");
  const years = useApi<Year[]>("/api/accounting/fiscal-years");
  const w = useWrite();
  const [newYear, setNewYear] = useState(String(new Date().getFullYear()));
  const [dialog, setDialog] = useState<null | { kind: "unlock" | "reopen" | "close" | "lock"; p: Period }>(null);
  const [reason, setReason] = useState("");
  const [checkId, setCheckId] = useState<string | null>(null);
  const can = setup.data?.can;
  const when = (x: string | null) => (x ? new Date(x).toLocaleString("en-GB", { timeZone: "Asia/Riyadh", dateStyle: "medium", timeStyle: "short" }) : "");

  async function act() {
    if (!dialog) return;
    const { kind, p } = dialog;
    const ok = { lock: L("أُقفلت الفترة مؤقتًا.", "Soft-closed."), unlock: L("فُتحت الفترة.", "Reopened."), close: L("أُقفلت الفترة نهائيًا.", "Closed."), reopen: L("أُعيد فتح الفترة وسُجّل السبب.", "Reopened; the reason is recorded.") }[kind];
    // A5: the soft close and the final close run through the close checklist (recorded with it).
    const r = kind === "lock" || kind === "close"
      ? await w.run(kind, `/api/accounting/close/${p.id}/${kind === "lock" ? "soft-close" : "close"}`, "POST", {}, ok)
      : await w.run(kind, `/api/accounting/fiscal-periods/${p.id}/${kind}`, "POST", { reason }, ok);
    if (r) { setDialog(null); setReason(""); years.reload(); }
  }
  async function createYear() {
    const r = await w.run("year", "/api/accounting/fiscal-years", "POST", { year: Number(newYear) }, L("أُنشئت السنة المالية بأشهرها الاثني عشر.", "The fiscal year and its twelve months are created."));
    if (r) years.reload();
  }
  const title = dialog ? { lock: L("إقفال مؤقت", "Soft close"), unlock: L("فتح الفترة", "Reopen the period"), close: L("إقفال نهائي", "Final close"), reopen: L("إعادة فتح فترة مقفلة نهائيًا", "Reopen a closed period") }[dialog.kind] : "";
  const needsReason = dialog?.kind === "unlock" || dialog?.kind === "reopen";

  return (
    <AcctShell setup={setup.data}
      actions={can?.settings ? (
        <span className="acct-actions">
          <input className="hr-input" style={{ width: 96 }} dir="ltr" inputMode="numeric" value={newYear} onChange={(e) => setNewYear(e.target.value.replace(/\D/g, "").slice(0, 4))} aria-label={L("السنة", "Year")} data-testid="fy-year" />
          <Btn variant="primary" busy={w.busy === "year"} onClick={createYear} data-testid="fy-create">{L("إنشاء سنة مالية", "Create fiscal year")}</Btn>
        </span>
      ) : undefined}>
      <Msg error={w.error ?? years.error} done={w.done} onClose={() => { w.setError(null); w.setDone(null); }} />
      {!years.data ? <OpsLoading /> : years.data.length === 0 ? <p className="acct-hint" data-testid="fy-empty">{L("لا سنوات مالية بعد. أنشئ السنة التي يقع فيها تاريخ بدء المحاسبة.", "No fiscal year yet. Create the year of the go-live date.")}</p> : years.data.map((y) => (
        <section key={y.id} className="acct-card" data-testid={`fy-${y.year}`}>
          <h2>{L(`السنة المالية ${y.year}`, `Fiscal year ${y.year}`)}</h2>
          <div className="hr-tablewrap">
            <table className="hr-table is-dense">
              <thead><tr><th>{L("الفترة", "Period")}</th><th>{L("الحالة", "Status")}</th><th className="acct-hide-m">{L("القيود", "Entries")}</th><th className="acct-hide-m">{L("آخر تغيير", "Last change")}</th><th>{L("الإجراء", "Action")}</th></tr></thead>
              <tbody>
                {y.periods.map((p) => {
                  const posted = (p.entries.POSTED ?? 0) + (p.entries.REVERSED ?? 0);
                  const pending = (p.entries.DRAFT ?? 0) + (p.entries.SUBMITTED ?? 0) + (p.entries.APPROVED ?? 0);
                  return (
                    <tr key={p.id} data-period={`${p.year}-${p.periodNo}`}>
                      <td>{L(`${MONTHS_AR[p.periodNo - 1]} ${p.year}`, `${MONTHS_EN[p.periodNo - 1]} ${p.year}`)}</td>
                      <td><StatusTag map={PERIOD_AR} value={p.status} /></td>
                      <td className="acct-hide-m hr-num">{posted}{pending ? <span className="acct-hint"> · {L(`${pending} معلّق`, `${pending} pending`)}</span> : null}</td>
                      <td className="acct-hide-m acct-hint">{p.reopenedAt ? L(`أُعيد فتحها ${when(p.reopenedAt)} · «${p.reopenReason}»`, `Reopened ${when(p.reopenedAt)} · “${p.reopenReason}”`) : p.closedAt ? when(p.closedAt) : p.lockedAt ? when(p.lockedAt) : "—"}</td>
                      <td>
                        <span className="acct-actions">
                          {p.status !== "CLOSED" ? <button type="button" className="hr-btn is-sm" aria-pressed={checkId === p.id} onClick={() => setCheckId(checkId === p.id ? null : p.id)} data-testid="period-checklist">{L("قائمة الإقفال", "Close checklist")}</button> : null}
                          {p.status === "OPEN" && can?.periodLock ? <button type="button" className="hr-btn is-sm" onClick={() => setDialog({ kind: "lock", p })} data-testid="period-lock">{L("إقفال مؤقت", "Soft close")}</button> : null}
                          {p.status === "LOCKED" && can?.periodLock ? <button type="button" className="hr-btn is-sm" onClick={() => setDialog({ kind: "unlock", p })} data-testid="period-unlock">{L("فتح الفترة", "Reopen")}</button> : null}
                          {p.status === "LOCKED" && can?.periodClose ? <button type="button" className="hr-btn is-sm" onClick={() => setCheckId(p.id)} data-testid="period-close">{L("إقفال نهائي", "Final close")}</button> : null}
                          {p.status === "CLOSED" && can?.periodReopen ? <button type="button" className="hr-btn is-sm is-danger" onClick={() => setDialog({ kind: "reopen", p })} data-testid="period-reopen">{L("إعادة فتح", "Reopen")}</button> : null}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {checkId && y.periods.some((p) => p.id === checkId) ? <CloseChecklist key={checkId} periodId={checkId} can={{ lock: !!can?.periodLock, close: !!can?.periodClose }} onChanged={years.reload} /> : null}
          <details data-testid={`ye-panel-${y.year}`}>
            <summary className="acct-hint">{L(`الإقفال السنوي ${y.year}`, `Year-end close ${y.year}`)}</summary>
            <YearEndClose y={y} canClose={!!can?.periodClose} onDone={years.reload} />
          </details>
        </section>
      ))}
      <p className="acct-hint">{L("الإقفال المؤقت يمنع الترحيل ويُفتح بسبب. الإقفال النهائي يمنعه في قاعدة البيانات، ولا يُرفع إلا بصلاحية إعادة الفتح مع سبب يُسجَّل. لا تُقفل فترة فيها قيود معلّقة.", "A soft close stops posting and is reopened with a reason. A final close stops it in the database and is lifted only with the reopen duty and a recorded reason. A period with pending journals is not closed.")}</p>
      <Dialog open={!!dialog} title={title} onClose={() => setDialog(null)}
        sub={dialog ? L(`${MONTHS_AR[dialog.p.periodNo - 1]} ${dialog.p.year}`, `${MONTHS_EN[dialog.p.periodNo - 1]} ${dialog.p.year}`) : undefined}
        actions={<><Btn variant={dialog?.kind === "reopen" || dialog?.kind === "close" ? "danger" : "primary"} disabled={needsReason && reason.trim().length < 3} busy={!!w.busy} onClick={act} data-testid="period-confirm">{title}</Btn><Btn onClick={() => setDialog(null)}>{L("إلغاء", "Cancel")}</Btn></>}>
        {needsReason ? <Field label={L("السبب (يُسجَّل)", "Reason (recorded)")}><textarea className="hr-input hr-textarea" value={reason} onChange={(e) => setReason(e.target.value)} data-testid="period-reason" /></Field>
          : <p>{dialog?.kind === "close" ? L("بعد الإقفال النهائي ترفض قاعدة البيانات أي ترحيل إلى هذه الفترة.", "After the final close the database refuses every posting into this period.") : L("لن يُرحَّل شيء إلى هذه الفترة حتى تُفتح.", "Nothing posts into this period until it is reopened.")}</p>}
      </Dialog>
    </AcctShell>
  );
}
