import { NextResponse } from "@/lib/api-response";
import { requireModule } from "@/lib/auth-server";
import { profile } from "@/lib/users/server";
import { noStore, usersErrorResponse } from "@/lib/users/http";

// GET — one account (Figma UR-02 and its tabs: effective permissions with their source, exceptions,
// recent changes): any holder of the «إدارة المستخدمين» module. Settles expired exceptions first.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireModule("employees");
  if (error) return error;
  const { id } = await params;
  try {
    const p = await profile(id, user);
    if (!p) return NextResponse.json({ error: "المستخدم غير موجود.", errorEn: "User not found." }, { status: 404 });
    return NextResponse.json(p, noStore);
  } catch (e) {
    return usersErrorResponse(e);
  }
}
