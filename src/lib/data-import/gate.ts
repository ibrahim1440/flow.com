// The server gate of «استيراد البيانات» (the rule is ./access.ts): the admin role as before — reads free, the import
// through requireAdminAction with a step-up — or a holder of accounting › data_import through the privileged gate of that
// key: a verified individual (SIMPLE MODE: not required) on every request, and a recent step-up on the import.
// scripts/auth/privileged-route-inventory.ts reads these helpers (helperGaps) and lists every route that calls them.
import type { NextResponse } from "next/server";
import { forbidden, requireAdminAction, requireAuth, requirePrivilegedAction, type SessionUser } from "@/lib/auth-server";
import { dataImportGate } from "./access";

/** Counts, the template and the preview (nothing written): the admin role, or a holder (verified individual). */
export async function requireDataImport(): Promise<{ user: SessionUser; error: NextResponse | null }> {
  const { user, error } = await requireAuth();
  if (error) return { user, error };
  const gate = dataImportGate(user, false);
  if (gate.kind === "forbidden") return { user, error: forbidden() };
  if (gate.kind === "holder") return { user, error: await requirePrivilegedAction(user, "accounting.data_import", { stepUp: false }) };
  return { user, error: null };
}

/** The import itself (after requireDataImport): the admin-role gate, or the holder's privileged gate — both step up. */
export async function requireDataImportApply(user: SessionUser): Promise<NextResponse | null> {
  const gate = dataImportGate(user, true);
  if (gate.kind === "admin") return requireAdminAction(user, "settings.data_import", { stepUp: true });
  if (gate.kind === "holder") return requirePrivilegedAction(user, "accounting.data_import", { stepUp: true });
  return forbidden();
}
