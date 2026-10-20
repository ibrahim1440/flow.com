import { NextResponse } from "next/server";
import { prisma, TX_OPTS } from "@/lib/db";
import { privilegedGate, requireSub } from "@/lib/auth-server";
import { hasSubPrivilege } from "@/lib/auth-shared";
import { isValidTransition } from "@/lib/batch-transitions";
import { handleDomainError } from "@/lib/api-error";
import { readQcSettings } from "@/lib/services/settings/sections";
import { autoPrepareAfterBatches } from "@/lib/services/orders/preparation";
import { applyQcDecision, qcDecisionCheck, type QcDecisionInput } from "@/lib/services/qc-finalize";

type Params = { params: Promise<{ batchId: string }> };

/**
 * POST /api/qc/[batchId]/finalize — the QC manager's decision on one batch.
 *
 * Body: { outcome: "Passed" | "Rejected", finalDecisionReason?, override?, overrideReason?, confirmed? }
 * The rules (minimum evaluators D1, exceptional approval D2, disagreement reason D3 / G26, loss on
 * reject G05) live in src/lib/services/qc-finalize.ts. The exceptional approval is
 * qc › finalize_override, a privileged permission with a step-up (owner decision D2): checked here,
 * and only when the decision actually needs it.
 */
export async function POST(request: Request, { params }: Params) {
  const { user, error } = await requireSub("qc", "manage");
  if (error) return error;

  const { batchId } = await params;
  let body: Record<string, unknown>;
  try { body = (await request.json()) as Record<string, unknown>; } catch { body = {}; }
  const outcome = body.outcome;
  if (outcome !== "Passed" && outcome !== "Rejected") {
    return NextResponse.json({ error: "outcome must be 'Passed' or 'Rejected'" }, { status: 400 });
  }
  const input: QcDecisionInput = {
    outcome,
    finalDecisionReason: typeof body.finalDecisionReason === "string" ? body.finalDecisionReason : null,
    override: body.override === true,
    overrideReason: typeof body.overrideReason === "string" ? body.overrideReason : null,
    confirmed: body.confirmed === true,
  };

  try {
    const batch = await prisma.roastingBatch.findUnique({
      where: { id: batchId },
      select: { id: true, status: true, batchNumber: true, orderItemId: true, productionOrderId: true, qcRecords: { select: { decision: true } } },
    });
    if (!batch) return NextResponse.json({ error: "Batch not found" }, { status: 404 });

    if (!isValidTransition(batch.status, outcome)) {
      return NextResponse.json({ error: `Cannot transition batch from "${batch.status}" to "${outcome}".` }, { status: 409 });
    }

    const { effectiveMinEvaluators: min } = await readQcSettings(prisma);
    const canOverride = hasSubPrivilege(user.permissions, "qc", "finalize_override");
    const check = qcDecisionCheck({ input, records: batch.qcRecords, min, canOverride });
    if (!check.ok) {
      return NextResponse.json({ error: check.error, errorEn: check.errorEn, code: check.code, min: check.min, count: check.count }, { status: check.status });
    }
    // D2: the exceptional approval is a privileged act — a verified individual (outside SIMPLE MODE)
    // after a recent step-up (qc.finalize_override is in STEP_UP_KEYS).
    if (check.overrideApplied) {
      const refused = await privilegedGate(user, "qc", "finalize_override");
      if (refused) return refused;
    }

    const applied = await prisma.$transaction(async (tx) => {
      const r = await applyQcDecision(tx, { batch, outcome, check, min, actor: user });
      if (!r.decided) {
        throw { _appCode: 409, message: "This batch was finalized by someone else while you were deciding. Please reload and check the outcome." };
      }
      return r;
    }, TX_OPTS);
    // Phase B item 4: the order this batch was roasted for is recomputed after the decision
    // (a rejection sends its demand back to the roast queue).
    await autoPrepareAfterBatches([batch.id], "qc_decision", { id: user.id, name: user.name });

    const acceptCount = batch.qcRecords.filter((r) => r.decision === "Accept").length;
    const rejectCount = batch.qcRecords.length - acceptCount;
    return NextResponse.json({
      status: outcome, total: batch.qcRecords.length, acceptCount, rejectCount,
      min, override: check.overrideApplied, lossKg: applied.lossKg,
    });
  } catch (err: unknown) {
    return handleDomainError(err);
  }
}
