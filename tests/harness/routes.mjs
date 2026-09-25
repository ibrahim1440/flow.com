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
const OWNER3 = { id: "u3", name: "خالد المطيري" };
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

const accrual = (id, status, amount, o = {}) => ({
  id, employeeId: o.employee?.id ?? "u1",
  qualifyingBase: o.base ?? "110000.00",
  sharePercent: o.share ?? "100",
  effectiveRatePercent: o.rate ?? "1.045455",
  amount, currency: "SAR", status,
  approvedAt: null, createdAt: o.at ?? at(-5),
  employee: o.employee ?? OWNER,
  collectionEvent: {
    id: `ce-${id}`, externalRef: o.ref ?? "SBX-2026-09-0044", sourceSystem: "SANDBOX",
    collectedAt: o.at ?? at(-5), status: "RECORDED",
    amountGross: o.gross ?? "126500.00",
    amountTax: o.tax ?? "16500.00",
    amountNonQualifying: "0.00",
    customer: { id: "c1", name: o.customer ?? "محمصة النخبة" },
  },
  planVersion: {
    version: 3, baseRatePercent: "1.00", tierMode: "INCREMENTAL",
    plan: { code: "REPS", name: "Reps", nameAr: "خطة المندوبين" },
  },
});

/** One quotation, whole — the shape `GET /api/sales/quotes/[id]` returns. */
const line = (position, skuCode, name, qty, unitPrice, discountPercent = "0") => {
  const gross = Number(qty) * Number(unitPrice);
  const discountAmount = (gross * Number(discountPercent)) / 100;
  const lineSubtotal = gross - discountAmount;
  const lineTax = lineSubtotal * 0.15;
  return {
    id: `l${position}`, productSkuId: `sku${position}`, description: null,
    quantity: qty, unit: "KG", unitPrice, discountPercent, taxRatePercent: "15",
    lineSubtotal: lineSubtotal.toFixed(2), lineTax: lineTax.toFixed(2),
    lineTotal: (lineSubtotal + lineTax).toFixed(2), position,
    productSku: { id: `sku${position}`, skuCode, name, nameAr: name, unitOfMeasure: "KG", price: unitPrice },
  };
};

const QUOTE_LINES = [
  line(1, "BRZ-1KG", "خلطة البرازيل 1 كجم", "300", "115.00", "0"),
  line(2, "ETH-1KG", "إثيوبيا يرغاتشيف 1 كجم", "200", "160.00", "5"),
  line(3, "SRV-CAL", "معايرة وصيانة", "1", "3500.00", "0"),
];

const QUOTE_DETAIL = {
  id: "q1", quoteNumber: "OF-1042", revision: 2, status: "ISSUED", currency: "SAR",
  validUntil: at(5), subtotal: "98000.00", discountTotal: "8000.00", taxTotal: "13500.00",
  grandTotal: "103500.00", issuedAt: at(-11), acceptedAt: null, rejectedAt: null,
  rejectionNote: null, discountApprovedById: null, discountApprovedAt: null,
  supersedesId: "q5", createdAt: at(-16), updatedAt: at(-11),
  supersededBy: null,
  supersedes: { id: "q5", quoteNumber: "OF-1038", revision: 1 },
  customer: {
    id: "c1", name: "محمصة النخبة", nameAr: "محمصة النخبة",
    phone: "+966 55 123 4567", email: "orders@nukhba.example", address: "الرياض · حي الملقا",
  },
  opportunity: { id: "d1", title: "خلطة خاصة", outcome: "OPEN", customerId: "c1", owner: OWNER },
  lines: QUOTE_LINES,
  orderLinks: [],
  issuedSnapshot: {
    frozenAt: at(-11),
    quoteNumber: "OF-1042", revision: 2, currency: "SAR", validUntil: at(5),
    totals: {
      subtotal: "98000.00", discountTotal: "8000.00", taxTotal: "13500.00",
      grandTotal: "103500.00", effectiveDiscountPercent: "7.55",
    },
    lines: QUOTE_LINES.map((l) => ({
      position: l.position, skuCode: l.productSku.skuCode, name: l.productSku.name,
      nameAr: l.productSku.nameAr, description: null, quantity: l.quantity, unit: l.unit,
      unitPrice: l.unitPrice, discountPercent: l.discountPercent, taxRatePercent: l.taxRatePercent,
      gross: (Number(l.quantity) * Number(l.unitPrice)).toFixed(2),
      discountAmount: ((Number(l.quantity) * Number(l.unitPrice) * Number(l.discountPercent)) / 100).toFixed(2),
      lineSubtotal: l.lineSubtotal, lineTax: l.lineTax, lineTotal: l.lineTotal,
    })),
  },
};

