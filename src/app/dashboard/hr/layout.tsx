// Server layout: only exports the Direction 2.1 viewport; the client part is unchanged.
import type { ReactNode } from "react";
import { direction21Viewport } from "@/components/shell/viewport";
import HrLayoutClient from "./hr-layout-client";

export const viewport = direction21Viewport;

export default function HrLayout({ children }: { children: ReactNode }) {
  return <HrLayoutClient>{children}</HrLayoutClient>;
}
