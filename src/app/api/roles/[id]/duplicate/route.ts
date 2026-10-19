import { NextResponse } from "next/server";
import { requireAuth, requireAdminAction } from "@/lib/auth-server";
import { createRole, freeCopyName, getRole } from "@/lib/users/roles";
import { auditContext } from "@/lib/users/account-update";
import { usersErrorResponse } from "@/lib/users/http";

// POST — «نسخ الدور» (Figma UR-06, UR-S14): a new custom role «نسخة من …» with the template's matrix,
// its sensitive permissions left out (P-3). The administrator role only, after a recent step-up.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireAuth();
  if (error) return error;
  const refused = await requireAdminAction(user, "roles.duplicate", { stepUp: true, message: "Only the administrator copies roles." });
  if (refused) return refused;
  const { id } = await params;
  try {
    const src = await getRole(id);
    if (!src) return NextResponse.json({ error: "الدور غير موجود.", errorEn: "Role not found." }, { status: 404 });
    const r = await createRole(auditContext(request, user.id), { name: await freeCopyName(src.name), description: src.description, basedOn: id });
    return NextResponse.json({ id: r.id, name: r.name }, { status: 201 });
  } catch (e) {
    return usersErrorResponse(e);
  }
}
