import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { forbidden, requireAuth } from "@/lib/auth-server";
import { DEPARTMENTS, departmentSql, processableSql, reachOf, readableSql, type Department, type Reach } from "@/lib/automation/message-access";
import { Prisma } from "@/generated/prisma/client";
import { automationResendVerdict } from "@/lib/automation/resend-rules";

const WA_STATUSES = ["QUEUED", "SENDING", "SENT", "FAILED", "SKIPPED", "CANCELLED"] as const;
const EMAIL_STATUSES = ["QUEUED", "SENDING", "SENT", "DELIVERED", "BOUNCED", "COMPLAINED", "FAILED", "SKIPPED", "CANCELLED"] as const;
const PER_PAGE = 50;
type Ch = "whatsapp" | "email";
const TABLE: Record<Ch, Prisma.Sql> = { whatsapp: Prisma.raw(`"WhatsAppMessage"`), email: Prisma.raw(`"EmailMessage"`) };

/** Nothing readable at all: not one department this viewer may read (the administrator always may). */
const readsNothing = (r: Reach) => !r.admin && !r.test && !r.invoices && !r.collection && !r.orders && !r.operations && !r.quotes && !r.deals && !r.finance;

/** «تحتاج مراجعة» / «معلّقة» — the same definitions as the campaign log (marketing/server/messaging.ts NEEDS_REVIEW). */
function reviewSql(ch: Ch, review: string | null): Prisma.Sql {
  if (review === "needed") return Prisma.sql`AND m.status::text = 'FAILED' AND m."deliveryDoubt" AND (m."reviewOutcome" IS NULL OR m."reviewOutcome" = 'UNCERTAIN') AND NOT EXISTS (SELECT 1 FROM ${TABLE[ch]} x WHERE x."resendOfMessageId" = m.id)`;
  if (review === "pending") return Prisma.sql`AND m.status::text = 'FAILED' AND m."deliveryDoubt" AND m."reviewOutcome" = 'UNCERTAIN'`;
  // «أُعيد إرسالها»: the originals that were resent after «لم تصل».
  if (review === "resent") return Prisma.sql`AND EXISTS (SELECT 1 FROM ${TABLE[ch]} x WHERE x."resendOfMessageId" = m.id)`;
  return Prisma.empty;
}

/**
 * The message log, newest first — both channels (batch 25): every row names its channel. Filters: channel
 * (whatsapp | email; none = both), status, ruleId, q (a phone, an address or a name), review (needed | pending).
 * R1-e (owner decisions 0–6): every row, every count and every search hit is limited IN SQL to what the viewer may read —
 * the row's department permission and its record in their scope (lib/automation/message-access.ts); default deny.
 */
