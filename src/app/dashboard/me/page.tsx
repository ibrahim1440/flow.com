"use client";
import { Plus } from "lucide-react";
// HR-07 · Employee self-service «خدماتي» (Figma 1JbZgpMqmPkUVne8ms9Ozz · desktop 454:1812;
// 390: 454:22415, leave sheet 455:3154). Needs no HR duty: every call goes to /api/hr/me*,
// whose subject is always the caller's own linked record (never a request parameter).
// Check-in/out uses the server clock — the client never sends a time.
import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import {
  ADVANCE_STATUS, Btn, Dialog, Empty, ErrorState, Field, Flag, KV, LoadingTable, Metrics, Notice, PageHeader, ProposalTag, REQUEST_STATUS,
  StatusDot, days, hrFetch, money, useAction, useForm, useHr, useHrI18n, type StatusEntry,
} from "@/components/hr/ui";
import { WEEKDAYS, leaveTypeName } from "@/lib/i18n/hr";
import { DateRangeSummary, QuoteNotes, quoteRows, useLeaveQuote } from "@/components/hr/leave-quote";
import { dayCount } from "../hr/leave/parts";
import "./me.css";

type Balance = { leaveTypeId: string; code: string; nameAr: string; paid: boolean; tracksBalance: boolean; isProposal: boolean; balance: string; pending: string; available: string };
type LeaveReq = { id: string; leaveTypeId: string; leaveType: string; leaveTypeCode?: string; startDate: string; endDate: string; days: string; status: string; reason: string | null; createdAt: string; decisionNote: string | null; cancelReason: string | null };
type Advance = { id: string; advanceNo: string; amount: string; installmentCount: number; firstInstallmentMonth: string; status: string; createdAt: string; outstanding: string; decisionNote: string | null };
type Attendance = { id: string; workDate: string; checkIn: string | null; checkOut: string | null; status: "OPEN" | "CLOSED" | "ABSENT"; lateMinutes: number | null; workedMinutes: number | null; overtimeMinutes: number | null };
type Payslip = { lineId: string; periodMonth: string; kind: string; runNo: number; status: string; gross: string; net: string };
type Correction = { id: string; workDate: string; status: string; reason: string };
type Review = { id: string; periodLabel: string; rating: number; status: string; strengths: string | null; improvements: string | null };
type Linked = {
  linked: true; timezone: string; today: string; policyConfigured: boolean;
  person: { id: string; employeeNo: string; fullNameAr: string; jobTitle: string; status: string; hireDate: string; manager: string | null; department: string | null; branch: string | null; departmentEn?: string | null; branchEn?: string | null };
  contract: { contractNo: string; type: string; endDate: string | null } | null;
  privateMasked: { iban: string | null; idNumber: string | null; emergency: string | null };
  leaveBalances: Balance[]; leaveRequests: LeaveReq[]; advances: Advance[]; today_attendance: Attendance | null;
  payslips: Payslip[]; corrections: Correction[]; reviews: Review[];
};
type Overview = { linked: false } | Linked;
type Private = Record<string, string | null> | null;

const weekday = (iso: string, lang: "ar" | "en") => WEEKDAYS[lang][new Date(`${iso}T00:00:00Z`).getUTCDay()];
const nextMonth = (iso: string) => {
  const [y, m] = iso.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
};
const CORRECTION_STATUS: Record<string, StatusEntry> = { PENDING: ["بانتظار المدير", "warning", "Awaiting manager"], APPROVED: ["معتمد", "success", "Approved"], REJECTED: ["مرفوض", "danger", "Rejected"], WITHDRAWN: ["مسحوب", "cancelled", "Withdrawn"] };
// The employee's own requests: pending reads as awaiting approval (HR-07 EN), not as their decision.
const MY_REQUEST_STATUS: Record<string, StatusEntry> = { ...REQUEST_STATUS, PENDING: [REQUEST_STATUS.PENDING[0], REQUEST_STATUS.PENDING[1], "Awaiting approval"] };
const reqType = (r: LeaveReq, lang: "ar" | "en") => leaveTypeName({ code: r.leaveTypeCode, nameAr: r.leaveType }, lang);
const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

type DialogState = null | "leave" | "advance" | "correction" | { cancelLeave: LeaveReq } | { cancelAdvance: Advance };

