import { NextResponse } from "@/lib/api-response";
import { prisma, TX_OPTS } from "@/lib/db";
import { canEdit, hasModuleAccess, type Permissions } from "@/lib/auth-shared";
import { currentEmailMode } from "@/lib/automation/email-dispatch";
import { handleDomainError } from "@/lib/api-error";
import { requestAutomationDispatch } from "@/lib/automation/emit";
import { sendQuoteEmailNow } from "@/lib/automation/quote-email-now";
import { quotesSeeAll } from "@/lib/services/sales/quote-access";
import { requireAnyModule } from "@/lib/auth-server";
import { orderInScope } from "@/lib/services/sales/customer-access";

/**
 * «الرسائل المرسلة» on an order or a quotation page (batch 25): the automated messages about THIS record, both
 * channels, newest first — when, which channel, plain status. No body, no address (the log has those, for the
 * automation module). GET ?subjectType=Order|Quote&subjectId=… — the orders or sales module, and the record in the
 * viewer's book (outside it: 404, like the record itself).
 */
/** Can this user open the quotation (the rule of GET /api/sales/quotes/[id])? */
async function quoteVisible(user: { id: string; permissions: unknown }, quoteId: string): Promise<boolean> {
  const p = user.permissions as Permissions;
  const q = await prisma.quote.findFirst({ where: { id: quoteId, ...(quotesSeeAll(p) ? {} : { opportunity: { ownerId: user.id } }) }, select: { id: true } });
  return !!q;
}

export async function GET(request: Request) {
  const { user, error } = await requireAnyModule("orders", "sales");
  if (error) return error;
  const url = new URL(request.url);
  const subjectType = url.searchParams.get("subjectType");
  const subjectId = (url.searchParams.get("subjectId") ?? "").slice(0, 64);
  if ((subjectType !== "Order" && subjectType !== "Quote") || !subjectId) return NextResponse.json({ error: "طلب غير صالح.", errorEn: "subjectType must be Order or Quote." }, { status: 400 });
  if (subjectType === "Order") {
    if (!(await orderInScope(user, subjectId))) return NextResponse.json({ error: "Not found" }, { status: 404 });
  } else {
    // Fix round 3 (gate D4): the quotation's own rule (api/sales/quotes/[id]) — its deal's owner, or quotesSeeAll.
    if (!(await quoteVisible(user, subjectId))) return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const where = { subjectType, subjectId };
  const [wa, em] = await Promise.all([
    prisma.whatsAppMessage.findMany({ where: { ...where, status: { in: ["SENT", "FAILED", "SKIPPED", "QUEUED"] } }, orderBy: { createdAt: "desc" }, take: 10, select: { id: true, status: true, statusNote: true, recipientKind: true, recipientName: true, sentAt: true, createdAt: true } }),
    prisma.emailMessage.findMany({ where: { ...where, status: { not: "CANCELLED" } }, orderBy: { createdAt: "desc" }, take: 10, select: { id: true, status: true, statusNote: true, recipientKind: true, recipientName: true, sentAt: true, deliveredAt: true, createdAt: true, attachmentKind: true, planMode: true } }),
  ]);
  const rows = [
    ...wa.map((m) => ({ ...m, channel: "whatsapp" as const, deliveredAt: null, attachmentKind: null, planMode: null })),
    ...em.map((m) => ({ ...m, channel: "email" as const })),
  ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, 10);
  if (subjectType !== "Quote") return NextResponse.json({ rows });
  // Fix round 2: what the quotation page needs to say WHY nothing went, and whether «أرسل الإيميل الحين» applies.
  const [rule, quote, emailMode] = await Promise.all([
    prisma.whatsAppStatusRule.findFirst({ where: { source: "quote", statusKey: "ISSUED" }, select: { active: true, enabled: true, emailEnabled: true } }),
    prisma.quote.findUnique({ where: { id: subjectId }, select: { status: true } }),
    currentEmailMode(),
  ]);
  return NextResponse.json({
    rows,
    quote: {
      status: quote?.status ?? null,
      rule: { email: !!rule?.active && !!rule.emailEnabled, whatsapp: !!rule?.active && !!rule.enabled },
      emailMode: emailMode.mode,
      canSendEmail: canEdit(user.permissions as Permissions, "sales") && hasModuleAccess(user.permissions as Permissions, "sales"),
    },
  });
}

/**
 * POST { subjectType: "Quote", subjectId, action: "send_email" } — «أرسل الإيميل الحين» (fix round 2): e-mail an issued
 * quotation to its customer now, through the «صدر» rule's own plan and the same sender (lib/automation/quote-email-now.ts).
 * Sales at edit, and the quotation's customer in the viewer's book. Never twice: a message already waiting or sent refuses.
 */
export async function POST(request: Request) {
  const { user, error } = await requireAnyModule("sales");
  if (error) return error;
  if (!canEdit(user.permissions as Permissions, "sales")) return NextResponse.json({ error: "إرسال العرض لمن يعدّل المبيعات.", errorEn: "Sales edit access is required." }, { status: 403 });
  const body = (await request.json().catch(() => ({}))) as { subjectType?: unknown; subjectId?: unknown; action?: unknown };
  const subjectId = typeof body.subjectId === "string" ? body.subjectId.slice(0, 64) : "";
  if (body.subjectType !== "Quote" || body.action !== "send_email" || !subjectId) return NextResponse.json({ error: "طلب غير صالح.", errorEn: "Invalid request." }, { status: 400 });
  // Fix round 3 (gate D4): authorised on the QUOTATION, before any rule or mode check — a quotation the user cannot open
  // answers 404, exactly like the quotation itself.
  if (!(await quoteVisible(user, subjectId))) return NextResponse.json({ error: "Not found" }, { status: 404 });
  try {
    const r = await prisma.$transaction((tx) => sendQuoteEmailNow(tx, subjectId, { id: user.id, name: user.name ?? user.id }), TX_OPTS);
    requestAutomationDispatch();
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    return handleDomainError(e);
  }
}
