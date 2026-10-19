import { requireAuth } from "@/lib/auth-server";
import { requireAccessManager } from "@/lib/users/gate";
import { changeAccess } from "@/lib/users/server";
import { body, usersErrorResponse } from "@/lib/users/http";
import { UsersError } from "@/lib/users/errors";

// POST — add one exception (Figma UR-09 «إضافة استثناء», UR-10 390 sheet): a cell, its value, the
// reason, and an expiry — or, for a permanent sensitive grant, a review date (O-2; SIMPLE MODE only).
// The administrator role or a power user (owner decision 19 Oct; guardrails in src/lib/users/power.ts),
// after a recent step-up, never on one's own account.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireAuth();
  if (error) return error;
  const refused = await requireAccessManager(user, "users.override", "Only the administrator or a power user adds exceptions.");
  if (refused) return refused;
  const { id } = await params;
  try {
    const b = await body(request);
    if (typeof b.cell !== "string" || typeof b.value !== "string") throw new UsersError(400, "INVALID_CELL", "اختر الصلاحية وقيمتها.", "Choose the permission and its value.");
    return await changeAccess(request, user, id, { cells: { [b.cell]: b.value }, reason: b.reason, expiresAt: b.expiresAt, permanent: b.permanent === true, reviewAt: b.reviewAt });
  } catch (e) {
    return usersErrorResponse(e);
  }
}
