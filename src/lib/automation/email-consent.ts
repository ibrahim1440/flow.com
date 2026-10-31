/**
 * «يستقبل إيميلات» — who may switch it back on, and the history kept with it (fix round 1, council b25).
 *
 * A customer who stopped e-mails THEMSELVES (the unsubscribe link, a spam complaint) or whose address bounced is not
 * switched back on by a rep: only a manager or an administrator, with a written reason, after confirming «العميل أوقفها
 * بنفسه — تأكد إنه طلب يرجعها». Every change appends one dated line to Customer.emailOptOutNote — the line that says the
 * customer stopped it is never overwritten.
 */

/** Sources the customer (or the receiving server) decided, not a member of staff. */
export const CUSTOMER_DECIDED_SOURCES: readonly string[] = ["customer_link", "complaint", "bounce"];

export const SOURCE_TEXT_AR: Record<string, string> = {
  customer_link: "أوقفها العميل بنفسه من رابط الإيميل",
  complaint: "العميل بلّغ عن إيميل كسبام",
  bounce: "الإيميل ارتدّ (العنوان مرفوض)",
  staff: "أوقفها موظف",
};

const day = (d: Date) => d.toISOString().slice(0, 10);

/** The history with one more dated line (at most 4,000 characters kept, the newest last). */
export function appendOptOutNote(prev: string | null | undefined, at: Date, line: string): string {
  const next = `${prev ? `${prev}\n` : ""}${day(at)} · ${line.replace(/[\r\n]+/g, " ").trim()}`;
  return next.length > 4000 ? next.slice(next.length - 4000) : next;
}

/** May this change of «يستقبل إيميلات» go through, and what does it need? Pure (the route supplies the facts). */
export function optInRule(o: { turningOn: boolean; source: string | null | undefined; suppressed: boolean; isManager: boolean; reason: string | null | undefined }):
  { ok: true } | { ok: false; status: number; code: string; error: string; errorEn: string } {
  if (!o.turningOn) return { ok: true };
  const customerDecided = (o.source && CUSTOMER_DECIDED_SOURCES.includes(o.source)) || o.suppressed;
  if (!customerDecided) return { ok: true };
  if (!o.isManager) {
    return { ok: false, status: 403, code: "CUSTOMER_OPTED_OUT", error: "العميل أوقف الإيميلات بنفسه. إرجاعها للمدير فقط، بعد ما يتأكد إن العميل طلبها.", errorEn: "The customer stopped e-mails themselves; only a manager or an administrator may switch them back on." };
  }
  if (!o.reason || o.reason.trim().length < 5) {
    return { ok: false, status: 400, code: "REASON_REQUIRED", error: "اكتب سبب الإرجاع (مثلًا: طلبها العميل باتصال يوم كذا).", errorEn: "Write why e-mails are switched back on (at least 5 characters)." };
  }
  return { ok: true };
}
