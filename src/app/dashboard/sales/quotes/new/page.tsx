"use client";

import { useState, useEffect, useRef } from "react";
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

  // ONE draft per arrival (test hygiene, 10 Nov): the effect can run again — React's development double-run, or a
  // dependency (the language, the base) settling after the first paint — and a second POST was refused (409) and showed
  // «already exists» instead of the draft the first one made. The first request is the only one, and its answer always
  // opens the draft.
  const started = useRef<string | null>(null);
  // …and an answer that arrives after the person has LEFT this page never moves them (gate L3). Set per mount: React's
  // development double-run unmounts and mounts again, so the flag is true again by the time the answer lands.
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!opportunityId) return;
    const arrival = `${opportunityId}:${fromCustomer ? "customer" : ""}`;
    if (started.current === arrival) return;
    started.current = arrival;

    (async () => {
      // Valid for thirty days by default — a figure the person can change before issuing,
      // and one that is at least not in the past, which an empty date would leave them to
      // discover at the moment of issue.
      const validUntil = new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10);
      // P2 ب4: `deferEmpty` — nothing is created while there is no line (no number burnt by an abandoned «عرض سعر جديد»);
      // the answer is then the unsaved editor (…/draft), whose first save creates and numbers the quotation.
      const res = await api<{ quote: { id: string } | null; draft?: boolean }>("/api/sales/quotes", {
        method: "POST",
        body: { opportunityId, validUntil, lines: [], deferEmpty: true, ...(fromCustomer ? { from: "customer" } : {}) },
      });
      if (!alive.current) return;
      if (res.ok && res.data.draft) {
        router.replace(`${base}/draft?opportunityId=${encodeURIComponent(opportunityId)}${fromCustomer ? "&from=customer" : ""}`);
      } else if (res.ok && res.data.quote) {
        router.replace(`${base}/${res.data.quote.id}`);
      } else {
        setCreateError(res.data.error ?? (ar ? "تعذّر إنشاء العرض." : "Could not create the quotation."));
      }
    })();
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
