// Which allocation categories get the "not distributable profit" explanation (D3b). Pure.
//
// Money set aside in a category is cash earmarked for a purpose; it is not accounting profit,
// and paying it out to owners needs its own approval. The explanation is shown where it is
// needed — next to categories whose name or code suggests profit or owner distributions, and
// in the category form while such a name is typed — instead of under every table.

const PATTERNS = [
  /profit/i, /dividend/i, /distribut/i, /owner'?s?\s*(share|draw|payout)/i, /partner'?s?\s*(share|draw|payout)/i, /\bdraw(ings?)?\b/i, /retained/i,
  /رب[حا]/, /أرباح/, /توزيع/, /حصة\s*(المالك|الشركاء|الشريك)/, /مسحوبات/, /سحوبات/,
];

export function isProfitLike(c: { code?: string | null; nameEn?: string | null; nameAr?: string | null }): boolean {
  const text = [c.code, c.nameEn, c.nameAr].filter(Boolean).join(" ");
  return PATTERNS.some((p) => p.test(text));
}

export const PROFIT_HINT = {
  ar: "النقد المخصص هنا ليس بالضرورة ربحاً قابلاً للتوزيع؛ أي توزيع على الملاك يتطلب اعتماداً منفصلاً.",
  en: "Cash allocated here is not necessarily distributable profit; any payout to owners needs a separate approval.",
};
