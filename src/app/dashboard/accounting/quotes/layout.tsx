// «عروض الأسعار» in the accounting section (BATCH22 WP-E): the same quotation screens as Sales' (/dashboard/sales/quotes),
// drawn under the accounting address so an accountant without the sales module reaches them (the route guard of
// /dashboard/accounting/**: the accounting module). Every rule is the API's (canViewQuotes / canWriteQuotes).
import type { ReactNode } from "react";
import { direction21Viewport } from "@/components/shell/viewport";
import "@/components/d21/reference.css";
import "../../d21.css";
import "../../sales/quotes/quotes.css";

export const viewport = direction21Viewport;

export default function AccountingQuotesLayout({ children }: { children: ReactNode }) {
  return children;
}
