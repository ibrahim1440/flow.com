import { NextResponse } from "next/server";
import { withArabicError } from "@/lib/i18n/api-errors";
import { MANUAL_JOURNALS_DISABLED, MANUAL_JOURNALS_DISABLED_AR, MANUAL_JOURNALS_DISABLED_EN } from "@/lib/accounting/manual-journals-messages";

/**
 * A refusal the domain raised deliberately, mapped to the status it asked for.
 *
 * Services throw `{ _appCode, message }` for business refusals — "a deal cannot be won
 * without a customer", "this quote is already accepted" — because a service must not
 * import NextResponse to say no. Without this branch every one of those surfaced as a
 * 500 with "An unexpected error occurred", which tells the operator nothing and reads in
 * the logs as a crash rather than as the guard doing its job. That exact confusion cost a
 * debugging session on the packaging routes, so it is one shared helper now rather than
 * the same six lines copied into each route.
 */
export function handleDomainError(err: unknown): NextResponse {
  if (err && typeof err === "object" && "_appCode" in err) {
    const e = err as { _appCode: number; message?: string; errorEn?: string; errorAr?: string; code?: string };
    const status = Number.isInteger(e._appCode) && e._appCode >= 400 && e._appCode < 600 ? e._appCode : 400;
    // A coded refusal (e.g. REAUTH_REQUIRED, IDENTITY_NOT_VERIFIED) keeps its code, so the client can act on it.
    // DEF-08/09: an English refusal also carries its Arabic (`errorAr`) when it is known.
    return NextResponse.json(withArabicError({ error: e.message ?? "Refused.", ...(e.errorEn ? { errorEn: e.errorEn } : {}), ...(e.errorAr ? { errorAr: e.errorAr } : {}), ...(e.code ? { code: e.code } : {}) }), { status });
  }
  return handlePrismaError(err);
}

export function handlePrismaError(err: unknown): NextResponse {
  // Phase 1 payroll lock (independent review F7): a refusal by the database's payroll guards is a
  // refusal, never a crash — 409 with its code, whatever route the write came through.
  const msg = err instanceof Error ? err.message : "";
  if (/HR: payroll is locked \(live payroll is off\)/.test(msg)) {
    return NextResponse.json({ error: "الرواتب مقفلة: لم يُفعَّل تشغيل الرواتب الفعلي بعد، لذلك رُفض هذا الإجراء.", errorEn: "Payroll is locked: live payroll has not been switched on, so this action is refused.", code: "PAYROLL_LOCKED" }, { status: 409 });
  }
  // The commission payout freeze (commission_payout_freeze_trg; owner decision 17 Oct, docs/hr/COMMISSION-PAYOUT-FREEZE.md):
  // a refusal by the database, never a crash — 409 with its code. Nothing was written.
  if (/Commission payout recording is frozen at the database/.test(msg)) {
    return NextResponse.json({ error: "تسجيل صرف العمولات موقوف في قاعدة البيانات؛ لا يُسجَّل أي صرف حتى يُرفع الإيقاف.", errorEn: "Commission payout recording is frozen at the database. No payout can be recorded until the freeze is lifted.", code: "COMMISSION_PAYOUT_FROZEN" }, { status: 409 });
  }
  if (/LEDGER: manual journals are disabled \(Phase 1\)/.test(msg)) {
    return NextResponse.json({ error: MANUAL_JOURNALS_DISABLED_AR, errorEn: MANUAL_JOURNALS_DISABLED_EN, code: MANUAL_JOURNALS_DISABLED }, { status: 409 });
  }
  if (/a journal posted by HR is (reversed|changed)|journal posted by HR/i.test(msg)) {
    return NextResponse.json({ error: "قيد الموارد البشرية لا يُعكس ولا يُعدّل إلا من خلال الموارد البشرية.", errorEn: "A journal posted by HR is reversed or changed only through HR.", code: "HR_JOURNAL" }, { status: 409 });
  }
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code: string }).code;
    if (code === "P2002") {
      return NextResponse.json(withArabicError({ error: "A record with these details already exists." }), { status: 409 });
    }
    if (code === "P2003" || code === "P2014") {
      return NextResponse.json(withArabicError({ error: "Cannot complete: a related record is missing or still referenced." }), { status: 409 });
    }
    if (code === "P2025") {
      return NextResponse.json(withArabicError({ error: "Record not found." }), { status: 404 });
    }
  }
  console.error("[API Error]", err);
  return NextResponse.json(withArabicError({ error: "An unexpected error occurred. Please try again." }), { status: 500 });
}
