"use client";

import { useEffect, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { LayoutDashboard, ArrowLeftRight, PieChart, CalendarRange, FileBarChart, CalendarClock, CheckCircle2, ReceiptText, Landmark, FileText, Package, Building2, BadgePercent } from "lucide-react";
import { FinanceContext, api, useL } from "../finance/_components/ui";
import "../finance/finance.css";

const TABS = [
  { href: "/dashboard/accounting", ar: "نظرة عامة", en: "Overview", icon: LayoutDashboard },
  { href: "/dashboard/accounting/journals", ar: "القيود اليومية", en: "Journal entries", icon: ArrowLeftRight, badge: "journals" as const },
  { href: "/dashboard/accounting/accounts", ar: "دليل الحسابات", en: "Chart of accounts", icon: PieChart },
  { href: "/dashboard/accounting/periods", ar: "الفترات والإقفال", en: "Periods & closing", icon: CalendarRange },
  { href: "/dashboard/accounting/reports", ar: "التقارير المالية", en: "Financial reports", icon: FileBarChart },
  { href: "/dashboard/accounting/payables", ar: "الذمم الدائنة", en: "Payables", icon: ReceiptText, badge: "bills" as const },
  { href: "/dashboard/accounting/receivables", ar: "الذمم المدينة", en: "Receivables", icon: FileText, badge: "sales" as const },
  { href: "/dashboard/accounting/inventory", ar: "المخزون", en: "Inventory", icon: Package, badge: "inventory" as const },
  { href: "/dashboard/accounting/assets", ar: "الأصول الثابتة", en: "Fixed assets", icon: Building2 },
  { href: "/dashboard/accounting/tax", ar: "الضريبة والفوترة الإلكترونية", en: "Tax & e-invoicing", icon: BadgePercent },
  { href: "/dashboard/accounting/bank", ar: "البنك", en: "Bank", icon: Landmark, badge: "bank" as const },
  { href: "/dashboard/accounting/automation", ar: "الترحيل الآلي والسياسات", en: "Automatic posting & policies", icon: CalendarClock, badge: "events" as const },
];

type Overview = { journals: { pendingApproval: number; approvedUnposted: number }; events: { blocked: number; failed: number; pending: number }; payables?: { pendingApproval: number }; receivables?: { pendingApproval: number }; inventory?: { pendingApproval: number }; bank?: { blocked: number } };

export default function AccountingLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { L } = useL();
  const [version, setVersion] = useState(0);
  const [ov, setOv] = useState<Overview | null>(null);
  useEffect(() => { api<Overview>("/api/accounting/overview").then(setOv).catch(() => setOv(null)); }, [version, pathname]);
  const active = [...TABS].sort((a, b) => b.href.length - a.href.length).find((t) => pathname === t.href || pathname.startsWith(t.href + "/"));
  const pending = ov?.journals.pendingApproval ?? 0;
  const badges = { journals: pending, events: (ov?.events.blocked ?? 0) + (ov?.events.failed ?? 0), bills: ov?.payables?.pendingApproval ?? 0, sales: ov?.receivables?.pendingApproval ?? 0, inventory: ov?.inventory?.pendingApproval ?? 0, bank: ov?.bank?.blocked ?? 0 };

  return (
    <FinanceContext value={{ branch: "", setBranch: () => {}, version, refresh: () => setVersion((v) => v + 1) }}>
      <div data-finance-root data-accounting-root className="flex flex-col gap-5 max-w-[1400px]">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-extrabold text-charcoal">{L("المحاسبة — دفتر الأستاذ العام", "Accounting — General ledger")}</h1>
            <p className="text-[13px] text-brown mt-1">{L("أساس الاستحقاق · ريال سعودي · توقيت الرياض", "Accrual basis · Saudi riyal · Asia/Riyadh")}</p>
          </div>
          <Link href="/dashboard/accounting/journals?status=SUBMITTED" className="inline-flex items-center gap-2 bg-white border border-border rounded-lg px-3 py-2 text-[13px] font-bold text-charcoal hover:bg-cream">
            <CheckCircle2 size={16} className="text-orange" />
            {L("بانتظار الاعتماد", "Awaiting approval")}
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${pending ? "bg-orange-light text-orange" : "bg-slate-100 text-slate-500"}`}>{pending}</span>
          </Link>
        </div>
        <nav className="bg-white border border-border rounded-xl p-1 flex flex-wrap gap-1" aria-label={L("أقسام المحاسبة", "Accounting sections")}>
          {TABS.map((t) => {
            const on = active?.href === t.href;
            const n = t.badge ? badges[t.badge] : 0;
            return (
              <a key={t.href} href={t.href} aria-current={on ? "page" : undefined}
                className={`inline-flex items-center gap-1.5 px-2.5 py-2 rounded-lg text-[13px] font-bold whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-orange ${on ? "bg-orange text-white" : "text-brown hover:bg-cream hover:text-charcoal"}`}>
                <t.icon size={16} aria-hidden />
                {L(t.ar, t.en)}
                {n > 0 && <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${on ? "bg-slate-100 text-slate-600" : "bg-amber-100 text-amber-700"}`}>{n}</span>}
              </a>
            );
          })}
        </nav>
        {children}
      </div>
    </FinanceContext>
  );
}
