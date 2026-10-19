"use client";
// Finance · overview — Direction 2.1, GX B-P01 (Figma 1247:11423 AR, 1251:11423 EN, 390 1233:79317).
// Visual port only: the same request (GET /api/finance/overview) and the same figures; every
// total below is the same sum over the same rows as before.

import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceDot } from "recharts";
import { Badge, Card, CardTitle, EmptyState, ErrorState, Kpi, LoadingState, Metrics, Table, Td, Th, useApi, useChartTokens, useHasSub, useL, type Tone } from "./_components/ui";
import { useUser } from "../user-context";
import { monthName, useAlertText, ddmm, type OverviewAlert } from "./_components/helpers";

type Week = { index: number; start: string; closing: number };
type Overview = {
  month: string;
  accounts: { id: string; code: string; nameEn: string; nameAr: string | null; bookBalance: number; isRestricted: boolean; lastReconciledDate: string | null }[];
  pools: { branchKey: string; bookCash: number; restrictedCash: number; eligibleCash: number; allocated: number; unallocated: number; pendingIn: number; pendingOut: number }[];
  categories: { id: string; code: string; nameEn: string; nameAr: string | null; balance: number; reserved: number; available: number; priority: number }[];
  monthly: { receipts: number; payments: number; financingIn: number; financingOut: number };
  reserved: number; unfunded: unknown[]; unfundedTotal: number;
  forecast: { monthEndCash: number; lowest: number; lowestWeek: number; weeks: Week[]; conservativeWeeks: Week[] };
  alerts: OverviewAlert[];
};

