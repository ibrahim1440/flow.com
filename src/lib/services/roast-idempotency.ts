import { createHash } from "node:crypto";

/**
 * Making one roast happen once (Workstations W1, D8 — the Delivery.requestKey pattern).
 *
 * A station on a shop-floor network loses responses. Without a request identity, a retry after
 * the commit succeeded and the answer was lost recorded a second batch: green drawn twice, two
 * batch numbers, two QC tasks. With an Idempotency-Key the retry finds the first batch instead.
 *
 * Unlike dispatch, the key is OPTIONAL here: the roast POST has callers (scripts, the regression
 * harness, older screens) that send none, and they keep recording exactly as before. Both screens
 * shipped with this change (the ERP roast sheet and the roasting station) always send one.
 *
 * The same key grammar as packaging and dispatch (one dialect in the codebase).
 */

const HEADER = "Idempotency-Key";
const KEY_MAX_LENGTH = 200;
const KEY_PATTERN = /^[A-Za-z0-9._:-]+$/;

export type RoastKey = { ok: true; key: string | null } | { ok: false; message: string; en: string };

export function readRoastRequestKey(request: Request): RoastKey {
  const raw = request.headers.get(HEADER);
  if (raw === null || raw.trim() === "") return { ok: true, key: null };
  const key = raw.trim();
  if (key.length > KEY_MAX_LENGTH) return { ok: false, message: `مفتاح التكرار أطول من ${KEY_MAX_LENGTH} حرفًا.`, en: `${HEADER} must be at most ${KEY_MAX_LENGTH} characters.` };
  if (!KEY_PATTERN.test(key)) return { ok: false, message: "مفتاح التكرار يقبل الحروف اللاتينية والأرقام و . _ : - فقط.", en: `${HEADER} may contain only letters, digits, and the characters . _ : -` };
  return { ok: true, key };
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const kg = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? +n.toFixed(3) : null;
};

/**
 * The roast a request describes, as one fixed-position array. What a retry may legitimately
 * change is left out: the acknowledgement (`ack`, sent again after a 422 ACK_REQUIRED), the
 * surplus authorization and the loss reason. Everything that decides what is recorded is in.
 */
export function roastIntent(body: Record<string, unknown>): (string | number | null)[] {
  return [
    str(body.productId),
    str(body.orderItemId),
    body.allocate === "oldest" ? "oldest" : null,
    str(body.productionOrderId),
    str(body.greenBeanId),
    kg(body.greenBeanQuantity),
    kg(body.roastedBeanQuantity ?? 0),
    str(body.roastProfile),
    str(body.roasterId),
    str(body.claimId),
    // The roasting schedule (merge of feat/roast-schedule): the slot the roast is recorded from.
    str(body.scheduledSlotId),
  ];
}

export function roastIntentHash(body: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(roastIntent(body))).digest("hex");
}

export const ROAST_IDEMPOTENCY_MISMATCH =
  "This Idempotency-Key has already been used for a different roast. Use a new key for a new roast, or resend the original request unchanged.";
export const ROAST_IDEMPOTENCY_MISMATCH_AR =
  "مفتاح التكرار هذا استُخدم لدفعة مختلفة. استخدم مفتاحًا جديدًا لدفعة جديدة، أو أعد إرسال الطلب الأصلي دون تغيير.";

/** Only the RoastingBatch.requestKey index turns a conflict into a replay; anything else is an error. */
export function isRoastKeyConflict(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: string; meta?: { target?: unknown } };
  if (e.code !== "P2002") return false;
  const target = e.meta?.target;
  const fields = Array.isArray(target) ? target.map(String) : [String(target ?? "")];
  return fields.some((f) => f === "requestKey" || f.includes("RoastingBatch_requestKey_key"));
}
