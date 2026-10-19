import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-server";
import { mySecurity } from "@/lib/auth/my-security";

// GET — the signed-in user's OWN account security («ملفي الشخصي»): account facts, the previous
// sign-in, live sessions, devices (sessions grouped by browser) and recent sign-in activity.
// Scoped to the caller by the session; no parameter names another account. ?activity=N (1–100).
export async function GET(request: Request) {
  const { user, error } = await requireAuth();
  if (error) return error;
  const n = Number(new URL(request.url).searchParams.get("activity") ?? "8");
  const data = await mySecurity({ id: user.id, sessionId: user.sessionId }, { activityLimit: Number.isFinite(n) ? n : 8 });
  return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
}
