import { NextResponse } from "@/lib/api-response";
import { requireDataImport } from "@/lib/data-import/gate";
import { handleDomainError } from "@/lib/api-error";
import { prisma } from "@/lib/db";
import { MATERIAL_TEMPLATES } from "@/lib/inventory/item-categories";
import { isTransitLocation } from "@/lib/inventory/locations";
import { isImportEntity } from "@/lib/data-import/spec";
import { templateXlsx } from "@/lib/data-import/sheet";

/** The .xlsx template of one kind of data (?entity=customers|suppliers|green|materials|products), for the admin role or a holder of accounting › data_import (requireDataImport). */
export async function GET(request: Request) {
  const { error } = await requireDataImport();
  if (error) return error;
  const entity = new URL(request.url).searchParams.get("entity");
  if (!isImportEntity(entity)) return NextResponse.json({ error: "نوع البيانات غير معروف.", errorEn: "Unknown entity." }, { status: 400 });
  try {
    const [locations, cats] = await Promise.all([
      prisma.stockLocation.findMany({ where: { isActive: true }, select: { id: true, code: true, nameAr: true, type: true }, orderBy: { sortOrder: "asc" } }),
      prisma.itemCategory.findMany({ where: { isActive: true, legacyMaterialCategory: { not: null }, template: { in: [...MATERIAL_TEMPLATES] } }, select: { nameAr: true, nameEn: true }, orderBy: [{ parentId: "asc" }, { sortOrder: "asc" }] }),
    ]);
    const buf = await templateXlsx(entity, { locations: locations.filter((l) => !isTransitLocation(l)), materialCategories: cats });
    return new Response(new Uint8Array(buf), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="hiqbah-import-${entity}.xlsx"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return handleDomainError(err);
  }
}
