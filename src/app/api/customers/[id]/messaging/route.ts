import { NextResponse } from "@/lib/api-response";
import { prisma, TX_OPTS } from "@/lib/db";
import { requireAnyModule } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { customerInScope } from "@/lib/services/sales/customer-access";
import { canSeeCustomerContact } from "@/lib/auth/customer-detail";
import { parseEmailAddress } from "@/lib/automation/email-mode";
import { canEditMessaging, emailConsentChange, isCustomerManager } from "@/lib/services/customers/email-consent";
import { CUSTOMER_DECIDED_SOURCES } from "@/lib/automation/email-consent";
import { Prisma } from "@/generated/prisma/client";
import { reachOf, readableSql } from "@/lib/automation/message-access";
import { writeSettingsAudit } from "@/lib/services/settings/audit";

type Ctx = { params: Promise<{ id: string }> };

/**
 * «الرسائل» on the customer page (batch 25): the customer's e-mail, «يستقبل إيميلات», «يستقبل واتساب» and the last
 * automated message that went out to them (either channel).
 *
 * GET: the customers or orders module, the customer in the viewer's book (404 outside it); the address only with the
 * customer contact right. PUT { email?, emailOptOut? }: the customer in the viewer's book AND canEditMessaging (owner
 * rep · manager · admin, owner decision 31 Oct 2026). Every change is audited before / after (settings trail, entity
 * Customer; the address by its domain).
 */
