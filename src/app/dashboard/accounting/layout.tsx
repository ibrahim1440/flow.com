// Server layout: the Direction 2.1 viewport (safe-area insets, keyboard resize) for this
// route, which renders in the Direction 2.1 shell (components/shell/AppShell).
import type { ReactNode } from "react";
import { direction21Viewport } from "@/components/shell/viewport";

export const viewport = direction21Viewport;

export default function AccountingLayout({ children }: { children: ReactNode }) {
  return children;
}
