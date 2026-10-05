"use client";

// Figma: ACC-06. Fiscal periods with lock / unlock (reason) / close (blockers shown first).
import { useState } from "react";
import { Plus } from "lucide-react";
import { ApiError, Badge, Button, Card, CardTitle, Dialog, EmptyState, ErrorState, Field, INPUT, LoadingState, Notice, Table, Td, Th, api, useApi, useFinance, useL } from "../../finance/_components/ui";
import { PERIOD_STATUS, useCan, useDay } from "../_components/kit";

type Period = { id: string; year: number; periodNo: number; startDate: string; endDate: string; status: string; lockedBy: string | null; closedBy: string | null; lockedAt: string | null; closedAt: string | null; lockedByName: string | null; closedByName: string | null; entries: Record<string, number> };
type Blockers = { blockers: { code: string; en: string; ar: string }[] };

export default function PeriodsPage() {
  const { L, lang } = useL();
  const day = useDay();
  const { can } = useCan();
  const { refresh } = useFinance();
  const { data, error, reload } = useApi<Period[]>("/api/accounting/fiscal-periods");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [closing, setClosing] = useState<{ p: Period; blockers: Blockers["blockers"] | null } | null>(null);
  const [unlocking, setUnlocking] = useState<Period | null>(null);
  const [reason, setReason] = useState("");
  const [yearForm, setYearForm] = useState<{ year: string; startMonth: string } | null>(null);

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key); setMsg(null);
    try { await fn(); setMsg({ tone: "ok", text: L("تم.", "Done.") }); reload(); refresh(); return true; }
    catch (e) { setMsg({ tone: "bad", text: e instanceof ApiError ? e.message : String(e) }); return false; }
    finally { setBusy(null); }
  };
  const openClose = async (p: Period) => { setClosing({ p, blockers: null }); const b = await api<Blockers>(`/api/accounting/fiscal-periods/${p.id}/close-check`).catch(() => ({ blockers: [] })); setClosing({ p, blockers: b.blockers }); };
  // Who closed (or else locked) the period, with the Riyadh calendar day it happened.
  const by = (p: Period) => {
    const name = p.status === "CLOSED" ? p.closedByName ?? p.lockedByName : p.status === "LOCKED" ? p.lockedByName : null;
    const at = p.status === "CLOSED" ? p.closedAt : p.status === "LOCKED" ? p.lockedAt : null;
    if (!name || !at) return "—";
    return `${name} · ${new Date(at).toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", timeZone: "Asia/Riyadh" })}`;
  };
  const month = (p: Period) => new Date(p.startDate).toLocaleDateString(lang === "ar" ? "ar-SA-u-ca-gregory-nu-latn" : "en-GB", { month: "long", year: "numeric", timeZone: "UTC" });

  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return <LoadingState />;
  const years = [...new Set(data.map((p) => p.year))].sort((a, b) => b - a);

  return (
    <div className="flex flex-col gap-4">
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      {data.length === 0 && <EmptyState title={L("لا توجد سنة مالية", "No fiscal year yet")} body={L("أنشئ سنة مالية من 12 فترة شهرية.", "Create a fiscal year of twelve monthly periods.")}>{can("settings_manage") && <Button kind="primary" icon={Plus} onClick={() => setYearForm({ year: String(new Date().getUTCFullYear()), startMonth: "1" })}>{L("سنة مالية", "Fiscal year")}</Button>}</EmptyState>}
      {years.map((y) => (
        <Card key={y}>
          <CardTitle title={L(`السنة المالية ${y}`, `Fiscal year ${y}`)} sub={L("فترات شهرية · لا تداخل بين الفترات · القفل يمنع الترحيل ويمكن فكّه بسبب · الإقفال نهائي", "Monthly periods · no overlap · locking stops posting and can be undone with a reason · closing is final")}
            right={<>
              <a href={`/dashboard/accounting/periods/year-end`}><Button>{L("إقفال السنة", "Year-end close")}</Button></a>
              {can("settings_manage") && <Button icon={Plus} onClick={() => setYearForm({ year: String(y + 1), startMonth: String(new Date(data.filter((p) => p.year === y).sort((a, b) => a.periodNo - b.periodNo)[0].startDate).getUTCMonth() + 1) })}>{L("سنة مالية", "Fiscal year")}</Button>}
            </>} />
          <Table>
            <thead><tr><Th>{L("الفترة", "Period")}</Th><Th>{L("من – إلى", "From – to")}</Th><Th>{L("الحالة", "Status")}</Th><Th num>{L("قيود مرحّلة", "Posted")}</Th><Th num>{L("معلّقة", "Pending")}</Th><Th>{L("بواسطة", "By")}</Th><Th>{L("إجراء", "Action")}</Th></tr></thead>
            <tbody>
              {data.filter((p) => p.year === y).sort((a, b) => a.periodNo - b.periodNo).map((p) => {
                const pending = (p.entries.DRAFT ?? 0) + (p.entries.SUBMITTED ?? 0) + (p.entries.APPROVED ?? 0);
                const st = PERIOD_STATUS[p.status];
                return (
                  <tr key={p.id}>
                    <Td className="font-bold">{month(p)}</Td>
                    <Td className="whitespace-nowrap">{day(p.startDate)} – {day(p.endDate)}</Td>
                    <Td><Badge tone={st.tone}>{L(st.ar, st.en)}</Badge></Td>
                    <Td num>{(p.entries.POSTED ?? 0) + (p.entries.REVERSED ?? 0)}</Td>
                    <Td num className={pending ? "font-bold text-amber-700" : ""}>{pending}</Td>
                    <Td className="whitespace-nowrap">{by(p)}</Td>
                    <Td>
                      <span className="flex gap-3">
                        {p.status === "OPEN" && can("period_lock") && <button type="button" className="text-[13px] font-bold text-orange hover:underline disabled:opacity-50" disabled={!!busy} onClick={() => run(p.id, () => api(`/api/accounting/fiscal-periods/${p.id}/lock`, { method: "POST", json: {} }))}>{L("قفل", "Lock")}</button>}
                        {p.status === "LOCKED" && can("unlock_period") && <button type="button" className="text-[13px] font-bold text-orange hover:underline" onClick={() => { setReason(""); setUnlocking(p); }}>{L("فكّ القفل", "Unlock")}</button>}
                        {p.status === "LOCKED" && can("period_close") && <button type="button" className="text-[13px] font-bold text-red-700 hover:underline" onClick={() => openClose(p)}>{L("إقفال", "Close")}</button>}
                      </span>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </Card>
      ))}

      <Dialog open={!!closing} onClose={() => setClosing(null)} title={closing ? L(`إقفال ${month(closing.p)} نهائياً؟`, `Close ${month(closing.p)} permanently?`) : ""} sub={L("الإقفال لا يُتراجع عنه.", "Closing cannot be undone.")}>
        {closing && (!closing.blockers ? <LoadingState /> : (
          <div className="flex flex-col gap-3">
            {closing.blockers.length === 0 ? <Notice tone="ok">{L("لا شيء يمنع الإقفال: لا قيود معلقة، ولا أحداث غير مرحّلة، والفترات السابقة مقفلة.", "Nothing prevents closing: no pending entries, no unposted events, earlier periods closed.")}</Notice>
              : <ul className="flex flex-col gap-2">{closing.blockers.map((b) => <li key={b.code} className="flex gap-2 items-center text-[13px]"><Badge tone="bad">✕</Badge>{L(b.ar, b.en)}</li>)}</ul>}
            <div className="flex gap-2 justify-end">
              <Button kind="ghost" onClick={() => setClosing(null)}>{L("إلغاء", "Cancel")}</Button>
              <Button kind="danger" disabled={closing.blockers.length > 0} busy={busy === "close"} onClick={async () => { if (await run("close", () => api(`/api/accounting/fiscal-periods/${closing.p.id}/close`, { method: "POST", json: {} }))) setClosing(null); }}>{L("إقفال نهائي", "Close permanently")}</Button>
            </div>
          </div>
        ))}
      </Dialog>
      <Dialog open={!!unlocking} onClose={() => setUnlocking(null)} title={unlocking ? L(`فكّ قفل ${month(unlocking)}`, `Unlock ${month(unlocking)}`) : ""} sub={L("يُسمح بالترحيل مجدداً في الفترة. يُسجَّل السبب ومن قام به.", "Posting is allowed again in the period. The reason and who did it are recorded.")}>
        <Field label={L("السبب (5 أحرف على الأقل)", "Reason (at least 5 characters)")}><textarea className={INPUT} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        <div className="flex gap-2 justify-end">
          <Button kind="ghost" onClick={() => setUnlocking(null)}>{L("إلغاء", "Cancel")}</Button>
          <Button kind="primary" disabled={reason.trim().length < 5} busy={busy === "unlock"} onClick={async () => { if (unlocking && await run("unlock", () => api(`/api/accounting/fiscal-periods/${unlocking.id}/unlock`, { method: "POST", json: { reason } }))) setUnlocking(null); }}>{L("فكّ القفل", "Unlock")}</Button>
        </div>
      </Dialog>
      <Dialog open={!!yearForm} onClose={() => setYearForm(null)} title={L("سنة مالية جديدة", "New fiscal year")} sub={L("12 فترة شهرية. تُرفض إن تداخلت مع فترات قائمة.", "Twelve monthly periods. Refused if they overlap existing periods.")}>
        {yearForm && <>
          <div className="grid grid-cols-2 gap-3">
            <Field label={L("السنة", "Year")}><input className={INPUT} inputMode="numeric" dir="ltr" value={yearForm.year} onChange={(e) => setYearForm({ ...yearForm, year: e.target.value })} /></Field>
            <Field label={L("شهر البداية", "Start month")}><select className={INPUT} value={yearForm.startMonth} onChange={(e) => setYearForm({ ...yearForm, startMonth: e.target.value })}>{Array.from({ length: 12 }, (_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}</select></Field>
          </div>
          <div className="flex gap-2 justify-end">
            <Button kind="ghost" onClick={() => setYearForm(null)}>{L("إلغاء", "Cancel")}</Button>
            <Button kind="primary" busy={busy === "year"} onClick={async () => { if (await run("year", () => api("/api/accounting/fiscal-periods", { method: "POST", json: { year: Number(yearForm.year), startMonth: Number(yearForm.startMonth) } }))) setYearForm(null); }}>{L("إنشاء", "Create")}</Button>
          </div>
        </>}
      </Dialog>
    </div>
  );
}
