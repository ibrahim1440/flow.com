// «فواتير الموردين» is now the «الفواتير» tab of the one purchases screen (unified inventory, phase 2): the old list
// address keeps working and lands on that tab. The detail page (/dashboard/purchases/invoices/[id]) stays.
import { redirect } from "next/navigation";

export default function SupplierInvoicesRedirect() {
  redirect("/dashboard/purchases?tab=invoices");
}
