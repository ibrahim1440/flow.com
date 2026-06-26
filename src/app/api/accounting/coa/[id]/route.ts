import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireModule, requireSub } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";

type Params = { params: Promise<{ id: string }> };

const ACCOUNT_TYPES = new Set(["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"]);

export async function GET(_request: Request, { params }: Params) {
  const { error } = await requireModule("accounting");
  if (error) return error;

  const { id } = await params;
  const account = await prisma.account.findUnique({ where: { id } });
  if (!account) {
    return NextResponse.json({ error: "Account not found." }, { status: 404 });
  }
  return NextResponse.json(account);
}

export async function PATCH(request: Request, { params }: Params) {
  const { user, error } = await requireSub("accounting", "coa_manage");
  if (error) return error;

  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { nameAr, nameEn, type, allowPosting, isActive, qoyodAccountId, parentId } = (body ?? {}) as {
    nameAr?: unknown;
    nameEn?: unknown;
    type?: unknown;
    allowPosting?: unknown;
    isActive?: unknown;
    qoyodAccountId?: unknown;
    parentId?: unknown;
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
  if (type !== undefined) {
    if (typeof type !== "string" || !ACCOUNT_TYPES.has(type)) {
      return NextResponse.json({ error: `type must be one of ${[...ACCOUNT_TYPES].join(", ")}.` }, { status: 400 });
    }
    data.type = type;
  }
  if (allowPosting !== undefined) {
    if (typeof allowPosting !== "boolean") {
      return NextResponse.json({ error: "allowPosting must be a boolean." }, { status: 400 });
    }
    data.allowPosting = allowPosting;
  }
  if (isActive !== undefined) {
    if (typeof isActive !== "boolean") {
      return NextResponse.json({ error: "isActive must be a boolean." }, { status: 400 });
    }
    data.isActive = isActive;
  }
  if (qoyodAccountId !== undefined) {
    if (qoyodAccountId !== null && typeof qoyodAccountId !== "string") {
      return NextResponse.json({ error: "qoyodAccountId must be a string or null." }, { status: 400 });
    }
    data.qoyodAccountId = qoyodAccountId;
  }
  if (parentId !== undefined) {
    if (parentId !== null && typeof parentId !== "string") {
      return NextResponse.json({ error: "parentId must be a string or null." }, { status: 400 });
    }
    if (parentId === id) {
      return NextResponse.json({ error: "An account cannot be its own parent." }, { status: 400 });
    }
    data.parentId = parentId;
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "No valid fields provided." }, { status: 400 });
  }

  data.updatedBy = user.id;

  try {
    if (data.parentId) {
      const parent = await prisma.account.findUnique({ where: { id: data.parentId as string } });
      if (!parent) {
        return NextResponse.json({ error: "parentId does not reference an existing account." }, { status: 400 });
      }
    }

    const account = await prisma.account.update({ where: { id }, data });
    return NextResponse.json(account);
  } catch (err) {
    return handlePrismaError(err);
  }
}
