import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-server";
import { mfaReport } from "@/lib/hr/services/mfa-reset";
import { errorResponse } from "../permission-requests/_shared";

/** Privileged accounts and their sign-in readiness (username, two-step verification). Account editors. */
export async function GET() {
  const { user, error } = await requireAuth();
  if (error) return error;
  try {
    return NextResponse.json(await mfaReport(user));
  } catch (e) {
    return errorResponse(e);
  }
}
