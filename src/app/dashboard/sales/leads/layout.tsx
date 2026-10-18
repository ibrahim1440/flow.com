// Server layout for the Direction 2.1 leads routes (list and lead page): the approved viewport
// and the reference page primitives. The pages themselves are unchanged client components.
import type { ReactNode } from "react";
import { direction21Viewport } from "@/components/shell/viewport";
import "@/components/d21/reference.css";
import "../../d21.css";

export const viewport = direction21Viewport;

export default function LeadsLayout({ children }: { children: ReactNode }) {
  return children;
}
