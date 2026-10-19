// Server layout for the Direction 2.1 customers list (UI batch 2): the approved viewport and the
// reference page primitives the leads list uses (`crm-leads`), so the two lists of «العملاء» read
// the same. The stylesheets are scoped to `.d21`, which only the Direction 2.1 shell sets.
import type { ReactNode } from "react";
import { direction21Viewport } from "@/components/shell/viewport";
import "@/components/d21/reference.css";
import "../d21.css";

export const viewport = direction21Viewport;

export default function CustomersLayout({ children }: { children: ReactNode }) {
  return children;
}