export default function FinanceOverviewPage() {
  const { L, lang, money, name } = useL();
  const alertText = useAlertText();
  const tk = useChartTokens();
  const { data, error, loading, reload } = useApi<Overview>("/api/finance/overview");
  const canSetUp = useHasSub(useUser()?.permissions, "settings_manage");
  if (loading && !data) return <LoadingState />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return null;
  if (data.accounts.length === 0) {
    return (
      <EmptyState title={L("لا توجد حسابات بنكية أو نقدية بعد", "No bank or cash accounts yet")} body={L("أضف حساباتك وأرصدتها الافتتاحية وبنود الميزانية. لا تُعرض أي أرقام تجريبية.", "Add your accounts, their opening balances and budget categories. No sample figures are shown.")}>
        {canSetUp ? (
          <>
            <a href="/dashboard/finance/reports" className="hr-btn is-primary">{L("إعداد الحسابات", "Set up accounts")}</a>
            <a href="/dashboard/finance/reports#categories" className="hr-btn">{L("إضافة البنود المقترحة", "Add suggested categories")}</a>
          </>
        ) : <p className="hr-caption" style={{ margin: 0 }}>{L("اطلب من مسؤول المالية إعداد الحسابات.", "Ask a finance administrator to set up the accounts.")}</p>}
      </EmptyState>
    );
  }
  const book = data.accounts.reduce((s, a) => s + a.bookBalance, 0);
  const restricted = data.pools.reduce((s, p) => s + p.restrictedCash, 0);
  const unallocated = data.pools.reduce((s, p) => s + p.unallocated, 0);
  const mName = monthName(data.month, lang);
  const chart = data.forecast.weeks.map((w, i) => ({ label: ddmm(w.start), base: w.closing / 100, cons: data.forecast.conservativeWeeks[i].closing / 100 }));
  const low = data.forecast.weeks[data.forecast.lowestWeek - 1];
  const tone = (s: string): "danger" | "warning" | "neutral" => (s === "high" ? "danger" : s === "medium" ? "warning" : "neutral");
  const rtl = lang === "ar";
  const cats = [...data.categories].sort((a, b) => b.balance - a.balance).slice(0, 6);
  const unit = L("ر.س", "SAR");
  const neg = (v: number) => (v < 0 ? "is-danger" : "");
  const recon: Tone = "warn";

  return (
    <>
      <div className="fin-top">
        <div className="fin-hero">
          <span className="stk-lbl">{L("النقد المؤكد في الحسابات", "Confirmed cash in accounts")}</span>
          <span className="fin-hero-v"><span className="fin-num">{money(book)}</span><span className="stk-unit">{unit}</span></span>
          <span className="fin-cap">{L(`مقيد ${money(restricted)} · المعلّق غير محتسب`, `Restricted ${money(restricted)} · pending not counted`)}</span>
        </div>
        <Metrics cols={3}>
          <Kpi label={L("النقد غير المخصص", "Unallocated cash")} value={money(unallocated)} valueClass={neg(unallocated)} sub={L("نقد مؤكد غير مرصود لأي غرض", "Confirmed cash not earmarked for any purpose")} />
          <Kpi label={L("محجوز لطلبات الدفع", "Reserved for payment requests")} value={money(data.reserved)} sub={L("مرصود لطلبات دفع قائمة", "Held for open payment requests")} />
          <Kpi label={L("التزامات غير ممولة", "Unfunded obligations")} value={money(data.unfundedTotal)} valueClass="is-danger" sub={L(`${data.unfunded.length} التزاماً خلال 13 أسبوعاً`, `${data.unfunded.length} obligations within 13 weeks`)} />
        </Metrics>
      </div>
      <Metrics cols={3}>
        <Kpi label={L(`مقبوضات ${mName} التشغيلية`, `${mName} operating receipts`)} value={money(data.monthly.receipts)} sub={L(`التمويل مستبعد: ${money(data.monthly.financingIn)}`, `Financing excluded: ${money(data.monthly.financingIn)}`)} />
        <Kpi label={L(`مدفوعات ${mName} التشغيلية`, `${mName} operating payments`)} value={money(data.monthly.payments)} sub={L("التحويلات الداخلية مستبعدة", "Internal transfers excluded")} />
        <Kpi label={L("النقد المتوقع نهاية الشهر", "Forecast month-end cash")} value={money(data.forecast.monthEndCash)} valueClass={neg(data.forecast.monthEndCash)} sub={L(`أدنى رصيد متوقع ${money(data.forecast.lowest)} — الأسبوع ${data.forecast.lowestWeek}`, `Lowest projected ${money(data.forecast.lowest)} — week ${data.forecast.lowestWeek}`)} />
      </Metrics>

      <div className="fin-grid-aside">
        <Card>
          <CardTitle title={L("توقع النقد — 13 أسبوعاً", "Cash forecast — 13 weeks")} sub={L("الرصيد الختامي أسبوعياً · التخصيصات الداخلية ليست مدفوعات ولا تُخصم", "Weekly closing balance · internal allocations are not payments and are not deducted")} />
          <div className="fin-chart" dir="ltr">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chart} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
                <CartesianGrid stroke={tk.grid} vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 12, fill: tk.muted }} axisLine={false} tickLine={false} />
                <YAxis orientation={rtl ? "right" : "left"} tick={{ fontSize: 12, fill: tk.muted }} axisLine={false} tickLine={false} tickFormatter={(v) => (v ? `${Math.round(v / 1000)}k` : "0")} width={44} />
                <Tooltip formatter={(v) => Number(v).toLocaleString("en-US", { minimumFractionDigits: 2 })} />
                <Line name={L("سيناريو متحفظ (تأخر التحصيل أسبوعين، 80%)", "Conservative (collections 2 weeks late, 80%)")} dataKey="cons" stroke={tk.plan} strokeWidth={1.5} strokeDasharray="5 4" dot={false} />
                <Line name={L("السيناريو الأساسي", "Base scenario")} dataKey="base" stroke={tk.primary} strokeWidth={1.75} dot={false} />
                {low && <ReferenceDot x={ddmm(low.start)} y={low.closing / 100} r={4.5} fill="#fff" stroke={tk.primary} strokeWidth={1.5} label={{ value: L(`أدنى رصيد ${money(low.closing)}`, `Lowest ${money(low.closing)}`), position: "bottom", fill: tk.muted, fontSize: 12 }} />}
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div className="fin-legend">
            <span><i />{L("السيناريو الأساسي", "Base scenario")}</span>
            <span><i className="is-dash" />{L("سيناريو متحفظ (تأخر التحصيل أسبوعين، 80%)", "Conservative (collections 2 weeks late, 80%)")}</span>
          </div>
        </Card>

        <Card>
          <CardTitle title={L("التنبيهات", "Alerts")} sub={L("مرتبة حسب الأهمية", "By severity")} right={data.alerts.length ? <span className="hr-num fin-mut">{data.alerts.length}</span> : undefined} />
          {data.alerts.length === 0 ? <p className="fin-cap">{L("لا توجد تنبيهات.", "No alerts.")}</p> : (
            <ul className="fin-alerts">
              {data.alerts.slice(0, 6).map((a, i) => {
                const [text, meta] = alertText(a);
                return (
                  <li key={i} className={`tone-${tone(a.severity)}`}>
                    <span className="fin-a-t">{text}</span>
                    {meta ? <span className="fin-a-m">{meta}</span> : <span />}
                  </li>
                );
              })}
            </ul>
          )}
          {data.alerts.length > 6 && <p className="fin-cap">{L(`+ ${data.alerts.length - 6} تنبيهات أخرى`, `+ ${data.alerts.length - 6} more alerts`)}</p>}
        </Card>
      </div>

      <div className="fin-grid-aside fin-sec is-ruled">
        <Card>
          <CardTitle title={L("أرصدة فئات التخصيص", "Allocation category balances")} sub={L("المتاح = الرصيد − المحجوز", "Available = balance − reserved")} right={<a href="/dashboard/finance/allocation" className="fin-lk">{L("عرض الكل", "View all")}</a>} />
          <Table className="is-mrow" label={L("أرصدة فئات التخصيص", "Allocation category balances")}>
            <thead><tr><Th>{L("الفئة", "Category")}</Th><Th num>{L("الرصيد", "Balance")}</Th><Th num>{L("محجوز", "Reserved")}</Th><Th num>{L("المتاح", "Available")}</Th></tr></thead>
            <tbody>
              {cats.map((c) => (
                <tr key={c.id}>
                  <Td className="m-title"><span className="strong">{name(c)}</span><span className="hr-msub">{L("الرصيد", "Balance")} {money(c.balance)} · {L("محجوز", "reserved")} {money(c.reserved)}</span></Td>
                  <Td num>{money(c.balance)}</Td><Td num className="fin-t2">{money(c.reserved)}</Td><Td num className={`m-end fin-strong ${c.available < 0 ? "fin-danger" : ""}`}>{money(c.available)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <p className="fin-foot">{L(`أعلى ${cats.length} فئات من ${data.categories.length} · المحجوز في كل الفئات ${money(data.reserved)}`, `Top ${cats.length} of ${data.categories.length} categories · reserved across all categories ${money(data.reserved)}`)}</p>
        </Card>
        <Card>
          <CardTitle title={L("الحسابات", "Accounts")} sub={L("الرصيد الدفتري المؤكد وآخر تسوية", "Confirmed book balance and last reconciliation")} />
          <Table className="is-mrow" label={L("الحسابات", "Accounts")}>
            <thead><tr><Th>{L("الحساب", "Account")}</Th><Th num>{L("الرصيد الدفتري", "Book balance")}</Th><Th>{L("آخر تسوية", "Last reconciled")}</Th></tr></thead>
            <tbody>
              {data.accounts.map((a) => (
                <tr key={a.id}>
                  <Td className="m-title"><span className="strong">{name(a)}</span><span className="fin-sub is-mono">{a.code}</span></Td>
                  <Td num className="m-end">{money(a.bookBalance)}</Td>
                  <Td>{a.lastReconciledDate ? <span className="hr-num fin-t2">{a.lastReconciledDate}</span> : <Badge tone={recon}>{L("لم تتم", "Never")}</Badge>}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <p className="fin-foot">{L(`الإجمالي ${money(book)} · رصيد الدفتر = الافتتاحي + السطور المؤكدة`, `Total ${money(book)} · book balance = opening + confirmed lines`)}</p>
        </Card>
      </div>

      <div className="fin-box">
        <p style={{ margin: 0 }}>{L("غير المخصص: النقد المؤكد في الحسابات غير المقيدة ناقص أرصدة كل الفئات — وهو الرقم الوحيد غير المرصود لأي غرض.", "Unallocated: confirmed cash in unrestricted accounts minus all category balances — the only figure not earmarked for any purpose.")}</p>
        <p style={{ margin: 0 }}>{L("المتاح في الفئة: رصيد الفئة ناقص الحجوزات المفتوحة، ويُصرف لغرض الفئة فقط. المتحصلات المتوقعة ليست نقداً حتى وصولها.", "Available in a category: its balance minus open reservations, spendable only for that purpose. Expected receipts are not cash until they arrive.")}</p>
      </div>
    </>
  );
}
