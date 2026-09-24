"use client";

import { useState, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useLang, Alert, Spinner, Card, api } from "../../_components/ui";

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

  const [createError, setCreateError] = useState("");

  /**
   * "You arrived without a deal" is derived from the URL, not stored.
   *
   * It used to be written with setError inside the effect, which is a synchronous state write
   * during an effect and causes a cascading render — and it was never really state anyway: it
   * is a fact about the current URL, knowable at render time. Only the failure of the create
   * call is genuine state, because only that is discovered asynchronously.
   */
  const missingDeal = !opportunityId;
  const error = missingDeal
    ? (ar
        ? "عرض السعر يُنشأ من صفقة. افتح الصفقة واضغط «عرض سعر جديد»."
        : "A quotation is raised from a deal. Open the deal and use “New quotation”.")
    : createError;

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
        body: { opportunityId, validUntil, lines: [] },
      });
      if (cancelled) return;
      if (res.ok && res.data.quote) {
        router.replace(`/dashboard/sales/quotes/${res.data.quote.id}`);
      } else {
        setCreateError(res.data.error ?? (ar ? "تعذّر إنشاء العرض." : "Could not create the quotation."));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [opportunityId, router, ar]);

  if (error) {
    return (
      <Card>
        <Alert kind="error">{error}</Alert>
      </Card>
    );
  }
  return <Spinner />;
}
