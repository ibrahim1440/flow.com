"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { LayoutDashboard, ArrowLeftRight, PieChart, CalendarRange, CalendarClock, FileBarChart, CheckCircle2, ChevronDown } from "lucide-react";
import { FinanceContext, useL, api, withBranch } from "./_components/ui";
import { ApprovalsDialog } from "./_components/approvals";
import "./finance.css";

const TABS = [
  { href: "/dashboard/finance", ar: "نظرة عامة", en: "Overview", icon: LayoutDashboard },
  { href: "/dashboard/finance/transactions", ar: "المعاملات والتسوية", en: "Transactions & Reconciliation", icon: ArrowLeftRight, badge: "review" as const },
  { href: "/dashboard/finance/allocation", ar: "تخصيص النقد", en: "Cash Allocation", icon: PieChart },
  { href: "/dashboard/finance/budget", ar: "الميزانية الشهرية", en: "Monthly Budget", icon: CalendarRange },
  { href: "/dashboard/finance/obligations", ar: "الالتزامات والتوقعات", en: "Obligations & Forecasts", icon: CalendarClock },
  { href: "/dashboard/finance/reports", ar: "التقارير والإعدادات", en: "Reports & Settings", icon: FileBarChart },
];

type Branch = { id: string; code: string; nameEn: string; nameAr: string | null };

export default function FinanceLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { L, name } = useL();
  const [branch, setBranch] = useState("");
  const [version, setVersion] = useState(0);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [companyWide, setCompanyWide] = useState(false);
  const [reviewCount, setReviewCount] = useState(0);
  const [approvalCount, setApprovalCount] = useState(0);
  const [showApprovals, setShowApprovals] = useState(false);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    api<{ branches: Branch[]; scope: { all: boolean } }>("/api/finance/setup")
      .then((s) => { setBranches(s.branches); setCompanyWide(s.scope.all); })
      .catch(() => {});
  }, [version]);
  useEffect(() => {
    api<{ total: number }>(withBranch("/api/finance/transactions?review=NEEDS_REVIEW&take=1", branch)).then((r) => setReviewCount(r.total)).catch(() => setReviewCount(0));
    api<{ toDecide: unknown[] }>(withBranch("/api/finance/approvals", branch)).then((r) => setApprovalCount(r.toDecide.length)).catch(() => setApprovalCount(0));
  }, [branch, version]);

  const active = [...TABS].sort((a, b) => b.href.length - a.href.length).find((t) => pathname === t.href || pathname.startsWith(t.href + "/"));

  return (
    <FinanceContext value={{ branch, setBranch, version, refresh }}>
      <div data-finance-root className="flex flex-col gap-5 max-w-[1400px]">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-extrabold text-charcoal">{L("المالية — النقد والميزانية", "Finance — Cash & Budget")}</h1>
            <p className="text-[13px] text-brown mt-1">{L("أساس نقدي · ريال سعودي · توقيت الرياض", "Cash basis · Saudi riyal · Asia/Riyadh")}</p>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative">
              <select aria-label={L("الفرع", "Branch")} value={branch} onChange={(e) => setBranch(e.target.value)}
                className="appearance-none bg-white border border-border rounded-lg ps-3 pe-8 py-2 text-[13px] font-medium text-charcoal outline-none focus:border-orange cursor-pointer">
                <option value="">{L("كل الفروع", "All branches")}</option>
                {companyWide && <option value="COMPANY">{L("مستوى الشركة", "Company level")}</option>}
                {branches.map((b) => <option key={b.id} value={b.id}>{name(b)}</option>)}
              </select>
              <ChevronDown size={12} className="absolute top-1/2 -translate-y-1/2 end-3 text-brown-light pointer-events-none" />
            </div>
            <button type="button" onClick={() => setShowApprovals(true)} className="inline-flex items-center gap-2 bg-white border border-border rounded-lg px-3 py-2 text-[13px] font-bold text-charcoal hover:bg-cream">
              <CheckCircle2 size={16} className="text-orange" />
              {L("الموافقات", "Approvals")}
              <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${approvalCount ? "bg-orange-light text-orange" : "bg-slate-100 text-slate-500"}`}>{approvalCount}</span>
            </button>
          </div>
        </div>

        <nav className="bg-white border border-border rounded-xl p-1 flex gap-1 overflow-x-auto" aria-label={L("أقسام المالية", "Finance sections")}>
          {TABS.map((t) => {
            const on = active?.href === t.href;
            return (
              <a key={t.href} href={t.href} aria-current={on ? "page" : undefined}
                className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-[13px] font-bold whitespace-nowrap transition-colors ${on ? "bg-orange text-white" : "text-brown hover:bg-cream hover:text-charcoal"}`}>
                <t.icon size={16} />
                {L(t.ar, t.en)}
                {t.badge === "review" && reviewCount > 0 && (
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${on ? "bg-slate-100 text-slate-600" : "bg-amber-100 text-amber-700"}`}>{reviewCount}</span>
                )}
              </a>
            );
          })}
        </nav>

        {children}
      </div>
      <ApprovalsDialog open={showApprovals} onClose={() => setShowApprovals(false)} onDecided={refresh} />
    </FinanceContext>
  );
}
