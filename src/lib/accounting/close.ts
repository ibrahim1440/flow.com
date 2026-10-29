// Accounting A5 — the month-end close and the year-end close.
//
// closeChecklist(periodId) runs the month's checks (council 01 «period close checklist»), each PASS / WARN / FAIL /
// NA with a count or an amount and the page that fixes it:
//   journals      no draft / submitted / approved journal left in the month                      FAIL (A1 refuses too)
//   documents     no sales-invoice draft supplied in the month, no supplier invoice still a draft / submitted   WARN
//   receipts      unapplied customer receipts and credits (AR)                                     WARN
//   grni          received, not yet billed in the books: open receipts vs the GRNI account                   WARN (review)
//   inventory     inventory sub-ledger = GL (A3 reconciliation: no UNEXPLAINED difference)         FAIL
//   supplierClaims open supplier claims (net) = SUPPLIER_CLAIMS («نقص من المورد»)                 FAIL (WARN: opening pending)
//   fixedAssets   the fixed-asset register = its GL accounts; the month's depreciation is run     FAIL / WARN (NA: none)
//   fixedAssetsReview  December only, with assets: review the useful lives and residual values      WARN (IAS 16.51)
//   deferrals     unrecognised deferrals = their balance-sheet accounts («قوالب التأجيل»)          FAIL (WARN: opening pending)
//   ar / ap       AR sub-ledger = GL (AR − customer advances); AP open items = GL                  WARN / FAIL
//   vat           the month's VAT documents = the VAT accounts' movement from documents             FAIL
//   zatca         the e-invoicing queue holds nothing pending / failed for the month (A4)          FAIL (NA while off)
//   trialBalance  the trial balance to the month end balances                                      FAIL
// softClose / close run it, record it (PeriodCloseReview, append-only) and then use A1's own period actions; a FAIL
// blocks the final close, a WARN needs a note (recorded). closeYear posts the CLOSING entry through the engine —
// every revenue / expense balance of the year to RETAINED_EARNINGS, dated 31 December — closes December and the
// fiscal year, and opens the next year (its twelve months; the balance-sheet balances simply carry on, the ledger
// being cumulative). Permissions are the routes' (A1 period duties + step-up); every write is audited.
import { Prisma } from "@/generated/prisma/client";
import { prisma, TX_OPTS } from "@/lib/db";
import { Decimal, ZERO, fix2 } from "./money";
import { dayText, riyadhDay } from "./dates";
import { refuse } from "./refusals";
import { setAuditContext, type AuditContext } from "./audit";
import { ensureFiscalYear, lockFiscalPeriod, closeFiscalPeriod as closeFiscalPeriodA1 } from "./fiscal-years";
import { postEntry, resolveRoles } from "./posting-engine";
import { trialBalance } from "./reports";
import { loadAccountInfo } from "./statements";
import { reconciliation } from "./ops/valuation";
import { rollForward as faRollForward } from "./fixed-assets/reports";
import { deferralReconciliation } from "./deferrals";
import { agingReport } from "@/lib/services/invoicing/ar";

type Tx = Prisma.TransactionClient;
export type CheckStatus = "PASS" | "WARN" | "FAIL" | "NA";
export type CheckResult = { key: string; status: CheckStatus; count: number | null; amount: string | null; ar: string; en: string; href: string };

const check = (key: string, status: CheckStatus, ar: string, en: string, href: string, count: number | null = null, amount: Decimal | string | null = null): CheckResult =>
  ({ key, status, count, amount: amount === null ? null : typeof amount === "string" ? amount : fix2(amount), ar, en, href });

async function periodOf(id: string) {
  const p = await prisma.fiscalPeriod.findUnique({ where: { id }, select: { id: true, year: true, periodNo: true, startDate: true, endDate: true, status: true } });
  if (!p) throw refuse("NOT_FOUND");
  return p;
}

