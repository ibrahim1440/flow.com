// ZATCA Phase 2 (A4) — every refusal of the e-invoicing services, bilingual, coded, with an HTTP status; and the
// database guards' own refusals ("ZATCA: …", "NUMBERING: …", 20261105090000_zatca_phase2) mapped to a coded 409.
import { NextResponse } from "@/lib/api-response";
import { AccountingError, accountingErrorJson } from "@/lib/accounting/errors";
import { acctError } from "@/lib/accounting/http";

type R = { status: number; en: string; ar: string };

export const ZATCA_REFUSALS = {
  BAD_INPUT: { status: 400, en: "The request is not valid.", ar: "الطلب غير صالح." },
  NOT_FOUND: { status: 404, en: "Not found.", ar: "غير موجود." },
  KEY_NOT_CONFIGURED: { status: 503, en: "ZATCA_KEY_ENCRYPTION_KEY is not configured on this server.", ar: "مفتاح تشفير أسرار الفوترة الإلكترونية (ZATCA_KEY_ENCRYPTION_KEY) غير مهيأ على الخادم." },
  SERVER_DISABLED: { status: 409, en: "E-invoicing is switched off on this server (ZATCA_ENABLED).", ar: "الفوترة الإلكترونية موقوفة على هذا الخادم (ZATCA_ENABLED)." },
  PRODUCTION_NOT_ALLOWED: { status: 409, en: "Production is not allowed on this server (ZATCA_PRODUCTION_ALLOWED).", ar: "بيئة الإنتاج غير مسموحة على هذا الخادم (ZATCA_PRODUCTION_ALLOWED)." },
  CSR_INVALID: { status: 400, en: "The EGS particulars are not valid.", ar: "بيانات وحدة الفوترة غير صحيحة." },
  WRONG_STEP: { status: 409, en: "This onboarding step is not available now.", ar: "خطوة التسجيل هذه غير متاحة الآن." },
  OTP_REQUIRED: { status: 400, en: "Enter the 6-digit OTP from the Fatoora portal.", ar: "أدخل رمز التحقق (6 أرقام) من بوابة فاتورة." },
  ZATCA_REFUSED: { status: 502, en: "ZATCA refused the request.", ar: "رفضت الهيئة الطلب." },
  ZATCA_UNREACHABLE: { status: 504, en: "ZATCA could not be reached. Nothing was changed; try again.", ar: "تعذّر الوصول إلى الهيئة. لم يتغير شيء؛ أعد المحاولة." },
  COMPLIANCE_FAILED: { status: 409, en: "Not every compliance check passed.", ar: "لم تنجح جميع فحوص الامتثال." },
  EGS_NOT_READY: { status: 409, en: "E-invoicing is on but no EGS unit holds a production CSID for this environment.", ar: "الفوترة الإلكترونية مفعّلة لكن لا توجد وحدة فوترة تحمل شهادة إنتاج لهذه البيئة." },
  EGS_ENVIRONMENT: { status: 409, en: "The EGS unit belongs to another environment.", ar: "وحدة الفوترة تابعة لبيئة أخرى." },
  NOT_SIGNABLE: { status: 409, en: "The document lacks particulars ZATCA requires.", ar: "تنقص المستند بيانات تشترطها الهيئة." },
  FINAL: { status: 409, en: "ZATCA has decided on this document; it is not sent again (a correction is a credit note).", ar: "قرار الهيئة في هذا المستند نهائي؛ لا يُعاد إرساله (التصحيح بإشعار دائن)." },
  IN_FLIGHT: { status: 409, en: "This document is being sent right now.", ar: "يُرسَل هذا المستند الآن." },
  NUMBERING_IN_USE: { status: 409, en: "This series has issued documents already; its start cannot change.", ar: "صدرت مستندات من هذه السلسلة؛ لا يتغير رقم بدايتها." },
  ZATCA_DB: { status: 409, en: "The e-invoicing register refused the change.", ar: "رفض سجل الفوترة الإلكترونية التغيير." },
} satisfies Record<string, R>;

export type ZatcaRefusalCode = keyof typeof ZATCA_REFUSALS;

export function refuseZatca(code: ZatcaRefusalCode, detail?: string, detailAr?: string, extra?: Record<string, unknown>): AccountingError {
  const r: R = ZATCA_REFUSALS[code];
  const e = new AccountingError(detail ? `${r.en} ${detail}` : r.en, r.status, code, detailAr ? `${r.ar} ${detailAr}` : r.ar) as AccountingError & { extra?: object };
  if (extra) e.extra = extra;
  return e;
}

export function zatcaDbRefusal(message: string): AccountingError | null {
  const m = /(ZATCA|NUMBERING): [^\n"]*/.exec(message);
  if (!m) return null;
  return refuseZatca(m[1] === "NUMBERING" ? "NUMBERING_IN_USE" : "ZATCA_DB", `(${m[0].slice(0, 300)})`);
}

export function zatcaError(err: unknown): NextResponse {
  if (err instanceof AccountingError) return NextResponse.json({ ...accountingErrorJson(err), ...(err as AccountingError & { extra?: object }).extra }, { status: err.status });
  const msg = err instanceof Error ? `${err.message} ${JSON.stringify((err as { cause?: unknown }).cause ?? "")}` : String(err);
  const db = zatcaDbRefusal(msg);
  if (db) return NextResponse.json(accountingErrorJson(db), { status: db.status });
  if (err instanceof Error && err.name === "ZatcaKeyMissing") return zatcaError(refuseZatca("KEY_NOT_CONFIGURED"));
  return acctError(err);
}
