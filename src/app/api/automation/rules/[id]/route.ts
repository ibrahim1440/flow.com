import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireModule, requireSub } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { validateRuleInput } from "@/lib/automation/rules";
import { deleteRule, setRuleActive, updateRule } from "@/lib/automation/rule-service";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  const { error } = await requireModule("automation");
  if (error) return error;
  const { id } = await params;
  const rule = await prisma.automationRule.findUnique({ where: { id } });
  if (!rule) return NextResponse.json({ error: "Rule not found." }, { status: 404 });
  return NextResponse.json({ rule });
}

/** Replace the whole rule. The editor always saves the rule as one unit. */
export async function PUT(request: Request, { params }: Params) {
  const { user, error } = await requireSub("automation", "manage_rules");
  if (error) return error;
  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const parsed = validateRuleInput(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.errors[0], details: parsed.errors }, { status: 400 });

  try {
    const rule = await prisma.$transaction((tx) => updateRule(tx, user.id, id, parsed.value));
    return NextResponse.json({ rule });
  } catch (err) {
    return handleDomainError(err);
  }
}

/** Switch a rule on or off without re-sending the whole rule: { isActive: boolean }. */
export async function PATCH(request: Request, { params }: Params) {
  const { user, error } = await requireSub("automation", "manage_rules");
  if (error) return error;
  const { id } = await params;

  let body: { isActive?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (typeof body.isActive !== "boolean") {
    return NextResponse.json({ error: "isActive must be true or false." }, { status: 400 });
  }
  try {
    await prisma.$transaction((tx) => setRuleActive(tx, user.id, id, body.isActive as boolean));
    return NextResponse.json({ ok: true });
  } catch (err) {
    return handleDomainError(err);
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  const { error } = await requireSub("automation", "manage_rules");
  if (error) return error;
  const { id } = await params;
  try {
    await prisma.$transaction((tx) => deleteRule(tx, id));
    return NextResponse.json({ ok: true });
  } catch (err) {
    return handleDomainError(err);
  }
}
