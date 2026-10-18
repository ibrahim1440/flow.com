import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-server";
import { withdrawMfaReset } from "@/lib/hr/services/mfa-reset";
import { errorResponse } from "../../../permission-requests/_shared";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireAuth();
  if (error) return error;
  const { id } = await params;
  try {
    return NextResponse.json(await withdrawMfaReset(user, id));
  } catch (e) {
    return errorResponse(e);
  }
}