/** The month's checks. Read-only; safe to run any time. */
export async function closeChecklist(periodId: string) {
  const p = await periodOf(periodId);
  const from = p.startDate, to = p.endDate, toDay = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()));
  const asOf = dayText(toDay);
  const settings = await prisma.accountingSettings.findUnique({ where: { id: "singleton" }, select: { accountingActive: true, goLiveDate: true } });
  const out: CheckResult[] = [];

  // 1. pending journals (A1's close refuses them too)
  const pendingJ = await prisma.journalEntry.count({ where: { fiscalPeriodId: p.id, status: { in: ["DRAFT", "SUBMITTED", "APPROVED"] } } });
  out.push(check("journals", pendingJ ? "FAIL" : "PASS", "لا قيود معلّقة (مسودة أو مقدّمة أو معتمدة غير مرحّلة)", "No pending journals (draft, submitted or approved, not posted)", "/dashboard/accounting/journals?status=pending", pendingJ));

  // 2. unposted documents of the month
  const [salesDrafts, apOpen] = await Promise.all([
    prisma.salesInvoice.count({ where: { status: "DRAFT", OR: [{ supplyDate: { gte: from, lte: toDay } }, { supplyDate: null, createdAt: { gte: from, lte: to } }] } }),
    prisma.supplierInvoice.count({ where: { status: { in: ["DRAFT", "SUBMITTED"] }, invoiceDate: { lte: toDay } } }),
  ]);
  out.push(check("documents", salesDrafts + apOpen ? "WARN" : "PASS", `مستندات غير صادرة: ${salesDrafts} مسودة فاتورة مبيعات، ${apOpen} فاتورة مشتريات لم تُرحَّل`, `Unissued documents: ${salesDrafts} sales-invoice drafts, ${apOpen} purchase invoices not posted`, apOpen ? "/dashboard/accounting/ap" : "/dashboard/sales/invoices?status=DRAFT", salesDrafts + apOpen));

  // 3–5. AR: unapplied receipts / credits; sub-ledger = GL
  const aging = await agingReport(prisma, null, asOf);
  const unapplied = aging.totals.unappliedCredit;
  const unappliedCount = aging.rows.filter((r) => r.aging.unappliedCredit.gt(0)).length;
  out.push(check("receipts", unapplied.gt(0) ? "WARN" : "PASS", "تحصيلات وإشعارات دائنة غير مخصّصة لفواتير", "Customer receipts and credits not applied to invoices", "/dashboard/sales/receivables", unappliedCount, unapplied));
  const recon = await reconciliation(asOf);
  const grniOpen = new Decimal(recon.grni.openReceipts), grniGl = new Decimal(recon.grni.gl);
  out.push(check("grni", !recon.grni.account ? "NA" : !grniGl.isZero() || !grniOpen.isZero() ? (grniOpen.minus(grniGl).isZero() ? "WARN" : "FAIL") : "PASS",
    `بضاعة مستلمة لم تُرحَّل فاتورتها: ${recon.grni.count} استلامًا (بلا فاتورة ${recon.grni.noInvoice.count}، فاتورة بانتظار الاعتماد ${recon.grni.awaitingApproval.count}) — راجعها (رصيد الحساب ${recon.grni.gl}، الفرق ${recon.grni.difference})`,
    `Received, not yet billed in the books: ${recon.grni.count} receipts (no invoice ${recon.grni.noInvoice.count}, invoice awaiting approval ${recon.grni.awaitingApproval.count}) — review them (account ${recon.grni.gl}, difference ${recon.grni.difference})`,
    "/dashboard/accounting/inventory?view=grni", recon.grni.count, recon.grni.gl));
  // «نقص من المورد» (council F1): open supplier claims (net) = the SUPPLIER_CLAIMS account.
  const sc = recon.supplierClaims;
  out.push(check("supplierClaims", !sc.account ? "NA" : sc.status === "MATCHED" ? "PASS" : sc.status === "EXPLAINED" ? "WARN" : "FAIL",
    sc.status === "MATCHED" ? `مطالبات الموردين المفتوحة = الحساب (${sc.openClaims})` : `مطالبات الموردين المفتوحة ${sc.openClaims} ≠ الحساب ${sc.gl} (الفرق ${sc.difference}${Number(sc.openingPending) ? `، منها ${sc.openingPending} بانتظار الأرصدة الافتتاحية` : ""})`,
    sc.status === "MATCHED" ? `Open supplier claims = the account (${sc.openClaims})` : `Open supplier claims ${sc.openClaims} ≠ the account ${sc.gl} (difference ${sc.difference}${Number(sc.openingPending) ? `, of which ${sc.openingPending} awaits the opening balances` : ""})`,
    "/dashboard/purchases?tab=claims", sc.count, sc.difference));
  // «الأصول الثابتة» (20261121090000_fixed_assets): the register = its GL accounts at the month end (FAIL when a
  // difference is not explained by what is not in the books yet), and the month's depreciation is run (WARN).
  const faCount = await prisma.fixedAsset.count({ where: { status: { not: "DRAFT" } } });
  if (!faCount) out.push(check("fixedAssets", "NA", "لا أصول ثابتة في السجل", "No fixed assets in the register", "/dashboard/accounting/fixed-assets"));
  else {
    const rf = await faRollForward(new Date(Date.UTC(toDay.getUTCFullYear(), 0, 1)), toDay);
    const bad = rf.tieOut.filter((t) => t.status === "UNEXPLAINED");
    const diff = rf.tieOut.reduce((t, x) => t.plus(new Decimal(x.difference).abs()), ZERO);
    const notRun = await prisma.fixedAsset.count({ where: { status: "ACTIVE", inServiceDate: { lte: toDay }, OR: [{ depreciatedThrough: null }, { depreciatedThrough: { lt: toDay } }] } });
    out.push(check("fixedAssets", bad.length ? "FAIL" : notRun || !rf.matched ? "WARN" : "PASS",
      bad.length ? `سجل الأصول الثابتة لا يطابق دفتر الأستاذ في ${bad.length} حساب` : notRun ? `لم يُرحَّل إهلاك الشهر لـ ${notRun} أصل` : rf.matched ? "سجل الأصول الثابتة = دفتر الأستاذ، وإهلاك الشهر مرحّل" : "سجل الأصول الثابتة = دفتر الأستاذ بعد البنود غير المرحّلة (الأرصدة الافتتاحية)",
      bad.length ? `The fixed-asset register differs from the ledger on ${bad.length} account(s)` : notRun ? `The month's depreciation is not run for ${notRun} asset(s)` : rf.matched ? "Fixed-asset register = ledger, the month's depreciation run" : "Fixed-asset register = ledger after the items not in the books yet (the opening)",
      notRun && !bad.length ? "/dashboard/accounting/fixed-assets/depreciation" : "/dashboard/accounting/fixed-assets?view=reports", bad.length || notRun || null, diff));
    // Council F5 (IAS 16.51 / SME 17.19): at least at each year end the useful lives and residual values are reviewed; a
    // change is recorded as «تعديل تقدير» (a revision, prospective). A WARN: the close records the reviewer's note.
    if (p.periodNo === 12) {
      const live = await prisma.fixedAsset.count({ where: { status: { in: ["ACTIVE", "FULLY_DEPRECIATED"] } } });
      out.push(check("fixedAssetsReview", "WARN",
        `نهاية السنة: راجع الأعمار الإنتاجية والقيم المتبقية لـ ${live} أصل ثابت، وسجّل أي تغيير «تعديل تقدير» (مستقبليًا)`,
        `Year end: review the useful lives and residual values of ${live} fixed asset(s); record any change as a «change of estimate» (prospective)`,
        "/dashboard/accounting/fixed-assets?status=ACTIVE", live));
    }
  }
  // «قوالب التأجيل» (council F2): the unrecognised amount of the schedules = their balance-sheet accounts, difference 0;
  // WARN when the difference is only the go-live opening still to post.
  const dr = await deferralReconciliation(toDay);
  const drDiff = dr.reduce((t, r) => t.plus(r.difference), ZERO), drOpen = dr.reduce((t, r) => t.plus(r.openingPending), ZERO);
  const drStatus: CheckStatus = !dr.length ? "NA" : dr.every((r) => r.status === "MATCHED") ? "PASS" : dr.every((r) => r.status !== "UNEXPLAINED") ? "WARN" : "FAIL";
  out.push(check("deferrals", drStatus,
    drStatus === "PASS" || drStatus === "NA" ? "المؤجلات غير المعترف بها = حسابات الميزانية" : `المؤجلات غير المعترف بها ≠ حسابات الميزانية (الفرق ${fix2(drDiff)}${drOpen.isZero() ? "" : `، منها ${fix2(drOpen)} بانتظار الأرصدة الافتتاحية`})`,
    drStatus === "PASS" || drStatus === "NA" ? "Unrecognised deferrals = their balance-sheet accounts" : `Unrecognised deferrals ≠ their balance-sheet accounts (difference ${fix2(drDiff)}${drOpen.isZero() ? "" : `, of which ${fix2(drOpen)} awaits the opening balances`})`,
    "/dashboard/accounting/deferrals", dr.filter((r) => r.status !== "MATCHED").length, drDiff));
  const unexplained = recon.inventory.filter((r) => r.status === "UNEXPLAINED");
  out.push(check("inventory", unexplained.length ? "FAIL" : recon.inventory.some((r) => r.status === "EXPLAINED") ? "WARN" : "PASS",
    unexplained.length ? `فرق غير مفسَّر بين سجل تكلفة المخزون ودفتر الأستاذ في ${unexplained.length} حساب` : "سجل تكلفة المخزون = دفتر الأستاذ",
    unexplained.length ? `Unexplained difference between the inventory cost ledger and the general ledger in ${unexplained.length} account(s)` : "Inventory cost ledger = general ledger",
    "/dashboard/accounting/inventory", unexplained.length, recon.totals.difference));
  const roles = await prisma.accountRole.findMany({ where: { tenantId: "hiqbah", role: { in: ["AR", "CUSTOMER_ADVANCES"] } }, select: { accountId: true } });
  const arGl = roles.length ? await prisma.$queryRaw<{ v: Prisma.Decimal }[]>`
    SELECT coalesce(sum(l."debit" - l."credit"), 0) AS v FROM "JournalEntryLine" l JOIN "JournalEntry" j ON j."id" = l."journalEntryId"
     WHERE l."accountId" = ANY(${roles.map((r) => r.accountId)}) AND j."status" IN ('POSTED', 'REVERSED') AND j."type"::text <> 'OPENING' AND j."entryDate" <= ${to}` : [{ v: 0 }];
  // The sub-ledger AS OF the month end: issued invoices / debit notes − credit notes, less the receipts approved by
  // then (a receipt reversed after the month end still counted) — Σ debits − Σ credits, so applications do not matter.
  const [sub] = await prisma.$queryRaw<{ v: Prisma.Decimal }[]>`
    SELECT (SELECT coalesce(sum(CASE WHEN "kind" = 'CREDIT_NOTE' THEN -"grandTotal" ELSE "grandTotal" END), 0) FROM "SalesInvoice" WHERE "status" = 'ISSUED' AND "issueDate" <= ${toDay})
         - (SELECT coalesce(sum("amountGross"), 0) FROM "SalesCollection" WHERE ("status"::text = 'APPROVED' OR ("status"::text = 'REVERSED' AND "reversedAt" > ${to})) AND "collectedAt" <= ${new Date(to.getTime() - 3 * 3600_000)}) AS v`;
  const arDiff = new Decimal(String(sub?.v ?? 0)).minus(new Decimal(String(arGl[0]?.v ?? 0)));
  const beforeGoLive = !settings?.goLiveDate || toDay < settings.goLiveDate;
  out.push(check("ar", !settings?.accountingActive || beforeGoLive ? "NA" : arDiff.isZero() ? "PASS" : "WARN",
    `الذمم المدينة (الدفتر الفرعي) = الأستاذ العام (الذمم − الدفعات المقدمة) دون الأرصدة الافتتاحية؛ الفرق ${fix2(arDiff)} — مستندات قبل تاريخ البدء تفسّره`,
    `AR sub-ledger = GL (AR − customer advances) excluding opening balances; difference ${fix2(arDiff)} — documents before go-live explain it`,
    "/dashboard/sales/receivables", null, arDiff));
  // AP: open supplier invoices + the opening supplier balances still unpaid = the AP account. Opening balances come
  // from the old books (A1 opening grid) with no invoice in the system and are paid through an AP payment's unapplied
  // part (A5). A difference is a WARN (a note at close), not a block: the accountant explains it.
  const apRole = await prisma.accountRole.findUnique({ where: { tenantId_role: { tenantId: "hiqbah", role: "AP" } }, select: { accountId: true } });
  const [apOpening] = apRole ? await prisma.$queryRaw<{ v: Prisma.Decimal }[]>`
    SELECT (SELECT coalesce(sum(l."credit" - l."debit"), 0) FROM "JournalEntryLine" l JOIN "JournalEntry" j ON j."id" = l."journalEntryId"
             WHERE l."accountId" = ${apRole.accountId} AND j."type"::text = 'OPENING' AND j."status" IN ('POSTED', 'REVERSED') AND j."entryDate" <= ${to})
         - (SELECT coalesce(sum(p."amount" - coalesce((SELECT sum(a."amount") FROM "SupplierPaymentAllocation" a WHERE a."paymentId" = p."id"), 0)), 0)
              FROM "SupplierPayment" p WHERE p."status" = 'POSTED' AND p."paymentDate" <= ${toDay}) AS v` : [{ v: 0 }];
  const apDiff = new Decimal(recon.ap.difference).plus(String(apOpening?.v ?? 0));
  out.push(check("ap", !recon.ap.account || beforeGoLive ? "NA" : apDiff.isZero() ? "PASS" : "WARN",
    `الذمم الدائنة (الفواتير المفتوحة + الأرصدة الافتتاحية غير المسددة) = الأستاذ العام؛ الفرق ${fix2(apDiff)}`, `AP (open invoices + unpaid opening balances) = GL; difference ${fix2(apDiff)}`,
    "/dashboard/accounting/ap?view=aging", null, apDiff));

  // 6. VAT: the month's documents = the VAT accounts' movement from documents
  const vat = await vatMonth(from, to);
  // Output and input are checked apart: an error on one side never hides behind an opposite error on the other.
  const vatOk = vat.outputDifference.isZero() && vat.inputDifference.isZero();
  out.push(check("vat", !settings?.accountingActive ? "NA" : vatOk ? "PASS" : "FAIL",
    `ضريبة المستندات المرحّلة = حركة حسابات الضريبة في الأستاذ؛ فرق المخرجات ${fix2(vat.outputDifference)} · فرق المدخلات ${fix2(vat.inputDifference)}`, `VAT on posted documents = the VAT accounts' movement; output difference ${fix2(vat.outputDifference)} · input difference ${fix2(vat.inputDifference)}`,
    `/dashboard/accounting/reports?view=vat&year=${p.year}&q=${Math.floor((p.periodNo - 1) / 3) + 1}`, null, vat.difference));

  // 7. ZATCA queue (A4): nothing pending / failed for documents signed up to the month end
  out.push(await zatcaCheck(to));

  // 8. trial balance
  const tb = await trialBalance(new Date(Date.UTC(p.year, 0, 1)), to);
  out.push(check("trialBalance", tb.balanced ? "PASS" : "FAIL", "ميزان المراجعة متوازن", "The trial balance balances", `/dashboard/accounting/reports?from=${p.year}-01-01&to=${asOf}`, null, tb.totals.closingDebit));

  const blocking = out.filter((c) => c.status === "FAIL").length;
  const warnings = out.filter((c) => c.status === "WARN").length;
  return { period: { id: p.id, year: p.year, periodNo: p.periodNo, status: String(p.status), from: dayText(from), to: asOf }, checks: out, blocking, warnings, ready: blocking === 0, active: !!settings?.accountingActive };
}

