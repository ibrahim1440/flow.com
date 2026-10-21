import { NextResponse } from "@/lib/api-response";
import { requireModule } from "@/lib/auth-server";
import { isUsersAdmin } from "@/lib/users/server";
import { parseFilters, queryAudit } from "@/lib/users/audit";
import { ADMIN_READ_ONLY, noStore, usersErrorResponse } from "@/lib/users/http";

// GET — «سجل الصلاحيات» (Figma UR-12): ?q=&cat=all|permissions|accounts|signin&days=7|30|90|365|all
// &source=all|web|station|system&before=<cursor>. The administrator role only (it names who signed
// in, from where, and every permission decision). Read-only.
export async function GET(request: Request) {
  const { user, error } = await requireModule("employees");
  if (error) return error;
  if (!isUsersAdmin(user)) return ADMIN_READ_ONLY();
  try {
    return NextResponse.json(await queryAudit(parseFilters(new URL(request.url).searchParams)), noStore);
  } catch (e) {
    return usersErrorResponse(e);
  }
}
