// Server layout for the whole quotations area on Direction 2.1 (`/dashboard/sales/quotes/**`):
// the list (`crm-quotes` 181:1609), the editor and the issued quotation (GX A-10 / A-11) and the
// document view (GX A-12). The stylesheets are scoped to `.d21`, which only the Direction 2.1
// shell sets (`@/components/shell/AppShell`).
import type { ReactNode } from "react";
import { direction21Viewport } from "@/components/shell/viewport";
import "@/components/d21/reference.css";
import "../../d21.css";
import "./quotes.css";

export const viewport = direction21Viewport;

export default function QuotesLayout({ children }: { children: ReactNode }) {
  return children;
}
