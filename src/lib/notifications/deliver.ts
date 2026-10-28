// The e-mail channel of the notifications (feat/notifications) — an outbox over the Notification
// rows themselves.
//
// A row written PENDING is claimed here (SKIP LOCKED / a conditional update: any number of runs share
// the work, none sends twice), the person's choice for the category is read (NotificationPreference,
// else EMAIL_DEFAULT), the address is the company e-mail (lib/notify/recipients.ts, purpose "system" —
// the linked HR person's «بريد الشركة», else the account's own; no notification category is an HR
// recruitment / interview / separation message, the only purposes that use the personal e-mail), and
// ONE e-mail goes out per event: every opted-in recipient of the same event is on that one message
// (no digest). A row PENDING for more than a day is EXPIRED, not sent late; a row left SENDING by a
// dead process becomes FAILED (it may or may not have gone — never re-sent automatically).
//
// Runs after the response of the request that wrote the rows, when a signed-in page polls the bell
// (at most once a minute per instance), and — for the storage alerts — at once (deliverEvent).
// Never throws.
import type { Prisma as PrismaNS, PrismaClient } from "@/generated/prisma/client";
import { alertEmailHtml, sendEmail, type EmailResult } from "@/lib/notify/email";
import { recipientFor } from "@/lib/notify/recipients";
import { EMAIL_DEFAULT, eventDef, isCategory } from "./catalog";

type Db = PrismaClient | PrismaNS.TransactionClient;

const STALE_MS = 24 * 60 * 60 * 1000;
const STUCK_MS = 5 * 60 * 1000;

type Claimed = { id: string; recipientId: string; category: string; kind: string; dedupeKey: string; severity: string; titleAr: string; titleEn: string; bodyAr: string; bodyEn: string; link: string | null };
const CLAIM_SELECT = { id: true, recipientId: true, category: true, kind: true, dedupeKey: true, severity: true, titleAr: true, titleEn: true, bodyAr: true, bodyEn: true, link: true } as const;

export type GroupResult = { dedupeKey: string; status: EmailResult; emailed: number };

function appBaseUrl(): string | null {
  return process.env.APP_BASE_URL?.trim() || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : null);
}

/** The e-mail choice of a person for a category, defaults applied (an event may default to e-mail — `emailDefault`). Pure. */
export function wantsEmail(own: Map<string, Map<string, boolean>>, employeeId: string, category: string, kind?: string): boolean {
  const v = own.get(employeeId)?.get(category);
  if (v !== undefined) return v;
  const ev = kind ? eventDef(kind)?.emailDefault : undefined;
  if (ev !== undefined) return ev;
  return isCategory(category) ? EMAIL_DEFAULT[category] : false;
}

async function choicesOf(db: Db, ids: string[]) {
  const rows = ids.length ? await db.notificationPreference.findMany({ where: { employeeId: { in: ids } } }) : [];
  const out = new Map<string, Map<string, boolean>>();
  for (const r of rows) out.set(r.employeeId, (out.get(r.employeeId) ?? new Map()).set(r.category, r.email));
  return out;
}

