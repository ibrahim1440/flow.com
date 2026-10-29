// «سند قبض» four-eyes — the OWNER RULE of 2026-10-29 (OWNER-ANSWERS.md «no-deal receipt four-eyes»):
//   «حالياً المحاسب يأكده بنفسه بحكم الموجود الان محاسب واحد ومستقبلاً في حال اضافة اكثر من محاسب يصير فيه شخص ثاني يأكد»
//
// The person who recorded an accountant's receipt (source ACCOUNTANT, an invoice with no deal) may confirm, reject or
// return it HIMSELF only while NO OTHER active accountant holds accounting › receipts_confirm (see «Eligible»). As soon as a
// second eligible confirmer exists the server refuses the self-decision (SOD_SELF_CONFIRM) — automatically, with no
// setting to remember: it does not read SIMPLE MODE's SoD switch or the «فصل المهام» toggle. A self-confirmation stays
// flagged (sodBypass) and is listed as RECEIPT_SELF_CONFIRMED in «استثناءات فصل المهام».
//
// «Eligible» — the release gate's B1 rule (BATCH22-GATE.md; the owner meant «a second ACCOUNTANT»). Another person
// counts as a second confirmer only if ALL hold:
//   · role ≠ admin (the owner-admin never makes the rule strict — neither SIMPLE MODE's admin grant, the admin role
//     defaults nor the back-fill's adminOnly `true` count; admins keep the ability to confirm others' receipts);
//   · the right is in their STORED permission document (a role template or an override is written into it): no role-
//     default fallback, no SIMPLE MODE grant — accounting.access === "edit" AND accounting.sub.receipts_confirm === true;
//   · the account is active, is not the actor, and is a verified individual (not a shared login) — exactly what the
//     central gate (privilegedGate) asks of a receipts_confirm holder: SIMPLE MODE asks no verified identity, so there
//     a holder counts as soon as the other conditions hold;
//   · no time-limited exception on that cell has expired (an expired, not yet settled override never counts).
// A Sales collection is never confirmed by its submitter (no exception: the rep's commission claim).
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { isSimpleMode } from "@/lib/simple-mode";
import { identityOfMany } from "@/lib/hr/identity";

type Db = PrismaClient | Prisma.TransactionClient;

/** Pure: does a STORED permission document hold accounting at edit with receipts_confirm explicitly true? */
export function storedReceiptsConfirm(raw: unknown): boolean {
  if (typeof raw !== "string" || !raw.trim()) return false;
  let p: unknown;
  try { p = JSON.parse(raw); } catch { return false; }
  const acc = (p as { accounting?: { access?: unknown; sub?: Record<string, unknown> } } | null)?.accounting;
  return !!acc && acc.access === "edit" && acc.sub?.receipts_confirm === true;
}

/** The OTHER people whose presence makes a self-confirmation impossible (the B1 rule above). */
export async function otherReceiptConfirmers(db: Db, actorId: string, now: Date = new Date()): Promise<string[]> {
  const rows = await db.employee.findMany({
    where: { active: true, id: { not: actorId }, role: { not: "admin" } },
    select: { id: true, permissions: true,
      permissionOverrides: { where: { endedAt: null, expiresAt: { lte: now }, module: "accounting", OR: [{ sub: null }, { sub: "receipts_confirm" }] }, select: { id: true } } },
  });
  const holders = rows.filter((r) => !r.permissionOverrides.length && storedReceiptsConfirm(r.permissions)).map((r) => r.id);
  if (!holders.length || isSimpleMode()) return holders;
  const ids = await identityOfMany(db, holders);
  return holders.filter((id) => ids.get(id)?.verified);
}

/** THE switch: may `actorId` decide the accountant receipt they recorded? Only while no other accountant is eligible. */
export async function receiptSelfConfirmAllowed(db: Db, actorId: string): Promise<boolean> {
  return (await otherReceiptConfirmers(db, actorId)).length === 0;
}
