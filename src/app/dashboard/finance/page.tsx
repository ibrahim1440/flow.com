"use client";

import { Wallet, PiggyBank, Lock, AlertOctagon, ArrowDownCircle, ArrowUpCircle, TrendingUp, Landmark } from "lucide-react";
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceDot, Legend } from "recharts";
import { Badge, Card, CardTitle, EmptyState, ErrorState, Kpi, LoadingState, Table, Td, Th, useApi, useHasSub, useL, type Tone } from "./_components/ui";
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
  const { L, lang, sar, money, name } = useL();
  const alertText = useAlertText();
  const { data, error, loading, reload } = useApi<Overview>("/api/finance/overview");
  const canSetUp = useHasSub(useUser()?.permissions, "settings_manage");
  if (loading && !data) return <LoadingState />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return null;
  if (data.accounts.length === 0) {
    return (
      <EmptyState icon={Landmark} title={L("لا توجد حسابات بنكية أو نقدية بعد", "No bank or cash accounts yet")} body={L("أضف حساباتك وأرصدتها الافتتاحية وبنود الميزانية. لا تُعرض أي أرقام تجريبية.", "Add your accounts, their opening balances and budget categories. No sample figures are shown.")}>
        {canSetUp ? (
          <div className="flex gap-2 flex-wrap justify-center">
            <a href="/dashboard/finance/reports" className="inline-flex items-center px-3.5 py-2 rounded-lg text-[13px] font-bold bg-orange text-white">{L("إعداد الحسابات", "Set up accounts")}</a>
            <a href="/dashboard/finance/reports#categories" className="inline-flex items-center px-3.5 py-2 rounded-lg text-[13px] font-bold bg-white border border-border text-charcoal">{L("إضافة البنود المقترحة", "Add suggested categories")}</a>
          </div>
        ) : <p className="text-xs text-brown">{L("اطلب من مسؤول المالية إعداد الحسابات.", "Ask a finance administrator to set up the accounts.")}</p>}
      </EmptyState>
    );
  }
  const book = data.accounts.reduce((s, a) => s + a.bookBalance, 0);
  const restricted = data.pools.reduce((s, p) => s + p.restrictedCash, 0);
  const unallocated = data.pools.reduce((s, p) => s + p.unallocated, 0);
  const mName = monthName(data.month, lang);
  const chart = data.forecast.weeks.map((w, i) => ({ label: ddmm(w.start), base: w.closing / 100, cons: data.forecast.conservativeWeeks[i].closing / 100 }));
  const low = data.forecast.weeks[data.forecast.lowestWeek - 1];
  const tone = (s: string): Tone => (s === "high" ? "bad" : s === "medium" ? "warn" : "info");
  const rtl = lang === "ar";
  const cats = [...data.categories].sort((a, b) => b.balance - a.balance).slice(0, 6);

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
        <Kpi icon={Wallet} tone="brand" label={L("النقد المؤكد في الحسابات", "Confirmed cash in accounts")} value={sar(book)} sub={L(`مقيد ${money(restricted)} · المعلّق غير محتسب`, `Restricted ${money(restricted)} · pending not counted`)} />
        <Kpi icon={PiggyBank} tone="teal" label={L("النقد غير المخصص", "Unallocated cash")} value={sar(unallocated)} sub={L("نقد مؤكد غير مرصود لأي غرض", "Confirmed cash not earmarked for any purpose")} valueClass={unallocated < 0 ? "text-red-600" : ""} />
        <Kpi icon={Lock} tone="blue" label={L("محجوز لطلبات الدفع", "Reserved for payment requests")} value={sar(data.reserved)} sub={L("مرصود لطلبات دفع قائمة", "Held for open payment requests")} />
        <Kpi icon={AlertOctagon} tone="bad" label={L("التزامات غير ممولة", "Unfunded obligations")} value={sar(data.unfundedTotal)} valueClass="text-red-600" sub={L(`${data.unfunded.length} التزاماً خلال 13 أسبوعاً`, `${data.unfunded.length} obligations within 13 weeks`)} />
      </div>
      <div className="grid grid-cols-2 xl:grid-cols-3 gap-4">
        <Kpi icon={ArrowDownCircle} tone="ok" label={L(`مقبوضات ${mName} التشغيلية`, `${mName} operating receipts`)} value={sar(data.monthly.receipts)} sub={L(`التمويل مستبعد: ${money(data.monthly.financingIn)}`, `Financing excluded: ${money(data.monthly.financingIn)}`)} />
        <Kpi icon={ArrowUpCircle} tone="warn" label={L(`مدفوعات ${mName} التشغيلية`, `${mName} operating payments`)} value={sar(data.monthly.payments)} sub={L("التحويلات الداخلية مستبعدة", "Internal transfers excluded")} />
        <div className="col-span-2 xl:col-span-1">
          <Kpi icon={TrendingUp} tone="slate" label={L("النقد المتوقع نهاية الشهر", "Forecast month-end cash")} value={sar(data.forecast.monthEndCash)} sub={L(`أدنى رصيد متوقع ${money(data.forecast.lowest)} — الأسبوع ${data.forecast.lowestWeek}`, `Lowest projected ${money(data.forecast.lowest)} — week ${data.forecast.lowestWeek}`)} />
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_380px] gap-4 items-start">
        <Card>
          <CardTitle title={L("توقع النقد — 13 أسبوعاً", "Cash forecast — 13 weeks")} sub={L("الرصيد الختامي أسبوعياً. التخصيصات الداخلية ليست مدفوعات ولا تُخصم.", "Weekly closing balance. Internal allocations are not payments and are not deducted.")} />
          <div className="h-[270px] -mx-2" dir="ltr">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chart} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
                <CartesianGrid stroke="#F3F4F6" vertical={false} />
                <XAxis dataKey="label" reversed={rtl} tick={{ fontSize: 11, fill: "#9CA3AF" }} axisLine={false} tickLine={false} />
                <YAxis orientation={rtl ? "right" : "left"} tick={{ fontSize: 11, fill: "#9CA3AF" }} axisLine={false} tickLine={false} tickFormatter={(v) => (v ? `${Math.round(v / 1000)}k` : "0")} width={44} />
                <Tooltip formatter={(v) => Number(v).toLocaleString("en-US", { minimumFractionDigits: 2 })} />
                <Legend verticalAlign="top" align={rtl ? "right" : "left"} height={28} wrapperStyle={{ fontSize: 12 }} />
                <Line name={L("سيناريو متحفظ (تأخر التحصيل أسبوعين، 80%)", "Conservative (collections 2 weeks late, 80%)")} dataKey="cons" stroke="#F59E0B" strokeWidth={2.5} strokeDasharray="6 4" dot={false} />
                <Line name={L("السيناريو الأساسي", "Base scenario")} dataKey="base" stroke="#7C3AED" strokeWidth={2.5} dot={false} />
                {low && <ReferenceDot x={ddmm(low.start)} y={low.closing / 100} r={5} fill="#7C3AED" stroke="#fff" strokeWidth={2} label={{ value: L(`أدنى رصيد ${money(low.closing)}`, `Lowest ${money(low.closing)}`), position: "bottom", fill: "#7C3AED", fontSize: 11, fontWeight: 700 }} />}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card>
          <CardTitle title={L("التنبيهات", "Alerts")} sub={L("مرتبة حسب الأهمية", "By severity")} right={<Badge tone={data.alerts.length ? "warn" : "ok"}>{data.alerts.length}</Badge>} />
          {data.alerts.length === 0 ? <p className="text-[13px] text-brown">{L("لا توجد تنبيهات.", "No alerts.")}</p> : (
            <ul className="flex flex-col gap-2.5">
              {data.alerts.slice(0, 6).map((a, i) => {
                const [text, meta] = alertText(a);
                const t = tone(a.severity);
                return (
                  <li key={i} className={`flex gap-2.5 px-3 py-2.5 rounded-[10px] ${t === "bad" ? "bg-red-100" : t === "warn" ? "bg-amber-100" : "bg-slate-100"}`}>
                    <span className={`w-2 h-2 rounded-full mt-1.5 flex-shrink-0 ${t === "bad" ? "bg-red-600" : t === "warn" ? "bg-amber-700" : "bg-slate-600"}`} />
                    <div className="min-w-0">
                      <p className="text-[13px] font-medium text-charcoal">{text}</p>
                      {meta && <p className="text-[11px] text-brown mt-0.5">{meta}</p>}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {data.alerts.length > 6 && <p className="text-xs font-bold text-orange">{L(`+ ${data.alerts.length - 6} تنبيهات أخرى`, `+ ${data.alerts.length - 6} more alerts`)}</p>}
        </Card>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
        <Card>
          <CardTitle title={L("أرصدة فئات التخصيص", "Allocation category balances")} sub={L("المتاح = الرصيد − المحجوز", "Available = balance − reserved")} right={<a href="/dashboard/finance/allocation" className="text-xs font-bold text-orange">{L("عرض الكل ←", "View all →")}</a>} />
          <Table>
            <thead><tr><Th>{L("الفئة", "Category")}</Th><Th num>{L("الرصيد", "Balance")}</Th><Th num>{L("محجوز", "Reserved")}</Th><Th num>{L("المتاح", "Available")}</Th></tr></thead>
            <tbody>
              {cats.map((c) => (
                <tr key={c.id}><Td>{name(c)}</Td><Td num>{money(c.balance)}</Td><Td num className="text-brown">{money(c.reserved)}</Td><Td num className="font-bold">{money(c.available)}</Td></tr>
              ))}
            </tbody>
          </Table>
        </Card>
        <Card>
          <CardTitle title={L("الحسابات", "Accounts")} sub={L("الرصيد الدفتري المؤكد وآخر تسوية", "Confirmed book balance and last reconciliation")} />
          <Table>
            <thead><tr><Th>{L("الحساب", "Account")}</Th><Th num>{L("الرصيد", "Balance")}</Th><Th>{L("آخر تسوية", "Last reconciled")}</Th></tr></thead>
            <tbody>
              {data.accounts.map((a) => (
                <tr key={a.id}>
                  <Td>{a.code} · {name(a)}</Td>
                  <Td num>{money(a.bookBalance)}</Td>
                  <Td>{a.lastReconciledDate ? <Badge tone="ok">{a.lastReconciledDate}</Badge> : <Badge tone="warn">{L("لم تتم", "Never")}</Badge>}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      </div>

      <div className="bg-slate-100 rounded-xl px-4 py-3 text-xs text-slate-600 flex flex-col gap-1">
        <p>{L("غير المخصص: النقد المؤكد في الحسابات غير المقيدة ناقص أرصدة كل الفئات — وهو الرقم الوحيد غير المرصود لأي غرض.", "Unallocated: confirmed cash in unrestricted accounts minus all category balances — the only figure not earmarked for any purpose.")}</p>
        <p>{L("المتاح في الفئة: رصيد الفئة ناقص الحجوزات المفتوحة، ويُصرف لغرض الفئة فقط. المتحصلات المتوقعة ليست نقداً حتى وصولها.", "Available in a category: its balance minus open reservations, spendable only for that purpose. Expected receipts are not cash until they arrive.")}</p>
      </div>
    </div>
  );
}
