import { NextResponse } from "next/server";
import { getUserWithPermissions } from "@/lib/auth-server";

export async function GET() {
  const user = await getUserWithPermissions();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  return NextResponse.json({ user });
}

export async function DELETE() {
  const response = NextResponse.json({ success: true });
  response.cookies.set("token", "", { maxAge: 0, path: "/" });
  return response;
}
