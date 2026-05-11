import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";

type Params = { params: Promise<{ id: string }> };

export async function PUT(request: Request, { params }: Params) {
  const { error } = await requireSub("inventory", "adjust");
  if (error) return error;

  const { id } = await params;
  try {
    const data = await request.json();
    const bean = await prisma.greenBean.update({ where: { id }, data });
    return NextResponse.json(bean);
  } catch (err) {
    return handlePrismaError(err);
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  const { error } = await requireSub("inventory", "adjust");
  if (error) return error;

  const { id } = await params;

  try {
    await prisma.greenBean.delete({ where: { id } });
    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code === "P2003" || code === "P2014") {
      return NextResponse.json(
        { error: "Cannot delete this bean because it has roasting history. Please deactivate it instead." },
        { status: 400 }
      );
    }
    throw err;
  }
}