export async function GET(request: Request) {
  const { user, error } = await requireAuth();
  if (error) return error;
  const r = await reachOf(user);
  if (readsNothing(r)) return forbidden("سجل الرسائل لمن يتابع رسائل قسمه.");

  const url = new URL(request.url);
  const channel = url.searchParams.get("channel");
  const status = url.searchParams.get("status");
  const ruleId = url.searchParams.get("ruleId");
  const review = url.searchParams.get("review");
  const deptParam = url.searchParams.get("department");
  const department = (DEPARTMENTS as readonly string[]).includes(deptParam ?? "") ? (deptParam as Department) : null;
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 60);
  const page = Math.max(1, Math.min(1000, Number(url.searchParams.get("page")) || 1));
  const wantWa = channel !== "email" && (!status || (WA_STATUSES as readonly string[]).includes(status));
  const wantEmail = channel !== "whatsapp" && (!status || (EMAIL_STATUSES as readonly string[]).includes(status));
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const digits = q.replace(/\D/g, "");
  const dLike = `%${digits}%`;

  const scope = (ch: Ch) => Prisma.sql`WHERE ${readableSql(r, ch)}`;
  const filters = (ch: Ch) => Prisma.sql`
    ${status ? Prisma.sql`AND m.status::text = ${status}` : Prisma.empty}
    ${ruleId ? Prisma.sql`AND m."ruleId" = ${ruleId}` : Prisma.empty}
    ${reviewSql(ch, review)}
    ${department ? Prisma.sql`AND (${departmentSql(ch)}) = ${department}` : Prisma.empty}
    ${!q ? Prisma.empty : ch === "whatsapp"
      ? Prisma.sql`AND (m."recipientName" ILIKE ${like} OR m."ruleName" ILIKE ${like}${digits.length >= 4 ? Prisma.sql` OR m.phone LIKE ${dLike} OR m."intendedPhone" LIKE ${dLike}` : Prisma.empty})`
      : Prisma.sql`AND (m."recipientName" ILIKE ${like} OR m."ruleName" ILIKE ${like} OR m.subject ILIKE ${like} OR m."toEmail" LIKE ${like.toLowerCase()} OR m."intendedEmail" LIKE ${like.toLowerCase()})`}`;
  const chans: Ch[] = [...(wantWa ? ["whatsapp" as const] : []), ...(wantEmail ? ["email" as const] : [])];
  const both: Ch[] = [...(channel !== "email" ? ["whatsapp" as const] : []), ...(channel !== "whatsapp" ? ["email" as const] : [])];

  const offset = (page - 1) * PER_PAGE;
  const zero = Promise.resolve([] as never[]);
  const [pageRefs, totals, statusCounts, reviewCounts, deptCounts] = await Promise.all([
    chans.length
      ? prisma.$queryRaw<{ channel: Ch; id: string; dept: Department; can: boolean }[]>`
          SELECT channel, id, dept, can FROM (
            ${Prisma.join(chans.map((ch) => Prisma.sql`SELECT ${ch}::text AS channel, m.id, m."createdAt", ${departmentSql(ch)} AS dept, ${processableSql(r, ch)} AS can FROM ${TABLE[ch]} m ${scope(ch)} ${filters(ch)}`), " UNION ALL ")}
          ) x ORDER BY "createdAt" DESC, id DESC LIMIT ${PER_PAGE} OFFSET ${offset}`
      : zero,
    chans.length
      ? prisma.$queryRaw<{ n: bigint }[]>`SELECT ${Prisma.join(chans.map((ch) => Prisma.sql`(SELECT count(*) FROM ${TABLE[ch]} m ${scope(ch)} ${filters(ch)})`), " + ")} AS n`
      : zero,
    // The status tabs and the review counters count every row the viewer may read (not narrowed by the other filters).
    both.length
      ? prisma.$queryRaw<{ status: string; n: bigint }[]>`SELECT status, sum(n)::bigint AS n FROM (${Prisma.join(both.map((ch) => Prisma.sql`SELECT m.status::text AS status, count(*) AS n FROM ${TABLE[ch]} m ${scope(ch)} GROUP BY 1`), " UNION ALL ")}) s GROUP BY status`
      : zero,
    both.length
      ? prisma.$queryRaw<{ needs: bigint; pending: bigint; resent: bigint }[]>`SELECT coalesce(sum(needs), 0)::bigint AS needs, coalesce(sum(pending), 0)::bigint AS pending, coalesce(sum(resent), 0)::bigint AS resent FROM (${Prisma.join(both.map((ch) => Prisma.sql`
          SELECT count(*) FILTER (WHERE TRUE ${reviewSql(ch, "needed")}) AS needs, count(*) FILTER (WHERE TRUE ${reviewSql(ch, "pending")}) AS pending,
                 count(*) FILTER (WHERE TRUE ${reviewSql(ch, "resent")}) AS resent FROM ${TABLE[ch]} m ${scope(ch)}`), " UNION ALL ")}) c`
      : zero,
    // The department chips: only the departments the viewer may read appear (a count over their readable rows).
    both.length
      ? prisma.$queryRaw<{ dept: Department; n: bigint }[]>`SELECT dept, sum(n)::bigint AS n FROM (${Prisma.join(both.map((ch) => Prisma.sql`SELECT ${departmentSql(ch)} AS dept, count(*) AS n FROM ${TABLE[ch]} m ${scope(ch)} GROUP BY 1`), " UNION ALL ")}) d GROUP BY dept`
      : zero,
  ]);

  // Only that page's rows are read in full — never page × 50 rows of each table into memory.
  const review_ = { dedupeKey: true, eventId: true, attachmentRefId: true, deliveryDoubt: true, reviewOutcome: true, reviewNote: true, reviewedAt: true, reviewedBy: { select: { id: true, name: true } }, resendOfMessageId: true, resend: { select: { id: true, status: true, createdAt: true, createdById: true } }, sendingStartedAt: true, interruptedAt: true } as const;
  const waSel = { id: true, ruleId: true, ruleName: true, eventType: true, subjectType: true, subjectId: true, recipientKind: true, recipientName: true, phone: true, intendedPhone: true, body: true, bodyArchivedAt: true, attachmentKind: true, status: true, statusNote: true, scheduledAt: true, attempts: true, sentAt: true, createdAt: true, ...review_ } as const;
  const emSel = { id: true, ruleId: true, ruleName: true, eventType: true, subjectType: true, subjectId: true, recipientKind: true, recipientName: true, toEmail: true, intendedEmail: true, subject: true, bodyText: true, bodyArchivedAt: true, attachmentKind: true, status: true, statusNote: true, scheduledAt: true, attempts: true, sentAt: true, deliveredAt: true, createdAt: true, ...review_ } as const;
  const [waRows, emRows] = await Promise.all([
    prisma.whatsAppMessage.findMany({ where: { id: { in: pageRefs.filter((x) => x.channel === "whatsapp").map((x) => x.id) } }, select: waSel }),
    prisma.emailMessage.findMany({ where: { id: { in: pageRefs.filter((x) => x.channel === "email").map((x) => x.id) } }, select: emSel }),
  ]);
  const byKey = new Map<string, Record<string, unknown>>([
    ...waRows.map((m) => [`whatsapp:${m.id}`, { ...m, channel: "whatsapp" as const, subject: null, address: m.phone, intended: m.intendedPhone, deliveredAt: null }] as const),
    ...emRows.map(({ bodyText, toEmail, intendedEmail, ...m }) => [`email:${m.id}`, { ...m, channel: "email" as const, body: bodyText, address: toEmail, intended: intendedEmail, phone: null, intendedPhone: null }] as const),
  ]);
  // «أعاد إرسالها: الاسم · الوقت»: the resend's creator and creation time.
  const resenderIds = [...new Set([...waRows, ...emRows].map((m) => m.resend?.createdById).filter((x): x is string => !!x))];
  const resenders = new Map((resenderIds.length ? await prisma.employee.findMany({ where: { id: { in: resenderIds } }, select: { id: true, name: true } }) : []).map((e) => [e.id, e.name]));
  for (const m of byKey.values()) {
    const rs = (m as { resend?: { createdAt: Date; createdById: string | null } | null }).resend;
    (m as Record<string, unknown>).resentBy = rs ? { name: rs.createdById ? resenders.get(rs.createdById) ?? null : null, at: rs.createdAt } : null;
  }
  // R1-e (owner 17 Nov 06:10): a message reviewed «لم تصل» and not resent shows, before anyone clicks, whether its type's
  // window and its content still allow a resend — the same verdict the resend proves again at execution.
  const now = new Date();
  for (const [key, m] of byKey) {
    const r = m as { id: string; reviewOutcome?: string | null; resend?: unknown; deliveryDoubt?: boolean };
    if (r.deliveryDoubt && r.reviewOutcome === "NOT_DELIVERED" && !r.resend) {
      const v = await automationResendVerdict(prisma, { ...(m as Record<string, unknown>), channel: key.startsWith("email:") ? "email" : "whatsapp" } as never, now);
      (m as Record<string, unknown>).resendCheck = v.ok ? { ok: true, from: v.from, until: v.until } : { ok: false, code: v.code, ar: v.ar, en: v.en, href: v.href, from: v.from, until: v.until };
    }
  }
  const rows = pageRefs.map((x) => {
    const row = byKey.get(`${x.channel}:${x.id}`);
    // department: what the row is about; canProcess: may this viewer review / resend / retry / cancel it.
    return row ? { ...row, department: x.dept, canProcess: x.can } : null;
  }).filter(Boolean);

  const counts: Record<string, number> = {};
  for (const c of statusCounts) counts[c.status] = Number(c.n);
  return NextResponse.json({
    rows, page, perPage: PER_PAGE, total: Number(totals[0]?.n ?? 0), counts,
    needsReview: Number(reviewCounts[0]?.needs ?? 0), pending: Number(reviewCounts[0]?.pending ?? 0), resent: Number(reviewCounts[0]?.resent ?? 0),
    departments: Object.fromEntries(deptCounts.map((d) => [d.dept, Number(d.n)])),
    scope: r.admin ? "all" : "department", canManage: r.manage,
    // the viewer's record list hit the cap (message-access.ts BOOK_CAP): the page says some messages are not listed
    ...(r.capped?.length ? { scopeCapped: r.capped } : {}),
  });
}
