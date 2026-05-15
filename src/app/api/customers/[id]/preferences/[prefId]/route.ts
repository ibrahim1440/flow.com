import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string; prefId: string }> }
) {
  const { error } = await requireSub("customers", "manage");
  if (error) return error;

  const { prefId } = await params;
  try {
    const body = await request.json() as { profileName?: string; notes?: string };
    if (body.profileName !== undefined && !body.profileName.trim()) {
      return NextResponse.json({ error: "profileName cannot be empty" }, { status: 400 });
    }

    const pref = await prisma.customerRoastPreference.update({
      where: { id: prefId },
      data: {
        ...(body.profileName !== undefined && { profileName: body.profileName.trim() }),
        ...(body.notes !== undefined && { notes: body.notes.trim() || null }),
      },
      include: { greenBean: { select: { id: true, beanType: true, serialNumber: true } } },
    });
    return NextResponse.json(pref);
  } catch (err) {
    return handlePrismaError(err);
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string; prefId: string }> }
) {
  const { error } = await requireSub("customers", "manage");
  if (error) return error;

  const { prefId } = await params;
  try {
    await prisma.customerRoastPreference.delete({ where: { id: prefId } });
    return NextResponse.json({ deleted: true });
  } catch (err) {
    return handlePrismaError(err);
  }
}
