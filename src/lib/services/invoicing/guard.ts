// The door of the invoice write routes: the Sales key, or — «مسار المحاسب» — the accounting module with
// accounting › invoices_issue. Same gates either way: verified individual (both keys are privileged) and a recent step-up
// to issue a document or work on a note (sales › invoices_issue / invoices_credit_note are STEP_UP_KEYS).
import { forbidden, requireAuth, requirePrivilegedAction, requireSub } from "@/lib/auth-server";
import { hasSubPrivilege } from "@/lib/auth-shared";
import { viaAccounting } from "./access";

export type InvoiceDuty = "invoices_create" | "invoices_issue" | "invoices_cancel" | "invoices_credit_note";

export async function requireInvoiceDuty(duty: InvoiceDuty) {
  const { user, error } = await requireAuth();
  if (error) return { user: null as never, error };
  if (hasSubPrivilege(user.permissions, "sales", duty)) return requireSub("sales", duty);
  if (!viaAccounting(user.permissions)) return { user: null as never, error: forbidden() };
  const refused = await requirePrivilegedAction(user, "accounting.invoices_issue", { stepUp: duty === "invoices_issue" || duty === "invoices_credit_note" });
  if (refused) return { user: null as never, error: refused };
  return { user, error: null };
}