/** VAT on the month's posted documents vs the VAT_OUTPUT / VAT_INPUT movement posted from documents. */
async function vatMonth(from: Date, to: Date) {
  const rows = await prisma.$queryRaw<{ role: string; v: Prisma.Decimal }[]>`
    SELECT r."role", coalesce(sum(l."debit" - l."credit"), 0) AS v
      FROM "JournalEntryLine" l JOIN "JournalEntry" j ON j."id" = l."journalEntryId" JOIN "AccountRole" r ON r."accountId" = l."accountId" AND r."tenantId" = 'hiqbah'
     WHERE r."role" IN ('VAT_OUTPUT', 'VAT_INPUT') AND j."status" IN ('POSTED', 'REVERSED') AND j."sourceModule" IN ('sales', 'purchasing')
       AND j."entryDate" >= ${from} AND j."entryDate" <= ${to}
     GROUP BY 1`;
  const gl = (role: string) => new Decimal(String(rows.find((r) => r.role === role)?.v ?? 0));
  const docs = await prisma.$queryRaw<{ kind: string; v: Prisma.Decimal }[]>`
    SELECT 'sales' AS kind, coalesce(sum(CASE WHEN i."kind" = 'CREDIT_NOTE' THEN -i."taxTotal" ELSE i."taxTotal" END), 0) AS v
      FROM "SalesInvoice" i JOIN "JournalEntry" j ON j."sourceId" = i."id" AND j."sourceType" IN ('SALES_INVOICE', 'CREDIT_NOTE', 'DEBIT_NOTE') AND j."status" IN ('POSTED', 'REVERSED')
     WHERE j."entryDate" >= ${from} AND j."entryDate" <= ${to}
    UNION ALL
    SELECT 'purchases', coalesce(sum(CASE WHEN j."type"::text = 'REVERSAL' THEN -v.claimed ELSE v.claimed END), 0)
      FROM "JournalEntry" j JOIN LATERAL (${PURCHASE_VAT_SQL}) v ON true
     WHERE j."sourceType" = 'SUPPLIER_INVOICE' AND j."sourceEvent" IN ('POSTED', 'POSTED.REVERSED') AND j."status" IN ('POSTED', 'REVERSED')
       AND j."entryDate" >= ${from} AND j."entryDate" <= ${to}
    UNION ALL
    SELECT 'reverseCharge', coalesce(sum(CASE WHEN j."type"::text = 'REVERSAL' THEN -v.rc ELSE v.rc END), 0)
      FROM "JournalEntry" j JOIN LATERAL (${PURCHASE_VAT_SQL}) v ON true
     WHERE j."sourceType" = 'SUPPLIER_INVOICE' AND j."sourceEvent" IN ('POSTED', 'POSTED.REVERSED') AND j."status" IN ('POSTED', 'REVERSED')
       AND j."entryDate" >= ${from} AND j."entryDate" <= ${to}`;
  const d = (k: string) => new Decimal(String(docs.find((x) => x.kind === k)?.v ?? 0));
  // Phase 2: the input VAT a bill claims is its recoverable / import VAT plus the reverse charge's self-assessed VAT
  // (a not-recoverable VAT is cost, never VAT_INPUT); the reverse charge also posts to VAT_OUTPUT.
  const outputDifference = d("sales").plus(d("reverseCharge")).minus(gl("VAT_OUTPUT").negated());
  const inputDifference = d("purchases").minus(gl("VAT_INPUT"));
  return { salesDocs: d("sales").plus(d("reverseCharge")), purchaseDocs: d("purchases"), glOutput: gl("VAT_OUTPUT").negated(), glInput: gl("VAT_INPUT"), outputDifference, inputDifference, difference: outputDifference.abs().plus(inputDifference.abs()) };
}

