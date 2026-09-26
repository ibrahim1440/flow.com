// What each bank classification means at company level. Shared by client and server.

export const RECEIPT_CLASSES = [
  "CUSTOMER_RECEIPT",
  "POS_SETTLEMENT",
  "GATEWAY_SETTLEMENT",
  "OTHER_OPERATING_RECEIPT",
  "LOAN_PROCEEDS",
  "OWNER_CONTRIBUTION",
  "REFUND_RECEIVED",
] as const;

export const PAYMENT_CLASSES = [
  "SUPPLIER_PAYMENT",
  "PAYROLL",
  "RENT",
  "UTILITIES_OPERATING",
  "TAX_PAYMENT",
  "LOAN_PRINCIPAL_REPAYMENT",
  "LOAN_INTEREST",
  "BANK_FEE",
  "CUSTOMER_REFUND",
  "OWNER_DRAWING",
  "OTHER_OPERATING_PAYMENT",
] as const;

export const ALL_CLASSES = ["UNCLASSIFIED", ...RECEIPT_CLASSES, "INTERNAL_TRANSFER", ...PAYMENT_CLASSES] as const;
export type TxnClass = (typeof ALL_CLASSES)[number];

/** Not sales, not operating: never part of an operating-receipt total or a default base. */
export const FINANCING_RECEIPTS: TxnClass[] = ["LOAN_PROCEEDS", "OWNER_CONTRIBUTION"];
/** Not operating expenses. */
export const FINANCING_PAYMENTS: TxnClass[] = ["LOAN_PRINCIPAL_REPAYMENT", "OWNER_DRAWING"];

/** Default percentage base: operating receipts only. */
export const DEFAULT_BASE_CLASSES: TxnClass[] = ["CUSTOMER_RECEIPT", "POS_SETTLEMENT", "GATEWAY_SETTLEMENT", "OTHER_OPERATING_RECEIPT"];

export const SETTLEMENT_CLASSES: TxnClass[] = ["POS_SETTLEMENT", "GATEWAY_SETTLEMENT"];

export function classDirection(c: TxnClass): "IN" | "OUT" | "EITHER" {
  if ((RECEIPT_CLASSES as readonly string[]).includes(c)) return "IN";
  if ((PAYMENT_CLASSES as readonly string[]).includes(c)) return "OUT";
  return "EITHER";
}

/** Cash that may be earmarked: any confirmed, reviewed inflow that is not a transfer. */
export function isAllocatableClass(c: TxnClass): boolean {
  return (RECEIPT_CLASSES as readonly string[]).includes(c);
}

export const CLASS_LABELS: Record<TxnClass, { en: string; ar: string }> = {
  UNCLASSIFIED: { en: "Unclassified", ar: "غير مصنفة" },
  CUSTOMER_RECEIPT: { en: "Customer receipt", ar: "تحصيل من عميل" },
  POS_SETTLEMENT: { en: "POS settlement (net of fees)", ar: "تسوية نقاط البيع (صافي الرسوم)" },
  GATEWAY_SETTLEMENT: { en: "Online gateway settlement", ar: "تسوية بوابة الدفع الإلكتروني" },
  OTHER_OPERATING_RECEIPT: { en: "Other operating receipt", ar: "مقبوضات تشغيلية أخرى" },
  INTERNAL_TRANSFER: { en: "Transfer between company accounts", ar: "تحويل بين حسابات الشركة" },
  LOAN_PROCEEDS: { en: "Loan proceeds (not sales)", ar: "متحصلات قرض (ليست مبيعات)" },
  OWNER_CONTRIBUTION: { en: "Owner contribution (not sales)", ar: "مساهمة المالك (ليست مبيعات)" },
  REFUND_RECEIVED: { en: "Refund received", ar: "استرداد مستلم" },
  SUPPLIER_PAYMENT: { en: "Supplier payment", ar: "دفعة لمورد" },
  PAYROLL: { en: "Payroll", ar: "الرواتب" },
  RENT: { en: "Rent", ar: "الإيجار" },
  UTILITIES_OPERATING: { en: "Utilities & operating", ar: "المرافق والتشغيل" },
  TAX_PAYMENT: { en: "Tax payment", ar: "سداد ضريبة" },
  LOAN_PRINCIPAL_REPAYMENT: { en: "Loan principal (not an expense)", ar: "سداد أصل القرض (ليس مصروفاً)" },
  LOAN_INTEREST: { en: "Loan interest", ar: "فوائد القرض" },
  BANK_FEE: { en: "Bank fee", ar: "رسوم بنكية" },
  CUSTOMER_REFUND: { en: "Customer refund", ar: "رد مبلغ لعميل" },
  OWNER_DRAWING: { en: "Owner drawing (not an expense)", ar: "مسحوبات المالك (ليست مصروفاً)" },
  OTHER_OPERATING_PAYMENT: { en: "Other operating payment", ar: "مدفوعات تشغيلية أخرى" },
};
