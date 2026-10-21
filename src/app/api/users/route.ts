import { NextResponse } from "@/lib/api-response";
import { requireAuth, requireModule, requireAdminAction } from "@/lib/auth-server";
import { createUser, directory, usersCaps } from "@/lib/users/server";
import { body, noStore, usersErrorResponse } from "@/lib/users/http";

// GET — the user directory (Figma UR-01): any holder of the «إدارة المستخدمين» module, view or edit
// (UR-S06 «عرض فقط»). No credential, hash or session id is ever returned.
export async function GET() {
  const { user, error } = await requireModule("employees");
  if (error) return error;
  try {
    return NextResponse.json({ users: await directory(), caps: usersCaps(user) }, noStore);
  } catch (e) {
    return usersErrorResponse(e);
  }
}

// POST — a new account (UR-03): the administrator role only, after a recent step-up (UR-03d «كلمة
// مرورك»). Starts at «بلا وصول» unless a role is chosen (P-1); a temporary password is generated and
// returned ONCE (UR-03e); the station PIN is set later by the person themselves.
export async function POST(request: Request) {
  const { user, error } = await requireAuth();
  if (error) return error;
  const refused = await requireAdminAction(user, "users.create", { stepUp: true, message: "Only the administrator creates users." });
  if (refused) return refused;
  try {
    return NextResponse.json(await createUser(request, user, await body(request)), { status: 201, ...noStore });
  } catch (e) {
    return usersErrorResponse(e);
  }
}