/**
 * Fixture values that are CUSTOMER-ENTERED free text and legitimately contain Arabic-Indic
 * digits.
 *
 * «كافيه ٢١» is a company's own name — "Cafe 21", written the way its owner writes it. The
 * application does not get to renumber somebody's trading name, so the digit audit removes
 * these exact strings from a text node before scanning it.
 *
 * Removing the string rather than skipping the element is deliberate: a formatter bug that
 * rendered "٥ عروض" into the same cell as the company name would still be caught, because
 * only the company name is subtracted.
 */
/** One recorded receipt, in whichever state the screen needs to show. */
const collection = (id, status, gross, tax, net, o = {}) => ({
  id, status,
  amountGross: gross, amountTax: tax, amountNet: net, currency: "SAR",
  paymentMethod: o.method ?? "BANK_TRANSFER",
  collectedAt: at(-3), referenceNumber: o.ref ?? null, note: null,
  submittedAt: at(-3), submittedBy: OWNER,
  decidedAt: o.decidedBy ? at(-2) : null,
  decidedBy: o.decidedBy ?? null,
  decisionReason: o.reason ?? null,
  reversedAt: o.reversalReason ? at(-1) : null,
  reversedBy: o.reversalReason ? (o.decidedBy ?? OWNER2) : null,
  reversalReason: o.reversalReason ?? null,
  collectionEventId: o.accrual ? `ce-${id}` : null,
  customer: { id: "c1", name: "محمصة النخبة", nameAr: "محمصة النخبة" },
  opportunity: { id: "d1", title: "خلطة خاصة", ownerId: "u1" },
  quote: { id: "q1", quoteNumber: "OF-1042" },
  _count: { evidence: o.evidence ?? 0 },
  collectionEvent: o.accrual
    ? { accruals: [{ amount: o.accrual, status: "ACCRUED", employee: OWNER }] }
    : null,
});

