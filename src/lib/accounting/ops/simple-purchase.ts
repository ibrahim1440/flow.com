// «فواتير بسيطة» — simple expense invoices (BATCH22 WP-H, 20261130090000_simple_purchase; owner answer 5: the council's
// best practice). A simple invoice IS the purchase invoice ("SupplierInvoice", kind SIMPLE): the same SINV numbering, the
// same posting (postInvoiceTx: Dr the category's expense account + VAT input, Cr AP), the same AP, the same SoD.
//
//   what qualifies    1–5 EXPENSE lines (an expense category each), at most SAR 5,000 gross a line — no stock, no GRN,
//                     no import VAT / landed cost, no capitalisation or deferral (above the limit the form asks «هل هذا
//                     أصل ثابت أو مصروف مقدم؟» and links the full form)
//   the supplier      a named supplier, or «مورد نقدي متنوع» (sup_misc_cash) with the vendor's name (and VAT number)
//                     on the invoice; supplierRef stays required (the paper's number) and is unique per vendor
//   VAT               lines are entered GROSS («شامل؟» on): net = round(G ÷ (1 + r), 2), VAT = G − net, adjustable by
//                     ±0.01 to match the paper (cleanLines re-checks |VAT − round(net × r)| ≤ 0.01). VAT is claimed
//                     (P-S15, box 7) only with the vendor's VAT number — MISC-CASH: vendorVatNumber, otherwise the
//                     supplier's — and the receipt attached; otherwise the line is P-S15-NR (the VAT goes to the
//                     expense), or Z / E / O (out of scope: fees, fines) with no VAT
//   the receipt       an attachment is MANDATORY on every simple invoice (JPEG / PNG / PDF ≤ 10 MB, proven by its
//                     signature — ./attachments.ts); postInvoiceTx refuses a SIMPLE invoice without one
//   pay in the act    «مدفوعة من» (a cash / bank account — paidFromAccountId, WP-D) with «حفظ وموافقة»: the invoice is posted AND a supplier payment
//                     allocated to it is recorded in the SAME transaction — two entries, one act, or none
//   actions           draft («حفظ كمسودة») · submit («حفظ وتقديم للاعتماد», another person approves on the invoice page)
//                     · post («حفظ وموافقة»: accounting › ap; the SoD setting decides whether the preparer may post)
import { prisma, TX_OPTS } from "@/lib/db";
import { setAuditContext, type AuditContext } from "../audit";
import { Decimal, toDecimal } from "../money";
import { dayText, riyadhDay } from "../dates";
import { opsRefuse } from "./refusals";
import { cleanLines, getInvoice, header, inclusiveSplit, lineRows, lockInvoice, nextNumber, postInvoiceTx, recordPaymentTx, totals, type InvoiceLineInput } from "./ap";
import { purchaseTaxCategories } from "./purchase-tax";
import { addInvoiceAttachment, attachmentCount, cleanAttachment, type AttachmentFile } from "./attachments";
import { logPurchaseActivity } from "./purchase-activity";
import { defaultBranchForActor } from "../locations";


export const MISC_CASH_SUPPLIER_ID = "sup_misc_cash";
export const SIMPLE_MAX_LINES = 5;
export const SIMPLE_MAX_LINE_GROSS = new Decimal(5000);
/** The VAT categories a simple line may take (no import VAT, no reverse charge). */
export const SIMPLE_TAX_CODES = ["P-S15", "P-S15-NR", "P-Z0", "P-E0", "P-O"] as const;
const VAT_RE = /^3\d{13}3$/;

export type SimpleLineInput = { expenseCategoryId: string; description?: string | null; gross: string | number; taxCode?: string | null; vat?: string | number | null };
export type SimpleInvoiceInput = {
  supplierId?: string | null; vendorName?: string | null; vendorVatNumber?: string | null;
  supplierRef: string; invoiceDate: string; dueDate?: string | null; notes?: string | null; branchId?: string | null;
  lines: SimpleLineInput[]; action?: "draft" | "submit" | "post";
  /** «مدفوعة من» (WP-D «الحساب»): the cash / bank account that pays the invoice in the same act (action post only); the
   *  payment's method follows the account (a CASH account: cash, else a bank transfer). `paidFrom` CASH | BANK is the
   *  account-less form (before the chart of accounts exists: the method's role account). */
  paidFromAccountId?: string | null; paidFrom?: "CASH" | "BANK" | null; paymentReference?: string | null;
};

