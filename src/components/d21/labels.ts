/** Labels shared by the Direction 2.1 CRM screens (the deal page keeps its own copy of these). */
export const ACTIVITY_LABELS: Record<string, { en: string; ar: string }> = {
  CALL: { en: "Call", ar: "مكالمة" }, // CRM.md D6
  VISIT: { en: "Visit", ar: "زيارة" },
  MEETING: { en: "Meeting", ar: "اجتماع" },
  NOTE: { en: "Note", ar: "ملاحظة" },
  TASK: { en: "Task", ar: "مهمة" },
  SAMPLE_FOLLOW_UP: { en: "Sample follow-up", ar: "متابعة عينة" },
};

/** «ماذا حدث؟» — the outcome list of the activity dialog (the deal page keeps its own copy). */
export const OUTCOME_LABELS: Record<string, { en: string; ar: string }> = {
  NO_ANSWER: { en: "No answer", ar: "لا رد" },
  LEFT_MESSAGE: { en: "Left a message", ar: "تُركت رسالة" },
  INTERESTED: { en: "Spoke — interested", ar: "تواصل ناجح — مهتم" },
  MEETING_SCHEDULED: { en: "Meeting scheduled", ar: "حُدِّد موعد اجتماع مع العميل" },
  VISIT_SCHEDULED: { en: "Visit scheduled", ar: "حُدِّد موعد زيارة للعميل" },
  MEETING_COMPLETED: { en: "Meeting held", ar: "تم الاجتماع" },
  VISIT_COMPLETED: { en: "Visit made", ar: "تمت الزيارة" },
  FOLLOW_UP_REQUIRED: { en: "Needs a follow-up", ar: "يحتاج متابعة" },
  NOT_INTERESTED: { en: "Not interested", ar: "غير مهتم" },
  NOTE_ONLY: { en: "Note / internal task", ar: "ملاحظة أو مهمة داخلية" },
};

/** Two letters for an avatar: «فهد العتيبي» → «فع». The article «ال» is not a letter of the name. */
export function initials(name: string | null | undefined): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  const first = (w: string) => w.replace(/^ال(?=.)/, "")[0] ?? "";
  return first(parts[0] ?? "") + first(parts[1] ?? "");
}

/**
 * A record named after its customer reads as the customer, then the rest: «محمصة النخبة —
 * خلطة خاصة» → top «محمصة النخبة», sub «خلطة خاصة» (the cards of `crm-pipeline`). A title that
 * does not start with the customer keeps the customer on top and the whole title under it.
 */
export function splitTitle(title: string, customer: string | null): { top: string; sub: string } {
  if (!customer) return { top: title, sub: "" };
  if (title === customer) return { top: customer, sub: "" };
  if (title.startsWith(customer)) return { top: customer, sub: title.slice(customer.length).replace(/^\s*[—–\-·:]\s*/, "") };
  return { top: customer, sub: title };
}

/** «8 صفقات مفتوحة» with the Arabic counted noun; "8 open deals". */
export function openDealsText(n: number, ar: boolean): string {
  if (!ar) return `${n} open deal${n === 1 ? "" : "s"}`;
  if (n === 1) return "صفقة واحدة مفتوحة";
  if (n === 2) return "صفقتان مفتوحتان";
  if (n >= 3 && n <= 10) return `${n} صفقات مفتوحة`;
  return `${n} صفقة مفتوحة`;
}
