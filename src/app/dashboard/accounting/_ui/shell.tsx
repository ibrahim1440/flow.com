"use client";

// Accounting core A1 — the module's frame (Direction 2.1; Figma ACC-23 / 24 / 25 / 80 family): the page title
// «المحاسبة», a meta line, and the section tabs (نظرة عامة · القيود · دليل الحسابات · التقارير · الفترات ·
// الأرصدة الافتتاحية · الإعدادات) as links. Pages fetch /api/accounting/*; every control is a convenience —
// the API re-checks each duty.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { OpsRoot, PageHeader, Notice } from "@/components/ops/ui";
import { localizeApiError, networkErrorText } from "@/lib/i18n/api-errors";
import { useI18n } from "@/lib/i18n/context";
import "./accounting.css";

export type Setup = {
  settings: { accountingActive: boolean; goLiveDate: string | null; setupComplete: boolean; coaSeededAt: string | null; openingEntryId: string | null; activatedAt: string | null };
  readiness: {
    active: boolean; goLiveDate: string | null; accounts: number; postable: number; canActivate: boolean; openingPosted: boolean; enginePosted: boolean;
    checks: { key: string; ok: boolean; ar: string; en: string }[];
    roles: { key: string; ar: string; en: string; phase: string; group: string; accountId: string | null; accountCode: string | null; accountName: string | null }[];
    missingByPhase: Record<string, string[]>;
    goLivePeriod: { id: string; status: string } | null;
  };
  manualJournalsEnabled: boolean;
  simpleMode: boolean;
  /** A5: the SoD setting (effective: the setting, or SIMPLE MODE). */
  sod?: { allowSelfApproval: boolean; approverMayPost: boolean; stored: { allowSelfApproval: boolean; approverMayPost: boolean }; simpleMode: boolean };
  viewer: { id: string };
  can: Record<"settings" | "coa" | "periodLock" | "periodClose" | "periodReopen" | "journalCreate" | "journalSubmit" | "journalApprove" | "journalPost" | "journalReverse" | "opening", boolean>;
};

export function useLang() {
  const { lang } = useI18n();
  const L = useCallback((ar: string, en: string) => (lang === "en" ? en : ar), [lang]);
  return { lang, ar: lang !== "en", L };
}

/** A journal's source module in the viewer's language (the list and the entry page). */
const JOURNAL_SOURCE: Record<string, [string, string]> = {
  manual: ["يدوي", "Manual"], hr: ["الموارد البشرية", "HR"], accounting: ["المحاسبة", "Accounting"], sales: ["المبيعات", "Sales"],
  purchasing: ["المشتريات", "Purchasing"], inventory: ["المخزون", "Inventory"], production: ["الإنتاج", "Production"],
  payroll: ["الرواتب", "Payroll"], commissions: ["العمولات", "Commissions"], pos: ["نقاط البيع", "POS"],
};
export const sourceLabel = (m: string, L: (ar: string, en: string) => string) => { const e = JOURNAL_SOURCE[m]; return e ? L(e[0], e[1]) : m; };

/** fetch for the accounting pages: JSON in and out; a refusal throws its text in the viewer's language
 *  (the body's Arabic, else the shared Arabic table, else the English — src/lib/i18n/api-errors.ts). */
export async function acctFetch<T = unknown>(url: string, init?: { method?: string; json?: unknown }): Promise<T> {
  // A request that never reached the server reads in the page's language, not the browser's "Failed to fetch".
  const res = await fetch(url, {
    method: init?.method ?? (init?.json !== undefined ? "POST" : "GET"),
    headers: init?.json !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: init?.json !== undefined ? JSON.stringify(init.json) : undefined,
    cache: "no-store",
  }).catch(() => { throw new Error(networkErrorText()); });
  const ct = res.headers.get("content-type") ?? "";
  const body = ct.includes("application/json") ? await res.json().catch(() => ({})) : null;
  if (!res.ok) throw new Error(localizeApiError(body) ?? `HTTP ${res.status}`);
  return body as T;
}

