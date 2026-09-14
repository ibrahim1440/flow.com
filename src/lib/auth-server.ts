import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { verifyToken, parsePermissions, buildDefaultPermissions, hasModuleAccess, canEdit, hasSubPrivilege, type UserPayload, type Permissions } from "./auth";
import { prisma } from "./db";

export async function getUser(): Promise<UserPayload | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get("token")?.value;
  if (!token) return null;
  return verifyToken(token);
}

/**
 * The authenticated caller, with authorization state read live from the database.
 *
 * The token proves WHO is calling. It does not decide what they may do.
 *
 * It used to decide half of it. Permissions were re-read here — good — but `active` was
 * never selected and `role` was taken from the token, so two things survived that should
 * not have. Deactivating an employee left them working normally until their token expired,
 * up to eight hours later: the one control an operations manager reaches for when somebody
 * leaves, or when a device goes missing, did nothing they could observe. And demoting an
 * admin left `role: "admin"` in a signed token that no later change could contradict —
 * which is the field that gates employee deletion and the production surplus override.
 *
 * So the rule is now the whole rule: the subject comes from the token, and existence,
 * active state, role and permissions all come from the row. A revoked account is
 * unauthenticated on its very next request.
 *
 * The cost is nothing new — this query already ran on every authenticated request; it
 * simply selects three columns instead of one.
 */
export async function getUserWithPermissions(): Promise<(UserPayload & { permissions: Permissions }) | null> {
  const user = await getUser();
  if (!user) return null;

  const employee = await prisma.employee.findUnique({
    where: { id: user.id },
    select: { active: true, role: true, permissions: true },
  });

  // Deleted, or deactivated since the token was issued. Both resolve as not authenticated
  // rather than as forbidden: there is no live account behind this request at all.
  if (!employee || !employee.active) return null;

  let permissions = parsePermissions(employee.permissions as string);
  if (!permissions || Object.keys(permissions).length === 0) {
    permissions = buildDefaultPermissions(employee.role);
  }
  // The live role overwrites the token's copy, so every `user.role === "admin"` call site
  // downstream reads current state without any of them having to know that.
  return { ...user, role: employee.role, permissions };
}

export function unauthorized(msg = "Not authenticated") {
  return NextResponse.json({ error: msg }, { status: 401 });
}

export function forbidden(msg = "Insufficient permissions") {
  return NextResponse.json({ error: msg }, { status: 403 });
}

export async function requireAuth() {
  const user = await getUserWithPermissions();
  if (!user) return { user: null as never, error: unauthorized() };
  return { user, error: null };
}

export async function requireModule(module: string) {
  const { user, error } = await requireAuth();
  if (error) return { user: null as never, error };
  if (!hasModuleAccess(user.permissions, module)) {
    return { user: null as never, error: forbidden() };
  }
  return { user, error: null };
}

export async function requireEdit(module: string) {
  const { user, error } = await requireAuth();
  if (error) return { user: null as never, error };
  if (!canEdit(user.permissions, module)) {
    return { user: null as never, error: forbidden() };
  }
  return { user, error: null };
}

export async function requireSub(module: string, subKey: string) {
  const { user, error } = await requireAuth();
  if (error) return { user: null as never, error };
  if (!hasSubPrivilege(user.permissions, module, subKey)) {
    return { user: null as never, error: forbidden() };
  }
  return { user, error: null };
}

// Read-only cross-module access: grants access when the user has ANY of the
// listed modules. Used so workflow stages can read relational data (bean names,
// order details, batch records) without needing permissions on the source module.
export async function requireAnyModule(...modules: string[]) {
  const { user, error } = await requireAuth();
  if (error) return { user: null as never, error };
  const allowed = modules.some((m) => hasModuleAccess(user.permissions, m));
  if (!allowed) return { user: null as never, error: forbidden() };
  return { user, error: null };
}