export async function GET(_req: Request, { params }: Ctx) {
  const { user, error } = await requireAnyModule("customers", "orders");
  if (error) return error;
  const { id } = await params;
  if (!(await customerInScope(user, id))) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const c = await prisma.customer.findUnique({ where: { id }, select: { email: true, emailOptOut: true, emailOptOutAt: true, emailOptOutSource: true, emailOptOutNote: true, whatsappOptOut: true, accountOwnerId: true } });
  if (!c) return NextResponse.json({ error: "Not found" }, { status: 404 });
  // Batch 25b (gate R3 P2) / R1-e: the "last message" line follows the message log's rule (message-access.ts) — only a
  // message of a department the viewer may read, about a record in their scope; anything else gives no line at all.
  const reach = await reachOf(user);
  const [emRows, waRows] = await Promise.all([
    prisma.$queryRaw<{ sentAt: Date | null; status: string }[]>`
      SELECT m."sentAt", m.status::text AS status FROM "EmailMessage" m
      WHERE m."customerId" = ${id} AND m.status::text IN ('SENT', 'DELIVERED', 'BOUNCED', 'COMPLAINED') AND m."planMode" = 'LIVE' AND ${readableSql(reach, "email")}
      ORDER BY m."sentAt" DESC NULLS LAST LIMIT 1`,
    prisma.$queryRaw<{ sentAt: Date | null }[]>`
      SELECT m."sentAt" FROM "WhatsAppMessage" m
      WHERE m.status::text = 'SENT' AND m."recipientKind" = 'customer' AND m."dedupeKey" LIKE ${`%customer:${id.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`} AND m."intendedPhone" IS NULL AND ${readableSql(reach, "whatsapp")}
      ORDER BY m."sentAt" DESC NULLS LAST LIMIT 1`,
  ]);
  const email = emRows[0] ?? null;
  const wa = waRows[0] ?? null;
  const last = [email ? { channel: "email" as const, at: email.sentAt, status: email.status } : null, wa ? { channel: "whatsapp" as const, at: wa.sentAt, status: "SENT" } : null]
    .filter((x): x is NonNullable<typeof x> => !!x && !!x.at)
    .sort((a, b) => b.at!.getTime() - a.at!.getTime())[0] ?? null;
  const showContact = canSeeCustomerContact(user.permissions);
  const norm = c.email?.trim().toLowerCase() ?? null;
  const suppressed = !!norm && !!(await prisma.emailSuppression.findUnique({ where: { email: norm }, select: { email: true } }));
  const mayEdit = canEditMessaging(user, c.accountOwnerId);
  return NextResponse.json({
    email: showContact ? c.email : null, hasEmail: !!c.email, emailValid: c.email ? !!parseEmailAddress(c.email) : false,
    emailOptOut: c.emailOptOut, emailOptOutSource: c.emailOptOutSource, emailOptOutAt: c.emailOptOutAt,
    customerDecided: c.emailOptOut && !!c.emailOptOutSource && CUSTOMER_DECIDED_SOURCES.includes(c.emailOptOutSource), suppressed,
    history: c.emailOptOutNote ? c.emailOptOutNote.split("\n").slice(-5) : [],
    whatsappOptOut: c.whatsappOptOut, last, can: { edit: mayEdit, reenable: mayEdit && isCustomerManager(user) },
  });
}

export async function PUT(request: Request, { params }: Ctx) {
  const { user, error } = await requireAnyModule("customers", "sales");
  if (error) return error;
  const { id } = await params;
  if (!(await customerInScope(user, id))) return NextResponse.json({ error: "Not found" }, { status: 404 });
  let body: { email?: unknown; emailOptOut?: unknown; reason?: unknown };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "طلب غير صالح.", errorEn: "Invalid JSON body." }, { status: 400 }); }
  let email: string | null | undefined;
  if (body.email !== undefined) {
    if (body.email === null || (typeof body.email === "string" && !body.email.trim())) email = null;
    else {
      email = parseEmailAddress(body.email);
      if (!email) return NextResponse.json({ error: "اكتب إيميل واحد صحيح، مثل orders@example.com", errorEn: "Enter one valid e-mail address.", code: "INVALID_EMAIL", field: "email" }, { status: 400 });
    }
  }
  if (body.emailOptOut !== undefined && typeof body.emailOptOut !== "boolean") return NextResponse.json({ error: "قيمة غير صالحة.", errorEn: "emailOptOut must be true or false." }, { status: 400 });
  const optOut = body.emailOptOut as boolean | undefined;
  try {
    const saved = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Customer" WHERE "id" = ${id} FOR UPDATE`;
      const c = await tx.customer.findUnique({ where: { id }, select: { email: true, emailOptOut: true, accountOwnerId: true } });
      if (!c) throw { _appCode: 404, message: "Not found" };
      if (!canEditMessaging(user, c.accountOwnerId)) throw { _appCode: 403, message: "تعديل إيميل العميل للمندوب المسؤول أو المدير.", errorEn: "Only the account owner, a manager or an admin edits this." };
      const data: Prisma.CustomerUncheckedUpdateInput = {};
      if (email !== undefined && email !== (c.email?.trim().toLowerCase() || null)) data.email = email;
      const consent = optOut !== undefined ? await emailConsentChange(tx, { customerId: id, turningOn: !optOut, actor: user, reason: typeof body.reason === "string" ? body.reason.slice(0, 300) : null }) : null;
      if (consent) Object.assign(data, consent.data);
      if (Object.keys(data).length === 0) return c;
      const u = await tx.customer.update({ where: { id }, data, select: { email: true, emailOptOut: true, accountOwnerId: true } });
      const changed = [...("email" in data ? ["email"] : []), ...(consent ? ["emailOptOut"] : [])];
      // The full address (a business contact, kept whole for a «you wrote to the wrong address» dispute — admin-only trail).
      await writeSettingsAudit(tx, {
        section: "organisation", action: "SETTINGS_UPDATED", entityType: "Customer", entityId: id, changed,
        before: { email: c.email ?? null, emailOptOut: c.emailOptOut, ...(consent?.before ?? {}) }, after: { email: u.email ?? null, emailOptOut: u.emailOptOut, ...(consent?.after ?? {}) },
        reason: consent && !optOut ? "CUSTOMER_EMAIL_REENABLED" : "CUSTOMER_EMAIL_SETTINGS", actor: { id: user.id, name: user.name },
      });
      return u;
    }, TX_OPTS);
    return NextResponse.json({ email: saved.email, emailOptOut: saved.emailOptOut });
  } catch (err) {
    return handleDomainError(err);
  }
}
