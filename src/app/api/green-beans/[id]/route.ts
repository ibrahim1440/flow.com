import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { error } = await requireSub("inventory", "adjust");
  if (error) return error;

  const { id } = await params;
  const data = await request.json();
  const bean = await prisma.greenBean.update({ where: { id }, data });
  return NextResponse.json(bean);
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { error } = await requireSub("inventory", "adjust");
  if (error) return error;

  const { id } = await params;
  await prisma.greenBean.delete({ where: { id } });
  return NextResponse.json({ success: true });
}
