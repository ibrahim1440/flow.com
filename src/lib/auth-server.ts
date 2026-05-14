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

export async function getUserWithPermissions(): Promise<(UserPayload & { permissions: Permissions }) | null> {
  const user = await getUser();
  if (!user) return null;

  const employee = await prisma.employee.findUnique({
    where: { id: user.id },
    select: { permissions: true },
  });

  if (!employee) return null;

  let permissions = parsePermissions(employee.permissions as string);
  if (!permissions || Object.keys(permissions).length === 0) {
    permissions = buildDefaultPermissions(user.role);
  }
  return { ...user, permissions };
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
