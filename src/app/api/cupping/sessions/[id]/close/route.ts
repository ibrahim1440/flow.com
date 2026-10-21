import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireAdminAction, requireEdit } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";
import {
  CLOSE_REASON_MAX, CuppingRefusal, cleanReason, getCuppingSettings, hasVisibleText, scorerCounts, type CloseKind,
} from "@/lib/cupping/close-policy";

type Params = { params: Promise<{ id: string }> };

/**
 * Close a cupping session (E6 close policy, owner decisions C-1…C-5).
 *
 * Body (optional; an empty body is a normal close):
 *   { kind?: "COMPLETE" | "INCOMPLETE", reason?: string }
 *
 * COMPLETE needs at least the configured minimum of distinct authenticated staff scorers;
 * below it the answer is 409 CUPPING_MIN_SCORERS_NOT_MET and the session stays open.
 * INCOMPLETE is only for a session below the minimum, and needs a written reason.
 * Either way the closure (who, when, kind, counts, the minimum that applied, reason) is
 * stored on the session and appended to CuppingAuditLog in the same transaction.
 */
export async function PUT(req: Request, { params }: Params) {
  const { user, error } = await requireEdit("cupping");
  if (error) return error;
  // Closing and deleting a session are administrator actions: the cupping screen offers
  // them only when `user.role === "admin"`. Cupping edit access alone (create, score) is
  // not enough; the same rule is enforced here so the API cannot be called around the UI. The
  // admin role is privileged: closing is exercised by a verified individual.
  const refused = await requireAdminAction(user, "cupping.session_close");
  if (refused) return refused;

  const { id } = await params;

  let body: { kind?: unknown; reason?: unknown } = {};
  const text = await req.text();
  if (text.trim()) {
    try { body = JSON.parse(text); } catch {
      return NextResponse.json({ error: "Invalid JSON body", code: "INVALID_BODY" }, { status: 400 });
    }
    if (!body || typeof body !== "object") body = {};
  }
  const kind: CloseKind | null = body.kind === undefined || body.kind === "COMPLETE" ? "COMPLETE" : body.kind === "INCOMPLETE" ? "INCOMPLETE" : null;
  if (!kind) {
    return NextResponse.json({ error: "kind must be COMPLETE or INCOMPLETE", code: "CUPPING_CLOSE_KIND_INVALID" }, { status: 400 });
  }
  // Whitespace, zero-width and format characters alone are not a reason (same rule as the DB CHECK).
  const reason = hasVisibleText(body.reason) ? cleanReason(body.reason) : "";
  if (kind === "INCOMPLETE" && !reason) {
    return NextResponse.json({ error: "A reason is required to close a session as incomplete.", code: "CUPPING_INCOMPLETE_REASON_REQUIRED" }, { status: 400 });
  }
  if (reason.length > CLOSE_REASON_MAX) {
    return NextResponse.json({ error: `The reason is limited to ${CLOSE_REASON_MAX} characters.`, code: "CUPPING_CLOSE_REASON_TOO_LONG" }, { status: 400 });
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      // FOR UPDATE: a concurrent close waits here and then sees Closed; a score being written
      // holds FOR SHARE, so the count below is the count the session closes with.
      const locked = await tx.$queryRaw<{ status: string }[]>`
        SELECT "status" FROM "CuppingSession" WHERE "id" = ${id} FOR UPDATE`;
      if (locked.length === 0) throw new CuppingRefusal(404, "NOT_FOUND", "Not found");
      if (locked[0].status !== "Open") throw new CuppingRefusal(409, "CUPPING_ALREADY_CLOSED", "Already closed");

      const settings = await getCuppingSettings(tx);
      const minScorers = settings.minScorers;
      const counts = (await scorerCounts([id], tx)).get(id)!;
      const scorers = counts.staffScorers;
      const figures = { scorers, minScorers, partialScorers: counts.partialScorers, guestScorers: counts.guestScorers, requiredCups: counts.requiredCups };

      if (kind === "COMPLETE" && scorers < minScorers) {
        throw new CuppingRefusal(409, "CUPPING_MIN_SCORERS_NOT_MET",
          `This session has ${scorers} of the ${minScorers} complete staff scorers (every cup scored) required for a normal close. An administrator can close it as incomplete with a reason.`, figures);
      }
      if (kind === "INCOMPLETE" && scorers >= minScorers) {
        throw new CuppingRefusal(409, "CUPPING_MIN_SCORERS_MET",
          "This session meets the minimum of staff scorers; close it normally.", figures);
      }

      const closedAt = new Date();
      // Conditional on Open: a second close can never overwrite the first.
      const { count } = await tx.cuppingSession.updateMany({
        where: { id, status: "Open" },
        data: {
          status: "Closed",
          closeKind: kind,
          closedAt,
          closedById: user.id,
          closedByName: user.name ?? null,
          closeReason: kind === "INCOMPLETE" ? reason : (reason || null),
          minScorersAtClose: minScorers,
          scorersAtClose: scorers,
        },
      });
      if (count !== 1) throw new CuppingRefusal(409, "CUPPING_ALREADY_CLOSED", "Already closed");

      const scoreCount = await tx.cuppingScore.count({ where: { sessionId: id } });
      await tx.cuppingAuditLog.create({
        data: {
          action: "SESSION_CLOSED",
          entityType: "CuppingSession",
          entityId: id,
          before: { status: "Open" },
          after: { status: "Closed", closeKind: kind, closedAt: closedAt.toISOString(), staffScorers: scorers, partialScorers: counts.partialScorers, guestScorers: counts.guestScorers, requiredCups: counts.requiredCups, scoreCount, minScorers },
          reason: kind === "INCOMPLETE" ? reason : (reason || null),
          actorId: user.id,
          actorName: user.name ?? null,
        },
      });
      return tx.cuppingSession.findUnique({ where: { id } });
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof CuppingRefusal) {
      return NextResponse.json({ error: err.message, code: err.code, ...err.extra }, { status: err.status });
    }
    return handlePrismaError(err);
  }
}