/** Per posted supplier invoice (j."sourceId"): the input VAT it claims and the reverse-charge VAT it self-assessed. */
const PURCHASE_VAT_SQL = Prisma.sql`
  SELECT coalesce(sum(CASE WHEN coalesce(l."taxSnapshot" ->> 'inputVatTreatment', c."inputVatTreatment", 'RECOVERABLE') = 'NON_RECOVERABLE' THEN 0 ELSE l."vat" END)
                  + sum(coalesce(l."selfAssessedVat", 0)), 0) AS claimed,
         coalesce(sum(coalesce(l."selfAssessedVat", 0)), 0) AS rc
    FROM "SupplierInvoiceLine" l LEFT JOIN "TaxCategory" c ON c."id" = l."taxCategoryId" WHERE l."invoiceId" = j."sourceId"`;

/** A4 feature detection: the e-invoicing tables may not exist (a database before 20261105090000) or the switch is OFF. */
async function zatcaCheck(to: Date): Promise<CheckResult> {
  const href = "/dashboard/accounting/zatca";
  try {
    const exists = await prisma.$queryRaw<{ t: string | null }[]>`SELECT to_regclass('"ZatcaDocument"')::text AS t`;
    if (!exists[0]?.t) return check("zatca", "NA", "الفوترة الإلكترونية (المرحلة الثانية) غير مثبّتة بعد", "E-invoicing (Phase 2) is not installed yet", href);
    const [docs, mode] = await Promise.all([
      prisma.zatcaDocument.count({ where: { status: { in: ["PENDING", "ERROR", "REJECTED"] }, signedAt: { lte: to } } }),
      prisma.zatcaSettings.findUnique({ where: { id: "singleton" }, select: { mode: true } }).catch(() => null),
    ]);
    const off = !mode || mode.mode === "OFF";
    if (off && docs === 0) return check("zatca", "NA", "الربط مع الهيئة غير مفعّل", "E-invoicing is off", href, 0);
    return check("zatca", docs ? "FAIL" : "PASS", "طابور الفوترة الإلكترونية فارغ (لا مستند معلّق أو متعثر أو مرفوض)", "The e-invoicing queue is empty (nothing pending, failed or rejected)", href, docs);
  } catch {
    return check("zatca", "NA", "تعذّرت قراءة طابور الفوترة الإلكترونية", "The e-invoicing queue could not be read", href);
  }
}

