import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireModule, requireSub } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";

const CATEGORY_TYPES = new Set(["STANDARD", "ZERO_RATED", "EXEMPT", "OUT_OF_SCOPE"]);

export async function GET() {
  const { error } = await requireModule("accounting");
  if (error) return error;

  const taxCategories = await prisma.taxCategory.findMany({ orderBy: { code: "asc" } });
  return NextResponse.json(taxCategories);
}

export async function POST(request: Request) {
  const { user, error } = await requireSub("accounting", "tax_category_manage");
  if (error) return error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { code, nameAr, nameEn, rate, categoryType, isDefault, requiresReason, requiresApproval, zatcaTaxCategoryCode } =
    (body ?? {}) as {
      code?: unknown;
      nameAr?: unknown;
      nameEn?: unknown;
      rate?: unknown;
      categoryType?: unknown;
      isDefault?: unknown;
      requiresReason?: unknown;
      requiresApproval?: unknown;
      zatcaTaxCategoryCode?: unknown;
    };

  if (typeof code !== "string" || !code.trim()) {
    return NextResponse.json({ error: "code is required." }, { status: 400 });
  }
  if (typeof nameEn !== "string" || !nameEn.trim()) {
    return NextResponse.json({ error: "nameEn is required." }, { status: 400 });
  }
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0 || rate > 100) {
    return NextResponse.json({ error: "rate must be a number between 0 and 100." }, { status: 400 });
  }
  if (typeof categoryType !== "string" || !CATEGORY_TYPES.has(categoryType)) {
    return NextResponse.json({ error: `categoryType must be one of ${[...CATEGORY_TYPES].join(", ")}.` }, { status: 400 });
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      if (isDefault === true) {
        await tx.taxCategory.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
      }
      return tx.taxCategory.create({
        data: {
          code: code.trim(),
          nameAr: typeof nameAr === "string" ? nameAr : null,
          nameEn: nameEn.trim(),
          rate,
          categoryType: categoryType as never,
          isDefault: isDefault === true,
          requiresReason: requiresReason === true,
          requiresApproval: requiresApproval === true,
          zatcaTaxCategoryCode: typeof zatcaTaxCategoryCode === "string" ? zatcaTaxCategoryCode : null,
          createdBy: user.id,
          updatedBy: user.id,
        },
      });
    });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return handlePrismaError(err);
  }
}
