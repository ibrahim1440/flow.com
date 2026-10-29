"use client";

// BATCH22 WP-E: the quotation screens are drawn under two addresses — Sales' «/dashboard/sales/quotes» and the accounting
// section's «/dashboard/accounting/quotes» (the accountant may hold no sales module, so the route guard would refuse the
// Sales address). Every link inside them is built from the address they were opened under; a deal link is drawn only
// under the Sales address (the deal pages are Sales').
import { usePathname } from "next/navigation";

export const SALES_QUOTES = "/dashboard/sales/quotes";
export const ACCOUNTING_QUOTES = "/dashboard/accounting/quotes";

export function useQuotesBase(): { base: string; accounting: boolean } {
  const path = usePathname() ?? "";
  const accounting = path.startsWith(ACCOUNTING_QUOTES);
  return { base: accounting ? ACCOUNTING_QUOTES : SALES_QUOTES, accounting };
}
