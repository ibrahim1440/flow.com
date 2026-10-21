import { NextResponse } from "@/lib/api-response";
import { requireAuth, requireModule, requireAdminAction } from "@/lib/auth-server";
import { getRole, updateRole } from "@/lib/users/roles";
import { usersCaps } from "@/lib/users/server";
import { auditContext } from "@/lib/users/account-update";
import { body, noStore, usersErrorResponse } from "@/lib/users/http";

// GET — one role (Figma UR-06): its matrix, members, version. A system template id (admin, inventory,
// roasting, qc, dispatch, custom) answers read-only. Any holder of the «إدارة المستخدمين» module.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireModule("employees");
  if (error) return error;
  const { id } = await params;
  try {
    const role = await getRole(id);
    if (!role) return NextResponse.json({ error: "الدور غير موجود.", errorEn: "Role not found." }, { status: 404 });
    return NextResponse.json({ role, caps: usersCaps(user) }, noStore);
  } catch (e) {
    return usersErrorResponse(e);
  }
}

// PUT — save a custom role (UR-06 → UR-10 «حفظ تغييرات دور …؟»): matrix, name, description, the
// reason and the version the editor read (UR-S10). Every member's document is rewritten in the same
// transaction (their exceptions kept) and audited. System templates are read-only (O-3). The
// administrator role only, after a recent step-up.
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireAuth();
  if (error) return error;
  const refused = await requireAdminAction(user, "roles.update", { stepUp: true, message: "Only the administrator edits roles." });
  if (refused) return refused;
  const { id } = await params;
  try {
    const r = await updateRole(auditContext(request, user.id), id, await body(request) as never);
    return NextResponse.json({ id: r.role.id, version: r.role.version, members: r.members });
  } catch (e) {
    return usersErrorResponse(e);
  }
}
