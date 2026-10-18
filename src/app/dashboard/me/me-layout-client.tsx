"use client";
// Self-service needs no HR module duty, so it does not load /api/hr/meta.
import type { ReactNode } from "react";
import { HrRoot } from "@/components/hr/ui";

export default function MeLayoutClient({ children }: { children: ReactNode }) {
  return <HrRoot>{children}</HrRoot>;
}