async function record(tx: Tx, periodId: string, action: "REVIEW" | "SOFT_CLOSE" | "CLOSE" | "YEAR_END", list: Awaited<ReturnType<typeof closeChecklist>>, ctx: AuditContext, note: string | null) {
  return tx.periodCloseReview.create({ data: { fiscalPeriodId: periodId, action, results: list.checks as unknown as Prisma.InputJsonValue, blocking: list.blocking, warnings: list.warnings, note, actorId: ctx.actorId }, select: { id: true, at: true } });
}

const noteOf = (v: unknown) => (typeof v === "string" && v.trim().length >= 3 ? v.trim().slice(0, 1000) : null);

/** Run and record the checklist without changing the period («مراجعة»). */
export async function reviewPeriod(periodId: string, note: unknown, ctx: AuditContext) {
  const list = await closeChecklist(periodId);
  const rec = await prisma.$transaction(async (tx) => { await setAuditContext(tx, ctx); return record(tx, periodId, "REVIEW", list, ctx, noteOf(note)); });
  return { ...list, review: rec };
}

// The checklist of a soft / final close is computed AFTER the period row is locked FOR UPDATE (inside the callback A1's
// lock / close runs under that lock) and recorded in the same transaction. An engine posting holds the period FOR
// SHARE until it commits (posting-engine.ts openPeriodFor), so by the time the lock is held every posting of the month
// has committed, and a later one waits — the recorded checklist sees exactly the books the period is locked with
// (audit F-3 follow-up). The checklist's reads use their own pooled connections and need no lock, so they cannot
// deadlock with the held period row.
type Checklist = Awaited<ReturnType<typeof closeChecklist>>;

