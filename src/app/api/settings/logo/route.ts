import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireEdit } from "@/lib/auth-server";

export async function GET() {
  const config = await prisma.systemConfig.upsert({
    where: { id: "singleton" },
    create: { id: "singleton" },
    update: {},
  });
  return NextResponse.json({ logoBase64: config.logoBase64 ?? null });
}

export async function PUT(request: Request) {
  const { error } = await requireEdit("settings");
  if (error) return error;

  const { logoBase64 } = await request.json();

  if (logoBase64 !== null && typeof logoBase64 !== "string") {
    return NextResponse.json({ error: "Invalid logo data" }, { status: 400 });
  }

  const config = await prisma.systemConfig.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", logoBase64: logoBase64 ?? null },
    update: { logoBase64: logoBase64 ?? null },
  });

  return NextResponse.json({ logoBase64: config.logoBase64 ?? null });
}
