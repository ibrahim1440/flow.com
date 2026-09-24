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

  const [error, setError] = useState("");

  useEffect(() => {
    if (!opportunityId) {
      setError(
        ar
          ? "عرض السعر يُنشأ من صفقة. افتح الصفقة واضغط «عرض سعر جديد»."
          : "A quotation is raised from a deal. Open the deal and use “New quotation”.",
      );
      return;
    }

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
        setError(res.data.error ?? (ar ? "تعذّر إنشاء العرض." : "Could not create the quotation."));
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
