/**
 * Per-route fixtures for visual comparison.
 *
 * One entry per Sales/Commissions route: the screen name the harness mounts, and the API
 * responses that screen needs. Content is deliberately close to the Figma frames — the same
 * companies, the same figures — so a difference between a screenshot and a frame is a
 * difference in the implementation and not in the data.
 *
 * Synthetic throughout. No reviewer data, nothing from any database.
 */
import { LEADS_ROWS, REP } from "./fixtures.mjs";

const OWNER = { id: "u1", name: "فهد العتيبي" };
const OWNER2 = { id: "u2", name: "نورة السبيعي" };
const CUST = { id: "c1", name: "Nukhba Roastery", nameAr: "محمصة النخبة" };

/**
 * A moment relative to now, as an ISO string.
 *
 * The Figma frames were drawn against "today" — they say "اليوم ١٥:٠٠" and "متأخّر يومان" —
 * so fixed dates in the fixtures would make every screenshot disagree with its frame for a
 * reason that has nothing to do with the implementation.
 */
const at = (days, hh = 9, mm = 0) => {
  const d = new Date();
  d.setHours(hh, mm, 0, 0);
  d.setDate(d.getDate() + days);
  return d.toISOString();
};

const stage = (id, code, nameAr, position, probability) =>
  ({ id, code, nameAr, nameEn: code, position, probability, isActive: true, _count: { opportunities: 2 } });

const STAGES = [
  stage("s1", "QUALIFY", "تأهيل", 1, 20),
  stage("s2", "QUOTE", "عرض سعر", 2, 40),
  stage("s3", "NEGOTIATE", "تفاوض", 3, 60),
  stage("s4", "CLOSE", "إغلاق", 4, 90),
];

const deal = (id, stageId, title, outcome = "OPEN", amount = "48000") => ({
  id, title, stageId, outcome,
  lostReason: outcome === "LOST" ? "السعر أعلى من المنافس" : null,
  amount, currency: "SAR", probability: 40,
  expectedCloseAt: "2026-10-15T00:00:00.000Z", nextFollowUpAt: null,
  closedAt: outcome === "OPEN" ? null : "2026-09-18T00:00:00.000Z",
  createdAt: "2026-09-08T00:00:00.000Z",
  stage: STAGES.find((s) => s.id === stageId),
  customer: CUST, owner: OWNER, owners: [], conversion: null,
  quotes: [], samples: [], activities: [], stageEvents: [], orderLinks: [],
  _count: { quotes: 2, samples: 1, activities: 3 },
});

const quote = (id, no, status, total, customerAr, dealTitle, validUntil) => ({
  id, quoteNumber: no, revision: 1, status, currency: "SAR",
  validUntil, subtotal: "98000.00", discountTotal: "8000.00",
  taxTotal: "13500.00", grandTotal: total, issuedAt: at(-11),
  acceptedAt: null, createdAt: at(-16),
  customer: { id: "c1", name: customerAr, nameAr: customerAr },
  opportunity: { id: "d1", title: dealTitle, outcome: "OPEN", owner: OWNER },
  _count: { lines: 3, orderLinks: 0 },
});

const accrual = (id, status, amount) => ({
  id, employeeId: "u1", qualifyingBase: "110000.00", sharePercent: "100",
  effectiveRatePercent: "1.045455", amount, currency: "SAR", status,
  approvedAt: null, createdAt: "2026-09-20T00:00:00.000Z",
  employee: OWNER,
  collectionEvent: {
    id: "ce1", externalRef: "SBX-2026-09-0044", sourceSystem: "SANDBOX",
    collectedAt: "2026-09-20T00:00:00.000Z", status: "RECORDED",
    amountGross: "126500.00", amountTax: "16500.00", amountNonQualifying: "0.00",
    customer: { id: "c1", name: "محمصة النخبة" },
  },
  planVersion: {
    version: 3, baseRatePercent: "1.00", tierMode: "INCREMENTAL",
    plan: { code: "REPS", name: "Reps", nameAr: "خطة المندوبين" },
  },
});

