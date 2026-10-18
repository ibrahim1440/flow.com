import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdminAction } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";
import { JOB_LIMITS, DEFAULT_MAX_LABELS_PER_JOB } from "@/lib/print/layout";
import { readJson, requirePrintRead, badRequest } from "@/lib/print/server/auth";
import { getPrintSettings } from "@/lib/print/server/data";

/**
 * The print job cap (orchestrator decision: default 200 labels per job, administrator-configurable,
 * enforced by the server). Read by anyone who prints; changed by administrators only, 1–2000,
 * each change appended to PrintAuditLog.
 */
export async function GET() {
  const { error } = await requirePrintRead();
  if (error) return error;
  const s = await getPrintSettings();
  return NextResponse.json({ maxLabelsPerJob: s.maxLabelsPerJob, range: { min: 1, max: JOB_LIMITS.labels, default: DEFAULT_MAX_LABELS_PER_JOB }, limits: JOB_LIMITS });
}

export async function PUT(req: Request) {
  const { user, error } = await requirePrintRead();
  if (error) return error;
  // A policy change: the admin role, exercised by a verified individual after a recent step-up.
  const refused = await requireAdminAction(user, "print.settings", { stepUp: true });
  if (refused) return refused;
  const { body, error: bodyErr } = await readJson(req);
  if (bodyErr) return bodyErr;
  const v = body!.maxLabelsPerJob;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > JOB_LIMITS.labels) {
    return badRequest("PRINT_MAX_LABELS_OUT_OF_RANGE", `maxLabelsPerJob must be a whole number from 1 to ${JOB_LIMITS.labels}.`);
  }
  try {
    const saved = await prisma.$transaction(async (tx) => {
      const before = await tx.printSettings.upsert({ where: { id: "singleton" }, create: { id: "singleton", maxLabelsPerJob: DEFAULT_MAX_LABELS_PER_JOB }, update: {} });
      const s = await tx.printSettings.update({ where: { id: "singleton" }, data: { maxLabelsPerJob: v, updatedById: user.id } });
      await tx.printAuditLog.create({ data: { action: "SETTINGS_UPDATED", actorId: user.id, actorName: user.name ?? null, entityId: "singleton", before: { maxLabelsPerJob: before.maxLabelsPerJob }, after: { maxLabelsPerJob: v } } });
      return s;
    });
    return NextResponse.json({ maxLabelsPerJob: saved.maxLabelsPerJob });
  } catch (err) {
    return handlePrismaError(err);
  }
}
