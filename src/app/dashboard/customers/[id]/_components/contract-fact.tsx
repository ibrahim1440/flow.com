"use client";

import { contractFactText, contractValidity, isRenewed, toDateOnly, EXPIRED_VISIBLE_DAYS } from "@/lib/services/customers/contract-rules";

/**
 * «العقد: ينتهي بعد X يوم» — the customer header's contract fact (batch 24 WP-C). Renders nothing unless one of
 * the customer's contracts / price agreements is inside its notice window (or ended in the last 30 days, «العقد:
 * منتهي»); a contract already replaced by a later one says nothing. The soonest one wins.
 *
 * Markup: one `<div>` holding `<dt>` + `<dd>`, so it drops into the header's facts `<dl>` beside «آخر تواصل» /
 * «آخر طلب». The page places it as the fifth fact of the header row (batch 24 integration).
 */
export function ContractFact({ ar, files, noticeDays, now }: {
  ar: boolean;
  files: { id: string; category: string; validFrom?: string | null; validUntil?: string | null; renewalNoticeDays?: number | null }[];
  noticeDays?: number | null;
  now?: Date;
}) {
  const fact = contractFactOf(files, noticeDays, now);
  if (!fact) return null;
  const text = fact.daysLeft < 0 ? { ar: "منتهي", en: "Expired" } : contractFactText(fact.daysLeft);
  return (
    <div className="contract-fact" data-testid="contract-fact" data-days-left={fact.daysLeft}>
      <dt className="lbl">{ar ? "العقد" : "Contract"}</dt>
      <dd className="warn">{ar ? text.ar : text.en}</dd>
    </div>
  );
}

/** The soonest contract in its notice window (or recently ended), or null. Exported for the page and the tests. */
export function contractFactOf(
  files: { id: string; category: string; validFrom?: string | null; validUntil?: string | null; renewalNoticeDays?: number | null }[],
  noticeDays?: number | null,
  now?: Date,
): { fileId: string; daysLeft: number } | null {
  let best: { fileId: string; daysLeft: number } | null = null;
  for (const f of files) {
    if (!toDateOnly(f.validUntil ?? null)) continue;
    const v = contractValidity(
      { category: f.category, validFrom: f.validFrom ?? null, validUntil: f.validUntil ?? null, renewalNoticeDays: f.renewalNoticeDays ?? null },
      { defaultNoticeDays: noticeDays, now, renewed: isRenewed({ ...f, validUntil: f.validUntil ?? null }, files.map((x) => ({ ...x, validUntil: x.validUntil ?? null }))) },
    );
    if (v.daysLeft === null) continue;
    if (v.state !== "expiring" && !(v.state === "expired" && v.daysLeft >= -EXPIRED_VISIBLE_DAYS)) continue;
    if (!best || v.daysLeft < best.daysLeft) best = { fileId: f.id, daysLeft: v.daysLeft };
  }
  return best;
}
