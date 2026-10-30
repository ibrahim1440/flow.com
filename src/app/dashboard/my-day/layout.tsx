// «يومي» (batch 24 WP-B): the approved viewport, the reference page primitives, the sales kit's token remap (its dialog
// and fields keep working, re-coloured) and the page's own few classes. Scoped to `.d21`, which only the shell sets.
import type { ReactNode } from "react";
import { direction21Viewport } from "@/components/shell/viewport";
import "@/components/d21/reference.css";
import "../d21.css";
import "./my-day.css";

export const viewport = direction21Viewport;

export default function MyDayLayout({ children }: { children: ReactNode }) {
  return children;
}