export const ROUTES = {
  "sales-leads": {
    screen: "leads-list",
    api: { "/api/sales/leads": { body: { rows: LEADS_ROWS, scope: "all" } } },
  },
  "sales-pipeline": {
    screen: "pipeline",
    api: {
      "/api/sales/opportunities": {
        body: {
          stages: STAGES,
          deals: [
            deal("d1", "s1", "مقهى ذوّاقة — تعاقد سنوي"),
            deal("d2", "s1", "كافيه ٢١ — توسعة فرعين", "OPEN", "76000"),
            deal("d3", "s2", "محمصة النخبة — خلطة خاصة", "OPEN", "90000"),
            deal("d4", "s3", "بن الشرق — عقد توريد", "OPEN", "32000"),
            deal("d5", "s4", "مقهى الرصيف — دفعة أولى", "WON", "26000"),
            deal("d6", "s4", "مطعم السدرة — تجهيز", "LOST", "32000"),
          ],
          scope: "own", can: { close: true, reopen: true },
        },
      },
    },
  },
  "sales-deal-detail": {
    screen: "deal-detail",
    api: {
      "/api/sales/opportunities/": {
        body: { deal: deal("d1", "s2", "محمصة النخبة — خلطة خاصة"), stages: STAGES,
          can: { write: true, close: true, reopen: true, quote: true, approveDiscount: false, assign: true, createOrder: true } },
      },
    },
  },
  "sales-quotes": {
    screen: "quotes-list",
    api: {
      "/api/sales/quotes": {
        body: {
          // The six rows of SC-05, in its order, with its customers, deals and figures.
          rows: [
            quote("q1", "OF-1042", "ISSUED", "103500.00", "محمصة النخبة", "خلطة خاصة", at(5)),
            quote("q2", "OF-1041", "ACCEPTED", "55200.00", "مقهى ذوّاقة", "تعاقد سنوي", at(3)),
            quote("q3", "OF-1040", "DRAFT", "87400.00", "كافيه ٢١", "توسعة فرعين", null),
            quote("q4", "OF-1039", "REJECTED", "36800.00", "بن الشرق", "عقد توريد", null),
            quote("q5", "OF-1038", "SUPERSEDED", "108100.00", "محمصة النخبة", "خلطة خاصة", null),
            quote("q6", "OF-1035", "EXPIRED", "29900.00", "مقهى الرصيف", "دفعة أولى", at(-10)),
          ],
          total: 6, scope: "all",
        },
      },
    },
  },
  "sales-activities": {
    screen: "activities",
    api: {
      "/api/sales/activities": {
        body: {
          // The five rows of SC-09, including the one already completed.
          rows: [
            { id: "a1", type: "CALL", subject: "مكالمة متابعة — تأكيد الكميات", body: null,
              dueAt: at(-2, 11), completedAt: null, createdAt: at(-6),
              owner: OWNER, lead: null, opportunity: { id: "d1", title: "خلطة خاصة", outcome: "OPEN" },
              customer: { id: "c1", name: "محمصة النخبة" } },
            { id: "a2", type: "VISIT", subject: "زيارة — تسليم عيّنة", body: null,
              dueAt: at(0, 15), completedAt: null, createdAt: at(-5),
              owner: OWNER, lead: null, opportunity: { id: "d2", title: "تعاقد سنوي", outcome: "OPEN" },
              customer: { id: "c2", name: "مقهى ذوّاقة" } },
            { id: "a3", type: "SAMPLE_FOLLOW_UP", subject: "متابعة عيّنة — رأي العميل", body: null,
              dueAt: at(1, 10), completedAt: null, createdAt: at(-4),
              owner: OWNER2, lead: null, opportunity: { id: "d3", title: "توسعة فرعين", outcome: "OPEN" },
              customer: { id: "c3", name: "كافيه ٢١" } },
            { id: "a4", type: "MEETING", subject: "اجتماع — مراجعة الخصم", body: null,
              dueAt: at(8, 9), completedAt: null, createdAt: at(-3),
              owner: OWNER2, lead: null, opportunity: { id: "d4", title: "عقد توريد", outcome: "OPEN" },
              customer: { id: "c4", name: "بن الشرق" } },
            { id: "a5", type: "NOTE", subject: "ملاحظة — العميل طلب تأجيل", body: null,
              dueAt: null, completedAt: at(-1, 16), createdAt: at(-7),
              owner: OWNER, lead: null, opportunity: { id: "d5", title: "دفعة أولى", outcome: "OPEN" },
              customer: { id: "c5", name: "مقهى الرصيف" } },
          ],
          counts: { overdue: 1, dueToday: 1, open: 4 }, scope: "own", canSeeTeam: true,
        },
      },
    },
  },
  "sales-targets": {
    screen: "targets",
    api: {
      "/api/sales/targets": {
        body: {
          rows: [
            { id: "t1", employeeId: "u1", targetAmount: "200000.00", bonusAmount: "2000.00", currency: "SAR",
              note: null, employee: { id: "u1", name: "فهد العتيبي", active: true },
              achieved: "110000.00", achievedPercent: "55.00", met: false, shortfall: "90000.00" },
            { id: "t2", employeeId: "u2", targetAmount: "150000.00", bonusAmount: "1500.00", currency: "SAR",
              note: null, employee: { id: "u2", name: "نورة السبيعي", active: true },
              achieved: "156000.00", achievedPercent: "104.00", met: true, shortfall: "0.00" },
            { id: "t3", employeeId: "u3", targetAmount: "120000.00", bonusAmount: "0.00", currency: "SAR",
              note: null, employee: { id: "u3", name: "خالد المطيري", active: true },
              achieved: "42000.00", achievedPercent: "35.00", met: false, shortfall: "78000.00" },
          ],
          scope: "all", notice: null,
        },
      },
    },
  },
  "sales-reports": {
    screen: "reports",
    api: {
      "/api/sales/reports": {
        body: {
          periodStart: "2026-09-01", periodEnd: "2026-09-30", scope: "all",
          leads: { created: 42, converted: 16, conversionRatePercent: "38.10", newCustomersCreated: 14,
            bySource: [{ source: "REFERRAL", count: 18 }, { source: "EXHIBITION", count: 11 }, { source: "WEBSITE", count: 8 }] },
          pipeline: { openCount: 6, openValue: "296000.00",
            byStage: STAGES.map((s, i) => ({ stageId: s.id, code: s.code, nameEn: s.nameEn, nameAr: s.nameAr, count: [2, 1, 1, 2][i], value: ["124000.00", "90000.00", "32000.00", "50000.00"][i] })) },
          closed: { won: 7, wonValue: "180000.00", lost: 12, lostValue: "240000.00", winRatePercent: "36.84",
            lostReasons: [{ reason: "السعر أعلى من المنافس", count: 5 }, { reason: "تأجيل الميزانية", count: 4 }] },
          duration: { sampleSize: 19, medianDays: 18, meanDays: 21 },
        },
      },
    },
  },
  "sales-settings": {
    screen: "settings",
    api: { "/api/sales/stages": { body: { stages: STAGES } } },
  },
  "sales-my-commissions": {
    screen: "commissions",
    api: {
      "/api/commissions/me": {
        body: {
          periodStart: "2026-09-01", periodEnd: "2026-09-30",
          statement: { accrued: "1530.00", adjustments: "0.00", paid: "200.00", outstanding: "1330.00" },
          accruals: [accrual("ac1", "ACCRUED", "1150.00"), accrual("ac2", "PAID", "200.00")],
          ledger: [
            { id: "le1", type: "ACCRUAL", amount: "1150.00", reason: null, createdAt: "2026-09-20T00:00:00.000Z" },
            { id: "le2", type: "PAYOUT", amount: "200.00", reason: "دفعة سبتمبر", createdAt: "2026-09-23T00:00:00.000Z" },
          ],
          target: { targetAmount: "200000.00", bonusAmount: "2000.00", currency: "SAR" },
          collectionSources: ["SANDBOX"], sandbox: true, notice: "لم يُقبض أي مبلغ ولم يُصرف. الأرقام حساب فقط.",
        },
      },
    },
  },
  "commissions-review": {
    screen: "review",
    api: {
      "/api/commissions/review": {
        body: {
          periodStart: "2026-09-01", periodEnd: "2026-09-30",
          employees: [
            { employeeId: "u1", name: "فهد العتيبي", accrued: "1530.00", adjustments: "0.00", paid: "200.00",
              outstanding: "1330.00", accrualRowsTotal: "1530.00", reconciliationDifference: "0.00",
              reconciled: true, pendingCount: 3, approvedCount: 0 },
            { employeeId: "u2", name: "نورة السبيعي", accrued: "840.00", adjustments: "0.00", paid: "0.00",
              outstanding: "840.00", accrualRowsTotal: "840.00", reconciliationDifference: "0.00",
              reconciled: true, pendingCount: 0, approvedCount: 2 },
          ],
          accruals: [accrual("ac1", "ACCRUED", "1150.00"), accrual("ac2", "APPROVED", "840.00")],
          totals: { accrued: "2370.00", adjustments: "0.00", paid: "200.00", outstanding: "2170.00" },
          can: { approve: true, recordPayout: true, managePlans: true },
          sandbox: true, notice: "بيئة تجريبية — الاعتماد والصرف هنا لا يحرّكان مالاً.",
        },
      },
    },
  },
  "commissions-plans": {
    screen: "plans",
    api: {
      "/api/commissions/plans": {
        body: {
          plans: [{
            id: "p1", code: "REPS", name: "Sales reps", nameAr: "خطة المندوبين",
            description: "الأساس صافي المحصّل بعد الضريبة وغير المؤهّل.", isActive: true,
            versions: [{
              id: "v3", version: 3, basis: "NET_COLLECTION", tierMode: "INCREMENTAL",
              baseRatePercent: "1.000000", currency: "SAR",
              effectiveFrom: "2026-07-01T00:00:00.000Z", effectiveTo: null,
              tiers: [
                { id: "t1", fromAmount: "0", toAmount: "100000", ratePercent: "0.000000" },
                { id: "t2", fromAmount: "100000", toAmount: "120000", ratePercent: "0.500000" },
                { id: "t3", fromAmount: "120000", toAmount: null, ratePercent: "1.000000" },
              ],
              _count: { accruals: 12, assignments: 3 },
            }],
            _count: { assignments: 3 },
          }],
        },
      },
      "/api/commissions/assignments": {
        body: {
          assignments: [{
            id: "as1", employeeId: "u1", effectiveFrom: "2026-07-01T00:00:00.000Z", effectiveTo: null, live: true,
            employee: { id: "u1", name: "فهد العتيبي", role: "sales", active: true },
            plan: { id: "p1", code: "REPS", name: "Sales reps" },
            planVersion: { id: "v3", version: 3, baseRatePercent: "1.000000", tierMode: "INCREMENTAL", currency: "SAR" },
          }],
          employees: [{ id: "u1", name: "فهد العتيبي", role: "sales" }],
        },
      },
    },
  },
};

export { REP };
