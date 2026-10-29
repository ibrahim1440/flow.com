"use client";
// «واجهة المحاسب» (Qoyod-parity program, phase 1): which sidebar the shell draws for this viewer, and where its home is.
// The shell provides it; pages and the shared page chrome (`@/components/chrome`) read it — the breadcrumb's
// «الصفحة الرئيسية» links to the workspace home, and the glossary (`@/lib/nav/glossary`) applies its Qoyod wording
// only while `accountant` is true. Presentation only: it never decides what anybody may open.
import { createContext, useContext } from "react";

export type WorkspaceMode = {
  /** The accountant workspace sidebar is drawn (the viewer holds the accounting module and has not switched to the full menu). */
  accountant: boolean;
  /** The landing page of the current workspace: «لوحة المتابعة» in the accountant workspace, the dashboard otherwise. */
  home: string;
};

export const ACCOUNTANT_HOME = "/dashboard/accounting/home";
export const FULL_HOME = "/dashboard";

export const WorkspaceModeContext = createContext<WorkspaceMode>({ accountant: false, home: FULL_HOME });

export function useWorkspaceMode(): WorkspaceMode {
  return useContext(WorkspaceModeContext);
}
