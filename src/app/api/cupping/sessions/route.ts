import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";

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
  const { error } = await requireAuth();
  if (error) return error;

  const sessions = await prisma.cuppingSession.findMany({
    orderBy: { createdAt: "desc" },
    include: SESSION_INCLUDE,
  });

  return NextResponse.json(sessions);
}

export async function POST(request: Request) {
  const { user, error } = await requireAuth();
  if (error) return error;

  if (user.role !== "admin") {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

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
