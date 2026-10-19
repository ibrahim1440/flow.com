import { NextResponse } from "next/server";
import { requireAuth, requireModule, requireAdminAction } from "@/lib/auth-server";
import { createRole, listRoles } from "@/lib/users/roles";
import { usersCaps } from "@/lib/users/server";
import { auditContext } from "@/lib/users/account-update";
import { body, noStore, usersErrorResponse } from "@/lib/users/http";

// GET — the roles (Figma UR-05, UR-07): the read-only system templates and the custom roles, each
// with its matrix, members and sensitive count. Any holder of the «إدارة المستخدمين» module.
export async function GET(request: Request) {
  const { user, error } = await requireModule("employees");
  if (error) return error;
  try {
    const includeNoAccess = new URL(request.url).searchParams.get("all") === "1";
    return NextResponse.json({ roles: await listRoles({ includeNoAccess }), caps: usersCaps(user) }, noStore);
  } catch (e) {
    return usersErrorResponse(e);
  }
}

// POST — «دور جديد» (UR-05 → UR-06 new): name, description and a matrix (or a template to copy, its
// sensitive permissions left out — P-3). The administrator role only, after a recent step-up.
export async function POST(request: Request) {
  const { user, error } = await requireAuth();
  if (error) return error;
  const refused = await requireAdminAction(user, "roles.create", { stepUp: true, message: "Only the administrator creates roles." });
  if (refused) return refused;
  try {
    const r = await createRole(auditContext(request, user.id), await body(request) as never);
    return NextResponse.json({ id: r.id, name: r.name, version: r.version }, { status: 201 });
  } catch (e) {
    return usersErrorResponse(e);
  }
}
