"use client";

/**
 * «مسار العميل» — the strip that ties the rep's four pages together (owner-approved Figma page 10, 4 Nov 2026):
 * العملاء المحتملون ← العيّنات ← عروض الأسعار ← العملاء. «الصفقات» is not a step: it has its own sidebar entry, first in
 * «المبيعات» (owner, 4 Nov 2026). Each step is a link to its page with its own open count
 * (GET /api/sales/journey, scoped like each list); the page the viewer is on is the white step. Counts that fail to
 * load are simply not shown — never a «0» that is not true.
 */
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { api } from "./ui";
import { Ico, type D21IconName } from "@/components/shell/icons";
import "./sales-pages.css";

export type JourneyStep = "leads" | "samples" | "quotes" | "customers";
type Counts = Record<JourneyStep, number>;

const STEPS: { key: JourneyStep; href: string; icon: D21IconName; ar: string; en: string }[] = [
  { key: "leads", href: "/dashboard/sales/leads", icon: "users", ar: "العملاء المحتملون", en: "Leads" },
  { key: "samples", href: "/dashboard/sales/samples", icon: "flask", ar: "العيّنات", en: "Samples" },
  { key: "quotes", href: "/dashboard/sales/quotes", icon: "quote", ar: "عروض الأسعار", en: "Quotations" },
  { key: "customers", href: "/dashboard/customers", icon: "user", ar: "العملاء", en: "Customers" },
];

export function SalesJourney({ current, ar, hide }: { current: JourneyStep; ar: boolean; hide?: JourneyStep[] }) {
  const [counts, setCounts] = useState<Counts | null>(null);
  useEffect(() => {
    let live = true;
    api<Counts>("/api/sales/journey").then((r) => { if (live && r.ok) setCounts(r.data); });
    return () => { live = false; };
  }, []);
  // On a phone the strip scrolls sideways: the page you are on is brought into view.
  const here = useRef<HTMLAnchorElement | null>(null);
  // (again once the counts arrive: they widen the steps).
  useEffect(() => {
    const el = here.current;
    const box = el?.closest("ol");
    if (!el || !box || box.scrollWidth <= box.clientWidth) return;
    box.scrollTo({ left: el.offsetLeft - (box.clientWidth - el.offsetWidth) / 2 });
  }, [counts]);
  const steps = STEPS.filter((s) => !hide?.includes(s.key));
  return (
    <nav className="sj" aria-label={ar ? "مسار العميل" : "Customer journey"} data-testid="sales-journey">
      <ol>
        {steps.map((s, i) => (
          <li key={s.key}>
            {i > 0 ? <Ico name="chev" small className="sj-arrow" /> : null}
            <Link ref={s.key === current ? here : undefined} href={s.href} className="sj-step" aria-current={s.key === current ? "page" : undefined} data-testid={`journey-${s.key}`}>
              <Ico name={s.icon} small />
              <span>{ar ? s.ar : s.en}</span>
              {counts ? <b>{counts[s.key]}</b> : null}
            </Link>
          </li>
        ))}
      </ol>
    </nav>
  );
}
