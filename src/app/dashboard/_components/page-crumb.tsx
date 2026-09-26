"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";

/**
 * A trailing breadcrumb a page can contribute about itself.
 *
 * The registry knows the shape of the menu, so it can name "Operations" and "Order
 * Preparation" from the path alone. It cannot name "Order #10248": that is a record, not
 * a route, and the only thing that knows it is the page that fetched it.
 *
 * Rather than teach the registry about data, a page sets its own last crumb here and the
 * shell's breadcrumb appends it. Setting it is optional — a page that says nothing gets
 * the registry trail on its own, exactly as before.
 */
type Ctx = { crumb: string | null; setCrumb: (v: string | null) => void };

const PageCrumbContext = createContext<Ctx | null>(null);

export function PageCrumbProvider({ children }: { children: React.ReactNode }) {
  const [crumb, setCrumb] = useState<string | null>(null);
  const value = useMemo(() => ({ crumb, setCrumb }), [crumb]);
  return <PageCrumbContext value={value}>{children}</PageCrumbContext>;
}

/** Read the current trailing crumb. Used by the breadcrumb trail. */
export function usePageCrumb(): string | null {
  return useContext(PageCrumbContext)?.crumb ?? null;
}

/**
 * Declare this page's trailing crumb.
 *
 * Cleared on unmount so navigating away cannot leave a stale record name pinned to the
 * next page's trail.
 */
export function useSetPageCrumb(label: string | null) {
  const ctx = useContext(PageCrumbContext);
  const setCrumb = ctx?.setCrumb;
  useEffect(() => {
    if (!setCrumb) return;
    setCrumb(label);
    return () => setCrumb(null);
  }, [label, setCrumb]);
}
