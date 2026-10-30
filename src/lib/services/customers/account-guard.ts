// Who may change the account particulars that decide somebody else's book, commission or credit
// (council gate B2, batch 23). Customer.accountOwnerId is the rep's visibility key (services/sales/scope.ts)
// AND the commission rep; the credit limit, payment terms, price list and default hold duration are credit
// terms. A rep holding customers › edit keeps editing the rest of the record (contact, city, CR / VAT …).
//
//   accountOwnerId                                   — the admin role, the sales manager (lead_assign), or a
//                                                      commission manager (manage_plans / manage_settings):
//                                                      managesNewClientExclusion, the same circle;
//   creditLimit, paymentTermsDays, priceList         — customers › sales_hold (credit control; the administrator
//                                                      holds it by role template);
//   defaultHoldDays, reorderIntervalDays             — anyone who may edit the record (the hold dialog's proposal,
//                                                      an agreed rhythm: they decide nothing alone), audited.
//
// A field sent with its current value is not a change (the account dialog posts the whole form). Every change
// to these fields is returned as before / after for the settings trail. Pure: the route reads, this decides.
import { hasSubPrivilege, type Permissions } from "@/lib/auth-shared";
import { managesNewClientExclusion } from "@/lib/services/sales/scope";

type Viewer = { role?: string | null; permissions: Permissions | Record<string, unknown> };
type Plain = Record<string, unknown>;

const OWNER = ["accountOwnerId"] as const;
const CREDIT = ["creditLimit", "paymentTermsDays", "priceList"] as const;
const AUDITED = [...OWNER, ...CREDIT, "defaultHoldDays", "reorderIntervalDays"] as const;

/** Compared as text; amounts (a Decimal, a number) by value, so "60000.00" and 60000 are the same. */
const norm = (v: unknown): string | null => {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number" || (typeof v === "object" && v !== null)) {
    const n = Number(String(v));
    return Number.isFinite(n) ? String(n) : String(v);
  }
  return String(v);
};

export function mayChangeAccountOwner(user: Viewer): boolean {
  return managesNewClientExclusion(user.permissions, user.role);
}

export function mayChangeCreditTerms(user: Viewer): boolean {
  // By permission only (release gate N2): credit control's key, which the administrator holds by role template.
  return hasSubPrivilege(user.permissions as Permissions, "customers", "sales_hold");
}

export function protectedAccountChanges(user: Viewer, current: Plain, next: Plain):
  | { ok: true; changed: string[]; before: Plain; after: Plain }
  | { ok: false; error: string; errorAr: string } {
  const changed = AUDITED.filter((k) => k in next && norm(next[k]) !== norm(current[k]));
  if (changed.some((k) => (OWNER as readonly string[]).includes(k)) && !mayChangeAccountOwner(user)) {
    return { ok: false, error: "Only a sales manager, a commission manager or the administrator changes the account owner.", errorAr: "تغيير المسؤول عن الحساب لمدير المبيعات أو مدير العمولات أو المدير فقط." };
  }
  if (changed.some((k) => (CREDIT as readonly string[]).includes(k)) && !mayChangeCreditTerms(user)) {
    return { ok: false, error: "Only credit control (customers › sales_hold) or the administrator changes the credit limit, terms or price list.", errorAr: "تغيير حد الائتمان أو شروط الدفع أو قائمة الأسعار لمسؤول الائتمان أو المدير فقط." };
  }
  return {
    ok: true, changed: [...changed],
    before: Object.fromEntries(changed.map((k) => [k, norm(current[k])])),
    after: Object.fromEntries(changed.map((k) => [k, norm(next[k])])),
  };
}
