import { NextResponse } from "next/server";
import { requireModule } from "@/lib/auth-server";
import { isUsersAdmin, linkablePeople } from "@/lib/users/server";
import { ADMIN_READ_ONLY, noStore, usersErrorResponse } from "@/lib/users/http";

// GET — HR people with no login yet (Figma UR-03a «ملف الموظف»): name, number, title, department —
// no pay, identity or bank data. The administrator role only (it creates accounts).
export async function GET() {
  const { user, error } = await requireModule("employees");
  if (error) return error;
  if (!isUsersAdmin(user)) return ADMIN_READ_ONLY();
  try {
    return NextResponse.json({ people: await linkablePeople() }, noStore);
  } catch (e) {
    return usersErrorResponse(e);
  }
}
