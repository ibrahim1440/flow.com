"use client";

// «فاتورة مشتريات» — /new for a new one (?receipt=<id> to invoice an earlier receipt); otherwise its detail page
// (status, approve, return, edit / cancel after receiving, cancel a posted one, payments). Phase 2, one-step.
import Link from "next/link";
import { use } from "react";
import { OpsRoot, PageHeader } from "@/components/ops/ui";
import { useLang } from "../../../accounting/_ui/shell";
import { PurchaseInvoiceForm } from "../../_parts/invoice-form";
import "@/components/ops/stock.css";
import "../../../accounting/_ui/accounting.css";
import "../../_parts/purchases.css";

export default function PurchaseInvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { L } = useLang();
  const isNew = id === "new";
  return (
    <OpsRoot className="acct pur-root">
      <div className="hr-page">
        <p className="acct-hint"><Link href="/dashboard/purchases?tab=invoices">→ {L("المشتريات · الفواتير", "Purchases · invoices")}</Link></p>
        <PageHeader title={isNew ? L("فاتورة مشتريات جديدة", "New purchase invoice") : L("فاتورة مشتريات", "Purchase invoice")}>
          <span className="acct-meta">{L("ريال سعودي · الأسعار قبل الضريبة، والضريبة لكل سطر", "SAR · prices before VAT, VAT per line")}</span>
        </PageHeader>
        <div className="acct-body">
          <PurchaseInvoiceForm key={id} id={isNew ? null : id} />
        </div>
      </div>
    </OpsRoot>
  );
}
