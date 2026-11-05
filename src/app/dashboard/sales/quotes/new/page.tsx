"use client";

import { useState, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useLang, Spinner, api } from "../../_components/ui";
import { useQuotesBase } from "../base";

/**
 * Raise a draft quotation and open its editor.
 *
 * A route rather than a modal on the deal page, because the thing a person wants next is
 * the editor with a real quote number in it — and a modal that then navigates is two
 * transitions where one will do.
 *
 * A STATIC segment, so it is matched before `[id]`: without this file, /quotes/new would be
 * read as a quotation whose id is the word "new" and 404.
 */
export default function NewQuotePage() {
  const router = useRouter();
  const search = useSearchParams();
  const lang = useLang();
  const ar = lang === "ar";
  const opportunityId = search.get("opportunityId");
  // From the customer page: reopen my empty draft of the deal, or prefill the usual items (POST from: "customer").
  const fromCustomer = search.get("from") === "customer";
  const { base } = useQuotesBase();

  const [createError, setCreateError] = useState("");

  // Arriving without a deal («يومي», «+ جديد», any old link): open the quotation page's customer picker (QuotePicker —
  // pick the customer, its open deal is linked or opened, then the editor) instead of a dead end (owner, 5 Nov 2026:
  // «خلي الاختصارات شغالة»).
  useEffect(() => {
    if (!opportunityId) router.replace(`${base}?pick=1`);
  }, [opportunityId, router, base]);
  const error = createError;

  useEffect(() => {
    if (!opportunityId) return;

    let cancelled = false;
    (async () => {
      // Valid for thirty days by default — a figure the person can change before issuing,
      // and one that is at least not in the past, which an empty date would leave them to
      // discover at the moment of issue.
      const validUntil = new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10);
      const res = await api<{ quote: { id: string } }>("/api/sales/quotes", {
        method: "POST",
        body: { opportunityId, validUntil, lines: [], ...(fromCustomer ? { from: "customer" } : {}) },
      });
      if (cancelled) return;
      if (res.ok && res.data.quote) {
        router.replace(`${base}/${res.data.quote.id}`);
      } else {
        setCreateError(res.data.error ?? (ar ? "تعذّر إنشاء العرض." : "Could not create the quotation."));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [opportunityId, router, ar, base, fromCustomer]);

  if (error) {
    return (
      <div className="pg">
        <p className="notice er" role="alert" data-testid="alert-error">{error}</p>
      </div>
    );
  }
  return <div className="pg"><Spinner /></div>;
}
