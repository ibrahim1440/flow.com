import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireModule, requireSub } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";

export async function GET() {
  const { error } = await requireModule("accounting");
  if (error) return error;

  const settings = await prisma.accountingSettings.findUnique({ where: { id: "singleton" } });
  if (!settings) {
    return NextResponse.json(
      { configured: false, settings: null, error: "Accounting settings have not been initialized." },
      { status: 404 },
    );
  }
  return NextResponse.json(settings);
}

const ALLOWED_FIELDS = [
  "baseCurrency",
  "costingMethod",
  "cogsPolicy",
  "branchAccountingMode",
  "exportToQoyod",
  "setupComplete",
] as const;

export async function PATCH(request: Request) {
  const { user, error } = await requireSub("accounting", "settings_manage");
  if (error) return error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const input = (body ?? {}) as Record<string, unknown>;
  const data: Record<string, unknown> = {};

  for (const field of ALLOWED_FIELDS) {
    if (!(field in input)) continue;
    const value = input[field];
    if (field === "exportToQoyod" || field === "setupComplete") {
      if (typeof value !== "boolean") {
        return NextResponse.json({ error: `${field} must be a boolean.` }, { status: 400 });
      }
    } else if (typeof value !== "string" || !value.trim()) {
      return NextResponse.json({ error: `${field} must be a non-empty string.` }, { status: 400 });
    }
    data[field] = value;
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "No valid fields provided." }, { status: 400 });
  }

  data.updatedBy = user.id;

  try {
    const settings = await prisma.accountingSettings.upsert({
      where: { id: "singleton" },
      create: { id: "singleton", ...data },
      update: data,
    });
    return NextResponse.json(settings);
  } catch (err) {
    return handlePrismaError(err);
  }
}
