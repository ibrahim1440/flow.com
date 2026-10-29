/**
 * The RESERVED routes of the accountant workspace (`./accountant`) whose page has landed WITHOUT a registry entry of its
 * own. A reserved item is drawn «قريباً» (disabled) until it is live: a registry node at exactly its href makes it live
 * by itself (budgets and deferrals, feat/budgets-deferrals); a page that ships without one is listed here, ONE line, in
 * the same change. `tests/ui/unit/accountant-nav.test.ts` fails when a reserved route has a page on disk but is not live,
 * or is live without a page.
 *
 * Reserved (Qoyod-parity program): /dashboard/accounting/recurring · /dashboard/accounting/journal-templates ·
 * /dashboard/accounting/fixed-assets (+ /depreciation, /disposals, /additions) · /dashboard/accounting/budgets ·
 * /dashboard/accounting/deferrals.
 */
export const LIVE_RESERVED: string[] = [
  // feat/recurring-journals (tabs of «المحاسبة», no registry entry of their own).
  "/dashboard/accounting/journal-templates",
  "/dashboard/accounting/recurring",
  // feat/fixed-assets (one tab «الأصول الثابتة» and its pages, no registry entry of their own).
  "/dashboard/accounting/fixed-assets",
  "/dashboard/accounting/fixed-assets/depreciation",
  "/dashboard/accounting/fixed-assets/disposals",
  "/dashboard/accounting/fixed-assets/additions",
  // «الموازنات» and «قوالب التأجيل» are live through their registry entries (finance.accountingBudgets / …Deferrals).
];
