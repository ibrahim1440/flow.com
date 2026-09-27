"use client";

// Figma: ACC-01 (page "17 — Accounting · General Ledger"). Accountant's landing screen:
// what waits for a decision, what the posting engine could not post, and whether the ledger
// balances — every figure read from the ledger API, nothing computed here.
import Link from "next/link";
import { AlertOctagon, CalendarRange, CheckCircle2, ClipboardList, Settings2 } from "lucide-react";
import { Badge, Button, Card, CardTitle, EmptyState, ErrorState, Kpi, LoadingState, Notice, Table, Td, Th, useApi, useL } from "../finance/_components/ui";
import { EVENT_LABEL, EVENT_STATUS, JournalStatus, PERIOD_STATUS, useAmount, useAutoText, useCan, useDay, useExplain } from "./_components/kit";

type Overview = {
  setupComplete: boolean; ledgerCutoverDate: string | null; accounts: number; mappings: number;
  journals: { drafts: number; pendingApproval: number; approvedUnposted: number };
  events: { pending: number; blocked: number; failed: number };
  periods: { id: string; year: number; periodNo: number; startDate: string; endDate: string; status: string }[];
  provisionalEntries: number;
};
type JRow = { id: string; entryNo: number; entryDate: string; description: string | null; total: number; status: string; createdBy: string | null; type: string };
type Events = { rows: { id: string; eventType: string; status: string; errorMessage: string | null; payload: { amount?: string } }[]; counts: Record<string, number> };
type TB = { lines: unknown[]; totals: { openingDebit: number; openingCredit: number; periodDebit: number; periodCredit: number; closingDebit: number; closingCredit: number }; balanced: boolean; provisionalEntries: number };

