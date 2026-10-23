import { NextResponse } from "@/lib/api-response";
import { handleDomainError } from "@/lib/api-error";
import { requireSub } from "@/lib/auth-server";
import { readRoastRequestKey } from "@/lib/services/roast-idempotency";
import { requestDisposition } from "@/lib/services/qc/dispositions";

/**
 * POST /api/qc/dispositions {batchId, kind: CONVERT | BLEND | DESTROY, reason, …} + Idempotency-Key —
 * QC asks for the disposition of a held batch (qc › manage). CONVERT: targetProductId (its approved
 * spec must be met — checked now and again at approval); BLEND: heldQuantityKg + partners
 * [{batchId, quantityKg}] (released batches only) — the recipe; DESTROY: quantityKg. Never CONVERT or
 * BLEND for foreign objects. Decided by another person (qc › dispose).
 */
export async function POST(request: Request) {
  const { user, error } = await requireSub("qc", "manage");
  if (error) return error;
  const k = readRoastRequestKey(request);
  if (!k.ok) return NextResponse.json({ error: k.message, errorEn: k.en }, { status: 400 });
  if (!k.key) return NextResponse.json({ error: "مفتاح التكرار مطلوب.", errorEn: "An Idempotency-Key is required.", code: "IDEMPOTENCY_KEY_REQUIRED" }, { status: 400 });
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    const out = await requestDisposition({ id: user.id, name: user.name }, k.key, body);
    return NextResponse.json(out, { status: out.replayed ? 200 : 201 });
  } catch (err) {
    return handleDomainError(err);
  }
}
