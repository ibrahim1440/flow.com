import { NextResponse } from "next/server";
import { prisma, TX_OPTS } from "@/lib/db";
import { requireModule } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { hasSubPrivilege } from "@/lib/auth-shared";
import {
  approveCollection, rejectCollection, reverseCollection, collectionSummary,
} from "@/lib/services/sales/collections";
import { serialiseSummary } from "../../route";

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/sales/collections/[id]/actions — the finance decision.
 *
 * ── Why one endpoint ──
 * Approve, reject and reverse are three answers to the same question and share every
 * precondition: the row is locked, the caller is not the submitter, and the current status
 * decides what is still possible. Three endpoints would be three copies of that, and the
 * copies would drift.
 *
 * ── Why the privilege is checked per action ──
 * They are separate abilities. Reversal in particular undoes a figure somebody has already
 * been told they earned, and a deployment can reasonably grant verification without it.
 */
const ACTIONS = ["approve", "reject", "reverse"] as const;
type Action = (typeof ACTIONS)[number];

const PRIVILEGE: Record<Action, string> = {
  approve: "collection_verify",
  reject: "collection_reject",
  reverse: "collection_reverse",
};

export async function POST(request: Request, { params }: Params) {
  // Module access only at the door; the ability is checked against the action below, so a
  // caller who holds one of the three does not get the other two for free.
  const { user, error } = await requireModule("commissions");
  if (error) return error;

  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;

  const action = typeof b.action === "string" && (ACTIONS as readonly string[]).includes(b.action)
    ? (b.action as Action)
    : null;
  if (!action) {
    return NextResponse.json({ error: "action must be one of: " + ACTIONS.join(", ") }, { status: 400 });
  }

  if (!hasSubPrivilege(user.permissions, "commissions", PRIVILEGE[action])) {
    return NextResponse.json(
      { error: `This needs the commissions/${PRIVILEGE[action]} permission.` },
      { status: 403 },
    );
  }

  const reason = typeof b.reason === "string" ? b.reason : "";

  try {
    // Existence is checked inside the transaction, behind the row lock, so two callers
    // racing the same collection resolve against one another rather than against a read
    // each of them took before the other started.
    const result = await prisma.$transaction(async (tx) => {
      if (action === "approve") return approveCollection(tx, { collectionId: id, actorId: user.id });
      if (action === "reject") return rejectCollection(tx, { collectionId: id, actorId: user.id, reason });
      return reverseCollection(tx, { collectionId: id, actorId: user.id, reason });
    }, TX_OPTS);

    // The deal's figures after the decision, so the screen does not have to refetch and
    // cannot briefly show the previous total.
    const collection = await prisma.salesCollection.findUnique({
      where: { id },
      select: { opportunityId: true },
    });
    const summary = collection
      ? serialiseSummary(await collectionSummary(prisma, collection.opportunityId))
      : null;

    return NextResponse.json({ ...result, summary });
  } catch (err) {
    return handleDomainError(err);
  }
}