export default function AccountingOverview() {
  const { L, money, lang } = useL();
  const day = useDay();
  const explain = useExplain();
  const amount = useAmount();
  const auto = useAutoText();
  const { user } = useCan();
  const ov = useApi<Overview>("/api/accounting/overview");
  const queue = useApi<{ rows: JRow[] }>("/api/accounting/journals?status=PENDING&pageSize=10&sort=oldest");
  const events = useApi<Events>("/api/accounting/events?status=BLOCKED&pageSize=10");
  const year = new Date().getUTCFullYear();
  const tb = useApi<TB>(`/api/accounting/reports/trial-balance?from=${year}-01-01`);

  if (ov.error) return <ErrorState error={ov.error} onRetry={ov.reload} />;
  if (!ov.data) return <LoadingState label={L("جارٍ تحميل البيانات المحاسبية…", "Loading accounting data…")} />;
  const o = ov.data;

  if (!o.setupComplete) {
    const steps: [string, string, boolean][] = [
      ["دليل الحسابات (تحميل القالب أو إنشاء الحسابات)", "Chart of accounts (load the template or create accounts)", o.accounts > 0],
      ["سنة مالية بفترات مفتوحة", "A fiscal year with open periods", o.periods.length > 0],
      ["ربط أدوار الترحيل بالحسابات", "Posting roles mapped to accounts", o.mappings > 0],
      ["تاريخ بداية الدفتر (بعد مراجعة الأرصدة الافتتاحية)", "Ledger cutover date (after the opening balances are reviewed)", !!o.ledgerCutoverDate],
    ];
    return (
      <Card>
        <CardTitle title={L("إعداد المحاسبة لم يكتمل", "Accounting set-up is not complete")} sub={L("لا يُرحّل أي قيد — يدوي أو آلي — قبل اكتمال الإعداد. الأحداث التشغيلية تنتظر ولا تضيع.", "Nothing posts — manual or automatic — until set-up is complete. Operational events wait; none are lost.")} />
        <ul className="flex flex-col gap-2">
          {steps.map(([ar, en, done]) => (
            <li key={en} className="flex items-center gap-2 text-[13px]"><Badge tone={done ? "ok" : "info"}>{done ? "✓" : "—"}</Badge><span className={done ? "text-charcoal" : "text-brown"}>{L(ar, en)}</span></li>
          ))}
        </ul>
        <div><Link href="/dashboard/accounting/automation"><Button kind="primary" icon={Settings2}>{L("متابعة الإعداد", "Continue set-up")}</Button></Link></div>
      </Card>
    );
  }

  const openNow = o.periods.find((p) => p.status === "OPEN");
  const monthName = (p: { startDate: string }) => new Date(p.startDate).toLocaleDateString(lang === "ar" ? "ar-SA-u-ca-gregory-nu-latn" : "en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
  const blocked = o.events.blocked + o.events.failed;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi icon={ClipboardList} tone="warn" label={L("قيود بانتظار الاعتماد", "Entries awaiting approval")} value={o.journals.pendingApproval} sub={L("أعدّها غيرك ولم تُعتمد بعد", "Prepared, not yet approved")} />
        <Kpi icon={CheckCircle2} tone="blue" label={L("معتمدة لم تُرحّل", "Approved, not posted")} value={o.journals.approvedUnposted} sub={L("جاهزة للترحيل", "Ready to post")} />
        <Kpi icon={AlertOctagon} tone={blocked ? "bad" : "slate"} valueClass={blocked ? "text-red-600" : ""} label={L("أحداث ترحيل محجوبة", "Blocked automatic postings")} value={blocked} sub={blocked ? L("تحتاج قراراً أو إعداداً", "Need a decision or set-up") : L("لا شيء محجوب", "Nothing blocked")} />
        <Kpi icon={CalendarRange} tone="brand" label={L("الفترة المفتوحة الحالية", "Current open period")} value={openNow ? monthName(openNow) : "—"} sub={o.ledgerCutoverDate ? L(`بداية الدفتر ${day(o.ledgerCutoverDate)}`, `Ledger cutover ${day(o.ledgerCutoverDate)}`) : ""} />
      </div>
      {o.provisionalEntries > 0 && (
        <Notice tone="warn">{L(`${o.provisionalEntries} قيداً مؤقتاً (من سياسات أو خطط غير معتمدة) في قاعدة اختبار معزولة — تظهر موسومة في التقارير.`, `${o.provisionalEntries} provisional entries (from unapproved policies or plans) in an isolated test database — labelled in reports.`)}</Notice>
      )}

      <div className="grid gap-4 grid-cols-1 xl:grid-cols-[1fr_444px]">
        <Card>
          <CardTitle title={L("بانتظار قرارك", "Waiting for a decision")} sub={L("لا يمكنك اعتماد قيد أعددته أو قدّمته بنفسك", "You cannot approve an entry you prepared or submitted")}
            right={<Link href="/dashboard/accounting/journals?status=PENDING"><Button>{L("كل القيود ←", "All entries →")}</Button></Link>} />
          {queue.error ? <ErrorState error={queue.error} onRetry={queue.reload} /> : !queue.data ? <LoadingState /> : queue.data.rows.length === 0 ? (
            <p className="text-[13px] text-brown">{L("لا توجد قيود بانتظار الاعتماد أو الترحيل.", "Nothing is waiting for approval or posting.")}</p>
          ) : (
            <Table>
              <thead><tr><Th>{L("رقم", "No.")}</Th><Th>{L("التاريخ", "Date")}</Th><Th>{L("الوصف", "Description")}</Th><Th num>{L("المبلغ", "Amount")}</Th><Th>{L("الحالة / أعدّه", "Status / prepared by")}</Th></tr></thead>
              <tbody>
                {queue.data.rows.map((r) => (
                  <tr key={r.id} className="hover:bg-cream/40">
                    <Td><a className="font-bold text-orange hover:underline" href={`/dashboard/accounting/journals/${r.id}`}>#{r.entryNo}</a></Td>
                    <Td className="whitespace-nowrap">{day(r.entryDate)}</Td>
                    <Td className="max-w-[320px] truncate">{auto(r.description) || "—"}</Td>
                    <Td num>{money(r.total)}</Td>
                    <Td>{r.status === "APPROVED" ? <JournalStatus status="APPROVED" /> : (r.createdBy === user?.name ? <Badge tone="info">{L("أعددته أنت", "Yours")}</Badge> : r.createdBy)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>

        <Card>
          <CardTitle title={L("الترحيل الآلي", "Automatic posting")} sub={L("أحداث من الوحدات التشغيلية لم تتحول إلى قيود", "Operational events not yet turned into entries")} />
          {events.data?.rows.slice(0, 3).map((e) => (
            <div key={e.id} className="rounded-xl bg-red-50 px-3 py-2.5 flex flex-col gap-1">
              <span className="text-[13px] font-bold text-red-800">{EVENT_LABEL[e.eventType] ? L(...EVENT_LABEL[e.eventType]) : e.eventType}{e.payload?.amount ? ` · ${amount(e.payload.amount)} ${L("ر.س", "SAR")}` : ""}</span>
              <span className="text-xs text-red-700">{explain(e.errorMessage)}</span>
            </div>
          ))}
          <div className="flex gap-2 flex-wrap">
            {(["TRANSLATED", "BLOCKED", "FAILED", "SKIPPED"] as const).map((s) => (events.data?.counts?.[s] ? <Badge key={s} tone={EVENT_STATUS[s].tone}>{L(EVENT_STATUS[s].ar, EVENT_STATUS[s].en)} {events.data.counts[s]}</Badge> : null))}
            {events.data && Object.keys(events.data.counts ?? {}).length === 0 && <span className="text-[13px] text-brown">{L("لا توجد أحداث بعد.", "No events yet.")}</span>}
          </div>
          <div><Link href="/dashboard/accounting/automation"><Button>{L("مراجعة الأحداث والسياسات", "Review events and policies")}</Button></Link></div>
        </Card>
      </div>

      <div className="grid gap-4 grid-cols-1 xl:grid-cols-2">
        <Card>
          <CardTitle title={L(`ميزان المراجعة — منذ 1 يناير ${year}`, `Trial balance — since 1 January ${year}`)} sub={L("من القيود المرحّلة فقط", "Posted entries only")}
            right={<Link href="/dashboard/accounting/reports"><Button>{L("فتح التقارير ←", "Open reports →")}</Button></Link>} />
          {tb.error ? <ErrorState error={tb.error} onRetry={tb.reload} /> : !tb.data ? <LoadingState /> : tb.data.lines.length === 0 ? (
            <EmptyState title={L("لا توجد قيود مرحّلة بعد", "No posted entries yet")} />
          ) : (
            <>
              <Table>
                <thead><tr><Th></Th><Th num>{L("مدين", "Debit")}</Th><Th num>{L("دائن", "Credit")}</Th></tr></thead>
                <tbody>
                  <tr><Td>{L("رصيد أول المدة", "Opening")}</Td><Td num>{money(tb.data.totals.openingDebit)}</Td><Td num>{money(tb.data.totals.openingCredit)}</Td></tr>
                  <tr><Td>{L("حركة الفترة", "Movement")}</Td><Td num>{money(tb.data.totals.periodDebit)}</Td><Td num>{money(tb.data.totals.periodCredit)}</Td></tr>
                  <tr className="font-bold"><Td>{L("الرصيد الختامي", "Closing")}</Td><Td num>{money(tb.data.totals.closingDebit)}</Td><Td num>{money(tb.data.totals.closingCredit)}</Td></tr>
                </tbody>
              </Table>
              <div className="flex items-center gap-2">
                {tb.data.balanced ? <Badge tone="ok">{L("متوازن ✓", "Balanced ✓")}</Badge> : <Badge tone="bad">{L("غير متوازن", "Not balanced")}</Badge>}
                <span className="text-xs text-brown">{tb.data.provisionalEntries ? L(`يشمل ${tb.data.provisionalEntries} قيداً مؤقتاً`, `Includes ${tb.data.provisionalEntries} provisional entries`) : L("مجموع المدين يساوي مجموع الدائن في كل عمود", "Debits equal credits in every column")}</span>
              </div>
            </>
          )}
        </Card>
        <Card>
          <CardTitle title={L("الفترات المالية", "Fiscal periods")} sub={L("القفل يمنع الترحيل مؤقتاً · الإقفال نهائي", "Locking pauses posting · closing is final")}
            right={<Link href="/dashboard/accounting/periods"><Button>{L("إدارة الفترات ←", "Manage periods →")}</Button></Link>} />
          <Table>
            <thead><tr><Th>{L("الفترة", "Period")}</Th><Th>{L("الحالة", "Status")}</Th></tr></thead>
            <tbody>
              {o.periods.slice(0, 6).map((p) => (
                <tr key={p.id}><Td>{monthName(p)}</Td><Td><Badge tone={PERIOD_STATUS[p.status].tone}>{L(PERIOD_STATUS[p.status].ar, PERIOD_STATUS[p.status].en)}</Badge></Td></tr>
              ))}
            </tbody>
          </Table>
        </Card>
      </div>
      <div className="rounded-xl bg-cream-dark/60 px-4 py-3 text-xs text-brown flex flex-col gap-1">
        <span>{L("القيد اليدوي يُعدّه موظف ويعتمده موظف آخر قبل ترحيله. القيد المرحّل لا يُعدَّل ولا يُحذف — يُصحَّح بقيد عكسي يحتاج اعتماداً.", "A manual entry is prepared by one person and approved by another before it posts. A posted entry is never edited or deleted — it is corrected by a reversal that needs approval.")}</span>
        <span>{L("القيود الآلية تأتي من الوحدات التشغيلية (العمولات حالياً) وتُصحَّح من مصدرها.", "Automatic entries come from operational modules (commissions for now) and are corrected at their source.")}</span>
      </div>
    </div>
  );
}