/** Soft close: the checklist is recorded, then A1's lock (OPEN → LOCKED). Never blocked: it stops posting so the close can begin. */
export async function softClosePeriod(periodId: string, note: unknown, ctx: AuditContext) {
  let list!: Checklist;
  // The record and the lock commit together (a refused lock records nothing).
  const period = await lockFiscalPeriod(periodId, ctx, async (tx) => {
    list = await closeChecklist(periodId);
    return record(tx, periodId, "SOFT_CLOSE", list, ctx, noteOf(note));
  });
  return { ...list, period };
}

/** Final close: refused while a check FAILs; a WARN needs a note (recorded). Then A1's close (LOCKED → CLOSED). */
export async function closePeriodWithChecklist(periodId: string, note: unknown, ctx: AuditContext) {
  const n = noteOf(note);
  let list!: Checklist;
  const period = await closeFiscalPeriodA1(periodId, { ...ctx, reason: n }, async (tx) => {
    list = await closeChecklist(periodId);
    if (list.blocking) throw refuse("CLOSE_BLOCKED", `(${list.checks.filter((c) => c.status === "FAIL").map((c) => c.key).join(", ")})`);
    if (list.warnings && !n) throw refuse("CLOSE_NOTE_REQUIRED");
    return record(tx, periodId, "CLOSE", list, ctx, n);
  });
  return { ...list, period };
}

