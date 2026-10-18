import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-server";
import { withdrawPermissionChange } from "@/lib/hr/services/permission-change";
import { errorResponse } from "../../_shared";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireAuth();
  if (error) return error;
  const { id } = await params;
  try {
    return NextResponse.json(await withdrawPermissionChange(user, id));
  } catch (e) {
    return errorResponse(e);
  }
}
