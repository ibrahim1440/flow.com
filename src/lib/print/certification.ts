/**
 * Print certification gate (owner decision on A-8, 18 Oct 2026): «Physical printer certification
 * may be deferred to Phase 1.1 only if uncertified printing functionality remains unavailable in
 * production until certification. Do not label printing as production-certified without
 * real-device and physical-output evidence.»
 *
 * `PRINT_CERTIFIED` (server environment) switches the label-printing flows (G-20 / G-21: Coffee
 * Origin and Cupping Results labels, their preview, the batch / lot selector and the calibration
 * page) on. It is FAIL-CLOSED in every environment: only the exact string "true" turns printing
 * on; unset, empty, "TRUE", "1", "yes", " true" … are all off. Production therefore defaults to
 * off, and preview / dev / test environments enable it explicitly to run the print suites.
 *
 * Setting the flag does not certify anything: it is the release switch an operator turns on only
 * after the A-8 run of docs/print/PRINT-SYSTEM.md §13 is recorded with a real printer and physical
 * output (docs/print/CERTIFICATION.md). This module is shared by the server and the browser; the
 * browser only ever learns the state from GET /api/print/status — it never reads the variable.
 */
export const PRINT_NOT_CERTIFIED_CODE = "PRINTING_NOT_CERTIFIED" as const;

export const PRINT_NOT_CERTIFIED_MESSAGE = {
  ar: "طباعة الملصقات غير متاحة: لم تُعتمد بعد على طابعة فعلية (A-8). تُفعَّل بعد تسجيل اختبار على طابعة حقيقية بمخرجات مطبوعة فعلًا.",
  en: "Label printing is unavailable: it has not been certified on a physical printer yet (A-8). It will be enabled once a test on a real printer with physical output is recorded.",
} as const;

type Env = Record<string, string | undefined>;

/** True only for the exact value "true". Anything else — including unset — is off. */
export function isPrintCertified(env: Env = process.env): boolean {
  return env.PRINT_CERTIFIED === "true";
}

/** Where the deployment runs, for the status payload and the runbook check (never decides the gate). */
export function printEnvironment(env: Env = process.env): "production" | "preview" | "development" | "test" {
  if (env.VERCEL_ENV === "production") return "production";
  if (env.VERCEL_ENV === "preview") return "preview";
  if (env.NODE_ENV === "production") return "production";
  if (env.NODE_ENV === "test") return "test";
  return "development";
}

/** The refusal body every gated print endpoint sends with HTTP 409. */
export function printNotCertifiedBody() {
  return {
    error: PRINT_NOT_CERTIFIED_MESSAGE.en,
    errorAr: PRINT_NOT_CERTIFIED_MESSAGE.ar,
    message: { ...PRINT_NOT_CERTIFIED_MESSAGE },
    code: PRINT_NOT_CERTIFIED_CODE,
  };
}

/**
 * Owner decision D1 (18 Oct 2026): «All printing is out of Phase 1 scope, including label printing
 * and ordinary document printing.» The SAME switch (PRINT_CERTIFIED, exact "true", fail-closed)
 * governs every print action in the application: label printing (above), the calibration page and
 * every plain-document «Print» button (payslips). There is deliberately no second flag.
 */
export const PRINT_PHASE1_NOTE = {
  ar: "الطباعة غير متاحة في المرحلة 1",
  en: "Printing is not available in Phase 1",
} as const;

/** Alias that reads as what it decides: printing of any kind is on only for the exact "true". */
export const isPrintingEnabled = isPrintCertified;

/**
 * D1-Q (decided 18 Oct 2026: follow D1 strictly). The quotation's only PDF is the browser's
 * «Save as PDF», which opens the print dialog — so it is printing, and while printing is off the
 * action is disabled with the Phase 1 note; the quotation stays viewable on screen. `true` would
 * keep «Save as PDF» available while printing is off (not approved).
 */
export const QUOTATION_PDF_WHEN_PRINT_OFF: boolean = false;
