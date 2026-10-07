import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireModule, requireSub } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { validateRuleInput } from "@/lib/automation/rules";
import { createRule } from "@/lib/automation/rule-service";

/** Every rule, with what it has sent in the last 30 days. */
export async function GET() {
  const { error } = await requireModule("automation");
  if (error) return error;

  const since = new Date(Date.now() - 30 * 86_400_000);
  const [rules, counts] = await Promise.all([
    prisma.automationRule.findMany({ orderBy: [{ isActive: "desc" }, { updatedAt: "desc" }] }),
    prisma.whatsAppMessage.groupBy({
      by: ["ruleId", "status"],
      where: { createdAt: { gte: since }, ruleId: { not: null } },
      _count: { _all: true },
    }),
  ]);
  const stats = new Map<string, Record<string, number>>();
  for (const c of counts) {
    const row = stats.get(c.ruleId!) ?? {};
    row[c.status] = c._count._all;
    stats.set(c.ruleId!, row);
  }
  return NextResponse.json({
    rules: rules.map((r) => ({ ...r, last30Days: stats.get(r.id) ?? {} })),
  });
}

export async function POST(request: Request) {
  const { user, error } = await requireSub("automation", "manage_rules");
  if (error) return error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const parsed = validateRuleInput(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.errors[0], details: parsed.errors }, { status: 400 });

  try {
    const rule = await prisma.$transaction((tx) => createRule(tx, user.id, parsed.value));
    return NextResponse.json({ rule }, { status: 201 });
  } catch (err) {
    return handleDomainError(err);
  }
}
