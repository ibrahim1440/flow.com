import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireModule, requireSub } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";

const ACCOUNT_TYPES = new Set(["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"]);

export async function GET() {
  const { error } = await requireModule("accounting");
  if (error) return error;

  const accounts = await prisma.account.findMany({
    orderBy: { code: "asc" },
    take: 500,
  });
  return NextResponse.json(accounts);
}

export async function POST(request: Request) {
  const { user, error } = await requireSub("accounting", "coa_manage");
  if (error) return error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { code, nameAr, nameEn, type, parentId, allowPosting, isActive, qoyodAccountId } = (body ?? {}) as {
    code?: unknown;
    nameAr?: unknown;
    nameEn?: unknown;
    type?: unknown;
    parentId?: unknown;
    allowPosting?: unknown;
    isActive?: unknown;
    qoyodAccountId?: unknown;
  };

  if (typeof code !== "string" || !code.trim()) {
    return NextResponse.json({ error: "code is required." }, { status: 400 });
  }
  if (typeof nameEn !== "string" || !nameEn.trim()) {
    return NextResponse.json({ error: "nameEn is required." }, { status: 400 });
  }
  if (typeof type !== "string" || !ACCOUNT_TYPES.has(type)) {
    return NextResponse.json({ error: `type must be one of ${[...ACCOUNT_TYPES].join(", ")}.` }, { status: 400 });
  }
  if (parentId !== undefined && parentId !== null && typeof parentId !== "string") {
    return NextResponse.json({ error: "parentId must be a string or null." }, { status: 400 });
  }

  try {
    if (parentId) {
      const parent = await prisma.account.findUnique({ where: { id: parentId } });
      if (!parent) {
        return NextResponse.json({ error: "parentId does not reference an existing account." }, { status: 400 });
      }
    }

    const account = await prisma.account.create({
      data: {
        code: code.trim(),
        nameAr: typeof nameAr === "string" ? nameAr : null,
        nameEn: nameEn.trim(),
        type: type as never,
        parentId: parentId ?? null,
        allowPosting: typeof allowPosting === "boolean" ? allowPosting : true,
        isActive: typeof isActive === "boolean" ? isActive : true,
        qoyodAccountId: typeof qoyodAccountId === "string" ? qoyodAccountId : null,
        createdBy: user.id,
        updatedBy: user.id,
      },
    });
    return NextResponse.json(account, { status: 201 });
  } catch (err) {
    return handlePrismaError(err);
  }
}