const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

function money2(v: unknown, what: string): Decimal {
  let d: Decimal;
  try { d = toDecimal(typeof v === "number" ? v.toFixed(2) : String(v ?? "")); } catch { throw opsRefuse("OPS_BAD_INPUT", `${what} is an amount.`, `${what}: مبلغ.`); }
  if (!d.equals(d.toDecimalPlaces(2))) throw opsRefuse("OPS_BAD_INPUT", `${what}: 2 decimals at most.`, `${what}: خانتان عشريتان كحد أقصى.`);
  return d;
}

/**
 * Pure: a gross-entered line split into net and VAT at `ratePct` — the ONE server-side «شامل؟» rule (ap.ts
 * inclusiveSplit, WP-K): net = round(G ÷ (1 + r), 2) HALF-UP, VAT = G − net; a VAT the paper shows (`vat`) replaces it
 * when |VAT − round(net × r)| ≤ 0.01 (and then net = G − VAT); a zero-rated line carries no VAT. Refused otherwise.
 * (A preview helper: the save itself sends the gross to cleanLines as an inclusive EXPENSE line.)
 */
export function splitGross(gross: Decimal, ratePct: Decimal, vat?: Decimal | null): { net: Decimal; vat: Decimal } {
  const s = inclusiveSplit(gross, ratePct, vat ?? null);
  if (!s) throw opsRefuse("SIMPLE_VAT_TOLERANCE");
  return s;
}

/** Pure: the simple-invoice rules on the raw lines (count, gross limit, a category each, an allowed VAT category). */
export function checkSimpleLines(lines: unknown): SimpleLineInput[] {
  if (!Array.isArray(lines) || lines.length < 1 || lines.length > SIMPLE_MAX_LINES) throw opsRefuse("SIMPLE_LINES");
  return (lines as SimpleLineInput[]).map((l, i) => {
    if (!l || typeof l !== "object" || typeof l.expenseCategoryId !== "string" || !l.expenseCategoryId) throw opsRefuse("SIMPLE_LINES", `Line ${i + 1}.`, `السطر ${i + 1}.`);
    const g = money2(l.gross, `Line ${i + 1} gross`);
    if (!g.gt(0)) throw opsRefuse("SIMPLE_LINES", `Line ${i + 1}: the amount is above zero.`, `السطر ${i + 1}: المبلغ أكبر من صفر.`);
    if (g.gt(SIMPLE_MAX_LINE_GROSS)) throw opsRefuse("SIMPLE_LINE_LIMIT", `Line ${i + 1}.`, `السطر ${i + 1}.`);
    const code = l.taxCode ?? "P-S15";
    if (!(SIMPLE_TAX_CODES as readonly string[]).includes(code)) throw opsRefuse("TAX_CATEGORY_INVALID", `Line ${i + 1}.`, `السطر ${i + 1}.`);
    return { ...l, gross: g.toFixed(2), taxCode: code };
  });
}

/** Pure: the vendor fields for the supplier (MISC-CASH: the name required, the VAT number optional; others: none). */
export function vendorOf(supplierId: string, name: unknown, vat: unknown): { vendorName: string | null; vendorVatNumber: string | null } {
  const vendorName = str(name, 200);
  const raw = typeof vat === "string" ? vat.replace(/\s+/g, "") : "";
  const vendorVatNumber = raw ? raw : null;
  if (supplierId !== MISC_CASH_SUPPLIER_ID) {
    if (vendorName || vendorVatNumber) throw opsRefuse("SIMPLE_VENDOR");
    return { vendorName: null, vendorVatNumber: null };
  }
  if (!vendorName || (vendorVatNumber && !VAT_RE.test(vendorVatNumber))) throw opsRefuse("SIMPLE_VENDOR");
  return { vendorName, vendorVatNumber };
}

