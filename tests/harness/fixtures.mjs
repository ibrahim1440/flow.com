/**
 * Shared synthetic data for visual comparison.
 *
 * These are the SAME five leads the Figma frame shows, in the same order and with the same
 * values. Comparing a screenshot of the application against a screenshot of the design is only
 * meaningful when the content matches — different names and dates produce different column
 * widths and wrapping, and every difference then has to be argued about.
 *
 * Nothing here comes from a real database and none of it is reviewer data.
 */
export const LEADS_ROWS = [
  {
    id: "l1", companyName: "Zawaqa Cafe", companyNameAr: "مقهى ذوّاقة", contactName: "سارة القحطاني",
    phone: "+966 55 214 8890", email: null, city: "الرياض", source: "REFERRAL", status: "QUALIFIED",
    nextFollowUpAt: "2099-01-01T07:00:00.000Z", createdAt: "2026-09-01T09:00:00.000Z",
    owner: { id: "u1", name: "فهد العتيبي" }, conversion: null,
  },
  {
    id: "l2", companyName: "Nukhba Roastery", companyNameAr: "محمصة النخبة", contactName: "عبدالله الدوسري",
    phone: "+966 50 771 3402", email: null, city: "جدة", source: "EXHIBITION", status: "CONTACTED",
    nextFollowUpAt: "2020-01-01T07:00:00.000Z", createdAt: "2026-09-01T09:00:00.000Z",
    owner: { id: "u1", name: "فهد العتيبي" }, conversion: null,
  },
  {
    id: "l3", companyName: "Bun Al Sharq", companyNameAr: "بن الشرق", contactName: "منى الشمري",
    phone: "+966 53 660 1177", email: null, city: "الدمام", source: "WEBSITE", status: "NEW",
    nextFollowUpAt: null, createdAt: "2026-09-01T09:00:00.000Z",
    owner: null, conversion: null,
  },
  {
    id: "l4", companyName: "Cafe 21", companyNameAr: "كافيه ٢١", contactName: "طارق الحربي",
    phone: "+966 56 902 4415", email: null, city: "الرياض", source: "WALK_IN", status: "CONVERTED",
    nextFollowUpAt: null, createdAt: "2026-09-01T09:00:00.000Z",
    owner: { id: "u2", name: "نورة السبيعي" }, conversion: { customerId: "c1", opportunityId: "o1" },
  },
  {
    id: "l5", companyName: "Raseef Cafe", companyNameAr: "مقهى الرصيف", contactName: "بدر العنزي",
    phone: "+966 59 338 7201", email: null, city: "الخبر", source: "PHONE", status: "UNQUALIFIED",
    nextFollowUpAt: null, createdAt: "2026-09-01T09:00:00.000Z",
    owner: { id: "u2", name: "نورة السبيعي" }, conversion: null,
  },
];

export const LEADS_ROUTES = {
  "/api/sales/leads": { body: { rows: LEADS_ROWS, scope: "all" } },
};

/** A rep who can do everything the Leads screen offers. */
export const REP = {
  id: "u1", name: "فهد العتيبي", preferredLanguage: "ar",
  permissions: {
    sales: {
      access: "full",
      sub: {
        lead_write: true, lead_convert: true, lead_import: true, lead_export: true,
        deal_close: true, deal_reopen: true,
      },
    },
    commissions: { access: "full", sub: { view_own: true, review: true } },
  },
};
