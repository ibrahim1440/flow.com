// The gate of a change of ANOTHER account's access on the users & roles routes (owner decision,
// 19 Oct 2026): the administrator role (requireAdminAction, with a recent step-up — unchanged), or a
// power user (employees › manage_access) — that permission is privileged, so it is exercised as
// one: a verified individual (SIMPLE MODE: not required) after a recent step-up. Everyone else: 403.
// The guardrails on what a power user may change (power.ts) run inside the shared account path.
import type { NextResponse } from "next/server";
import { requireAdminAction, requirePrivilegedAction, type SessionUser } from "@/lib/auth-server";
import { accessActor } from "./power";

export async function requireAccessManager(user: SessionUser, step: string, message: string): Promise<NextResponse | null> {
  if (accessActor(user) === "power") {
    return requirePrivilegedAction(user, `employees.manage_access ${step}`, { stepUp: true });
  }
  return requireAdminAction(user, step, { stepUp: true, message });
}