export type SimpleGrants = { mayPost: boolean };

/**
 * Save a simple invoice — new (`id` null) or an existing simple DRAFT — with its receipt and its action. ONE transaction:
 * the invoice, its attachment, and (post) its entry, and («مدفوعة من») its payment and the payment's entry — all or none.
 */
export async function saveSimpleInvoice(input: SimpleInvoiceInput, file: AttachmentFile | null, id: string | null, ctx: AuditContext, grants: SimpleGrants) {
  const action = input?.action === "post" || input?.action === "submit" ? input.action : "draft";
  if (action === "post" && !grants.mayPost) throw opsRefuse("OPS_BAD_INPUT", "Approving needs accounting › ap.", "الاعتماد يحتاج صلاحية الذمم الدائنة.");
  const paidFromAccountId = typeof input?.paidFromAccountId === "string" && input.paidFromAccountId ? input.paidFromAccountId.slice(0, 64) : null;
  const paidFrom = paidFromAccountId ? null : input?.paidFrom === "CASH" || input?.paidFrom === "BANK" ? input.paidFrom : null;
  if ((paidFrom || paidFromAccountId) && action !== "post") throw opsRefuse("SIMPLE_PAY_NEEDS_POST");
  const raw = checkSimpleLines(input?.lines);
  const attachment = file ? cleanAttachment(file) : null;
  const supplierId = str(input?.supplierId, 64) ?? MISC_CASH_SUPPLIER_ID;
  const vendor = vendorOf(supplierId, input?.vendorName, input?.vendorVatNumber);

  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, ctx);
    const { h, supplier, branchId: givenBranch } = await header(tx, { ...input, supplierId, lines: [] } as never);
    const cur = id ? await lockInvoice(tx, id) : null;
    if (cur && (cur.kind !== "SIMPLE" || cur.status !== "DRAFT")) throw opsRefuse(cur.kind !== "SIMPLE" ? "SIMPLE_ONLY_HERE" : "INVOICE_STATE");
    if (!attachment && !(cur && (await attachmentCount(tx, cur.id)) > 0)) throw opsRefuse("SIMPLE_ATTACHMENT");

    // VAT: claimed (P-S15) only with the vendor's VAT number — MISC-CASH: on the invoice; otherwise the supplier's.
    const vatNumber = supplierId === MISC_CASH_SUPPLIER_ID ? vendor.vendorVatNumber : supplier.vatNumber;
    const tax = await purchaseTaxCategories(tx);
    const lines: InvoiceLineInput[] = raw.map((l, i) => {
      const tc = tax.byCode.get(String(l.taxCode));
      if (!tc || !tc.isActive) throw opsRefuse("TAX_CATEGORY_INVALID", `Line ${i + 1}.`, `السطر ${i + 1}.`);
      if (tc.inputVatTreatment === "RECOVERABLE" && !vatNumber) throw opsRefuse("SIMPLE_VAT_NUMBER", `Line ${i + 1}.`, `السطر ${i + 1}.`);
      const given = l.vat === undefined || l.vat === null || l.vat === "" ? null : money2(l.vat, `Line ${i + 1} VAT`);
      splitGross(new Decimal(String(l.gross)), new Decimal(tc.rate), given); // the simple form's own refusal code first
      // «شامل؟» (WP-K): the line goes to cleanLines by its gross — the one server-side inclusive path derives the net.
      return { kind: "EXPENSE", expenseCategoryId: l.expenseCategoryId, description: str(l.description, 300), net: "0", priceIncludesVat: true, grossEntered: l.gross, vat: given ? given.toFixed(2) : null, taxCode: tc.code };
    });
    // cleanLines splits the gross, checks the categories, the VAT rules and the ±0.01 VAT (the supplier carries the vendor's VAT number).
    const clean = await cleanLines(tx, { ...supplier, vatNumber: vatNumber ?? null }, lines);
    for (const [i, l] of clean.entries()) if (!l.gross.equals(new Decimal(String(raw[i].gross)))) throw opsRefuse("SIMPLE_VAT_TOLERANCE", `Line ${i + 1}.`, `السطر ${i + 1}.`);

    // The reference is unique per vendor (MISC-CASH) or per supplier, among live invoices.
    const dup = vendor.vendorName
      ? await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "SupplierInvoice" WHERE "supplierId" = ${supplierId} AND "vendorName" IS NOT NULL
          AND coalesce("vendorVatNumber", lower(btrim("vendorName"))) = coalesce(${vendor.vendorVatNumber}::text, lower(btrim(${vendor.vendorName})))
          AND lower(btrim("supplierRef")) = lower(btrim(${h.supplierRef})) AND "status" <> 'CANCELLED' AND "id" <> ${cur?.id ?? ""}`
      : await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "SupplierInvoice" WHERE "supplierId" = ${supplierId} AND "vendorName" IS NULL
          AND lower(btrim("supplierRef")) = lower(btrim(${h.supplierRef})) AND "status" <> 'CANCELLED' AND "id" <> ${cur?.id ?? ""}`;
    if ((dup[0]?.n ?? 0) > 0) throw opsRefuse("SUPPLIER_REF_DUPLICATE");

    const branchId = givenBranch !== undefined ? givenBranch : cur?.branchId ?? (await defaultBranchForActor(tx, ctx.actorId));
    const now = new Date();
    const status = action === "draft" ? { status: "DRAFT", submittedBy: null, submittedAt: null } : { status: "SUBMITTED", submittedBy: ctx.actorId, submittedAt: now };
    let invId: string;
    if (cur) {
      await tx.supplierInvoiceLine.deleteMany({ where: { invoiceId: cur.id } });
      await tx.supplierInvoice.update({ where: { id: cur.id }, data: { ...h, ...vendor, ...totals(clean), ...status, branchId, lastEditedBy: ctx.actorId, lines: { create: lineRows(clean) } } });
      invId = cur.id;
    } else {
      const number = await nextNumber(tx, "SINV", riyadhDay());
      invId = (await tx.supplierInvoice.create({
        data: { ...h, ...vendor, number, kind: "SIMPLE", origin: "PURCHASES", ...totals(clean), ...status, branchId, createdBy: ctx.actorId, lastEditedBy: ctx.actorId, lines: { create: lineRows(clean) } },
        select: { id: true },
      })).id;
    }
    if (attachment) await addInvoiceAttachment(tx, invId, attachment, ctx.actorId);
    await logPurchaseActivity(tx, ctx, action === "draft" ? "PURCHASE_INVOICE_SAVED" : "PURCHASE_INVOICE_SUBMITTED", invId, { simple: true, ...(attachment ? { attachment: { fileName: attachment.fileName, sizeBytes: attachment.sizeBytes, sha256: attachment.sha256 } } : {}) });
    let payment: { id: string; number: string } | null = null;
    if (action === "post") {
      await postInvoiceTx(tx, invId, ctx);
      if (paidFrom || paidFromAccountId) {
        const inv = await tx.supplierInvoice.findUniqueOrThrow({ where: { id: invId }, select: { grossTotal: true, invoiceDate: true, branchId: true } });
        // «الحساب»: the account decides the method (recordPaymentTx checks it is a postable cash / bank account).
        const acct = paidFromAccountId ? await tx.account.findUnique({ where: { id: paidFromAccountId }, select: { controlType: true } }) : null;
        const cash = paidFromAccountId ? acct?.controlType === "CASH" : paidFrom === "CASH";
        const p = await recordPaymentTx(tx, {
          supplierId, paymentDate: dayText(inv.invoiceDate), amount: new Decimal(inv.grossTotal).toFixed(2), method: cash ? "CASH" : "BANK_TRANSFER", paidFromAccountId,
          reference: str(input.paymentReference, 120), allocations: [{ invoiceId: invId, amount: new Decimal(inv.grossTotal).toFixed(2) }], branchId: inv.branchId,
        }, ctx);
        payment = { id: p.id, number: p.number };
      }
    }
    return { invoice: await getInvoice(invId, tx), payment };
  }, { ...TX_OPTS, timeout: 60_000 });
}
