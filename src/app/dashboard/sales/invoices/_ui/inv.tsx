"use client";

// Sales invoicing A2 — the hub's frame (Figma ZT-10 / ZT-11): «الفواتير والتحصيل» with the tabs
// فواتير المبيعات · الإشعارات الدائنة والمدينة · التحصيلات · أعمار الذمم وكشوف العملاء. Direction 2.1, RTL first,
// on the A1 accounting kit (acct.css, the fetch / write helpers). Every control is a convenience: the API
// re-checks each duty and the database re-checks every guarantee.
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { OpsRoot, PageHeader } from "@/components/ops/ui";
import { useLang } from "@/app/dashboard/accounting/_ui/shell";
import "@/app/dashboard/accounting/_ui/accounting.css";
import { useTerm, useWorkspaceMode } from "@/components/chrome";
import "./inv.css";

export { acctFetch, money, Msg, useApi, useLang, useWrite, todayRiyadh } from "@/app/dashboard/accounting/_ui/shell";

export const INV_TABS = [
  { href: "/dashboard/sales/invoices", ar: "فواتير المبيعات", en: "Sales invoices", match: (p: string, tab: string | null) => p.startsWith("/dashboard/sales/invoices") && tab !== "notes" },
  { href: "/dashboard/sales/invoices?tab=notes", ar: "الإشعارات الدائنة والمدينة", en: "Credit & debit notes", match: (p: string, tab: string | null) => p === "/dashboard/sales/invoices" && tab === "notes" },
  { href: "/dashboard/sales/collections", ar: "التحصيلات", en: "Collections", match: (p: string) => p.startsWith("/dashboard/sales/collections") },
  { href: "/dashboard/sales/receivables", ar: "أعمار الذمم وكشوف العملاء", en: "AR aging & statements", match: (p: string) => p.startsWith("/dashboard/sales/receivables") },
];

export function InvShell({ title, meta, actions, children, testId, tab = null }: { title?: string; meta?: ReactNode; actions?: ReactNode; children: ReactNode; testId?: string; tab?: string | null }) {
  const { L } = useLang();
  const path = usePathname() ?? "";
  // The hub tabs read the glossary (Qoyod's words in the accountant workspace, ours elsewhere).
  const term = useTerm();
  const { accountant } = useWorkspaceMode();
  const word = (href: string, ar: string, en: string) => (!accountant ? L(ar, en) : href === "/dashboard/sales/collections" ? term("collections") : href.endsWith("?tab=notes") ? term("creditNotes") : href === "/dashboard/sales/invoices" ? term("salesInvoices") : L(ar, en));
  return (
    <OpsRoot className="acct inv">
      <div className="hr-page" data-testid={testId}>
        <PageHeader title={title ?? L("الفواتير والتحصيل", "Invoices & collections")} actions={actions}>
          {meta ?? <span className="acct-meta"><span>{L("ريال سعودي", "SAR")}</span><span aria-hidden="true">·</span><span>{L("الأسعار قبل الضريبة", "Prices before VAT")}</span></span>}
        </PageHeader>
        <nav className="hr-tabs is-underline acct-tabs" aria-label={L("أقسام الفواتير", "Invoicing sections")}>
          {INV_TABS.map((t) => {
            const on = t.match(path, tab);
            return <Link key={t.href} href={t.href} className="hr-tab" aria-selected={on} aria-current={on ? "page" : undefined}>{word(t.href, t.ar, t.en)}</Link>;
          })}
        </nav>
        <div className="acct-body">{children}</div>
      </div>
    </OpsRoot>
  );
}

type Tone = "neutral" | "info" | "warning" | "success" | "cancelled" | "danger";
export const DOC_STATUS: Record<string, [string, string, Tone]> = {
  DRAFT: ["مسودة", "Draft", "neutral"],
  ISSUED: ["صادرة", "Issued", "success"],
  CANCELLED: ["ملغاة", "Cancelled", "cancelled"],
};
export const PAY_STATUS: Record<string, [string, string, Tone]> = {
  UNPAID: ["غير مسددة", "Unpaid", "warning"],
  PARTIAL: ["مسددة جزئيًا", "Partly paid", "info"],
  PAID: ["مسددة", "Paid", "success"],
};
export const KIND: Record<string, Record<string, [string, string]>> = {
  INVOICE: { STANDARD: ["فاتورة ضريبية", "Tax invoice"], SIMPLIFIED: ["فاتورة ضريبية مبسطة", "Simplified tax invoice"] },
  CREDIT_NOTE: { STANDARD: ["إشعار دائن", "Credit note"], SIMPLIFIED: ["إشعار دائن مبسط", "Simplified credit note"] },
  DEBIT_NOTE: { STANDARD: ["إشعار مدين", "Debit note"], SIMPLIFIED: ["إشعار مدين مبسط", "Simplified debit note"] },
};
export const FAMILY: Record<string, [string, string]> = { STANDARD: ["ضريبية", "Standard"], SIMPLIFIED: ["مبسطة", "Simplified"] };
export const REASONS: Record<string, [string, string]> = {
  RETURN: ["إرجاع بضاعة", "Goods returned"], PRICE_ADJUSTMENT: ["تعديل السعر", "Price adjustment"], DISCOUNT: ["خصم لاحق", "Discount after issue"],
  CANCELLATION: ["إلغاء التوريد أو جزء منه", "Supply cancelled"], AMENDMENT: ["تصحيح بيانات الفاتورة", "Correction"], OTHER: ["سبب آخر", "Other"],
};
export const CATEGORY: Record<string, [string, string]> = { S: ["أساسية 15%", "Standard"], Z: ["صفرية", "Zero rated"], E: ["معفاة", "Exempt"], O: ["خارج النطاق", "Out of scope"] };

export function Tag({ map, value }: { map: Record<string, [string, string, Tone]>; value: string }) {
  const { L } = useLang();
  const e = map[value];
  return <span className={`hr-dot tone-${e?.[2] ?? "neutral"}`}><span>{e ? L(e[0], e[1]) : value}</span></span>;
}

/** A document number in the monospace face, isolated LTR inside Arabic text. */
export function DocNo({ n, draftLabel }: { n: string | null | undefined; draftLabel?: string }) {
  return n ? <bdi className="acct-code" dir="ltr">{n}</bdi> : <span className="hr-muted">{draftLabel ?? "—"}</span>;
}
