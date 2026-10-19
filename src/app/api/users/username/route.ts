import { NextResponse } from "next/server";
import { requireModule } from "@/lib/auth-server";
import { isUsersAdmin, usernameAvailable } from "@/lib/users/server";
import { ADMIN_READ_ONLY, noStore } from "@/lib/users/http";

// GET ?u= — is a username free (Figma UR-03a «متاح», UR-S13 «مستخدَم لحساب آخر. جرّب …»)? The
// administrator role only. Answers available / valid and a suggestion; nothing about the holder.
export async function GET(request: Request) {
  const { user, error } = await requireModule("employees");
  if (error) return error;
  if (!isUsersAdmin(user)) return ADMIN_READ_ONLY();
  return NextResponse.json(await usernameAvailable(new URL(request.url).searchParams.get("u")), noStore);
}
