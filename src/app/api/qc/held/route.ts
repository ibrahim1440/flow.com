import { NextResponse } from "@/lib/api-response";
import { handleDomainError } from "@/lib/api-error";
import { requireAuth, forbidden } from "@/lib/auth-server";
import { hasModuleAccess, hasSubPrivilege } from "@/lib/auth-shared";
import { qcStationQueue } from "@/lib/services/qc/inspection";
import { listHeld } from "@/lib/services/qc/dispositions";

/** GET /api/qc/held — «المحجوزة» in the ERP: held batches, every disposition, and what the caller may do. */
export async function GET() {
  const { user, error } = await requireAuth();
  if (error) return error;
  if (!hasModuleAccess(user.permissions, "qc")) return forbidden();
  try {
    const q = await qcStationQueue();
    const p = user.permissions;
    return NextResponse.json({
      held: q.held, dispositions: await listHeld(), me: user.id,
      can: { request: hasSubPrivilege(p, "qc", "manage"), decide: hasSubPrivilege(p, "qc", "dispose"), inspect: hasSubPrivilege(p, "qc", "create_record"), blend: hasModuleAccess(p, "production") && hasSubPrivilege(p, "production", "blend") },
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return handleDomainError(err);
  }
}
