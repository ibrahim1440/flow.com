import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { prisma } from "@/lib/db";
import { requireModule, requireEdit } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";
import { getCuppingSettings, policyView, scorerCounts } from "@/lib/cupping/close-policy";

const SESSION_INCLUDE = {
  _count: { select: { scores: true } },
  batch: { select: { batchNumber: true } },
  greenBean: { select: { serialNumber: true, beanType: true } },
  sessionBatches: {
    orderBy: { order: "asc" as const },
    include: {
      batch: {
        select: {
          batchNumber: true,
          roastProfile: true,
          greenBean: { select: { beanType: true, serialNumber: true } },
          orderItem: { select: { beanTypeName: true } },
        },
      },
    },
  },
};

type SessionItem =
  | { batchId: string }
  | { isExternalSample: true; externalSampleName: string; externalSupplierName?: string };

export async function GET() {
  const { error } = await requireModule("cupping");
  if (error) return error;

  const sessions = await prisma.cuppingSession.findMany({
    orderBy: { createdAt: "desc" },
    include: SESSION_INCLUDE,
  });

  // E6: counts only (distinct staff scorers, distinct guest names, the applicable minimum),
  // never who scored or what, so an open session stays blind.
  const [counts, settings] = await Promise.all([scorerCounts(sessions.map((s) => s.id)), getCuppingSettings()]);
  return NextResponse.json(sessions.map((s) => ({ ...s, ...policyView(s, counts.get(s.id), settings.minScorers) })));
}

export async function POST(request: Request) {
  const { error } = await requireEdit("cupping");
  if (error) return error;

  const { name, batchId, greenBeanId, items } = await request.json() as {
    name?: string;
    batchId?: string;
    greenBeanId?: string;
    items?: SessionItem[];
  };

  if (!name?.trim()) {
    return NextResponse.json({ error: "Session name is required" }, { status: 400 });
  }

  const isMulti = Array.isArray(items) && items.length > 0;
  const sessionToken = isMulti ? randomBytes(8).toString("hex") : null;

  try {
    const session = await prisma.cuppingSession.create({
      data: {
        name: name.trim(),
        batchId: batchId || null,
        greenBeanId: greenBeanId || null,
        sessionToken,
        sessionBatches: isMulti ? {
          create: (items as SessionItem[]).map((item, idx) => {
            if ("isExternalSample" in item && item.isExternalSample) {
              return {
                order: idx,
                isExternalSample: true,
                externalSampleName: item.externalSampleName,
                externalSupplierName: item.externalSupplierName || null,
              };
            }
            return { order: idx, batchId: (item as { batchId: string }).batchId };
          }),
        } : undefined,
      },
      include: SESSION_INCLUDE,
    });

    return NextResponse.json(session, { status: 201 });
  } catch (err) { return handlePrismaError(err); }
}