/** Send the claimed rows: one e-mail per event. */
async function sendClaimed(db: Db, claimed: Claimed[]): Promise<GroupResult[]> {
  const out: GroupResult[] = [];
  const set = async (ids: string[], state: string) => {
    if (ids.length) await db.notification.updateMany({ where: { id: { in: ids } }, data: { emailState: state, ...(state === "SENT" ? { emailedAt: new Date() } : {}) } });
  };
  const choices = await choicesOf(db, [...new Set(claimed.map((c) => c.recipientId))]);
  const groups = new Map<string, Claimed[]>();
  for (const c of claimed) groups.set(c.dedupeKey, [...(groups.get(c.dedupeKey) ?? []), c]);
  const base = appBaseUrl();
  for (const [dedupeKey, rows] of groups) {
    const off = rows.filter((r) => !wantsEmail(choices, r.recipientId, r.category, r.kind));
    await set(off.map((r) => r.id), "OFF");
    const addressed: { row: Claimed; email: string }[] = [];
    const noAddress: string[] = [];
    for (const r of rows) {
      if (off.includes(r)) continue;
      const rec = await recipientFor(db, { accountId: r.recipientId }, "system");
      if (rec.email) addressed.push({ row: r, email: rec.email }); else noAddress.push(r.id);
    }
    await set(noAddress, "NO_ADDRESS");
    if (addressed.length === 0) { out.push({ dedupeKey, status: "NO_RECIPIENTS", emailed: 0 }); continue; }
    const first = addressed[0].row;
    const view = eventDef(first.kind)?.emailView;
    const a = view ? { ...first, ...view(first) } : first;
    const status = await sendEmail({
      to: addressed.map((x) => x.email),
      subject: `حِقبة · ${a.titleAr}`,
      html: alertEmailHtml({
        titleAr: a.titleAr, titleEn: a.titleEn, bodyAr: a.bodyAr, bodyEn: a.bodyEn, severity: a.severity,
        appUrl: base ? (a.category === "system" ? base : `${base}${a.link ?? "/dashboard/notifications"}`) : null,
        heading: a.category === "system" ? undefined : "حِقبة · تنبيه",
      }),
      text: `${a.titleAr}\n\n${a.bodyAr}\n\n— ${a.titleEn}\n${a.bodyEn}`,
    });
    await set(addressed.map((x) => x.row.id), status === "SENT" ? "SENT" : status === "NOT_CONFIGURED" ? "NOT_CONFIGURED" : "FAILED");
    out.push({ dedupeKey, status, emailed: status === "SENT" ? new Set(addressed.map((x) => x.email.toLowerCase())).size : 0 });
  }
  return out;
}

/** Deliver everything that waits. Returns one result per event. */
export async function deliverPendingEmails(opts: { limit?: number } = {}): Promise<GroupResult[]> {
  try {
    // Lazily: this module is also loaded where no database client may be created (unit tests of deliverEvent).
    const { prisma } = await import("@/lib/db");
    const now = Date.now();
    await prisma.notification.updateMany({ where: { emailState: "PENDING", createdAt: { lt: new Date(now - STALE_MS) } }, data: { emailState: "EXPIRED" } });
    await prisma.notification.updateMany({ where: { emailState: "SENDING", emailClaimedAt: { lt: new Date(now - STUCK_MS) } }, data: { emailState: "FAILED" } });
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const claimed = await prisma.$queryRaw<Claimed[]>`
      UPDATE "Notification" SET "emailState" = 'SENDING', "emailClaimedAt" = now()
      WHERE "id" IN (SELECT "id" FROM "Notification" WHERE "emailState" = 'PENDING'
                     ORDER BY "createdAt" LIMIT ${limit} FOR UPDATE SKIP LOCKED)
      RETURNING "id", "recipientId", "category", "kind", "dedupeKey", "severity", "titleAr", "titleEn", "bodyAr", "bodyEn", "link"`;
    return claimed.length ? await sendClaimed(prisma, claimed) : [];
  } catch (e) {
    console.error("[notifications] e-mail delivery failed:", (e as Error)?.name ?? "error");
    return [];
  }
}

/** Deliver one event's rows now, on `db` (the storage alerts: their result goes on the SystemAlert row). */
export async function deliverEvent(db: Db, dedupeKey: string): Promise<GroupResult | null> {
  try {
    const rows = await db.notification.findMany({ where: { dedupeKey, emailState: "PENDING" }, select: CLAIM_SELECT });
    if (rows.length === 0) return null;
    const claim = await db.notification.updateMany({ where: { id: { in: rows.map((r) => r.id) }, emailState: "PENDING" }, data: { emailState: "SENDING", emailClaimedAt: new Date() } });
    if (claim.count !== rows.length) return null; // another run took them
    return (await sendClaimed(db, rows)).find((g) => g.dedupeKey === dedupeKey) ?? null;
  } catch (e) {
    console.error("[notifications] e-mail delivery failed:", (e as Error)?.name ?? "error");
    return null;
  }
}
