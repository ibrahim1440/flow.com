import { NextResponse } from "@/lib/api-response";
import { prisma, TX_OPTS } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { parseVersionBody, updateUnusedVersion } from "@/lib/services/commissions/plans";

type Params = { params: Promise<{ id: string; versionId: string }> };

/**
 * PATCH /api/commissions/plans/[id]/versions/[versionId] — edit a COMPONENTS version in place,
 * ONLY while nothing hangs off it (no assignment, accrual, ledger movement, monthly result or
 * decision): a template plan just created, being adjusted before anyone is put on it. Once it
 * governs anybody, a change is a new version with an effective date (POST …/versions), so a past
 * month keeps the version it was computed with. Tiered versions are never edited in place.
 */
export async function PATCH(request: Request, { params }: Params) {
  const { user, error } = await requireSub("commissions", "manage_plans");
  if (error) return error;
  const { id, versionId } = await params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  try {
    const version = parseVersionBody((body ?? {}) as Record<string, unknown>);
    const updated = await prisma.$transaction(
      (tx) => updateUnusedVersion(tx, { planId: id, planVersionId: versionId, version, actorId: user.id }),
      TX_OPTS,
    );
    return NextResponse.json(updated);
  } catch (err) {
    return handleDomainError(err);
  }
}
