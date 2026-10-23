// Server layout: the Direction 2.1 viewport for «التنبيهات» (feat/notifications).
import type { ReactNode } from "react";
import { direction21Viewport } from "@/components/shell/viewport";

export const viewport = direction21Viewport;

export default function Layout({ children }: { children: ReactNode }) {
  return children;
}
