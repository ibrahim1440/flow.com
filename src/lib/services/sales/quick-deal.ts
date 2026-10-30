import type { Prisma as PrismaNS } from "@/generated/prisma/client";
import { requireStageFor } from "./stages";
import { NOT_FOUND_MESSAGE, seesTeamReports } from "./scope";
import type { Permissions } from "@/lib/auth-shared";

/**
 * «عرض سعر» / «عيّنة» in one tap from the customer page (batch 24 WP-A §3).
 *
 * A quotation and a sample belong to a deal. The rep should not have to know that, so the deal is
 * chosen for them:
 *   · exactly one OPEN deal of this customer owned by the caller → that deal;
 *   · none → a deal is opened silently at the Qualification stage (`requireStageFor`, as the account
 *     page's «فتح صفقة» and the lead conversion do), owned by the caller, titled
 *     «<customer> — عرض سعر <date>» (or «— عيّنة»), with its stage event — the deal's audit row — naming
 *     the caller and why it was opened. Opening needs `sales › lead_convert`, the privilege that opens
 *     deals today; without it the answer is `{ kind: "none" }` and nothing is written;
 *   · several → `{ kind: "pick" }` with the caller's open deals, the most recently touched first.
 *
 * WHO (council fix round 1, H1): the deal belongs to the CUSTOMER'S ACCOUNT OWNER — commission follows the deal
 * owner, so a one-tap deal must never move a rep's customer to somebody else:
 *   · the caller may act only as the customer's account owner, as a team-view manager (`teamView`), or — for a
 *     customer with no account owner (the pool) — as any rep who has it in their book; anyone else is refused
 *     (`{ kind: "forbidden" }`, the route answers 403) and nothing is written;
 *   · the deals offered / used are the DEAL OWNER's open deals: the account owner's, or the caller's for a pool
 *     customer; a deal opened silently is owned by that same person;
 *   · the stage event — the deal's audit row — names the CALLER (actorId) as the person who opened it.
 * The customer row is locked first, so a double tap opens one deal: the second request finds it and uses it.
 * `preview` (council fix round 2, item 3 — «عيّنة»): the same decision with NOTHING written; where a deal would be opened
 * the answer is `{ kind: "new" }`, and the sample request opens it together with the sample, in one transaction.
 * The caller decides first that the customer is in the viewer's book (`customerInScope`).
 */
export type QuickPurpose = "quote" | "sample";
export type QuickDealPick = { id: string; title: string; stageAr: string; stageEn: string; amount: string | null; updatedAt: Date };
export type QuickDealResult =
  | { kind: "use"; opportunityId: string }
  | { kind: "created"; opportunityId: string }
  | { kind: "pick"; deals: QuickDealPick[] }
  | { kind: "none" }
  | { kind: "forbidden" }
  /** `preview` only: no open deal, and one WOULD be opened — on submit, not now (fix round 2, item 3). */
  | { kind: "new" };

const PURPOSE_AR: Record<QuickPurpose, string> = { quote: "عرض سعر", sample: "عيّنة" };

/** «2026-10-30» in Riyadh time — the day the rep sees on the deal title. */
export function riyadhDay(now: Date): string {
  return new Date(now.getTime() + 3 * 3_600_000).toISOString().slice(0, 10);
}

export function quickDealTitle(customerName: string, purpose: QuickPurpose, now: Date): string {
  return `${customerName} — ${PURPOSE_AR[purpose]} ${riyadhDay(now)}`.slice(0, 200);
}

export async function resolveQuickDeal(
  tx: PrismaNS.TransactionClient,
  actor: { id: string; canOpenDeal: boolean; teamView?: boolean },
  customerId: string,
  purpose: QuickPurpose,
  now: Date = new Date(),
  opts: { preview?: boolean } = {},
): Promise<QuickDealResult> {
  const locked = opts.preview
    ? await tx.$queryRaw<{ id: string; name: string; nameAr: string | null; accountOwnerId: string | null }[]>`
        SELECT "id", "name", "nameAr", "accountOwnerId" FROM "Customer" WHERE "id" = ${customerId}`
    : await tx.$queryRaw<{ id: string; name: string; nameAr: string | null; accountOwnerId: string | null }[]>`
        SELECT "id", "name", "nameAr", "accountOwnerId" FROM "Customer" WHERE "id" = ${customerId} FOR UPDATE`;
  const customer = locked[0];
  if (!customer) throw { _appCode: 404, message: NOT_FOUND_MESSAGE };
  const accountOwner = customer.accountOwnerId;
  if (accountOwner && accountOwner !== actor.id && !actor.teamView) return { kind: "forbidden" };
  const dealOwner = accountOwner ?? actor.id;

  const open = await tx.opportunity.findMany({
    where: { customerId, ownerId: dealOwner, outcome: "OPEN" },
    orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
    take: 20,
    select: { id: true, title: true, amount: true, updatedAt: true, stage: { select: { nameAr: true, nameEn: true } } },
  });
  if (open.length === 1) return { kind: "use", opportunityId: open[0].id };
  if (open.length > 1) {
    return {
      kind: "pick",
      deals: open.map((d) => ({ id: d.id, title: d.title, stageAr: d.stage.nameAr, stageEn: d.stage.nameEn, amount: d.amount != null ? d.amount.toFixed(2) : null, updatedAt: d.updatedAt })),
    };
  }
  if (!actor.canOpenDeal) return { kind: "none" };
  if (opts.preview) return { kind: "new" };

  const title = quickDealTitle(customer.nameAr || customer.name, purpose, now);
  const stage = await requireStageFor(tx, "QUALIFICATION");
  const deal = await tx.opportunity.create({
    data: { title, customerId, stageId: stage.id, outcome: "OPEN", ownerId: dealOwner },
    select: { id: true },
  });
  await tx.opportunityStageEvent.create({
    data: {
      opportunityId: deal.id, toStageId: stage.id, toOutcome: "OPEN", actorId: actor.id,
      reason: (purpose === "quote" ? "Opened automatically for a quotation from the customer page" : "Opened automatically for a sample from the customer page")
        + (dealOwner !== actor.id ? ` (by ${actor.id} for the account owner ${dealOwner})` : ""),
    },
  });
  return { kind: "created", opportunityId: deal.id };
}

/** A team-view caller (the sales manager or the admin) acts for the customer's account owner (H1). Reads, decides nothing else. */
export function actsForAccountOwner(user: { role?: string | null; permissions: Permissions | Record<string, unknown> }): boolean {
  return seesTeamReports(user.permissions, user.role ?? null);
}
