// Server layout: only exports the Direction 2.1 viewport; the client part is unchanged.
import type { ReactNode } from "react";
import { direction21Viewport } from "@/components/shell/viewport";
import MeLayoutClient from "./me-layout-client";

export const viewport = direction21Viewport;

export default function MeLayout({ children }: { children: ReactNode }) {
  return <MeLayoutClient>{children}</MeLayoutClient>;
}
