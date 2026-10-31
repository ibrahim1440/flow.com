import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireModule } from "@/lib/auth-server";
import { STATUS_SOURCES } from "@/lib/automation/status-rules/sources";

/**
 * «تنبيه التكرار» (batch 25): would a rule on this event and a status notification both message the customer?
 * GET ?eventType=… → the switched-on status notifications that event can trigger (and on which channels), and the
 * active rules on it. The editors show «العميل بيوصله رسالتين» when both exist. Read-only; the automation module.
 */
export async function GET(request: Request) {
  const { error } = await requireModule("automation");
  if (error) return error;
  const eventType = new URL(request.url).searchParams.get("eventType") ?? "";
  const sources = STATUS_SOURCES.filter((s) => s.events.includes(eventType)).map((s) => s.key as string);
  const [statuses, rules] = await Promise.all([
    sources.length
      ? prisma.whatsAppStatusRule.findMany({ where: { source: { in: sources }, active: true, OR: [{ enabled: true }, { emailEnabled: true }] }, select: { id: true, source: true, statusKey: true, labelAr: true, labelEn: true, enabled: true, emailEnabled: true, recipients: true } })
      : Promise.resolve([]),
    prisma.automationRule.findMany({ where: { eventType, isActive: true }, select: { id: true, name: true, steps: true } }),
  ]);
  return NextResponse.json({
    statuses: statuses.map((s) => ({ ...s, toCustomer: s.emailEnabled || (Array.isArray(s.recipients) && (s.recipients as unknown[]).includes("customer")) })),
    rules: rules.map((r) => ({ id: r.id, name: r.name, toCustomer: Array.isArray(r.steps) && (r.steps as { type?: string; to?: { kind?: string } }[]).some((x) => (x.type === "whatsapp" || x.type === "email") && x.to?.kind === "customer") })),
  });
}
