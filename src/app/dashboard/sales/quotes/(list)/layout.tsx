// Server layout for the Direction 2.1 quotations LIST only (`/dashboard/sales/quotes`). It sits
// in the `(list)` route group so that the quotation editor, the issued quotation and the print
// view (`../new`, `../[id]`, `../[id]/print`), which are not migrated, do not get the Direction
// 2.1 viewport. The stylesheets are scoped to `.d21`, which only the Direction 2.1 shell sets.
import type { ReactNode } from "react";
import { direction21Viewport } from "@/components/shell/viewport";
import "@/components/d21/reference.css";
import "../../../d21.css";

export const viewport = direction21Viewport;

export default function QuotesListLayout({ children }: { children: ReactNode }) {
  return children;
}
