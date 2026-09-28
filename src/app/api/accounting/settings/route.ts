import { accountingRoute, body } from "@/lib/accounting/http";
import { AccountingError } from "@/lib/accounting/errors";
import { accountingDate } from "@/lib/accounting/dates";
import { getSettings, updateSettings } from "@/lib/accounting/setup-service";
import { requireSub } from "@/lib/auth-server";

export const GET = accountingRoute(null, () => getSettings());

// Cutover date needs mapping_manage; completing set-up needs settings_manage. Costing, COGS
// and branch-mode settings are not editable here: they wait for the accountant's policy
// decision (docs/accounting/POLICIES.md) and no code reads them yet.
export const PATCH = accountingRoute("settings_manage", async ({ user, request }) => {
  const b = await body(request);
  const patch: { ledgerCutoverDate?: Date | null; setupComplete?: boolean; bankPostingFrom?: Date | null; advanceVatTreatment?: "AT_RECEIPT" | "NOT_AT_RECEIPT" | null } = {};
  if ("ledgerCutoverDate" in b) {
    const auth = await requireSub("accounting", "mapping_manage");
    if (auth.error) throw new AccountingError("Setting the cutover date needs the mapping permission.", 403);
    patch.ledgerCutoverDate = b.ledgerCutoverDate === null ? null : accountingDate(b.ledgerCutoverDate);
  }
  if ("bankPostingFrom" in b) {
    const auth = await requireSub("accounting", "bank_posting_manage");
    if (auth.error) throw new AccountingError("Setting the bank posting start date needs the bank posting permission.", 403);
    patch.bankPostingFrom = b.bankPostingFrom === null ? null : accountingDate(b.bankPostingFrom);
  }
  if ("advanceVatTreatment" in b) {
    // Decision D-2. Applies to receipts assigned from now on; posted receipts keep their VAT.
    if (b.advanceVatTreatment !== null && b.advanceVatTreatment !== "AT_RECEIPT" && b.advanceVatTreatment !== "NOT_AT_RECEIPT") throw new AccountingError("VAT on advances is AT_RECEIPT, NOT_AT_RECEIPT or null (undecided).", 400);
    patch.advanceVatTreatment = b.advanceVatTreatment as "AT_RECEIPT" | "NOT_AT_RECEIPT" | null;
  }
  if ("setupComplete" in b) {
    if (typeof b.setupComplete !== "boolean") throw new AccountingError("setupComplete must be true or false.", 400);
    patch.setupComplete = b.setupComplete;
  }
  const other = Object.keys(b).filter((k) => !["ledgerCutoverDate", "setupComplete", "bankPostingFrom", "advanceVatTreatment"].includes(k));
  if (other.length) throw new AccountingError(`These settings are not editable yet: ${other.join(", ")}.`, 400);
  if (!Object.keys(patch).length) throw new AccountingError("Nothing to change.", 400);
  return updateSettings(patch, user.id);
});
