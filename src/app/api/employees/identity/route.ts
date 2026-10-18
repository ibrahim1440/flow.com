import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-server";
import { identityRegister } from "@/lib/hr/services/identity-verification";
import { errorResponse } from "../permission-requests/_shared";

/** Option A: the identity register (external persons, each login's person and verification, identity requests). Account editors. */
export async function GET() {
  const { user, error } = await requireAuth();
  if (error) return error;
  try {
    return NextResponse.json(await identityRegister(user));
  } catch (e) {
    return errorResponse(e);
  }
}
