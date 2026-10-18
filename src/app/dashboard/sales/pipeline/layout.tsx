// Server layout for the Direction 2.1 pipeline board: the approved viewport and the reference
// page primitives. The page itself is unchanged.
import type { ReactNode } from "react";
import { direction21Viewport } from "@/components/shell/viewport";
import "@/components/d21/reference.css";
import "../../d21.css";

export const viewport = direction21Viewport;

export default function PipelineLayout({ children }: { children: ReactNode }) {
  return children;
}