/** Pure: the closing lines — each P&L account's balance reversed, the net to retained earnings. */
export function closingLines(balances: { accountId: string; net: Decimal }[], retainedEarningsAccountId: string) {
  const lines: { accountId: string; debit?: string; credit?: string; description: string }[] = [];
  let total = ZERO;
  for (const b of balances) {
    if (b.net.isZero()) continue;
    total = total.plus(b.net);
    lines.push(b.net.isPositive() ? { accountId: b.accountId, credit: fix2(b.net), description: "إقفال حساب مصروف" } : { accountId: b.accountId, debit: fix2(b.net.abs()), description: "إقفال حساب إيراد" });
  }
  // total = Σ (debit − credit) of P&L = −profit. Profit (total < 0) credits retained earnings; a loss debits it.
  if (!total.isZero()) lines.push(total.isNegative() ? { accountId: retainedEarningsAccountId, credit: fix2(total.abs()), description: "صافي ربح السنة إلى الأرباح المبقاة" } : { accountId: retainedEarningsAccountId, debit: fix2(total), description: "صافي خسارة السنة من الأرباح المبقاة" });
  return { lines, netProfit: total.negated() };
}

/**
 * Year-end close of a Gregorian (= fiscal) year: every month LOCKED or CLOSED, December LOCKED (soft-closed: the
 * closing entry is its last posting). Posts the CLOSING entry (accounting · YEAR_END · <year> · CLOSED, dated
 * 31 December; idempotent), records the checklist of December, closes December, marks the year CLOSED and creates
 * the next year. A year with no P&L balance closes without an entry.
 */
