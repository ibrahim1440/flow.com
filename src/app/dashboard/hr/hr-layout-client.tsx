"use client";
// Native HR — every page under /dashboard/hr renders inside the Direction 2.1 scope and
// shares the caller's duties and reference lists (GET /api/hr/meta).
import type { ReactNode } from "react";
import { HrMetaProvider, HrRoot } from "@/components/hr/ui";

export default function HrLayoutClient({ children }: { children: ReactNode }) {
  return (
    <HrRoot>
      <HrMetaProvider>{children}</HrMetaProvider>
    </HrRoot>
  );
}