/** GET with reload; the error is the API's own (Arabic first) refusal. */
export function useApi<T>(url: string | null) {
  const [tick, setTick] = useState(0);
  const [state, setState] = useState<{ key: string | null; data: T | null; error: string | null }>({ key: null, data: null, error: null });
  const key = url ? `${url}#${tick}` : null;
  useEffect(() => {
    if (!url || !key) return;
    let off = false;
    acctFetch<T>(url).then((d) => { if (!off) setState({ key, data: d, error: null }); }).catch((e) => { if (!off) setState((s) => ({ key, data: s.data, error: e instanceof Error ? e.message : String(e) })); });
    return () => { off = true; };
  }, [url, key]);
  return { data: state.data, error: state.error, loading: !!key && state.key !== key, reload: useCallback(() => setTick((t) => t + 1), []) };
}

/** Run a write; returns the body or null (the error is kept for the page's notice). */
export function useWrite() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const run = useCallback(async <T,>(id: string, url: string, method: string, json?: unknown, ok?: string): Promise<T | null> => {
    setBusy(id); setError(null); setDone(null);
    try {
      const r = await acctFetch<T>(url, { method, json: json ?? {} });
      if (ok) setDone(ok);
      return r;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setBusy(null);
    }
  }, []);
  return { busy, error, done, setError, setDone, run };
}

const nf = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** Latin digits, grouped, 2 decimals; blank for zero when asked (statements show «—» or nothing for zero). */
export function money(v: string | number | null | undefined, blankZero = false): string {
  if (v === null || v === undefined || v === "") return "";
  const n = Number(v);
  if (blankZero && n === 0) return "";
  return nf.format(n);
}

export const TABS = [
  { href: "/dashboard/accounting", ar: "نظرة عامة", en: "Overview", exact: true },
  { href: "/dashboard/accounting/journals", ar: "القيود", en: "Journals" },
  { href: "/dashboard/accounting/chart", ar: "دليل الحسابات", en: "Chart of accounts" },
  { href: "/dashboard/accounting/reports", ar: "التقارير", en: "Reports" },
  // Accounting A5: the quarterly VAT return, reconciled to the GL and ZATCA (Figma «الضريبة»).
  { href: "/dashboard/accounting/tax", ar: "الضريبة", en: "VAT" },
  // Accounting A3: the AP ledger (Figma ACC-50 / 53) and the inventory cost ledger (ACC-100).
  { href: "/dashboard/accounting/ap", ar: "الذمم الدائنة", en: "Payables" },
  { href: "/dashboard/accounting/inventory", ar: "المخزون والتكلفة", en: "Inventory & cost" },
  { href: "/dashboard/accounting/periods", ar: "الفترات", en: "Periods" },
  { href: "/dashboard/accounting/opening", ar: "الأرصدة الافتتاحية", en: "Opening balances" },
  { href: "/dashboard/accounting/settings", ar: "الإعدادات", en: "Settings" },
  // ZATCA Phase 2 A4 (ZT-20 family): the e-invoicing setup, onboarding, queue and log.
  { href: "/dashboard/accounting/zatca", ar: "الفوترة الإلكترونية", en: "E-invoicing" },
];

