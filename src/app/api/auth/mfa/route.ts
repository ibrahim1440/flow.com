import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-server";
import { mfaStatus } from "@/lib/auth/mfa";

/** The caller's own two-step verification status. */
export async function GET() {
  const { user, error } = await requireAuth({ allowMfaEnrollment: true });
  if (error) return error;
  return NextResponse.json({ ...(await mfaStatus(user.id)), privileged: user.privileged, enrollmentRequired: user.mfaEnrollmentRequired });
}
