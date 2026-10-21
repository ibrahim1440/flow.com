import { NextResponse } from "@/lib/api-response";
import { prisma, TX_OPTS } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";
import {
  isPreparationDecision,
  NOTE_MESSAGE_MAX_LENGTH,
  type PreparationDecision,
} from "@/lib/services/order-operations";
import { reviewOrderPreparation, autoPrepareOrder } from "@/lib/services/orders/preparation";

type Params = { params: Promise<{ id: string }> };

type RawItem = {
  orderItemId?: unknown;
  decision?: unknown;
  availableQuantity?: unknown;
  productionRequiredQuantity?: unknown;
};

type ParsedItem = {
  orderItemId: string;
  // null = "you work it out from stock". Non-null = a claim the server must be able to back.
  decision: PreparationDecision | null;
  availableQuantity: number | null;
  productionRequiredQuantity: number | null;
};

export async function POST(request: Request, { params }: Params) {
  const { user, error } = await requireSub("orders", "prepare_review");
  if (error) return error;

  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { items, note } = (body ?? {}) as { items?: unknown; note?: unknown };

  if (!Array.isArray(items) || items.length === 0) {
    return NextResponse.json({ error: "items must be a non-empty array." }, { status: 400 });
  }

  const trimmedNote = typeof note === "string" ? note.trim() : "";
  if (trimmedNote.length > NOTE_MESSAGE_MAX_LENGTH) {
    return NextResponse.json(
      { error: `note must be at most ${NOTE_MESSAGE_MAX_LENGTH} characters.` },
      { status: 400 }
    );
  }

  // Structural + value validation of every submitted item before any DB access.
  const seenIds = new Set<string>();
  const parsedItems: ParsedItem[] = [];

  for (const raw of items as RawItem[]) {
    if (typeof raw.orderItemId !== "string" || !raw.orderItemId) {
      return NextResponse.json({ error: "Each item requires a valid orderItemId." }, { status: 400 });
    }
    if (seenIds.has(raw.orderItemId)) {
      return NextResponse.json(
        { error: `Duplicate orderItemId in request: ${raw.orderItemId}` },
        { status: 400 }
      );
    }
    seenIds.add(raw.orderItemId);

    // The decision is now OPTIONAL. Omit it and the server derives it from real stock;
    // send it and it is treated as a claim that must match what the shelf can back.
    const decisionValue = raw.decision === undefined || raw.decision === null || raw.decision === ""
      ? null
      : raw.decision;
    if (decisionValue !== null && !isPreparationDecision(decisionValue)) {
      return NextResponse.json(
        {
          error: `Invalid decision for item ${raw.orderItemId}. Must be one of: Available on Shelf, Needs Production, Partially Available, Blocked.`,
        },
        { status: 400 }
      );
    }

    let availableQuantity: number | null = null;
    if (raw.availableQuantity !== undefined && raw.availableQuantity !== null && raw.availableQuantity !== "") {
      const n = Number(raw.availableQuantity);
      if (!Number.isFinite(n)) {
        return NextResponse.json(
          { error: `availableQuantity for item ${raw.orderItemId} must be a number.` },
          { status: 400 }
        );
      }
      availableQuantity = n;
    }

    let productionRequiredQuantity: number | null = null;
    if (
      raw.productionRequiredQuantity !== undefined &&
      raw.productionRequiredQuantity !== null &&
      raw.productionRequiredQuantity !== ""
    ) {
      const n = Number(raw.productionRequiredQuantity);
      if (!Number.isFinite(n)) {
        return NextResponse.json(
          { error: `productionRequiredQuantity for item ${raw.orderItemId} must be a number.` },
          { status: 400 }
        );
      }
      productionRequiredQuantity = n;
    }

    parsedItems.push({
      orderItemId: raw.orderItemId,
      decision: decisionValue,
      availableQuantity,
      productionRequiredQuantity,
    });
  }

  if (parsedItems.some((i) => i.decision === "Blocked") && !trimmedNote) {
    return NextResponse.json(
      { error: "note is required when any item is marked Blocked." },
      { status: 400 }
    );
  }

  try {
    // The arithmetic lives in services/orders/preparation (Phase B item 4), shared with the
    // automatic recompute that now runs after every stock event. This route is the manual
    // mode: unchanged behaviour, and the only place a line can be marked Blocked.
    const outcome = await prisma.$transaction(
      (tx) => reviewOrderPreparation(tx, {
        orderId: id,
        mode: "manual",
        actor: { id: user.id, name: user.name },
        items: parsedItems,
        note: trimmedNote,
      }),
      TX_OPTS,
    );
    const result = outcome.order;

    // After commit, like every automatic step: production orders for any shortfall and the
    // settling of plans that are no longer needed (Phase C item 3). The recompute itself is a
    // no-op right after a review.
    await autoPrepareOrder(id, "review", { id: user.id, name: user.name });

    return NextResponse.json(result);
  } catch (err: unknown) {
    if (err && typeof err === "object" && "_appCode" in err) {
      const e = err as { _appCode: number; message: string; computed?: unknown };
      // On a rejected claim the server hands back what it actually computed, so the
      // review screen can correct itself without a second round trip.
      return NextResponse.json(
        e.computed === undefined ? { error: e.message } : { error: e.message, computed: e.computed },
        { status: e._appCode }
      );
    }
    return handlePrismaError(err);
  }
}
