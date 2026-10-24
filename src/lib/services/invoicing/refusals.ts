// Sales invoicing A2 — every refusal of the invoicing and AR services, in Arabic and English, with a stable code
// and an HTTP status; and the database guards' own refusals ("SINV: …", 20261103090000_sales_invoicing) mapped
// to the same codes, so a guard firing is a coded 409, never a 500. The routes answer through invError().
import { NextResponse } from "@/lib/api-response";
import { AccountingError, accountingErrorJson } from "@/lib/accounting/errors";
import { acctError } from "@/lib/accounting/http";

type R = { status: number; en: string; ar: string };

export const INV_REFUSALS = {
  BAD_INPUT: { status: 400, en: "The request is not valid.", ar: "الطلب غير صالح." },
  NOT_FOUND: { status: 404, en: "Not found.", ar: "غير موجود." },
  CUSTOMER_NOT_FOUND: { status: 404, en: "Customer not found.", ar: "العميل غير موجود." },
  ORDER_NOT_FOUND: { status: 404, en: "Order not found.", ar: "الطلب غير موجود." },
  DRAFT_ONLY: { status: 409, en: "Only a draft can be edited or cancelled.", ar: "تُعدَّل المسودة أو تُلغى فقط؛ المستند الصادر لا يتغير." },
  ALREADY_CANCELLED: { status: 409, en: "This draft is cancelled.", ar: "هذه المسودة ملغاة." },
  LINES_INVALID: { status: 400, en: "Some lines are not valid.", ar: "بعض البنود غير صحيحة." },
  NOT_READY: { status: 409, en: "The document cannot be issued yet.", ar: "لا يمكن إصدار المستند بعد." },
  OVER_INVOICED: { status: 409, en: "This would invoice more than the order line holds.", ar: "الكمية تتجاوز المتبقي دون فوترة على بند الطلب." },
  NOTHING_TO_INVOICE: { status: 409, en: "Nothing is left to invoice on this order.", ar: "لا يوجد ما يُفوتر في هذا الطلب." },
  OVER_CREDITED: { status: 409, en: "A credit note credits at most what the invoice charged.", ar: "الإشعار الدائن لا يتجاوز ما حمّلته الفاتورة الأصلية." },
  ORIGINAL_NOT_ISSUED: { status: 409, en: "A note is issued against an issued invoice.", ar: "يصدر الإشعار على فاتورة صادرة فقط." },
  REASON_REQUIRED: { status: 400, en: "A reason is required (at least 3 characters).", ar: "السبب مطلوب (3 أحرف على الأقل)." },
  SOD_SELF_ISSUE: { status: 409, en: "The preparer of a credit or debit note does not issue it (segregation of duties).", ar: "مُعدّ الإشعار لا يصدره بنفسه (فصل المهام)." },
  COLLECTION_NOT_APPROVED: { status: 409, en: "Only an approved receipt can be applied.", ar: "يُخصَّص التحصيل المعتمد فقط." },
  OVER_APPLIED: { status: 409, en: "The application exceeds the receipt or what the invoice owes.", ar: "التخصيص يتجاوز المتاح في السند أو المتبقي على الفاتورة." },
  CUSTOMER_MISMATCH: { status: 409, en: "The receipt and the invoice belong to different customers.", ar: "السند والفاتورة لعميلين مختلفين." },
  ALREADY_REVERSED: { status: 409, en: "This application is already reversed.", ar: "أُلغي هذا التخصيص مسبقًا." },
  SETTINGS_INVALID: { status: 400, en: "A setting is not valid.", ar: "قيمة إعداد غير صالحة." },
  INVOICE_DB: { status: 409, en: "The invoice register refused the change.", ar: "رفض سجل الفواتير التغيير." },
} satisfies Record<string, R>;

export type InvRefusalCode = keyof typeof INV_REFUSALS;

export function refuseInv(code: InvRefusalCode, detail?: string, detailAr?: string): AccountingError {
  const r: R = INV_REFUSALS[code];
  return new AccountingError(detail ? `${r.en} ${detail}` : r.en, r.status, code, detailAr ? `${r.ar} ${detailAr}` : r.ar);
}

const DB: [RegExp, InvRefusalCode][] = [
  [/SINV: over-invoicing/, "OVER_INVOICED"],
  [/SINV: a credit note line credits at most|SINV: credit notes credit at most|SINV: the credit notes of an invoice never exceed/, "OVER_CREDITED"],
  [/SINV: an application exceeds/, "OVER_APPLIED"],
  [/SINV: a receipt is applied only once approved/, "COLLECTION_NOT_APPROVED"],
  [/SINV: an issued invoice never changes|SINV: a line of an issued or cancelled invoice|SINV: a line is added or changed only on a draft|SINV: a cancelled draft never changes/, "DRAFT_ONLY"],
  [/SINV: a credit or debit note names an issued invoice/, "ORIGINAL_NOT_ISSUED"],
  [/SINV: /, "INVOICE_DB"],
];

export function sinvDbRefusal(message: string): AccountingError | null {
  if (!/SINV: /.test(message)) return null;
  const hit = DB.find(([re]) => re.test(message))!;
  const line = (/SINV: [^\n"]*/.exec(message)?.[0] ?? "").slice(0, 300);
  return refuseInv(hit[1], `(${line})`);
}

/** The routes' error answer: invoicing / accounting refusals coded, a database guard mapped, else the shared handling. */
export function invError(err: unknown): NextResponse {
  if (err instanceof AccountingError) return NextResponse.json({ ...accountingErrorJson(err), ...(err as AccountingError & { extra?: object }).extra }, { status: err.status });
  const msg = err instanceof Error ? `${err.message} ${JSON.stringify((err as { cause?: unknown }).cause ?? "")}` : String(err);
  const db = sinvDbRefusal(msg);
  if (db) return NextResponse.json(accountingErrorJson(db), { status: db.status });
  return acctError(err);
}

/** A refusal that carries a list (the issue checklist, the line problems) for the screen. */
export function refuseWith(code: InvRefusalCode, extra: Record<string, unknown>, detail?: string): AccountingError {
  const e = refuseInv(code, detail) as AccountingError & { extra?: object };
  e.extra = extra;
  return e;
}
