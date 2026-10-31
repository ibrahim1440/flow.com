import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { forbidden, requireAuth } from "@/lib/auth-server";
import { bookEmailWhere, bookSql, bookWhatsAppWhere, logScopeFor } from "@/lib/automation/log-scope";
import { Prisma } from "@/generated/prisma/client";

const WA_STATUSES = ["QUEUED", "SENDING", "SENT", "FAILED", "SKIPPED", "CANCELLED"] as const;
const EMAIL_STATUSES = ["QUEUED", "SENDING", "SENT", "DELIVERED", "BOUNCED", "COMPLAINED", "FAILED", "SKIPPED", "CANCELLED"] as const;
const PER_PAGE = 50;

/**
 * The message log, newest first — both channels (batch 25): every row names its channel. Filters: channel
 * (whatsapp | email; none = both), status, ruleId, q (a phone, an address or a name).
 */
export async function GET(request: Request) {
  const { user, error } = await requireAuth();
  if (error) return error;
  // Fix round 2: the automation module reads everything; a manager the messages to customers; a rep those to their book.
  const scope = await logScopeFor(user);
  if (!scope) return forbidden("سجل الرسائل لمن يتابع رسائل العملاء.");

  const url = new URL(request.url);
  const channel = url.searchParams.get("channel");
  const status = url.searchParams.get("status");
  const ruleId = url.searchParams.get("ruleId");
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 60);
  const page = Math.max(1, Math.min(1000, Number(url.searchParams.get("page")) || 1));
  const wantWa = channel !== "email";
  const wantEmail = channel !== "whatsapp";

  // Fix round 3 (gate D3): a rep's rows are scoped by what each message is about (lib/automation/log-scope.ts).
  const scopeWa: Prisma.WhatsAppMessageWhereInput = scope.kind === "all" ? {} : scope.kind === "customers" ? { recipientKind: "customer" } : bookWhatsAppWhere(scope);
  const scopeEm: Prisma.EmailMessageWhereInput = scope.kind === "all" ? {} : scope.kind === "customers" ? { recipientKind: "customer" } : bookEmailWhere(scope);
  const scopeWaSql = scope.kind === "all" ? Prisma.empty : scope.kind === "customers" ? Prisma.sql`AND "recipientKind" = 'customer'` : bookSql(scope, "whatsapp");
  const scopeEmSql = scope.kind === "all" ? Prisma.empty : scope.kind === "customers" ? Prisma.sql`AND "recipientKind" = 'customer'` : bookSql(scope, "email");
  const wa: Prisma.WhatsAppMessageWhereInput = { AND: [scopeWa] };
  const em: Prisma.EmailMessageWhereInput = { AND: [scopeEm] };
  let waNone = false;
  if (status) {
    if ((WA_STATUSES as readonly string[]).includes(status)) wa.status = status as (typeof WA_STATUSES)[number];
    else waNone = true;
    if ((EMAIL_STATUSES as readonly string[]).includes(status)) em.status = status as (typeof EMAIL_STATUSES)[number];
  }
  if (ruleId) { wa.ruleId = ruleId; em.ruleId = ruleId; }
  if (q) {
    const digits = q.replace(/\D/g, "");
    wa.OR = [
      { recipientName: { contains: q, mode: "insensitive" } },
      { ruleName: { contains: q, mode: "insensitive" } },
      ...(digits.length >= 4 ? [{ phone: { contains: digits } }, { intendedPhone: { contains: digits } }] : []),
    ];
    em.OR = [
      { recipientName: { contains: q, mode: "insensitive" } },
      { ruleName: { contains: q, mode: "insensitive" } },
      { subject: { contains: q, mode: "insensitive" } },
      { toEmail: { contains: q.toLowerCase() } },
      { intendedEmail: { contains: q.toLowerCase() } },
    ];
  }
  // Paged in SQL (fix round 1): one UNION ALL of the two logs' ids, ordered and cut to the page; only that page's rows
  // are then read in full — never page × 50 rows of each table into memory.
  const waSel = { id: true, ruleId: true, ruleName: true, eventType: true, subjectType: true, subjectId: true, recipientKind: true, recipientName: true, phone: true, intendedPhone: true, body: true, bodyArchivedAt: true, status: true, statusNote: true, scheduledAt: true, attempts: true, sentAt: true, createdAt: true } as const;
  const emSel = { id: true, ruleId: true, ruleName: true, eventType: true, subjectType: true, subjectId: true, recipientKind: true, recipientName: true, toEmail: true, intendedEmail: true, subject: true, bodyText: true, bodyArchivedAt: true, attachmentKind: true, status: true, statusNote: true, scheduledAt: true, attempts: true, sentAt: true, deliveredAt: true, createdAt: true } as const;
  const useWa = wantWa && !waNone;
  const [waTotal, emTotal, waCounts, emCounts] = await Promise.all([
    useWa ? prisma.whatsAppMessage.count({ where: wa }) : Promise.resolve(0),
    wantEmail ? prisma.emailMessage.count({ where: em }) : Promise.resolve(0),
    wantWa ? prisma.whatsAppMessage.groupBy({ by: ["status"], where: scopeWa, _count: { _all: true } }) : Promise.resolve([]),
    wantEmail ? prisma.emailMessage.groupBy({ by: ["status"], where: scopeEm, _count: { _all: true } }) : Promise.resolve([]),
  ]);
  const offset = (page - 1) * PER_PAGE;
  let pageRefs: { channel: "whatsapp" | "email"; id: string }[];
  if (useWa && wantEmail) {
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const digits = q.replace(/\D/g, "");
    const dLike = `%${digits}%`;
    const st = status ?? null;
    const waStatusOk = !status || (WA_STATUSES as readonly string[]).includes(status);
    const waWhere = Prisma.sql`WHERE ${waStatusOk ? Prisma.sql`TRUE` : Prisma.sql`FALSE`} ${scopeWaSql}
      ${st && waStatusOk ? Prisma.sql`AND status::text = ${st}` : Prisma.empty}
      ${ruleId ? Prisma.sql`AND "ruleId" = ${ruleId}` : Prisma.empty}
      ${q ? Prisma.sql`AND ("recipientName" ILIKE ${like} OR "ruleName" ILIKE ${like}${digits.length >= 4 ? Prisma.sql` OR phone LIKE ${dLike} OR "intendedPhone" LIKE ${dLike}` : Prisma.empty})` : Prisma.empty}`;
    const emWhere = Prisma.sql`WHERE TRUE ${scopeEmSql}
      ${st ? Prisma.sql`AND status::text = ${st}` : Prisma.empty}
      ${ruleId ? Prisma.sql`AND "ruleId" = ${ruleId}` : Prisma.empty}
      ${q ? Prisma.sql`AND ("recipientName" ILIKE ${like} OR "ruleName" ILIKE ${like} OR subject ILIKE ${like} OR "toEmail" LIKE ${like.toLowerCase()} OR "intendedEmail" LIKE ${like.toLowerCase()})` : Prisma.empty}`;
    pageRefs = await prisma.$queryRaw<{ channel: "whatsapp" | "email"; id: string }[]>`
      SELECT channel, id FROM (
        SELECT 'whatsapp' AS channel, id, "createdAt" FROM "WhatsAppMessage" ${waWhere}
        UNION ALL
        SELECT 'email' AS channel, id, "createdAt" FROM "EmailMessage" ${emWhere}
      ) x ORDER BY "createdAt" DESC, id DESC LIMIT ${PER_PAGE} OFFSET ${offset}`;
  } else if (useWa) {
    pageRefs = (await prisma.whatsAppMessage.findMany({ where: wa, select: { id: true }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: offset, take: PER_PAGE })).map((r) => ({ channel: "whatsapp" as const, id: r.id }));
  } else {
    pageRefs = wantEmail ? (await prisma.emailMessage.findMany({ where: em, select: { id: true }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: offset, take: PER_PAGE })).map((r) => ({ channel: "email" as const, id: r.id })) : [];
  }
  const [waRows, emRows] = await Promise.all([
    prisma.whatsAppMessage.findMany({ where: { id: { in: pageRefs.filter((r) => r.channel === "whatsapp").map((r) => r.id) } }, select: waSel }),
    prisma.emailMessage.findMany({ where: { id: { in: pageRefs.filter((r) => r.channel === "email").map((r) => r.id) } }, select: emSel }),
  ]);
  const byKey = new Map<string, unknown>([
    ...waRows.map((m) => [`whatsapp:${m.id}`, { ...m, channel: "whatsapp" as const, subject: null, address: m.phone, intended: m.intendedPhone, attachmentKind: null, deliveredAt: null }] as const),
    ...emRows.map(({ bodyText, toEmail, intendedEmail, ...m }) => [`email:${m.id}`, { ...m, channel: "email" as const, body: bodyText, address: toEmail, intended: intendedEmail, phone: null, intendedPhone: null }] as const),
  ]);
  const rows = pageRefs.map((r) => byKey.get(`${r.channel}:${r.id}`)).filter(Boolean);

  const counts: Record<string, number> = {};
  for (const c of [...waCounts, ...emCounts]) counts[c.status] = (counts[c.status] ?? 0) + c._count._all;
  return NextResponse.json({ rows, page, perPage: PER_PAGE, total: waTotal + emTotal, counts, scope: scope.kind });
}
