// Server layout for the Direction 2.1 commission pages (UI batch 2): review (GX A-P06) and plans
// (A-P07), the only two routes under /dashboard/commissions. The approved viewport, the reference
// page primitives, the token remap of the sales kit and the «الأداء والعمولات» classes, all
// scoped to `.d21`, which only the Direction 2.1 shell sets.
import type { ReactNode } from "react";
import { direction21Viewport } from "@/components/shell/viewport";
import "@/components/d21/reference.css";
import "../d21.css";
import "../sales/_components/perf.css";

export const viewport = direction21Viewport;

export default function CommissionsLayout({ children }: { children: ReactNode }) {
  return children;
}
