// Owner decision (13 Nov 2026, quote-45 round, item 3): a draft quotation has no number until it is issued. Every screen,
// message and list that names a quotation names it through here: the number when it has one, else «مسودة» / "Draft"
// (the lists put the customer / deal and the date beside it). Pure and client-safe.
export const DRAFT_QUOTE_LABEL = { ar: "مسودة", en: "Draft" } as const;

/** The quotation's reference as shown: its number, or «مسودة» before it is issued. */
export function quoteRef(quoteNumber: string | null | undefined, ar: boolean): string {
  return quoteNumber || (ar ? DRAFT_QUOTE_LABEL.ar : DRAFT_QUOTE_LABEL.en);
}

/** A stable test / DOM key: the number when there is one, else the id (an unnumbered draft). */
export const quoteKey = (q: { id: string; quoteNumber: string | null | undefined }): string => q.quoteNumber || q.id;
