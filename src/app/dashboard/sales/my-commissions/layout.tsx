// Server layout for a Direction 2.1 page of «الأداء والعمولات» / sales settings (UI batch 2,
// GX A-P03…A-P08): the approved viewport, the reference page primitives, the token remap of the
// sales kit (its dialogs and fields keep working, re-coloured) and the family's own few classes.
// The stylesheets are scoped to `.d21`, which only the Direction 2.1 shell sets.
import type { ReactNode } from "react";
import { direction21Viewport } from "@/components/shell/viewport";
import "@/components/d21/reference.css";
import "../../d21.css";
import "../_components/perf.css";
import "../../commissions/builder.css";

export const viewport = direction21Viewport;

export default function PerfLayout({ children }: { children: ReactNode }) {
  return children;
}
