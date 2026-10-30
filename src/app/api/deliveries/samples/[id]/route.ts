import { NextResponse } from "@/lib/api-response";
import { requireSub } from "@/lib/auth-server";
import { hasSubPrivilege, type Permissions } from "@/lib/auth-shared";
import { handleDomainError } from "@/lib/api-error";
import { issueSample, prepareSample } from "@/lib/services/sales/sample-issue";

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/deliveries/samples/[id] — the dispatch department acts on a requested stock sample.
 *
 *   { "action": "prepare" } — REQUESTED → PREPARING («بدأ التجهيز»). Moves no stock.
 *   { "action": "issue" }   — deduct the sample's units from finished goods and mark it SENT
 *                             (services/sales/sample-issue.ts — locks, free units only, QC holds, one movement per lot).
 *
 * Gate: dispatch › mark_delivered — the existing permission for «stock leaves the building», held by exactly the
 * people who already hand coffee over; no new key, so no permission backfill. Authorization comes first, before the
 * body is read.
 *
 * Idempotent by the sample itself: one sample is issued at most once, so the sample id is the idempotency key. A
 * retry after a lost answer, a double click, or the loser of two concurrent requests gets the ORIGINAL issue back
 * with 200 and `replayed: true`; a fresh issue answers 201. Nothing is ever deducted twice.
 *
 * The answer carries the lots used (batch, units) for the dispatcher; the cost only to holders of inventory ›
 * valuation (the existing «see the cost of stock» right) — never to a sales-only caller, who cannot reach this
 * route at all.
 */
export async function POST(request: Request, { params }: Params) {
  const { user, error } = await requireSub("dispatch", "mark_delivered");
  if (error) return error;
  const { id } = await params;

  let b: Record<string, unknown> = {};
  try { b = ((await request.json()) ?? {}) as Record<string, unknown>; } catch { b = {}; }
  const action = b.action;

  try {
    if (action === "prepare") {
      const r = await prepareSample(id);
      return NextResponse.json({ sample: { id: r.id, status: r.status }, replayed: r.replayed }, { status: 200 });
    }
    if (action === "issue") {
      const r = await issueSample(id, user.id);
      const seesCost = hasSubPrivilege(user.permissions as Permissions, "inventory", "valuation");
      return NextResponse.json(
        { sample: r.sample, replayed: r.replayed, ...(seesCost ? { costValue: r.costValue } : {}) },
        { status: r.replayed ? 200 : 201 },
      );
    }
    return NextResponse.json(
      { error: "الإجراء غير معروف: prepare أو issue.", errorEn: "Unknown action: prepare or issue." },
      { status: 400 },
    );
  } catch (err) {
    return handleDomainError(err);
  }
}
