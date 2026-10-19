// Server layout for collections on Direction 2.1 (GX A-01, Figma 1459:15522 / 1459:17412): the
// approved viewport, the reference page primitives and the page's own drawer styles, all scoped
// to `.d21`.
import type { ReactNode } from "react";
import { direction21Viewport } from "@/components/shell/viewport";
import "@/components/d21/reference.css";
import "../../d21.css";
import "./collections.css";

export const viewport = direction21Viewport;

export default function CollectionsLayout({ children }: { children: ReactNode }) {
  return children;
}
