export class AccountingError extends Error {
  status: number;
  /** A machine-readable refusal code (e.g. PAYROLL_LOCKED), when the client can act on it. */
  code?: string;
  /** Arabic wording, when the refusal has one; the English stays the message. */
  messageAr?: string;
  constructor(message: string, status = 400, code?: string, messageAr?: string) {
    super(message);
    this.name = "AccountingError";
    this.status = status;
    this.code = code;
    this.messageAr = messageAr;
  }
}

/** The JSON body of an accounting refusal: unchanged for plain errors; Arabic + English + code for coded ones. */
export function accountingErrorJson(err: AccountingError): Record<string, string> {
  if (err.messageAr) return { error: err.messageAr, errorEn: err.message, ...(err.code ? { code: err.code } : {}) };
  return { error: err.message, ...(err.code ? { code: err.code } : {}) };
}
