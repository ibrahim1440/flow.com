import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { forbidden, requireAdminAction, requireAuth } from "@/lib/auth-server";
import { hasModuleAccess } from "@/lib/auth";
import { handlePrismaError } from "@/lib/api-error";
import {
  MIN_SCORERS_CEILING, MIN_SCORERS_DEFAULT, MIN_SCORERS_FLOOR, getCuppingSettings, isValidMinScorers,
} from "@/lib/cupping/close-policy";

/**
 * The cupping close policy setting (E6, C-5): the minimum of distinct staff scorers a session
 * needs for a normal close. Read by administrators and cupping users (the close dialog shows
 * it); changed by administrators only, 2–20, each change appended to CuppingAuditLog.
 */
export async function GET() {
  const { user, error } = await requireAuth();
  if (error) return error;
  if (user.role !== "admin" && !hasModuleAccess(user.permissions, "cupping")) return forbidden();
  const s = await getCuppingSettings();
  return NextResponse.json({
    minScorers: s.minScorers,
    range: { min: MIN_SCORERS_FLOOR, max: MIN_SCORERS_CEILING, default: MIN_SCORERS_DEFAULT },
    updatedAt: s.updatedAt,
  });
}

export async function PUT(req: Request) {
  const { user, error } = await requireAuth();
  if (error) return error;
  // A policy change: the admin role, exercised by a verified individual after a recent step-up.
  const refused = await requireAdminAction(user, "cupping.settings", { stepUp: true });
  if (refused) return refused;

  let body: { minScorers?: unknown };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON body", code: "INVALID_BODY" }, { status: 400 });
  }
  const v = body?.minScorers;
  if (!isValidMinScorers(v)) {
    return NextResponse.json({
      error: `minScorers must be a whole number from ${MIN_SCORERS_FLOOR} to ${MIN_SCORERS_CEILING}.`,
      code: "CUPPING_MIN_SCORERS_OUT_OF_RANGE",
      range: { min: MIN_SCORERS_FLOOR, max: MIN_SCORERS_CEILING },
    }, { status: 400 });
  }

  try {
    const saved = await prisma.$transaction(async (tx) => {
      await getCuppingSettings(tx);
      const [before] = await tx.$queryRaw<{ minScorers: number }[]>`
        SELECT "minScorers" FROM "CuppingSettings" WHERE "id" = 'singleton' FOR UPDATE`;
      const s = await tx.cuppingSettings.update({ where: { id: "singleton" }, data: { minScorers: v, updatedById: user.id } });
      await tx.cuppingAuditLog.create({
        data: {
          action: "SETTINGS_UPDATED",
          entityType: "CuppingSettings",
          entityId: "singleton",
          before: { minScorers: before.minScorers },
          after: { minScorers: v },
          actorId: user.id,
          actorName: user.name ?? null,
        },
      });
      return s;
    });
    return NextResponse.json({ minScorers: saved.minScorers, updatedAt: saved.updatedAt });
  } catch (err) {
    return handlePrismaError(err);
  }
}
