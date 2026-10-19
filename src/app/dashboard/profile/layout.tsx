// Server layout: the Direction 2.1 viewport (safe-area insets, keyboard resize) for the own
// profile, which renders in the Direction 2.1 shell (components/shell/routes.ts, UI batch 2).
import type { ReactNode } from "react";
import { direction21Viewport } from "@/components/shell/viewport";

export const viewport = direction21Viewport;

export default function ProfileLayout({ children }: { children: ReactNode }) {
  return children;
}
