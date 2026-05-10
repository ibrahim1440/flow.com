import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/auth-server";

type Params = { params: Promise<{ id: string }> };

export async function PUT(_req: Request, { params }: Params) {
  const { user, error } = await requireAuth();
  if (error) return error;

  if (user.role !== "admin") {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  const { id } = await params;

  const session = await prisma.cuppingSession.findUnique({ where: { id } });
  if (!session) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (session.status === "Closed") {
    return NextResponse.json({ error: "Already closed" }, { status: 409 });
  }

  const updated = await prisma.cuppingSession.update({
    where: { id },
    data: { status: "Closed" },
  });

  return NextResponse.json(updated);
}
