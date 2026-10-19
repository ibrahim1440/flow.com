"use client";
// The cash & budget frame around the six finance pages (GX B-P01…B-P06 page header): title,
// «أساس نقدي · ريال سعودي · توقيت الرياض», the branch filter chip and the approvals queue
// (B-P07) in the header's action area, then the six areas as an underline tab bar of links.
//
// Same state and requests as the legacy layout it replaces: GET /api/finance/setup (branches,
// company scope), the review count (GET /api/finance/transactions?review=NEEDS_REVIEW&take=1)
// and the approvals count (GET /api/finance/approvals), re-read on branch or refresh. The tabs
// stay plain links (a full navigation, as before), so the branch choice resets per area as it did.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { Btn, FilterChip, OpsRoot, PageHeader } from "@/components/ops/ui";
import { useD21Phone, useD21Title } from "@/components/shell/page-context";
import "@/components/ops/stock.css";
import { FinanceContext, useL, api, withBranch } from "./ui";
import { ApprovalsDialog } from "./approvals";
import "../finance.css";

const TABS = [
  { href: "/dashboard/finance", ar: "نظرة عامة", en: "Overview" },
  { href: "/dashboard/finance/transactions", ar: "المعاملات والتسوية", en: "Transactions", badge: "review" as const },
  { href: "/dashboard/finance/allocation", ar: "تخصيص النقد", en: "Cash allocation" },
  { href: "/dashboard/finance/budget", ar: "الميزانية الشهرية", en: "Monthly budget" },
  { href: "/dashboard/finance/obligations", ar: "الالتزامات والتوقعات", en: "Obligations & forecasts" },
  { href: "/dashboard/finance/reports", ar: "التقارير والإعدادات", en: "Reports & settings" },
];

type Branch = { id: string; code: string; nameEn: string; nameAr: string | null };

export function FinanceShell({ children }: { children: ReactNode }) {
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
  const isOverview = active?.href === TABS[0].href;
  const title = L("النقد والميزانية", "Cash & budget");
  // The top bar's trail ends with the area («المالية / النقد والميزانية / نظرة عامة»); on the
  // phone the header names the area under «النقد والميزانية» (B-01 390 names the page itself).
  useD21Title(active ? L(active.ar, active.en) : null);
  useD21Phone(active ? (isOverview ? { title, sub: L("المالية", "Finance") } : { title: L(active.ar, active.en), sub: title }) : null);

  const branchOptions = [
    ...(companyWide ? [{ value: "COMPANY", label: L("مستوى الشركة", "Company level") }] : []),
    ...branches.map((b) => ({ value: b.id, label: name(b) })),
  ];

  return (
    <FinanceContext value={{ branch, setBranch, version, refresh }}>
      <OpsRoot>
        <div className="hr-page" data-fin-root="">
          <PageHeader
            title={title}
            actions={<>
              <FilterChip label={L("الفرع", "Branch")} allLabel={L("كل الفروع", "All branches")} value={branch} onChange={setBranch} options={branchOptions} />
              <Btn onClick={() => setShowApprovals(true)} aria-haspopup="dialog">
                {L("الموافقات", "Approvals")}<span className="hr-num">{approvalCount}</span>
              </Btn>
            </>}
          >
            <span className="hr-caption">{L("أساس نقدي · ريال سعودي · توقيت الرياض", "Cash basis · Saudi riyal · Asia/Riyadh")}</span>
          </PageHeader>

          <nav className="hr-tabs is-underline fin-tabs" aria-label={L("أقسام المالية", "Finance sections")}>
            {TABS.map((t) => (
              <a key={t.href} href={t.href} className="hr-tab" aria-current={active?.href === t.href ? "page" : undefined}>
                {L(t.ar, t.en)}
                {t.badge === "review" && reviewCount > 0 ? <span className="hr-count">{reviewCount}</span> : null}
              </a>
            ))}
          </nav>

          <div className="fin-body">{children}</div>
        </div>
        <ApprovalsDialog open={showApprovals} onClose={() => setShowApprovals(false)} onDecided={refresh} />
      </OpsRoot>
    </FinanceContext>
  );
}
