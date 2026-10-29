import { NextResponse } from "@/lib/api-response";
import { forbidden, privilegedGate, requireSub } from "@/lib/auth-server";
import { hasSubPrivilege } from "@/lib/auth-shared";
import { handleDomainError } from "@/lib/api-error";
import { auditFromRequest } from "@/lib/accounting/audit";
import { deleteLocation, updateLocation } from "@/lib/services/stock-locations";

type Params = { params: Promise<{ id: string }> };

/**
 * PATCH { nameAr?, nameEn?, code?, type?, address?, notes? } — edit; or { action: "default" } (the default receiving
 * site), { action: "deactivate", reason } (refused while it holds stock — «انقل الرصيد أولًا» — and for the default),
 * { action: "reactivate" }, { action: "branch", finBranchId: id | null | "new" } («الموقع»: accounting › settings_manage too). DELETE — only a location that was never used. inventory › adjust; audited.
 */
export async function PATCH(request: Request, { params }: Params) {
  const { user, error } = await requireSub("inventory", "adjust");
  if (error) return error;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  // «الموقع» (WP-B): mapping a site to a branch moves what its documents post to — accounting › settings_manage too.
  if (body.action === "branch") {
    if (!hasSubPrivilege(user.permissions, "accounting", "settings_manage")) return forbidden();
    const refused = await privilegedGate(user, "accounting", "settings_manage");
    if (refused) return refused;
  }
  try {
    const reason = typeof body.reason === "string" ? body.reason : null;
    return NextResponse.json(await updateLocation((await params).id, body, { id: user.id, name: user.name }, auditFromRequest(request, user.id, reason)));
  } catch (err) {
    return handleDomainError(err);
  }
}

export async function DELETE(request: Request, { params }: Params) {
  const { user, error } = await requireSub("inventory", "adjust");
  if (error) return error;
  try {
    return NextResponse.json(await deleteLocation((await params).id, { id: user.id, name: user.name }, auditFromRequest(request, user.id)));
  } catch (err) {
    return handleDomainError(err);
  }
}
