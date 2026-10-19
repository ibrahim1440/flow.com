// Server layout: the Direction 2.1 viewport (safe-area insets, keyboard resize) for the cash &
// budget pages, and the client frame around them (header, branch filter, approvals, tabs).
import type { ReactNode } from "react";
import { direction21Viewport } from "@/components/shell/viewport";
import { FinanceShell } from "./_components/shell";

export const viewport = direction21Viewport;

export default function FinanceLayout({ children }: { children: ReactNode }) {
  return <FinanceShell>{children}</FinanceShell>;
}
