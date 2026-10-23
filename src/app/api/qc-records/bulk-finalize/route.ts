import { specBlocksPanelPass } from "@/lib/services/qc/inspection";
import { NextResponse } from "@/lib/api-response";
import { prisma, TX_OPTS } from "@/lib/db";
import { privilegedGate, requireSub } from "@/lib/auth-server";
import { hasSubPrivilege } from "@/lib/auth-shared";
import { isValidTransition } from "@/lib/batch-transitions";
import { handleDomainError } from "@/lib/api-error";
import { readQcSettings } from "@/lib/services/settings/sections";
import { autoPrepareAfterBatches } from "@/lib/services/orders/preparation";
import { applyQcDecision, qcDecisionCheck, type QcDecisionInput } from "@/lib/services/qc-finalize";

/**
 * POST /api/qc-records/bulk-finalize — one decision for several batches.
 *
 * Body: { batchIds, outcome, finalDecisionReason?, override?, overrideReason?, confirmed? }
 * Every batch is judged by the SAME rules as the single decision (src/lib/services/qc-finalize.ts:
 * minimum evaluators, exceptional approval, disagreement reason in both directions, loss on
 * reject). All or nothing at validation: one batch the rules refuse refuses the request, naming
 * each refused batch and why, and nothing is decided. A batch somebody else decided between the
 * check and the commit is not overwritten: it is reported in `skipped` (gap G26: the response no
 * longer claims a decision it did not make).
 */
export async function POST(request: Request) {
  const { user, error } = await requireSub("qc", "manage");
  if (error) return error;

  let body: Record<string, unknown>;
  try { body = (await request.json()) as Record<string, unknown>; } catch { body = {}; }
  const batchIds = body.batchIds;
  const outcome = body.outcome;
  if (!Array.isArray(batchIds) || batchIds.length === 0 || !batchIds.every((x) => typeof x === "string"))
    return NextResponse.json({ error: "batchIds must be a non-empty array" }, { status: 400 });
  if (batchIds.length > 100) return NextResponse.json({ error: "At most 100 batches per decision." }, { status: 400 });
  if (outcome !== "Passed" && outcome !== "Rejected")
    return NextResponse.json({ error: "outcome must be Passed or Rejected" }, { status: 400 });
  const input: QcDecisionInput = {
    outcome,
    finalDecisionReason: typeof body.finalDecisionReason === "string" ? body.finalDecisionReason : null,
    override: body.override === true,
    overrideReason: typeof body.overrideReason === "string" ? body.overrideReason : null,
    confirmed: body.confirmed === true,
  };
  const ids = [...new Set(batchIds as string[])];

  try {
    const batches = await prisma.roastingBatch.findMany({
      where: { id: { in: ids } },
      select: { id: true, status: true, batchNumber: true, orderItemId: true, productionOrderId: true, qcRecords: { select: { decision: true } } },
      orderBy: { id: "asc" },
    });

    if (batches.length !== ids.length) {
      const found = new Set(batches.map((b) => b.id));
      return NextResponse.json({ error: "Some batches not found", missing: ids.filter((id) => !found.has(id)) }, { status: 404 });
    }

    const invalid = batches.filter((b) => !isValidTransition(b.status, outcome));
    if (invalid.length > 0) {
      return NextResponse.json({ error: "Some batches cannot transition to the chosen outcome", invalid: invalid.map((b) => b.id) }, { status: 409 });
    }


    // QC W3: a batch roasted to an APPROVED profile version passes only through a conforming
    // inspection («فحص بالقياس»); the panel cannot pass around the approved spec.
    if (outcome === "Passed") {
      for (const id of ids) {
        const n = await specBlocksPanelPass(prisma, id);
        if (n) return NextResponse.json({ error: `للدفعة ${n} مواصفة معتمدة: القبول يمر عبر فحص بالقياس مطابق في محطة الجودة.`, errorEn: `Batch ${n} has an approved spec: it passes only through a conforming inspection.`, code: "SPEC_INSPECTION_REQUIRED" }, { status: 409 });
      }
    }
    const { effectiveMinEvaluators: min } = await readQcSettings(prisma);
    const canOverride = hasSubPrivilege(user.permissions, "qc", "finalize_override");
    const checks = batches.map((b) => ({ b, check: qcDecisionCheck({ input, records: b.qcRecords, min, canOverride }) }));
    const refused = checks.filter((c) => !c.check.ok);
    if (refused.length > 0) {
      const first = refused[0].check as Exclude<(typeof refused)[number]["check"], { ok: true }>;
      return NextResponse.json({
        error: first.error, errorEn: first.errorEn, code: first.code, min,
        // Every refused batch, so the screen can say which ones and why; nothing was decided.
        refused: refused.map((c) => {
          const r = c.check as typeof first;
          return { batchId: c.b.id, batchNumber: c.b.batchNumber, code: r.code, error: r.error };
        }),
      }, { status: first.status });
    }

    if (checks.some((c) => c.check.ok && c.check.overrideApplied)) {
      const gate = await privilegedGate(user, "qc", "finalize_override");
      if (gate) return gate;
    }

    const result = await prisma.$transaction(async (tx) => {
      const decided: string[] = [];
      const skipped: string[] = [];
      let lossKg = 0;
      for (const { b, check } of checks) {
        if (!check.ok) continue;
        const r = await applyQcDecision(tx, { batch: b, outcome, check, min, actor: user });
        if (r.decided) { decided.push(b.id); lossKg += r.lossKg; } else skipped.push(b.id);
      }
      return { decided, skipped, lossKg: +lossKg.toFixed(3) };
    }, TX_OPTS);
    await autoPrepareAfterBatches(result.decided, "qc_decision", { id: user.id, name: user.name });

    // The real number, not the number asked for.
    return NextResponse.json({
      finalized: result.decided.length, requested: ids.length, outcome,
      decided: result.decided, skipped: result.skipped, lossKg: result.lossKg, min,
      overrides: checks.filter((c) => c.check.ok && c.check.overrideApplied).length,
    });
  } catch (err) {
    return handleDomainError(err);
  }
}
