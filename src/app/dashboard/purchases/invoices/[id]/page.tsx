"use client";

// «فاتورة مورد» (Figma ACC-51 draft · ACC-52 awaiting approval / posted): /new for a new draft.
import Link from "next/link";
import { use } from "react";
import { OpsLoading, OpsRoot, PageHeader } from "@/components/ops/ui";
import { InvoiceEditor } from "../../../accounting/_ui/ap";
import { useApi, useLang } from "../../../accounting/_ui/shell";
import "../../../accounting/_ui/accounting.css";

type Me = { can: { draft: boolean; ap: boolean }; viewer: { id: string }; simpleMode: boolean; sodSelfAllowed?: boolean };

export default function SupplierInvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { L } = useLang();
  const me = useApi<Me>("/api/accounting/ap/invoices?status=__none__");
  const isNew = id === "new";
  return (
    <OpsRoot className="acct">
      <div className="hr-page">
        <p className="acct-hint"><Link href="/dashboard/purchases/invoices">→ {L("الذمم الدائنة · فواتير الموردين", "Payables · supplier invoices")}</Link></p>
        <PageHeader title={isNew ? L("فاتورة مورد جديدة", "New supplier invoice") : L("فاتورة مورد", "Supplier invoice")}>
          <span className="acct-meta">{L("ريال سعودي · شامل الضريبة", "SAR · VAT inclusive")}</span>
        </PageHeader>
        <div className="acct-body">
          {me.error ? <p role="alert" className="hr-err">{me.error}</p> : !me.data ? <OpsLoading /> : (
            <InvoiceEditor key={id} id={isNew ? null : id} base="/dashboard/purchases/invoices" can={{ draft: me.data.can.draft, ap: me.data.can.ap, viewerId: me.data.viewer.id, simpleMode: me.data.simpleMode, sodSelfAllowed: me.data.sodSelfAllowed ?? me.data.simpleMode }} />
          )}
        </div>
      </div>
    </OpsRoot>
  );
}
