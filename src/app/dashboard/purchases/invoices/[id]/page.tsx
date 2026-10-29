"use client";

// «فاتورة مشتريات» — /new for a new one (?receipt=<id> to invoice an earlier receipt); otherwise its detail page
// (status, approve, return, edit / cancel after receiving, cancel a posted one, payments). Phase 2, one-step.
import Link from "next/link";
import { use } from "react";
import { useSearchParams } from "next/navigation";
import { SIMPLE_BILL_PARAM } from "@/components/chrome";
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
  // «فواتير بسيطة» (Qoyod parity): /new?mode=expense opens the same form as one expense line.
  const sp = useSearchParams();
  const expense = isNew && sp.get(SIMPLE_BILL_PARAM) === "expense";
  return (
    <OpsRoot className="acct pur-root">
      <div className="hr-page">
        <p className="acct-hint"><Link href="/dashboard/purchases?tab=invoices">→ {L("المشتريات · الفواتير", "Purchases · invoices")}</Link></p>
        <PageHeader title={expense ? L("فاتورة بسيطة جديدة", "New simple bill") : isNew ? L("فاتورة مشتريات جديدة", "New purchase invoice") : L("فاتورة مشتريات", "Purchase invoice")}>
          <span className="acct-meta">{expense ? L("مصروف على حساب مصروف (إيجار، كهرباء، وقود…) · ريال سعودي · المبلغ قبل الضريبة", "An expense to an expense account (rent, power, fuel…) · SAR · amount before VAT") : L("ريال سعودي · الأسعار قبل الضريبة، والضريبة لكل سطر", "SAR · prices before VAT, VAT per line")}</span>
        </PageHeader>
        <div className="acct-body">
          <PurchaseInvoiceForm key={`${id}:${expense}`} id={isNew ? null : id} expense={expense} />
        </div>
      </div>
    </OpsRoot>
  );
}