export async function closeYear(year: number, note: unknown, ctx: AuditContext) {
  if (!Number.isInteger(year) || year < 2000 || year > 2200) throw refuse("BAD_INPUT", "year.");
  const fy = await prisma.fiscalYear.findUnique({ where: { tenantId_year: { tenantId: "hiqbah", year } }, include: { periods: { orderBy: { periodNo: "asc" } } } });
  if (!fy) throw refuse("NOT_FOUND");
  if (fy.status === "CLOSED") throw refuse("YEAR_CLOSED");
  const dec = fy.periods.find((p) => p.periodNo === 12);
  if (fy.periods.length !== 12 || !dec || dec.status !== "LOCKED" || fy.periods.some((p) => p.status === "OPEN")) throw refuse("YEAR_NOT_READY");
  const n = noteOf(note);
  const accounts = await loadAccountInfo();
  const yearEnd = new Date(Date.UTC(year, 11, 31));
  let list!: Checklist;
  const result = await prisma.$transaction(async (tx) => {
    await setAuditContext(tx, { ...ctx, reason: n ?? `year-end close ${year}` });
    // December held first (as softClosePeriod does), then the checklist on the books it is closed with.
    const held = await tx.$queryRaw<{ status: string }[]>`SELECT "status"::text AS status FROM "FiscalPeriod" WHERE "id" = ${dec.id} FOR UPDATE`;
    if (held[0]?.status !== "LOCKED") throw refuse("YEAR_NOT_READY");
    list = await closeChecklist(dec.id);
    if (list.blocking) throw refuse("CLOSE_BLOCKED", `(${list.checks.filter((c) => c.status === "FAIL").map((c) => c.key).join(", ")})`);
    if (list.warnings && !n) throw refuse("CLOSE_NOTE_REQUIRED");
    const [re] = [...(await resolveRoles(tx, ["RETAINED_EARNINGS"])).values()];
    // Every P&L account's cumulative balance to the year end (earlier years never closed are closed too).
    const rows = await tx.$queryRaw<{ accountId: string; v: Prisma.Decimal }[]>`
      SELECT l."accountId", coalesce(sum(l."debit" - l."credit"), 0) AS v FROM "JournalEntryLine" l JOIN "JournalEntry" j ON j."id" = l."journalEntryId"
        JOIN "Account" a ON a."id" = l."accountId"
       WHERE j."status" IN ('POSTED', 'REVERSED') AND j."entryDate" <= ${new Date(yearEnd.getTime() + 86_399_999)} AND a."type"::text IN ('REVENUE', 'EXPENSE')
       GROUP BY 1 ORDER BY 1`;
    const balances = rows.map((r) => ({ accountId: r.accountId, net: new Decimal(String(r.v)) })).filter((b) => accounts.has(b.accountId));
    const { lines, netProfit } = closingLines(balances, re);
    let entryId: string | null = null;
    if (lines.length >= 2) {
      // A CLOSING entry is the one posting a soft-closed (LOCKED) December takes (posting-engine: allowSoftClosed).
      const r = await postEntry(tx, { source: { module: "accounting", type: "YEAR_END", id: String(year), event: "CLOSED" }, date: dayText(yearEnd), memo: `إقفال السنة المالية ${year}: الإيرادات والمصروفات إلى الأرباح المبقاة`, createdBy: ctx.actorId, entryType: "CLOSING", lines });
      if (r.status === "posted") entryId = r.entryId;
    }
    await record(tx, dec.id, "YEAR_END", list, ctx, n);
    // December: LOCKED → CLOSED in the same transaction (A1's rule: nothing pending).
    const locked = await tx.$queryRaw<{ status: string }[]>`SELECT "status"::text AS status FROM "FiscalPeriod" WHERE "id" = ${dec.id} FOR UPDATE`;
    if (locked[0]?.status !== "LOCKED") throw refuse("YEAR_NOT_READY");
    if (await tx.journalEntry.count({ where: { fiscalPeriodId: dec.id, status: { in: ["DRAFT", "SUBMITTED", "APPROVED"] } } })) throw refuse("PERIOD_PENDING");
    await tx.fiscalPeriod.update({ where: { id: dec.id }, data: { status: "CLOSED", closedAt: new Date(), closedBy: ctx.actorId } });
    await tx.fiscalYear.update({ where: { id: fy.id }, data: { status: "CLOSED", closedAt: new Date(), closedBy: ctx.actorId, closingEntryId: entryId } });
    await ensureFiscalYear(tx, year + 1, ctx.actorId);
    return { entryId, netProfit: fix2(netProfit), lines: lines.length };
  }, { ...TX_OPTS, timeout: 60_000 });
  return { year, ...result, nextYear: year + 1, closedAt: dayText(riyadhDay()) };
}

/** The recorded reviews of a period (newest first). */
export async function closeHistory(periodId: string) {
  return prisma.periodCloseReview.findMany({ where: { fiscalPeriodId: periodId }, orderBy: { at: "desc" }, take: 50 });
}
