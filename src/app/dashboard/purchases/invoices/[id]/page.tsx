"use client";

// «فاتورة مشتريات» — /new for a new one (?receipt=<id> to invoice an earlier receipt); otherwise its detail page
// (status, approve, return, edit / cancel after receiving, cancel a posted one, payments). Phase 2, one-step.
// «فواتير بسيطة» (BATCH22 WP-H): /new?mode=expense opens the simple-invoice form; a simple DRAFT reopens in it; every
// saved invoice shows its attachments.
import Link from "next/link";
import { use } from "react";
import { useSearchParams } from "next/navigation";
import { SIMPLE_BILL_LIST_HREF, SIMPLE_BILL_PARAM } from "@/components/chrome";
import { OpsLoading, OpsRoot, PageHeader } from "@/components/ops/ui";
import { useApi, useLang } from "../../../accounting/_ui/shell";
import { PurchaseInvoiceForm } from "../../_parts/invoice-form";
import { SimpleBillForm, type SimpleDraft } from "../../_parts/simple-bill-form";
import { InvoiceAttachments } from "../../_parts/attachments";
import type { PurchaseCan } from "../../_parts/invoices";
import "@/components/ops/stock.css";
import "../../../accounting/_ui/accounting.css";
import "../../_parts/purchases.css";

type Head = { id: string; kind?: string; status: string; supplierId: string; vendorName: string | null; vendorVatNumber: string | null; supplierRef: string; invoiceDate: string; notes: string | null; branchId?: string | null;
  lines: { expenseCategoryId: string | null; description: string; gross: string; vat: string; taxCode: string | null }[] };

export default function PurchaseInvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { L } = useLang();
  const isNew = id === "new";
  const sp = useSearchParams();
  const expense = isNew && sp.get(SIMPLE_BILL_PARAM) === "expense";
  const head = useApi<Head>(isNew ? null : `/api/purchases/invoices/${id}`);
  const meta = useApi<{ can: PurchaseCan }>(isNew ? null : "/api/purchases/invoices?status=__none__");
  const simple = !isNew && head.data?.kind === "SIMPLE";
  const simpleDraft = simple && head.data?.status === "DRAFT";
  return (
    <OpsRoot className="acct pur-root">
      <div className="hr-page">
        <p className="acct-hint"><Link href={expense || simple ? SIMPLE_BILL_LIST_HREF : "/dashboard/purchases?tab=invoices"}>→ {expense || simple ? L("المشتريات · فواتير بسيطة", "Purchases · simple bills") : L("المشتريات · الفواتير", "Purchases · invoices")}</Link></p>
        <PageHeader title={expense ? L("فاتورة بسيطة جديدة", "New simple bill") : isNew ? L("فاتورة مشتريات جديدة", "New purchase invoice") : simple ? L("فاتورة بسيطة", "Simple bill") : L("فاتورة مشتريات", "Purchase invoice")}>
          <span className="acct-meta">{expense || simpleDraft ? L("مصروفات (إيجار، كهرباء، وقود…) · ريال سعودي · المبلغ شامل الضريبة كما في الإيصال", "Expenses (rent, power, fuel…) · SAR · the amount VAT inclusive, as on the receipt") : L("ريال سعودي · الأسعار قبل الضريبة، والضريبة لكل سطر", "SAR · prices before VAT, VAT per line")}</span>
        </PageHeader>
        <div className="acct-body">
          {expense ? <SimpleBillForm key="new-simple" />
            : !isNew && !head.data && !head.error ? <OpsLoading />
            : simpleDraft ? <SimpleBillForm key={`edit-${id}`} draft={head.data as unknown as SimpleDraft} />
            : <PurchaseInvoiceForm key={`${id}:${expense}`} id={isNew ? null : id} expense={false} />}
          {!isNew && head.data ? <InvoiceAttachments invoiceId={id} canWrite={!!meta.data?.can.draft} posted={head.data.status === "POSTED"} /> : null}
        </div>
      </div>
    </OpsRoot>
  );
}
