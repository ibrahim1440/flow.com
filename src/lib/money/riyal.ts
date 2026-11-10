/**
 * The Saudi riyal sign «⃁» (U+20C1 SAUDI RIYAL SIGN, Unicode 17.0) — the symbol the Saudi Central Bank (SAMA) approved on
 * 20 Feb 2025. Owner, 10 Nov 2026: the official symbol everywhere in the system, to the LEFT of the amount (SAMA's rule).
 * It renders through public/fonts/saudi-riyal.css (loaded with IBM Plex wherever the app loads its fonts).
 *   · Arabic text: «7,245.00 ⃁» — in a right-to-left line the sign after the number sits on its left.
 *   · English text: «⃁ 7,245.00».
 * Text that leaves the system keeps «ر.س» (customers' phones may not have the glyph yet): WhatsApp / e-mail / PDF
 * attachments (lib/notify, lib/marketing), Qoyod (services/invoicing), the data-import column names.
 */
export const RIYAL = "⃁";

/** «1,500.50 ⃁» (Arabic) / «⃁ 1,500.50» (English) — the number as given, the sign on its left either way. */
export const withRiyal = (formatted: string, lang: "ar" | "en") => (lang === "ar" ? `${formatted} ${RIYAL}` : `${RIYAL} ${formatted}`);

/**
 * Text that LEAVES the system (gate M1): a WhatsApp link (wa.me/?text=…), a copied message, a mailto, a share sheet,
 * an e-mail subject or body. The receiving phone or mail client may not draw «⃁» yet, so these keep the letters:
 * «1,500.50 ر.س» (Arabic) / «SAR 1,500.50» (English). Never use RIYAL / withRiyal for them.
 */
export const formatSARText = (formatted: string, lang: "ar" | "en") => (lang === "ar" ? `${formatted} ر.س` : `SAR ${formatted}`);

/**
 * A safety net for text already formatted for the screen that is about to leave the system (gate L3: a notification's
 * in-app title doubles as an e-mail subject and body). The English form «⃁ 1,500» becomes «SAR 1,500»; any other «⃁»
 * (the Arabic form «1,500 ⃁») becomes «ر.س». Applied to every e-mail's subject, HTML and text (lib/notify/email.ts).
 */
export const riyalAsText = (s: string) => (s.includes(RIYAL) ? s.replace(/⃁ (?=[\d−-])/g, "SAR ").replaceAll(RIYAL, "ر.س") : s);