export default function MePage() {
  const { data, error, loading, reload } = useHr<Overview>("/api/hr/me");
  const [dialog, setDialog] = useState<DialogState>(null);
  const act = useAction();
  const { L, lang, month } = useHrI18n();

  if (error) return <div className="hr-page"><PageHeader title={L("خدماتي", "My HR")} /><ErrorState error={error} onRetry={reload} /></div>;
  if (loading && !data) return <div className="hr-page"><PageHeader title={L("خدماتي", "My HR")} /><LoadingTable /></div>;
  if (!data) return null;
  if (!data.linked) {
    return (
      <div className="hr-page">
        <PageHeader title={L("خدماتي", "My HR")} />
        <Empty title={L("حسابك غير مرتبط بملف موظف — اطلب من الموارد البشرية ربطه.", "Your login is not linked to an employee file — ask HR to link it.")} body={L("بعد الربط تظهر هنا إجازاتك وحضورك وقسائم راتبك وطلباتك.", "Once linked, your leave, attendance, payslips and requests appear here.")} />
      </div>
    );
  }
  const d = data;
  const done = () => { setDialog(null); void reload(); };
  const withdraw = (id: string) => act.run(`w:${id}`, async () => {
    await hrFetch(`/api/hr/me/leave/${id}/withdraw`, { json: {} });
    await reload();
  });
  const ack = (id: string) => act.run(`r:${id}`, async () => {
    await hrFetch(`/api/hr/me/reviews/${id}/acknowledge`, { json: {} });
    await reload();
  });
  const actions = (
    <>
      <Btn variant="primary" onClick={() => setDialog("leave")}><Plus aria-hidden="true" /> {L("طلب إجازة", "Leave request")}</Btn>
      <Btn onClick={() => setDialog("advance")}>{L("طلب سلفة", "Advance request")}</Btn>
    </>
  );

  return (
    <div className="hr-page is-tight-mobile">
      <PageHeader title={L("خدماتي", "My HR")} actions={<span className="hr-actions hr-hide-mobile" style={{ display: "flex", gap: 8 }}>{actions}</span>}>
        <span className="hr-caption hr-iso" dir={lang === "en" ? "ltr" : undefined}><bdi>{d.person.fullNameAr}</bdi> · <span className="hr-num">{d.person.employeeNo}</span> · <bdi>{d.person.jobTitle}</bdi></span>
      </PageHeader>
      {act.error ? <Notice tone="danger">{act.error}</Notice> : null}

      <TodayCard d={d} onCorrection={() => setDialog("correction")} onChanged={reload} />

      <div className="me-metrics"><MetricsRow d={d} /></div>

      <div className="hr-cols-2">
        <section className="hr-stack" aria-labelledby="me-requests">
          <h2 id="me-requests" className="hr-section">{L("طلباتي", "My requests")}</h2>
          <Requests d={d} busy={act.busy} onWithdraw={withdraw} onCancelLeave={(r) => setDialog({ cancelLeave: r })} onCancelAdvance={(a) => setDialog({ cancelAdvance: a })} />
          <p className="hr-caption" style={{ margin: 0 }}>{L("إلغاء إجازة معتمدة قبل بدايتها يعيد الأيام إلى رصيدك بحركة عكسية. بعد بدايتها يحتاج الإلغاء موافقة الموارد البشرية.", "Cancelling approved leave before it starts returns the days to your balance with a reversing movement. After it starts, cancelling needs HR approval.")}</p>
        </section>
        <section className="hr-stack" aria-labelledby="me-payslips">
          <h2 id="me-payslips" className="hr-section">{L("قسائم الراتب", "Payslips")}</h2>
          {d.payslips.length === 0 ? <p className="hr-caption" style={{ margin: 0 }}>{L("لا قسائم بعد.", "No payslips yet.")}</p> : (
            <div className="hr-tablewrap">
              <table className="hr-table is-mrow" aria-label={L("قسائم الراتب", "Payslips")}>
                <thead><tr><th>{L("الشهر", "Month")}</th><th className="num">{L("الإجمالي", "Gross")}</th><th className="num">{L("الصافي", "Net")}</th><th><span className="hr-sr">{L("القسيمة", "Payslip")}</span></th></tr></thead>
                <tbody>
                  {d.payslips.map((p) => (
                    <tr key={p.lineId}>
                      <td data-label={L("الشهر", "Month")} className="strong m-title">{month(p.periodMonth)}{p.kind !== "REGULAR" ? <span className="sub">{L("تصحيح", "Correction")}</span> : null}<span className="hr-msub">{L("الإجمالي", "Gross")} <span className="hr-num">{money(p.gross)}</span></span></td>
                      <td data-label={L("الإجمالي", "Gross")} className="num">{money(p.gross)}</td>
                      <td data-label={L("الصافي", "Net")} className="num">{money(p.net)}</td>
                      <td data-label={L("القسيمة", "Payslip")} className="m-end"><span className="hr-mobile-only hr-num strong">{money(p.net)}</span><Link className="hr-btn is-ghost is-sm" href={`/dashboard/me/payslips/${p.lineId}`} aria-label={L(`عرض قسيمة ${month(p.periodMonth)}`, `View ${month(p.periodMonth)} payslip`)}>{L("عرض", "View")}</Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="hr-caption" style={{ margin: 0 }}>{L("تظهر القسيمة بعد اعتماد المسير فقط، ولا تتغير بعد ذلك. أي تصحيح يظهر قسيمةً مستقلة مرتبطة بالأصل.", "A payslip appears only after the run is approved and does not change afterwards. Any correction appears as a separate payslip linked to the original.")}</p>
        </section>
      </div>

      <MyData d={d} />

      {d.reviews.length ? (
        <section className="hr-stack" aria-labelledby="me-reviews">
          <h2 id="me-reviews" className="hr-section">{L("تقييمات الأداء", "Performance reviews")}</h2>
          <dl className="hr-kv">
            {d.reviews.map((r) => (
              <div key={r.id}>
                <dt>
                  {r.periodLabel} · <span className="hr-num">{r.rating}/5</span>
                  {r.strengths ? <div className="hr-caption">{L("نقاط القوة:", "Strengths:")} {r.strengths}</div> : null}
                  {r.improvements ? <div className="hr-caption">{L("للتحسين:", "To improve:")} {r.improvements}</div> : null}
                </dt>
                <dd>{r.status === "SUBMITTED" ? <Btn size="sm" busy={act.busy === `r:${r.id}`} onClick={() => ack(r.id)}>{L("إقرار بالاطلاع", "Acknowledge")}</Btn> : <span className="hr-caption">{L("تم الاطلاع", "Acknowledged")}</span>}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}

      <div className="me-mobilebar">{actions}</div>

      {dialog === "leave" ? <LeaveDialog d={d} onClose={() => setDialog(null)} onDone={() => void reload()} /> : null}
      {dialog === "advance" ? <AdvanceDialog today={d.today} onClose={() => setDialog(null)} onDone={done} /> : null}
      {dialog === "correction" ? <CorrectionDialog today={d.today} onClose={() => setDialog(null)} onDone={done} /> : null}
      {dialog && typeof dialog === "object" && "cancelLeave" in dialog ? (
        <ReasonDialog title={L("إلغاء إجازة معتمدة", "Cancel approved leave")} confirm={L("إلغاء الإجازة", "Cancel leave")} url={`/api/hr/me/leave/${dialog.cancelLeave.id}/cancel`} onClose={() => setDialog(null)} onDone={done}>
          <p style={{ margin: 0 }}>{reqType(dialog.cancelLeave, lang)} · <span className="hr-num">{dialog.cancelLeave.startDate} → {dialog.cancelLeave.endDate}</span> · {dayCount(dialog.cancelLeave.days, lang)}</p>
          <p className="hr-caption" style={{ margin: 0 }}>{L("تعود الأيام إلى رصيدك بحركة عكسية.", "The days return to your balance with a reversing entry.")}</p>
        </ReasonDialog>
      ) : null}
      {dialog && typeof dialog === "object" && "cancelAdvance" in dialog ? (
        <ReasonDialog title={L("إلغاء طلب السلفة", "Cancel advance request")} confirm={L("إلغاء الطلب", "Cancel request")} url={`/api/hr/me/advances/${dialog.cancelAdvance.id}/cancel`} onClose={() => setDialog(null)} onDone={done}>
          <p style={{ margin: 0 }}>{dialog.cancelAdvance.advanceNo} · <span className="hr-num">{money(dialog.cancelAdvance.amount)}</span></p>
        </ReasonDialog>
      ) : null}
    </div>
  );
}

// ── Today ──────────────────────────────────────────────────────────────────────────

function TodayCard({ d, onCorrection, onChanged }: { d: Linked; onCorrection: () => void; onChanged: () => void | Promise<void> }) {
  const act = useAction();
  const a = d.today_attendance;
  const open = a?.status === "OPEN";
  const doneToday = !!a && a.workDate === d.today && a.status !== "OPEN";
  const { L, lang } = useHrI18n();
  const check = (action: "in" | "out") => act.run(action, async () => {
    await hrFetch("/api/hr/me/check", { json: { action } });
    await onChanged();
  });
  const parts: string[] = [];
  if (a?.checkIn) parts.push(L(`حضرت ${a.checkIn}`, `Checked in ${a.checkIn}`) + (a.workDate !== d.today ? ` (${a.workDate})` : ""));
  if (a?.checkOut) parts.push(L(`انصرفت ${a.checkOut}`, `checked out ${a.checkOut}`));
  if (a?.lateMinutes) parts.push(L(`التأخير ${a.lateMinutes} دقيقة`, `late ${a.lateMinutes} min`));
  if (a?.status === "CLOSED" && a.workedMinutes !== null) { const hm = `${Math.floor(a.workedMinutes / 60)}:${String(a.workedMinutes % 60).padStart(2, "0")}`; parts.push(L(`العمل ${hm} ساعة`, `worked ${hm} h`)); }
  if (a?.status === "ABSENT") parts.push(L("مسجَّل غائبًا", "Recorded as absent"));
  const status = parts.length ? parts.join(" · ") : L("لم تسجّل حضورك اليوم بعد.", "You haven’t checked in today.");
  return (
    <div className="hr-stack" style={{ gap: 8 }}>
      <div className="me-today">
        <div className="me-today-text">
          <span className="me-today-title">{L("اليوم", "Today")} · {weekday(d.today, lang)} <span className="hr-num">{d.today}</span></span>
          <span className="hr-caption" aria-live="polite">{status}</span>
        </div>
        <div className="me-today-actions">
          {doneToday ? null : (
            <Btn variant="primary" disabled={!d.policyConfigured} busy={act.busy !== null} onClick={() => check(open ? "out" : "in")}>
              {open ? L("تسجيل الانصراف", "Check out") : L("تسجيل الحضور", "Check in")}
            </Btn>
          )}
          <Btn variant="ghost" onClick={onCorrection}>{L("طلب تصحيح", "Request correction")}</Btn>
        </div>
      </div>
      {!d.policyConfigured ? <Notice tone="warning">{L("لم تُعتمد سياسة رواتب بعد، لذا لا يمكن تسجيل الحضور من هنا. تواصل مع الموارد البشرية.", "No payroll policy is approved yet, so attendance can’t be recorded here. Contact HR.")}</Notice> : null}
      {act.error ? <Notice tone="danger">{act.error}</Notice> : null}
    </div>
  );
}

function MetricsRow({ d }: { d: Linked }) {
  const { L, lang } = useHrI18n();
  const items: [string, React.ReactNode][] = d.leaveBalances.filter((b) => b.tracksBalance).map((b) => [leaveTypeName(b, lang), <span key={b.leaveTypeId}>{dayCount(b.available, lang)}</span>]);
  const open = d.advances.filter((a) => ["REQUESTED", "APPROVED", "DISBURSED"].includes(a.status));
  items.push([L("السلف القائمة", "Open advances"), money(open.reduce((s, a) => s + Number(a.outstanding), 0))]);
  if (d.payslips[0]) items.push([L("صافي آخر راتب", "Last net pay"), money(d.payslips[0].net)]);
  return <Metrics items={items} />;
}

// ── Requests ───────────────────────────────────────────────────────────────────────

type ReqRow = { key: string; date: string; title: React.ReactNode; sub?: string; status: React.ReactNode; action: React.ReactNode };

function Requests({ d, busy, onWithdraw, onCancelLeave, onCancelAdvance }: { d: Linked; busy: string | null; onWithdraw: (id: string) => void; onCancelLeave: (r: LeaveReq) => void; onCancelAdvance: (a: Advance) => void }) {
  const { L, lang, month } = useHrI18n();
  const rows = useMemo(() => {
    const out: ReqRow[] = [];
    for (const r of d.leaveRequests) {
      const before = r.startDate > d.today;
      out.push({
        key: `l:${r.id}`, date: r.startDate,
        title: <>{L(`إجازة ${r.leaveType}`, `${reqType(r, lang)} leave`)} · {dayCount(r.days, lang)}</>,
        sub: `${r.startDate} → ${r.endDate}`,
        status: <StatusDot map={MY_REQUEST_STATUS} value={r.status} />,
        action: r.status === "PENDING" ? <Btn size="sm" variant="ghost" busy={busy === `w:${r.id}`} onClick={() => onWithdraw(r.id)}>{L("سحب", "Withdraw")}</Btn>
          : r.status === "APPROVED" && before ? <Btn size="sm" variant="ghost" onClick={() => onCancelLeave(r)}>{L("إلغاء", "Cancel")}</Btn>
          : r.status === "APPROVED" ? <span className="hr-caption">{L("عبر الموارد البشرية", "Through HR")}</span> : null,
      });
    }
    for (const c of d.corrections) {
      out.push({ key: `c:${c.id}`, date: c.workDate, title: L("تصحيح حضور", "Attendance correction"), sub: c.reason, status: <StatusDot map={CORRECTION_STATUS} value={c.status} />, action: null });
    }
    for (const a of d.advances) {
      out.push({
        key: `a:${a.id}`, date: String(a.createdAt).slice(0, 10),
        title: <>{L("سلفة", "Advance")} <span className="hr-num">{money(a.amount)}</span></>,
        sub: L(`${a.advanceNo} · ${a.installmentCount} قسط من ${a.firstInstallmentMonth}${a.status === "DISBURSED" ? ` · المتبقي ${money(a.outstanding)}` : ""}`, `${a.advanceNo} · ${a.installmentCount} instalments from ${month(a.firstInstallmentMonth)}${a.status === "DISBURSED" ? ` · remaining ${money(a.outstanding)}` : ""}`),
        status: <StatusDot map={ADVANCE_STATUS} value={a.status} />,
        action: a.status === "REQUESTED" ? <Btn size="sm" variant="ghost" onClick={() => onCancelAdvance(a)}>{L("إلغاء", "Cancel")}</Btn> : null,
      });
    }
    return out.sort((x, y) => y.date.localeCompare(x.date));
  }, [d, busy, onWithdraw, onCancelLeave, onCancelAdvance, L, lang, month]);
  if (!rows.length) return <p className="hr-caption" style={{ margin: 0 }}>{L("لا طلبات بعد.", "No requests yet.")}</p>;
  return (
    <div className="hr-tablewrap">
      {/* M-07 / M-07 R3: on a phone each request is one list row — title and dates on the right,
          status and its action at the end. */}
      <table className="hr-table is-mrow" aria-label={L("طلباتي", "My requests")}>
        <thead><tr><th>{L("الطلب", "Request")}</th><th className="num hr-hide-compact">{L("التاريخ", "Date")}</th><th>{L("الحالة", "Status")}</th><th><span className="hr-sr">{L("إجراء", "Action")}</span></th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td data-label={L("الطلب", "Request")} className="strong m-title">{r.title}{r.sub ? <div className="hr-caption" style={{ fontWeight: 400 }}><span className="hr-iso" dir={/^\d{4}-\d{2}-\d{2} → /.test(r.sub) ? "ltr" : undefined}>{r.sub}</span></div> : null}</td>
              <td data-label={L("التاريخ", "Date")} className="num hr-hide-compact">{r.date}</td>
              <td data-label={L("الحالة", "Status")}>{r.status}</td>
              <td data-label={L("إجراء", "Action")} className="m-end"><span className="hr-mobile-only">{r.status}</span>{r.action}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── My data (masked; unmasking is audited) ─────────────────────────────────────────

function MyData({ d }: { d: Linked }) {
  const [priv, setPriv] = useState<Private | undefined>(undefined);
  const act = useAction();
  const reveal = () => act.run("p", async () => setPriv(await hrFetch<Private>("/api/hr/me/private")));
  const shown = priv !== undefined;
  const emergency = shown && priv ? [priv.emergencyName, priv.emergencyRelation, priv.emergencyPhone].filter(Boolean).join(" · ") || null : d.privateMasked.emergency;
  const num = (v: string | null | undefined) => (v ? <span className="hr-num">{v}</span> : "—");
  const { L, lang } = useHrI18n();
  return (
    <section className="hr-stack" aria-labelledby="me-data">
      <div className="me-titleline">
        <h2 id="me-data" className="hr-section">{L("بياناتي", "My details")}</h2>
        {shown ? <Btn size="sm" variant="ghost" onClick={() => setPriv(undefined)}>{L("إخفاء", "Hide")}</Btn> : <Btn size="sm" busy={act.busy === "p"} onClick={reveal}>{L("إظهار", "Reveal")}</Btn>}
      </div>
      {act.error ? <Notice tone="danger">{act.error}</Notice> : null}
      <div className="hr-cols-2">
        <KV rows={[
          [L("المدير", "Manager"), d.person.manager ?? "—"],
          [L("الإدارة · الفرع", "Department · Branch"), (lang === "en" ? [d.person.departmentEn || d.person.department, d.person.branchEn || d.person.branch] : [d.person.department, d.person.branch]).filter(Boolean).join(" · ") || "—"],
          [L("تاريخ المباشرة", "Start date"), num(d.person.hireDate)],
          [L("العقد", "Contract"), d.contract ? (d.contract.endDate ? <span key="c">{L("محدد المدة حتى", "Fixed term until")} <span className="hr-num">{d.contract.endDate}</span></span> : L("غير محدد المدة", "Open-ended")) : L("لا يوجد عقد ساري", "No active contract"), d.contract ? undefined : "warning"],
        ]} />
        <KV rows={[
          [L("الآيبان", "IBAN"), num(shown ? priv?.iban : d.privateMasked.iban)],
          [L("رقم الهوية", "ID number"), num(shown ? priv?.idNumber : d.privateMasked.idNumber)],
          [L("جهة الطوارئ", "Emergency contact"), emergency ? <span className="hr-iso">{emergency}</span> : "—"],
          ...(shown && priv ? ([[L("البنك", "Bank"), priv.bankName ?? "—"], [L("الجوال الشخصي", "Personal mobile"), num(priv.personalPhone)], [L("انتهاء الهوية", "ID expiry"), num(priv.idExpiry)]] as [string, React.ReactNode][]) : []),
        ]} />
      </div>
      <p className="hr-caption" style={{ margin: 0 }}>{L("البيانات الخاصة مخفية جزئيًا. «إظهار» يعرضها كاملة ويُسجَّل في سجل التدقيق. لتعديلها تواصل مع الموارد البشرية.", "Private data is partly hidden. Reveal shows it in full and is recorded in the audit log. To change it, contact HR.")}</p>
    </section>
  );
}

// ── Dialogs ────────────────────────────────────────────────────────────────────────

function LeaveDialog({ d, onClose, onDone }: { d: Linked; onClose: () => void; onDone: () => void }) {
  const first = d.leaveBalances[0];
  const f = useForm({ leaveTypeId: first?.leaveTypeId ?? "", startDate: d.today, endDate: d.today, reason: "" });
  const act = useAction();
  const key = useRef<string | null>(null);
  const [result, setResult] = useState<(LeaveReq & { replayed?: boolean }) | null>(null);
  const type = d.leaveBalances.find((b) => b.leaveTypeId === f.v.leaveTypeId);
  const { L, lang } = useHrI18n();
  const q = useLeaveQuote("/api/hr/me/leave/quote", result ? null : { leaveTypeId: f.v.leaveTypeId, startDate: f.v.startDate, endDate: f.v.endDate });
  const bind = (k: keyof typeof f.v) => {
    const b = f.bind(k);
    return { ...b, onChange: (e: { target: { value: string } }) => { key.current = null; b.onChange(e); } };
  };
  const submit = () => act.run("l", async () => {
    key.current ??= newKey();
    const r = await hrFetch<LeaveReq & { replayed?: boolean }>("/api/hr/me/leave", { json: { leaveTypeId: f.v.leaveTypeId, startDate: f.v.startDate, endDate: f.v.endDate, reason: f.v.reason || undefined, idempotencyKey: key.current } });
    setResult(r);
    onDone();
  });
  const invalid = !f.v.leaveTypeId || !f.v.startDate || !f.v.endDate || f.v.endDate < f.v.startDate;

  if (!d.leaveBalances.length) {
    return <Dialog open title={L("طلب إجازة", "Leave request")} onClose={onClose} actions={<Btn onClick={onClose}>{L("إغلاق", "Close")}</Btn>}><Empty title={L("لا أنواع إجازات متاحة", "No leave types available")} body={L("لم تُعرَّف أنواع الإجازات بعد. تواصل مع الموارد البشرية.", "Leave types are not defined yet. Contact HR.")} /></Dialog>;
  }
  return (
    <Dialog
      open
      title={L("طلب إجازة", "Leave request")}
      onClose={onClose}
      actions={result ? <Btn variant="primary" onClick={onClose}>{L("تم", "Done")}</Btn> : <><Btn variant="primary" busy={act.busy === "l"} disabled={invalid || q.blocking} onClick={submit}>{L("إرسال الطلب", "Submit request")}</Btn><Btn onClick={onClose}>{L("إلغاء", "Cancel")}</Btn></>}
    >
      {act.error ? <Notice tone="danger">{act.error}</Notice> : null}
      {result ? <Notice tone="success">{result.replayed ? L("سبق إرسال هذا الطلب؛ لم يُنشأ طلب ثانٍ.", "This request was already sent; no second request was created.") : <>{L("أُرسل الطلب", "Request sent")} (<span className="hr-num">{days(result.days)}</span> {L("يوم)، وهو بانتظار القرار.", "days); it awaits a decision.")}</>}</Notice> : null}
      <div className="hr-form has-date-pair">
        <Field label={L("النوع", "Type")} wide>
          <select className="hr-select" disabled={!!result} {...bind("leaveTypeId")}>
            {d.leaveBalances.map((b) => <option key={b.leaveTypeId} value={b.leaveTypeId}>{leaveTypeName(b, lang)}{b.tracksBalance ? L(` · المتاح ${days(b.available)} يومًا`, ` · ${days(b.available)} days available`) : ""}{b.paid ? "" : L(" · بدون راتب", " · unpaid")}</option>)}
          </select>
        </Field>
        <div className="is-half-mobile"><Field label={L("تاريخ البداية", "Start date")}><input className="hr-input" type="date" disabled={!!result} {...bind("startDate")} /></Field></div>
        <div className="is-half-mobile"><Field label={L("تاريخ النهاية (يُحتسب)", "End date (counted)")} error={f.v.endDate && f.v.endDate < f.v.startDate ? L("لا تنتهي الإجازة قبل بدايتها.", "The leave cannot end before it starts.") : null}><input className="hr-input" type="date" min={f.v.startDate} disabled={!!result} {...bind("endDate")} /></Field></div>
      </div>
      {!result ? <DateRangeSummary start={f.v.startDate} end={f.v.endDate} /> : null}
      {!result ? (
        <>
          <KV rows={[...quoteRows(q, lang), [L("يعتمده", "Approver"), d.person.manager ? L(`${d.person.manager} (المدير المباشر)`, `${d.person.manager} (line manager)`) : L("الموارد البشرية", "HR")]]} />
          <QuoteNotes q={q} refused={!!act.error} />
          <div className="hr-form"><Field label={L("السبب (اختياري)", "Reason (optional)")} wide><textarea className="hr-textarea is-compact" rows={1} maxLength={500} {...bind("reason")} /></Field></div>
          {type?.isProposal ? <div><ProposalTag /> <span className="hr-caption">{L("استحقاق هذا النوع مقترح لم تعتمده الإدارة بعد.", "This type’s accrual is a proposal management has not approved yet.")}</span></div> : null}
        </>
      ) : null}
    </Dialog>
  );
}

function AdvanceDialog({ today, onClose, onDone }: { today: string; onClose: () => void; onDone: () => void }) {
  const f = useForm({ amount: "", installmentCount: "3", firstInstallmentMonth: nextMonth(today), reason: "" });
  const act = useAction();
  const n = Math.max(1, Number(f.v.installmentCount) || 1);
  const { L } = useHrI18n();
  const each = Number(f.v.amount) > 0 ? Math.floor((Number(f.v.amount) / n) * 100) / 100 : null;
  const submit = () => act.run("a", async () => {
    await hrFetch("/api/hr/me/advances", { json: { amount: f.v.amount, installmentCount: Number(f.v.installmentCount), firstInstallmentMonth: f.v.firstInstallmentMonth, reason: f.v.reason } });
    onDone();
  });
  return (
    <Dialog open title={L("طلب سلفة", "Advance request")} onClose={onClose} actions={<><Btn variant="primary" busy={act.busy === "a"} disabled={!f.v.amount || !f.v.firstInstallmentMonth || f.v.reason.trim().length < 3} onClick={submit}>{L("إرسال الطلب", "Submit request")}</Btn><Btn onClick={onClose}>{L("إلغاء", "Cancel")}</Btn></>}>
      {act.error ? <Notice tone="danger">{act.error}</Notice> : null}
      <div className="hr-form">
        <Field label={L("المبلغ *", "Amount *")}><input className="hr-input hr-num" inputMode="decimal" {...f.bind("amount")} /></Field>
        <Field label={L("عدد الأقساط *", "Number of instalments *")}><input className="hr-input hr-num" type="number" min={1} max={120} {...f.bind("installmentCount")} /></Field>
        <Field label={L("شهر أول قسط *", "First instalment month *")} help={L("يُخصم القسط من مسير ذلك الشهر.", "The instalment is deducted in that month’s payroll.")}><input className="hr-input" type="month" min={today.slice(0, 7)} {...f.bind("firstInstallmentMonth")} /></Field>
        <Field label={L("القسط التقريبي", "Approximate instalment")}><span className="hr-num" style={{ paddingBlock: 8 }}>{each !== null ? money(each) : "—"}</span></Field>
        <Field label={L("السبب *", "Reason *")} wide><textarea className="hr-textarea" maxLength={500} {...f.bind("reason")} /></Field>
      </div>
      <p className="hr-caption" style={{ margin: 0 }}>{L("سلفة واحدة مفتوحة لكل موظف (سياسة مقترحة). يمكنك إلغاء الطلب ما دام بانتظار الاعتماد.", "One open advance per employee (proposed policy). You can cancel the request while it awaits approval.")}</p>
    </Dialog>
  );
}

function CorrectionDialog({ today, onClose, onDone }: { today: string; onClose: () => void; onDone: () => void }) {
  const f = useForm({ workDate: today, checkIn: "", checkOut: "", reason: "" });
  const act = useAction();
  const { L } = useHrI18n();
  const submit = () => act.run("c", async () => {
    await hrFetch("/api/hr/me/corrections", { json: { workDate: f.v.workDate, checkIn: f.v.checkIn || undefined, checkOut: f.v.checkOut || undefined, reason: f.v.reason } });
    onDone();
  });
  return (
    <Dialog open title={L("طلب تصحيح حضور", "Attendance correction request")} onClose={onClose} actions={<><Btn variant="primary" busy={act.busy === "c"} disabled={!f.v.workDate || (!f.v.checkIn && !f.v.checkOut) || f.v.reason.trim().length < 3} onClick={submit}>{L("إرسال الطلب", "Submit request")}</Btn><Btn onClick={onClose}>{L("إلغاء", "Cancel")}</Btn></>}>
      {act.error ? <Notice tone="danger">{act.error}</Notice> : null}
      <div className="hr-form">
        <Field label={L("اليوم *", "Date *")} wide><input className="hr-input" type="date" max={today} {...f.bind("workDate")} /></Field>
        <Field label={L("وقت الحضور الصحيح", "Correct check-in time")}><input className="hr-input" type="time" {...f.bind("checkIn")} /></Field>
        <Field label={L("وقت الانصراف الصحيح", "Correct check-out time")} help={L("إن كان بعد منتصف الليل يُحسب لليوم التالي.", "After midnight counts as the next day.")}><input className="hr-input" type="time" {...f.bind("checkOut")} /></Field>
        <Field label={L("السبب *", "Reason *")} wide><textarea className="hr-textarea" maxLength={500} {...f.bind("reason")} /></Field>
      </div>
      <p className="hr-caption" style={{ margin: 0 }}>{L("يبقى السجل الأصلي كما هو حتى يعتمد المدير التصحيح، وتُحفظ القيم السابقة.", "The original record stays as it is until the manager approves the correction, and the previous values are kept.")}</p>
    </Dialog>
  );
}

function ReasonDialog({ title, confirm, url, onClose, onDone, children }: { title: string; confirm: string; url: string; onClose: () => void; onDone: () => void; children: React.ReactNode }) {
  const [reason, setReason] = useState("");
  const act = useAction();
  const { L } = useHrI18n();
  const submit = () => act.run("x", async () => {
    await hrFetch(url, { json: { reason } });
    onDone();
  });
  return (
    <Dialog open title={title} onClose={onClose} actions={<><Btn variant="danger" busy={act.busy === "x"} disabled={reason.trim().length < 3} onClick={submit}>{confirm}</Btn><Btn onClick={onClose}>{L("تراجع", "Discard")}</Btn></>}>
      {act.error ? <Notice tone="danger">{act.error}</Notice> : null}
      {children}
      <Field label={L("السبب *", "Reason *")}><textarea className="hr-textarea" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      {reason && reason.trim().length < 3 ? <Flag tone="danger">{L("السبب قصير جدًا.", "The reason is too short.")}</Flag> : null}
    </Dialog>
  );
}
