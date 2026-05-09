import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireModule, requireSub } from "@/lib/auth-server";

export async function GET() {
  const { error } = await requireModule("inventory");
  if (error) return error;

  const beans = await prisma.greenBean.findMany({ orderBy: { createdAt: "desc" } });
  return NextResponse.json(beans);
}

export async function POST(request: Request) {
  const { error } = await requireSub("inventory", "receive");
  if (error) return error;

  const data = await request.json();
  const bean = await prisma.greenBean.create({ data });
  return NextResponse.json(bean, { status: 201 });
}
