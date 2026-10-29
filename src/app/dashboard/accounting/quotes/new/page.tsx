"use client";

// «+ عرض سعر» from the accounting section (BATCH22 WP-E): with a deal (?opportunityId, from the picker) the Sales editor
// raises the draft; without one, the list opens its picker — the accountant chooses an existing open deal.
import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import SalesNewQuote from "../../../sales/quotes/new/page";

function NewQuote() {
  const sp = useSearchParams();
  const router = useRouter();
  const deal = sp.get("opportunityId");
  useEffect(() => { if (!deal) router.replace("/dashboard/accounting/quotes?pick=1"); }, [deal, router]);
  return deal ? <SalesNewQuote /> : null;
}

export default function AccountingNewQuotePage() {
  return <Suspense fallback={null}><NewQuote /></Suspense>;
}
