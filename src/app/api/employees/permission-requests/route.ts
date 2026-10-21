import { NextResponse } from "@/lib/api-response";
import { requireAuth } from "@/lib/auth-server";
import { listPermissionChanges } from "@/lib/hr/services/permission-change";
import { errorResponse } from "./_shared";

export async function GET(request: Request) {
  const { user, error } = await requireAuth();
  if (error) return error;
  try {
    return NextResponse.json(await listPermissionChanges(user, new URL(request.url).searchParams.get("status") === "pending"));
  } catch (e) {
    return errorResponse(e);
  }
}
