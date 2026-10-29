"use client";

// «الأصول الثابتة» — the section's frame (20261121090000_fixed_assets): the accounting shell, the section's own pages
// as a segment (Qoyod's «الأصول الثابتة · الإهلاك · الاستبعادات · الإضافات», then categories, reports and the go-live
// opening), the status words and small shared pieces. Every control is a convenience — the API re-checks each duty.
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import type { ReactNode } from "react";
import { AcctShell, money, useApi, useLang, type Setup } from "../../_ui/shell";
import { HomeCrumb } from "@/components/chrome";
import "./fa.css";

export type Can = { write: boolean; post: boolean; reverse: boolean; opening: boolean };
export type Named = { id: string; code?: string; nameAr: string | null; nameEn: string | null };
export type Asset = {
  id: string; code: string; nameAr: string; nameEn: string | null; status: string; category: Named & { zakatDeductible: boolean; isLeasehold: boolean }; branch: Named | null; location: string | null;
  supplier: { id: string; name: string } | null; supplierInvoice: { id: string; number: string; supplierRef: string } | null; supplierInvoiceLineId: string | null;
  acquisitionKind: string; counterAccount: Named | null; acquisitionDate: string; inServiceDate: string | null; lifeEnd: string | null; cost: string; residualValue: string;
  usefulLifeMonths: number; method: string; decliningRatePercent: string | null; openingAccumulated: string | null; accumulatedDepreciation: string; netBookValue: string;
  depreciatedThrough: string | null; serialNumber: string | null; custodianEmployeeId: string | null; attachments: { name: string; url: string }[]; notes: string | null;
  zakatDeductible: boolean | null; zakatDeductibleEffective: boolean; leaseEndDate: string | null;
  nextMonth: { periodKey: string; charge: string } | null;
};

export const FA_STATUS: Record<string, [string, string, string]> = {
  DRAFT: ["مسودة", "Draft", "neutral"], ACTIVE: ["نشط", "Active", "success"], FULLY_DEPRECIATED: ["مُهلك بالكامل", "Fully depreciated", "info"], DISPOSED: ["مستبعد", "Disposed", "cancelled"],
  POSTED: ["مرحّل", "Posted", "success"], REVERSED: ["معكوس", "Reversed", "cancelled"], CANCELLED: ["ملغى", "Cancelled", "cancelled"],
};
export const GL_STATE: Record<string, [string, string, string]> = {
  POSTED: ["في الدفاتر", "In the books", "success"], SKIPPED: ["قبل بدء المحاسبة", "Before go-live", "warning"], OPENING: ["عبر الأرصدة الافتتاحية", "Via the opening", "info"],
};
export const METHOD: Record<string, [string, string]> = { STRAIGHT_LINE: ["القسط الثابت", "Straight-line"], DECLINING_BALANCE: ["القسط المتناقص", "Declining balance"] };
export const KIND: Record<string, [string, string]> = { PURCHASE_INVOICE: ["من فاتورة مشتريات", "From a purchase invoice"], MANUAL: ["يدوي (مقابل حساب)", "Manual (against an account)"], OPENING: ["قائم عند بدء المحاسبة", "Existing at go-live"], REVISION: ["تعديل تقدير (العمر / القيمة المتبقية)", "Change of estimate (life / residual)"] };

export function Tag({ map, value }: { map: Record<string, [string, string, string]>; value: string }) {
  const { L } = useLang();
  const e = map[value];
  return <span className={`hr-dot tone-${e?.[2] ?? "neutral"}`}><span>{e ? L(e[0], e[1]) : value}</span></span>;
}

export const nameOf = (x: { nameAr?: string | null; nameEn?: string | null; name?: string | null } | null | undefined, ar: boolean) => (x ? (ar ? x.nameAr || x.nameEn || x.name : x.nameEn || x.nameAr || x.name) ?? "" : "");
export function Money({ v, strong }: { v: string | number | null | undefined; strong?: boolean }) {
  return <span className={`acct-amount fa-money${strong ? " is-strong" : ""}`}>{money(v)}</span>;
}

const SECTIONS = [
  { href: "/dashboard/accounting/fixed-assets", ar: "الأصول الثابتة", en: "Fixed assets", exact: true },
  { href: "/dashboard/accounting/fixed-assets/depreciation", ar: "الإهلاك", en: "Depreciation" },
  { href: "/dashboard/accounting/fixed-assets/disposals", ar: "الاستبعادات", en: "Disposals" },
  { href: "/dashboard/accounting/fixed-assets/additions", ar: "الإضافات", en: "Additions" },
  { href: "/dashboard/accounting/fixed-assets?view=categories", ar: "الفئات", en: "Categories", view: "categories" },
  { href: "/dashboard/accounting/fixed-assets?view=reports", ar: "التقارير", en: "Reports", view: "reports" },
  { href: "/dashboard/accounting/fixed-assets?view=opening", ar: "الافتتاحي", en: "Opening", view: "opening" },
];

/** The accounting shell with the section's segment; `actions` sit in the page header. */
export function FaShell({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  const { L } = useLang();
  const setup = useApi<Setup>("/api/accounting/setup");
  const path = usePathname() ?? "";
  const view = useSearchParams()?.get("view") ?? null;
  return (
    <AcctShell setup={setup.data} title={title} actions={actions}>
      <nav className="acct-seg fa-sections" aria-label={L("أقسام الأصول الثابتة", "Fixed-asset sections")} data-testid="fa-sections">
        {SECTIONS.map((s) => {
          const on = s.view ? path === "/dashboard/accounting/fixed-assets" && view === s.view : s.exact ? path === s.href && !view : path.startsWith(s.href);
          return <Link key={s.href} href={s.href} aria-current={on ? "page" : undefined}>{L(s.ar, s.en)}</Link>;
        })}
      </nav>
      {children}
    </AcctShell>
  );
}

/** «الصفحة الرئيسية / الأصول الثابتة / …» — the shared chrome's trail (feat/qoyod-shell, CHROME.md). */
export function Crumb({ items }: { items: { label: string; href?: string }[] }) {
  const { L } = useLang();
  return <HomeCrumb items={[{ label: L("الأصول الثابتة", "Fixed assets"), href: items.length ? "/dashboard/accounting/fixed-assets" : null }, ...items]} testId="fa-crumb" />;
}

/** Qoyod's list page size (the coordinator: 15), then the chrome's larger sizes. */
export const FA_PAGE_SIZES = [15, 25, 50, 100];

export const MONTHS_AR = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
export const MONTHS_EN = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
