import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { error } = await requireSub("customers", "manage");
  if (error) return error;

  const { id: customerId } = await params;
  try {
    const VALID_USAGE = ["ESPRESSO", "FILTER", "BOTH"];
    const body = await request.json() as {
      greenBeanId: string; profileName: string; usageType?: string; notes?: string;
      targetColorWhole?: number | null; targetToleranceWhole?: number | null;
      targetColorGround?: number | null; targetToleranceGround?: number | null;
      targetDeltaMin?: number | null; targetDeltaMax?: number | null;
    };
    if (!body.greenBeanId) {
      return NextResponse.json({ error: "greenBeanId is required" }, { status: 400 });
    }
    if (!body.profileName?.trim()) {
      return NextResponse.json({ error: "profileName is required" }, { status: 400 });
    }
    const usageType = body.usageType && VALID_USAGE.includes(body.usageType) ? body.usageType : "BOTH";
    const targets = {
      targetColorWhole:      body.targetColorWhole      ?? null,
      targetToleranceWhole:  body.targetToleranceWhole  ?? null,
      targetColorGround:     body.targetColorGround     ?? null,
      targetToleranceGround: body.targetToleranceGround ?? null,
      targetDeltaMin:        body.targetDeltaMin        ?? null,
      targetDeltaMax:        body.targetDeltaMax        ?? null,
    };

    const pref = await prisma.customerRoastPreference.upsert({
      where: { customerId_greenBeanId: { customerId, greenBeanId: body.greenBeanId } },
      create: {
        customerId,
        greenBeanId: body.greenBeanId,
        profileName: body.profileName.trim(),
        usageType,
        notes: body.notes?.trim() || null,
        ...targets,
      },
      update: {
        profileName: body.profileName.trim(),
        usageType,
        notes: body.notes?.trim() || null,
        ...targets,
      },
      include: { greenBean: { select: { id: true, beanType: true, serialNumber: true } } },
    });
    return NextResponse.json(pref, { status: 201 });
  } catch (err) {
    return handlePrismaError(err);
  }
}
