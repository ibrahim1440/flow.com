import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireModule, requireSub } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";

type Params = { params: Promise<{ id: string }> };

const CATEGORY_TYPES = new Set(["STANDARD", "ZERO_RATED", "EXEMPT", "OUT_OF_SCOPE"]);

export async function GET(_request: Request, { params }: Params) {
  const { error } = await requireModule("accounting");
  if (error) return error;

  const { id } = await params;
  const taxCategory = await prisma.taxCategory.findUnique({ where: { id } });
  if (!taxCategory) {
    return NextResponse.json({ error: "Tax category not found." }, { status: 404 });
  }
  return NextResponse.json(taxCategory);
}

export async function PATCH(request: Request, { params }: Params) {
  const { user, error } = await requireSub("accounting", "tax_category_manage");
  if (error) return error;

  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { nameAr, nameEn, rate, categoryType, isDefault, isActive, requiresReason, requiresApproval, zatcaTaxCategoryCode } =
    (body ?? {}) as {
      nameAr?: unknown;
      nameEn?: unknown;
      rate?: unknown;
      categoryType?: unknown;
      isDefault?: unknown;
      isActive?: unknown;
      requiresReason?: unknown;
      requiresApproval?: unknown;
      zatcaTaxCategoryCode?: unknown;
    };

  const data: Record<string, unknown> = {};

  if (nameAr !== undefined) {
    if (nameAr !== null && typeof nameAr !== "string") {
      return NextResponse.json({ error: "nameAr must be a string or null." }, { status: 400 });
    }
    data.nameAr = nameAr;
  }
  if (nameEn !== undefined) {
    if (typeof nameEn !== "string" || !nameEn.trim()) {
      return NextResponse.json({ error: "nameEn must be a non-empty string." }, { status: 400 });
    }
    data.nameEn = nameEn.trim();
  }
  if (rate !== undefined) {
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0 || rate > 100) {
      return NextResponse.json({ error: "rate must be a number between 0 and 100." }, { status: 400 });
    }
    data.rate = rate;
  }
  if (categoryType !== undefined) {
    if (typeof categoryType !== "string" || !CATEGORY_TYPES.has(categoryType)) {
      return NextResponse.json({ error: `categoryType must be one of ${[...CATEGORY_TYPES].join(", ")}.` }, { status: 400 });
    }
    data.categoryType = categoryType;
  }
  if (isActive !== undefined) {
    // Deactivation only — existing invoices/lines keep their snapshot regardless.
    if (typeof isActive !== "boolean") {
      return NextResponse.json({ error: "isActive must be a boolean." }, { status: 400 });
    }
    data.isActive = isActive;
  }
  if (requiresReason !== undefined) {
    if (typeof requiresReason !== "boolean") {
      return NextResponse.json({ error: "requiresReason must be a boolean." }, { status: 400 });
    }
    data.requiresReason = requiresReason;
  }
  if (requiresApproval !== undefined) {
    if (typeof requiresApproval !== "boolean") {
      return NextResponse.json({ error: "requiresApproval must be a boolean." }, { status: 400 });
    }
    data.requiresApproval = requiresApproval;
  }
  if (zatcaTaxCategoryCode !== undefined) {
    if (zatcaTaxCategoryCode !== null && typeof zatcaTaxCategoryCode !== "string") {
      return NextResponse.json({ error: "zatcaTaxCategoryCode must be a string or null." }, { status: 400 });
    }
    data.zatcaTaxCategoryCode = zatcaTaxCategoryCode;
  }

  if (isDefault !== undefined && typeof isDefault !== "boolean") {
    return NextResponse.json({ error: "isDefault must be a boolean." }, { status: 400 });
  }

  if (Object.keys(data).length === 0 && isDefault === undefined) {
    return NextResponse.json({ error: "No valid fields provided." }, { status: 400 });
  }

  data.updatedBy = user.id;

  try {
    const taxCategory = await prisma.$transaction(async (tx) => {
      if (isDefault === true) {
        await tx.taxCategory.updateMany({ where: { isDefault: true, id: { not: id } }, data: { isDefault: false } });
        data.isDefault = true;
      } else if (isDefault === false) {
        data.isDefault = false;
      }
      return tx.taxCategory.update({ where: { id }, data });
    });
    return NextResponse.json(taxCategory);
  } catch (err) {
    return handlePrismaError(err);
  }
}
