import { NextResponse } from "@/lib/api-response";
import { handleDomainError } from "@/lib/api-error";
import { requireAuth, forbidden } from "@/lib/auth-server";
import { hasModuleAccess, hasSubPrivilege } from "@/lib/auth-shared";
import { exceptionView, sodBlock } from "@/lib/services/qc/exceptions";

/** GET /api/qc/exceptions/[id] — QX-02 / QX-06: the request, the measurements against the spec, the people, and whether YOU may decide it. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireAuth();
  if (error) return error;
  if (!hasModuleAccess(user.permissions, "qc")) return forbidden();
  const { id } = await params;
  try {
    const e = await exceptionView(id);
    if (!e) return NextResponse.json({ error: "الطلب غير موجود.", errorEn: "Request not found." }, { status: 404 });
    const holds = hasSubPrivilege(user.permissions, "qc", "approve_exception");
    return NextResponse.json({ ...e, can: { decide: holds && e.status === "PENDING" && !sodBlock(user.id, e), holds, sod: sodBlock(user.id, e) } }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return handleDomainError(err);
  }
}
