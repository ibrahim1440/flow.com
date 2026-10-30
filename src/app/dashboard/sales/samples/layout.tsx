// «العيّنات» (batch 24 WP-B): the Direction 2.1 page primitives and the sales kit's token remap, as the other sales lists.
import type { ReactNode } from "react";
import { direction21Viewport } from "@/components/shell/viewport";
import "@/components/d21/reference.css";
import "../../d21.css";
import "../_components/perf.css";
import "./samples.css";

export const viewport = direction21Viewport;

export default function SamplesLayout({ children }: { children: ReactNode }) {
  return children;
}
