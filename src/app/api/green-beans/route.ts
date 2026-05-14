import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAnyModule, requireSub } from "@/lib/auth-server";

export async function GET(request: Request) {
  // Production workers need to see bean names and stock when creating roasting batches
  const { error } = await requireAnyModule("inventory", "production");
  if (error) return error;

  const { searchParams } = new URL(request.url);
  const all = searchParams.get("all") === "1";

  const beans = await prisma.greenBean.findMany({
    where: all ? undefined : { isActive: true },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json(beans);
}

function nullify(v: unknown): string | null {
  if (typeof v === "string" && v.trim() !== "") return v.trim();
  return null;
}

export async function POST(request: Request) {
  const { error } = await requireSub("inventory", "receive");
  if (error) return error;

  const raw = await request.json();

  const serialNumber =
    raw.serialNumber?.trim() ||
    `GB-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${Math.floor(Math.random() * 900 + 100)}`;

  const data = {
    serialNumber,
    beanType:   raw.beanType?.trim()   || "Unknown",
    beanTypeAr: nullify(raw.beanTypeAr),
    country:    raw.country?.trim()    || "Unknown",
    countryAr:  nullify(raw.countryAr),
    region:     nullify(raw.region),
    regionAr:   nullify(raw.regionAr),
    variety:    nullify(raw.variety),
    process:    nullify(raw.process),
    processAr:  nullify(raw.processAr),
    altitude:   nullify(raw.altitude),
    location:   nullify(raw.location),
    quantityKg: Number(raw.quantityKg) || 0,
  };

  try {
    const bean = await prisma.greenBean.create({ data });
    return NextResponse.json(bean, { status: 201 });
  } catch (err: unknown) {
    const msg = (err as { message?: string })?.message ?? "Unknown error";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
