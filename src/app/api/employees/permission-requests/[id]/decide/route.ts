import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-server";
import { decidePermissionChange } from "@/lib/hr/services/permission-change";
import { auditContext, errorResponse } from "../../_shared";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireAuth();
  if (error) return error;
  const { id } = await params;
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    return NextResponse.json(await decidePermissionChange(user, id, body, auditContext(request, user.id)));
  } catch (e) {
    return errorResponse(e);
  }
}