export function AcctShell({ title, meta, actions, children, setup, pendingCount }: { title?: string; meta?: ReactNode; actions?: ReactNode; children: ReactNode; setup?: Setup | null; pendingCount?: number }) {
  const { L } = useLang();
  const path = usePathname() ?? "";
  const active = setup?.settings.accountingActive;
  return (
    <OpsRoot className="acct">
      <div className="hr-page">
      <PageHeader title={title ?? L("المحاسبة", "Accounting")} actions={actions}>
        {meta ?? (
          <span className="acct-meta">
            <span>{L("ريال سعودي", "SAR")}</span>
            <span aria-hidden="true">·</span>
            <span>{L("أساس الاستحقاق", "Accrual basis")}</span>
            {setup ? (
              <>
                <span aria-hidden="true">·</span>
                {active ? (
                  <span className="acct-pill is-on" data-testid="acct-state">{L("مفعّلة منذ", "Active from")} <span className="hr-num">{setup.settings.goLiveDate}</span></span>
                ) : (
                  <span className="acct-pill is-off" data-testid="acct-state">{L("غير مفعّلة — لا يُرحَّل شيء من العمليات", "Not activated — operations post nothing")}</span>
                )}
              </>
            ) : null}
          </span>
        )}
      </PageHeader>
      <nav className="hr-tabs is-underline acct-tabs" aria-label={L("أقسام المحاسبة", "Accounting sections")}>
        {TABS.map((t) => {
          const on = t.exact ? path === t.href : path.startsWith(t.href);
          return (
            <Link key={t.href} href={t.href} className="hr-tab" aria-selected={on} aria-current={on ? "page" : undefined}>
              {L(t.ar, t.en)}
              {t.href.endsWith("/journals") && pendingCount ? <span className="hr-count">{pendingCount}</span> : null}
            </Link>
          );
        })}
      </nav>
      <div className="acct-body">{children}</div>
      </div>
    </OpsRoot>
  );
}

export function Msg({ error, done, onClose }: { error?: string | null; done?: string | null; onClose?: () => void }) {
  if (!error && !done) return null;
  return (
    <div role={error ? "alert" : "status"} className="acct-msg" onClick={onClose}>
      <Notice tone={error ? "danger" : "success"}>{error ?? done}</Notice>
    </div>
  );
}

export const STATUS_AR: Record<string, [string, string, "neutral" | "info" | "warning" | "success" | "cancelled" | "danger"]> = {
  DRAFT: ["مسودة", "Draft", "neutral"],
  SUBMITTED: ["بانتظار الاعتماد", "Awaiting approval", "warning"],
  APPROVED: ["معتمد · لم يُرحَّل", "Approved · not posted", "info"],
  POSTED: ["مرحّل", "Posted", "success"],
  REVERSED: ["معكوس", "Reversed", "cancelled"],
};
export const TYPE_AR: Record<string, [string, string]> = {
  MANUAL: ["يدوي", "Manual"], AUTO: ["آلي", "Automatic"], REVERSAL: ["عكسي", "Reversal"], ADJUSTMENT: ["تسوية", "Adjustment"], OPENING: ["افتتاحي", "Opening"], CLOSING: ["إقفال", "Closing"],
};
export const ACCOUNT_TYPE_AR: Record<string, [string, string]> = {
  ASSET: ["أصول", "Asset"], LIABILITY: ["التزامات", "Liability"], EQUITY: ["حقوق ملكية", "Equity"], REVENUE: ["إيرادات", "Revenue"], EXPENSE: ["مصروفات", "Expense"],
};
export const CONTROL_AR: Record<string, [string, string]> = {
  AR: ["ذمم مدينة", "Receivables"], AP: ["ذمم دائنة", "Payables"], INVENTORY: ["مخزون", "Inventory"], VAT_INPUT: ["ضريبة", "VAT"], VAT_OUTPUT: ["ضريبة", "VAT"],
  CASH: ["نقدية", "Cash"], BANK: ["بنك", "Bank"], FIXED_ASSET: ["أصول ثابتة", "Fixed assets"], PAYROLL: ["رواتب", "Payroll"], COMMISSION: ["عمولات", "Commissions"], CLEARING: ["وسيط", "Clearing"],
};
export const PERIOD_AR: Record<string, [string, string, string]> = {
  OPEN: ["مفتوحة", "Open", "success"], LOCKED: ["مقفلة مؤقتًا", "Soft-closed", "warning"], CLOSED: ["مقفلة نهائيًا", "Closed", "cancelled"],
};

export function StatusTag({ map, value }: { map: Record<string, [string, string, string]>; value: string }) {
  const { L } = useLang();
  const e = map[value];
  return <span className={`hr-dot tone-${e?.[2] ?? "neutral"}`}><span>{e ? L(e[0], e[1]) : value}</span></span>;
}

/** Today in Riyadh as YYYY-MM-DD (the business day). */
export function todayRiyadh(): string {
  return new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
}