export const CUSTOMER_TEXT = ["كافيه ٢١"];

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
        body: {
          // SC-04's deal, with the quotations and the log the frame shows against it.
          deal: {
            ...deal("d1", "s2", "محمصة النخبة — خلطة خاصة", "OPEN", "90000"),
            probability: 60,
            createdAt: at(-17, 8, 15),
            quotes: [
              { id: "q1", quoteNumber: "OF-1042", revision: 2, status: "ISSUED", currency: "SAR",
                validUntil: at(5), grandTotal: "90000.00", issuedAt: at(-11), acceptedAt: null,
                _count: { lines: 3, orderLinks: 0 } },
              { id: "q5", quoteNumber: "OF-1038", revision: 1, status: "SUPERSEDED", currency: "SAR",
                validUntil: null, grandTotal: "94000.00", issuedAt: at(-14), acceptedAt: null,
                _count: { lines: 3, orderLinks: 0 } },
            ],
            activities: [
              { id: "a1", type: "CALL", subject: "مكالمة — مناقشة الكميات", body: null,
                dueAt: at(-13, 9, 30), completedAt: at(-13, 10, 0), createdAt: at(-13),
                owner: OWNER },
              { id: "a2", type: "VISIT", subject: "زيارة — تذوّق العيّنة", body: null,
                dueAt: at(-15, 13, 0), completedAt: at(-15, 14, 0), createdAt: at(-15),
                owner: OWNER },
            ],
            stageEvents: [
              { id: "se1", reason: null, createdAt: at(-11, 11, 2), toOutcome: null,
                toStage: { nameEn: "QUOTE", nameAr: "عرض سعر" } },
              { id: "se2", reason: null, createdAt: at(-17, 8, 15), toOutcome: null,
                toStage: { nameEn: "QUALIFY", nameAr: "تأهيل" } },
            ],
          },
          stages: STAGES,
          can: { write: true, close: true, reopen: true, quote: true, approveDiscount: false, assign: true, createOrder: true },
        },
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
  "sales-quote-detail": {
    screen: "quote-editor",
    api: {
      "/api/sales/quotes/q1": {
        body: {
          quote: QUOTE_DETAIL,
          state: { editable: false, revisable: true, expired: false, orderable: false },
          can: { write: true, approveDiscount: false, createOrder: true },
          discountThresholdPercent: "10",
        },
      },
    },
  },
  "sales-quote-draft": {
    screen: "quote-editor",
    api: {
      // The same quotation before it was issued — the editor, not the record.
      "/api/sales/quotes/q1": {
        body: {
          quote: { ...QUOTE_DETAIL, status: "DRAFT", issuedAt: null, issuedSnapshot: null, revision: 1 },
          state: { editable: true, revisable: false, expired: false, orderable: false },
          can: { write: true, approveDiscount: false, createOrder: true },
          discountThresholdPercent: "10",
        },
      },
      "/api/products/skus": { body: { skus: [] } },
    },
  },
  "sales-quote-print": {
    screen: "quote-print",
    api: { "/api/sales/quotes/q1": { body: { quote: QUOTE_DETAIL } } },
  },
  "sales-lead-detail": {
    screen: "lead-detail",
    api: {
      "/api/sales/leads/l1": {
        body: {
          lead: {
            id: "l1", companyName: "Nukhba Roastery", companyNameAr: "محمصة النخبة",
            contactName: "سارة القحطاني", phone: "+966551234567", email: "sara@nukhba.example",
            city: "الرياض", address: "حي الملقا", source: "REFERRAL", sourceNote: null,
            status: "QUALIFIED", notes: "تريد خلطة خاصة للفرع الجديد.",
            nextFollowUpAt: at(1, 10), createdAt: at(-20), updatedAt: at(-2),
            owner: OWNER, conversion: null,
            activities: [
              { id: "a1", type: "CALL", subject: "مكالمة — مناقشة الكميات", body: null,
                dueAt: at(-13, 9, 30), completedAt: at(-13, 10), createdAt: at(-13), owner: OWNER },
              { id: "a2", type: "VISIT", subject: "زيارة — تذوّق العيّنة", body: null,
                dueAt: at(-15, 13), completedAt: at(-15, 14), createdAt: at(-15), owner: OWNER },
              { id: "a3", type: "TASK", subject: "متابعة — تأكيد العرض", body: null,
                dueAt: at(1, 10), completedAt: null, createdAt: at(-2), owner: OWNER },
            ],
          },
          can: { write: true, convert: true },
        },
      },
    },
  },
  "sales-collections": {
    screen: "collections",
    api: {
      "/api/sales/collections": {
        body: {
          rows: [
            collection("sc1", "PENDING_VERIFICATION", "5750.00", "750.00", "5000.00", {
              ref: "TRF-88214", evidence: 1,
            }),
            collection("sc2", "APPROVED", "11500.00", "1500.00", "10000.00", {
              ref: "TRF-88190", evidence: 2, accrual: "100.00", decidedBy: OWNER2,
            }),
            collection("sc3", "REJECTED", "2300.00", "300.00", "2000.00", {
              ref: "CHQ-4471", decidedBy: OWNER2,
              reason: "صورة الإيصال لا تطابق المبلغ المذكور.",
            }),
            collection("sc4", "REVERSED", "4600.00", "600.00", "4000.00", {
              ref: "TRF-88011", accrual: "-40.00", decidedBy: OWNER2,
              reversalReason: "أُعيد المبلغ للعميل بعد إلغاء جزء من الطلب.",
            }),
          ],
          scope: "all",
          can: { submit: true, verify: true, reject: true, reverse: true },
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
          // The three accruals of SC-01, including the split one whose share divides the base.
          accruals: [
            accrual("ac1", "ACCRUED", "1150.00", { customer: "مقهى ذوّاقة", ref: "SBX-2026-09-0044", at: at(-5) }),
            // The split one. `qualifyingBase` is what the engine stores: the share is already
            // applied to it (34,500 − 4,500 = 30,000 net, × 60% = 18,000, × 1% = 180), so the
            // fixture has to agree with the engine or the screen shows arithmetic that does
            // not add up.
            accrual("ac2", "ACCRUED", "180.00", {
              customer: "محمصة النخبة", ref: "SBX-2026-09-0051", at: at(-3),
              gross: "34500.00", tax: "4500.00", base: "18000.00", share: "60", rate: "1.000000",
            }),
            accrual("ac3", "PAID", "200.00", {
              customer: "بن الشرق", ref: "SBX-2026-09-0186", at: at(-13),
              gross: "23000.00", tax: "3000.00", base: "20000.00", rate: "1.000000",
            }),
          ],
          ledger: [
            { id: "le1", type: "ACCRUAL", amount: "1150.00", reason: "استحقاق — مقهى ذوّاقة", createdAt: at(-5) },
            { id: "le2", type: "ACCRUAL", amount: "180.00", reason: "استحقاق — محمصة النخبة", createdAt: at(-3) },
            { id: "le3", type: "ACCRUAL", amount: "200.00", reason: "استحقاق — بن الشرق", createdAt: at(-13) },
            { id: "le4", type: "PAYOUT", amount: "200.00", reason: "صرف دفعة سبتمبر — لا يغيّر «مستحق»", createdAt: at(-2) },
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
            { employeeId: "u1", name: "فهد العتيبي", accrued: "1530.00", accrualEntries: "1530.00",
              reversals: "0.00", adjustments: "0.00", paid: "200.00",
              outstanding: "1330.00", accrualRowsTotal: "1530.00", frozenReversedTotal: "0.00",
              expectedFromRows: "1530.00", reconciliationDifference: "0.00",
              reconciled: true, pendingCount: 3, approvedCount: 0 },
            // A period that has seen a refund. The rows still add to 1,040.00 because an
            // approved accrual is never rewritten; the 200.00 that came back is its own
            // figure, and the period still reconciles. Before the reconciliation control
            // was corrected this row read "off by -200.00" and nothing was wrong with it.
            { employeeId: "u2", name: "نورة السبيعي", accrued: "840.00", accrualEntries: "1040.00",
              reversals: "-200.00", adjustments: "0.00", paid: "0.00",
              outstanding: "840.00", accrualRowsTotal: "1040.00", frozenReversedTotal: "200.00",
              expectedFromRows: "840.00", reconciliationDifference: "0.00",
              reconciled: true, pendingCount: 0, approvedCount: 2 },
            // A genuine mismatch, so the control is visibly still able to fire.
            { employeeId: "u3", name: "خالد المطيري", accrued: "700.00", accrualEntries: "700.00",
              reversals: "0.00", adjustments: "-90.00", paid: "610.00",
              outstanding: "0.00", accrualRowsTotal: "685.00", frozenReversedTotal: "0.00",
              expectedFromRows: "685.00", reconciliationDifference: "15.00",
              reconciled: false, pendingCount: 0, approvedCount: 1 },
          ],
          accruals: [
            accrual("ac1", "ACCRUED", "1150.00", { customer: "مقهى ذوّاقة" }),
            accrual("ac2", "APPROVED", "840.00", { employee: OWNER2, customer: "كافيه ٢١" }),
            accrual("ac3", "PAID", "700.00", { employee: OWNER3, customer: "بن الشرق" }),
          ],
          totals: { accrued: "3070.00", adjustments: "-90.00", paid: "810.00", outstanding: "2170.00" },
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
