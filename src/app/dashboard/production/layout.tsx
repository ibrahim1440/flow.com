// Server layout: the Direction 2.1 viewport (safe-area insets, keyboard resize) for this
// operations route; the page itself is unchanged by this file.
import type { ReactNode } from "react";
import { direction21Viewport } from "@/components/shell/viewport";

export const viewport = direction21Viewport;

export default function Layout({ children }: { children: ReactNode }) {
  return children;
}
