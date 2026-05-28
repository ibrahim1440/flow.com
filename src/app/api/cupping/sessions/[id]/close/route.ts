import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireEdit } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";

type Params = { params: Promise<{ id: string }> };

export async function PUT(_req: Request, { params }: Params) {
  const { error } = await requireEdit("cupping");
  if (error) return error;

  const { id } = await params;

  const session = await prisma.cuppingSession.findUnique({ where: { id } });
  if (!session) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (session.status === "Closed") {
    return NextResponse.json({ error: "Already closed" }, { status: 409 });
  }

  try {
    const updated = await prisma.cuppingSession.update({ where: { id }, data: { status: "Closed" } });
    return NextResponse.json(updated);
  } catch (err) {
    return handlePrismaError(err);
  }
}
