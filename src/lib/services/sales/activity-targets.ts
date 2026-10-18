/**
 * The record picker of «+ تسجيل نشاط» (D6.3): what the read-only
 * `/api/sales/activities/targets` returns, and the one normalisation rule its search uses.
 */

export type Target = {
  kind: "lead" | "deal";
  id: string;
  /** A lead's company name, a deal's title. */
  name: string;
  nameAr: string | null;
  customer: { name: string; nameAr: string | null } | null;
  stage: { nameEn: string; nameAr: string } | null;
  /** The follow-up the row is about (due group), or the activity last logged (recent group). */
  subject: string | null;
  dueAt: string | null;
};

/** What the picker searches on. Diacritics, tatweel, hamza forms, alef maqsura and taa
    marbuta are ignored, so «محمصه» finds «محمصة» and «النخبه» finds «النخبة». The SQL side
    applies the same rule (see the route). */
export function normalizeQuery(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\u064B-\u0652\u0640]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/\s+/g, " ");
}
