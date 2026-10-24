import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireApRead } from "@/lib/accounting/ops/http";

/** Pick lists for a supplier invoice's STOCK lines: active green lots and materials (names only). */
export async function GET() {
  const { error } = await requireApRead();
  if (error) return error;
  const [greens, materials] = await Promise.all([
    prisma.greenBean.findMany({ where: { isActive: true }, orderBy: { serialNumber: "asc" }, select: { id: true, serialNumber: true, beanType: true, beanTypeAr: true } }),
    prisma.materialItem.findMany({ where: { isActive: true }, orderBy: { code: "asc" }, select: { id: true, code: true, name: true, nameAr: true } }),
  ]);
  return NextResponse.json({
    greens: greens.map((g) => ({ id: g.id, label: `${g.serialNumber} · ${g.beanTypeAr ?? g.beanType}` })),
    materials: materials.map((m) => ({ id: m.id, label: `${m.code} · ${m.nameAr ?? m.name}` })),
  });
}
