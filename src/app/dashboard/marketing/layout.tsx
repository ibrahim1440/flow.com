// Server layout for «التسويق الذكي» (feat/smart-marketing): the Direction 2.1 viewport, the reference
// primitives and the sales kit's token remap (the marketing screens reuse that kit), plus the
// section's own few classes. All scoped to `.d21`, which only the dashboard shell sets.
import type { ReactNode } from "react";
import { direction21Viewport } from "@/components/shell/viewport";
import "@/components/d21/reference.css";
import "../d21.css";
import "./_components/mkt.css";

export const viewport = direction21Viewport;

export default function MarketingLayout({ children }: { children: ReactNode }) {
  return children;
}
