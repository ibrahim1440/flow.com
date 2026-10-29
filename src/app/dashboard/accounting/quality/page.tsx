// «جودة المحاسبة» (accountant workspace, Qoyod-parity program). RESERVED route: until a page of its own exists it opens
// the close checklist and reconciliation — «الفترات» (each open month's checklist: balanced ledger, sub-ledgers
// against their control accounts, inventory, VAT, unposted documents). Same audience: the accounting module.
import { redirect } from "next/navigation";

export default function AccountingQuality() {
  redirect("/dashboard/accounting/periods");
}
