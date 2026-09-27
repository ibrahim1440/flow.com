// Posting roles and accounting policies the engine knows about. Account codes are never
// hard-coded in a translator: a translator asks for a role, and AccountMapping says which
// account plays it. Policies are the approvable statements a posting depends on.

export type RoleDef = { role: string; en: string; ar: string; usedBy: string };

export const POSTING_ROLES: RoleDef[] = [
  { role: "COMMISSION_EXPENSE", en: "Sales commission expense", ar: "مصروف عمولات المبيعات", usedBy: "commissions" },
  { role: "COMMISSION_PAYABLE", en: "Commissions payable (control)", ar: "عمولات مستحقة الدفع (حساب مراقبة)", usedBy: "commissions" },
  { role: "COMMISSION_PAYMENT_CLEARING", en: "Commission payments clearing", ar: "حساب وسيط لمدفوعات العمولات", usedBy: "commissions" },
  { role: "RETAINED_EARNINGS", en: "Retained earnings (year-end close)", ar: "الأرباح المبقاة (إقفال السنة)", usedBy: "closing" },
  { role: "OPENING_BALANCE_EQUITY", en: "Opening balance equity (cutover)", ar: "حقوق ملكية الأرصدة الافتتاحية", usedBy: "opening" },
];

export const ROLE_SET = new Set(POSTING_ROLES.map((r) => r.role));

export type PolicyDef = { key: string; en: string; ar: string; governs: string[]; defaultStatement: string };

export const POLICIES: PolicyDef[] = [
  {
    key: "commissions.recognition",
    en: "Sales commission recognition",
    ar: "إثبات عمولات المبيعات",
    governs: ["commission.accrual", "commission.reversal", "commission.adjustment", "commission.payout"],
    defaultStatement:
      "Commission expense and the related liability are recognised when a finance-verified sales collection " +
      "produces a commission ledger movement, on that movement's date, for the amount the approved plan version " +
      "computes. Reversals and adjustments are recognised when recorded, never by editing an earlier entry. " +
      "A payout settles the liability against the commission payments clearing account; the bank payment clears " +
      "that account when it is matched, so the payment is not expensed twice. Only plan versions approved for " +
      "accounting may post.",
  },
];

export const POLICY_BY_EVENT = new Map<string, string>(
  POLICIES.flatMap((p) => p.governs.map((e) => [e, p.key] as [string, string])),
);
