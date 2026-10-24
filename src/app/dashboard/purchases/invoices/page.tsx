"use client";

// «فواتير الموردين» (Figma ACC-50) for purchasing: the list and «فاتورة مورد» (new draft). purchases › invoices or
// accounting › ap; the API re-checks every duty.
import Link from "next/link";
import { OpsRoot, PageHeader } from "@/components/ops/ui";
import { InvoiceList } from "../../accounting/_ui/ap";
import { useLang } from "../../accounting/_ui/shell";
import "../../accounting/_ui/accounting.css";

export default function SupplierInvoicesPage() {
  const { L } = useLang();
  return (
    <OpsRoot className="acct">
      <div className="hr-page">
        <PageHeader title={L("فواتير الموردين", "Supplier invoices")} actions={<Link className="hr-btn is-primary" href="/dashboard/purchases/invoices/new" data-testid="new-invoice">+ {L("فاتورة مورد", "Supplier invoice")}</Link>}>
          <span className="acct-meta">{L("ريال سعودي · شامل الضريبة", "SAR · VAT inclusive")}</span>
        </PageHeader>
        <div className="acct-body"><InvoiceList base="/dashboard/purchases/invoices" /></div>
      </div>
    </OpsRoot>
  );
}
