"use client";
// «طلب جديد» (D10, owner-approved Figma 1827:8 / 1829:45, 6 Nov 2026): every «طلب جديد» entry — «＋ جديد › طلب», the
// «طلب جديد» button of يومي, a customer row's order icon, `?new=order` on any page — opens this one question:
//   «عرض سعر»       the customer wants prices first → the existing quotation path (picker → editor → issue → accept → order)
//   «بيع مباشر»      the customer buys now (owner decision 1: not «فاتورة مباشرة» — the accountant issues the invoice) → the direct-sale flow (the order, its deal WON, the invoice to the accountant)
//   «خيارات أخرى»    an internal order with no invoice (the old order form) — operations and administration only, never a
//                   scoped sales rep (owner decision 4 of the approved plan)
// No title (the owner removed it in Figma). Options the viewer may not use are not shown; with only the internal order
// left (an operations user with no sales rights) the sheet is skipped and the form opens directly.
import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { hasSubPrivilege } from "@/lib/auth-shared";
import type { Viewer } from "@/lib/nav/registry";
import { customersScopedToOwner } from "@/lib/services/sales/scope";
import { Ico } from "./icons";
import { useTrap } from "./QuickJump";

export type NewOrderChoice = { key: "quote" | "direct" | "internal"; href: string };

/** What this viewer may start from «طلب جديد», for a customer when one is known. Pure. */
export function newOrderChoices(viewer: Viewer, customerId: string | null): NewOrderChoice[] {
  const p = viewer.permissions;
  const c = customerId ? encodeURIComponent(customerId) : null;
  const out: NewOrderChoice[] = [];
  if (hasSubPrivilege(p, "sales", "quote_write")) out.push({ key: "quote", href: c ? `/dashboard/customers/${c}?new=quote` : "/dashboard/sales/quotes/new" });
  if (hasSubPrivilege(p, "orders", "create") && hasSubPrivilege(p, "sales", "invoices_create")) out.push({ key: "direct", href: `/dashboard/sales/direct-sale${c ? `?customerId=${c}` : ""}` });
  if (hasSubPrivilege(p, "orders", "create") && !customersScopedToOwner(viewer)) out.push({ key: "internal", href: `/dashboard/orders?new=internal${c ? `&customerId=${c}` : ""}` });
  return out;
}

const TEXT = {
  quote: { ar: ["عرض سعر", "العميل يبي يشوف الأسعار قبل"], en: ["Quotation", "The customer wants to see prices first"] },
  direct: { ar: ["بيع مباشر", "العميل بيشتري الحين"], en: ["Direct sale", "The customer is buying now"] },
} as const;

export function NewOrderSheet({ ar, viewer, customerId, onClose }: { ar: boolean; viewer: Viewer; customerId: string | null; onClose: () => void }) {
  const router = useRouter();
  const ref = useTrap(onClose);
  const first = useRef<HTMLButtonElement | null>(null);
  const choices = newOrderChoices(viewer, customerId);
  const big = choices.filter((c) => c.key !== "internal");
  const internal = choices.find((c) => c.key === "internal");
  const go = (href: string) => { onClose(); router.push(href); };
  // Nothing to choose between: straight to the one thing (or nothing at all).
  const only = big.length === 0 ? internal?.href ?? null : null;
  useEffect(() => { if (big.length === 0) { onClose(); if (only) router.push(only); } }, [big.length, only, onClose, router]);
  useEffect(() => { first.current?.focus(); }, []);
  if (big.length === 0) return null;
  return (
    <div className="d21-out-scrim" onClick={onClose} data-testid="new-order-scrim">
      <div ref={ref} className="d21-out d21-no" role="dialog" aria-modal="true" aria-label={ar ? "طلب جديد" : "New order"} dir={ar ? "rtl" : "ltr"}
        onClick={(e) => e.stopPropagation()} data-testid="new-order-sheet">
        <span className="d21-out-grab" aria-hidden />
        <div className="d21-no-opts">
          {big.map((c, i) => {
            const [t, s] = TEXT[c.key as "quote" | "direct"][ar ? "ar" : "en"];
            return (
              <button key={c.key} ref={i === 0 ? first : undefined} type="button" className="d21-no-opt" onClick={() => go(c.href)} data-testid={`new-order-${c.key}`}>
                <span className="d21-no-ico" aria-hidden><Ico name={c.key === "quote" ? "quote" : "invoice"} /></span>
                <span className="d21-no-txt"><b>{t}</b><small>{s}</small></span>
                <span className="d21-no-chev" aria-hidden><Ico name="chev" small /></span>
              </button>
            );
          })}
        </div>
        {internal ? (
          <button type="button" className="d21-no-other" onClick={() => go(internal.href)} data-testid="new-order-internal">
            {ar ? "خيارات أخرى · طلب داخلي بدون فاتورة" : "Other options · internal order, no invoice"}
          </button>
        ) : null}
        <button type="button" className="d21-out-no" onClick={onClose} data-testid="new-order-cancel">{ar ? "إلغاء" : "Cancel"}</button>
      </div>
    </div>
  );
}
