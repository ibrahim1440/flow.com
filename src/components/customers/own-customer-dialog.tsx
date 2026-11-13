"use client";

// P1 ERR-08 (approved Figma 2033:83, 12 Nov 2026): a lead being converted (or a customer being added) matches a customer
// already in the rep's OWN book — the server names it (409 DUPLICATE_CUSTOMER_OWN with { customer: { id, name } }).
// «افتح العميل», and — when converting a lead — «اربط العميل المحتمل به» (convert with linkToCustomerId: the lead becomes
// «تحوّل» and its activities join the customer). Another rep's customer is never named (SEC-06): the generic message.
import Link from "next/link";
import { useState } from "react";
import { Dialog } from "@/components/hr/ui";

export type OwnCustomer = { id: string; name: string };

/** A 409 body → the rep's own matching customer (or null for any other answer). */
export function ownCustomerOf(body: unknown): OwnCustomer | null {
  const b = body as { code?: string; customer?: OwnCustomer } | null;
  return b?.code === "DUPLICATE_CUSTOMER_OWN" && b.customer?.id ? b.customer : null;
}

export function OwnCustomerDialog({ ar, customer, onLink, onClose }: { ar: boolean; customer: OwnCustomer; onLink?: () => Promise<void> | void; onClose: () => void }) {
  const t = (a: string, e: string) => (ar ? a : e);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open title={t("العميل موجود في دفترك", "The customer is already in your book")} onClose={onClose} testId="own-customer-dialog"
      actions={<>
        <Link className="hr-btn is-primary" href={`/dashboard/customers/${encodeURIComponent(customer.id)}`} data-testid="own-customer-open">{t("افتح العميل", "Open the customer")}</Link>
        {onLink ? <button type="button" className="hr-btn" disabled={busy} data-testid="own-customer-link"
          onClick={async () => { setBusy(true); try { await onLink(); } finally { setBusy(false); } }}>{busy ? t("جارٍ…", "Working…") : t("اربط العميل المحتمل به", "Link the lead to it")}</button> : null}
        <button type="button" className="hr-btn" onClick={onClose}>{t("رجوع", "Back")}</button>
      </>}>
      <div className="hr-stack">
        <p style={{ margin: 0 }} data-testid="own-customer-text">{ar
          ? <>«<bdi>{customer.name}</bdi>» عميل عندك من قبل — افتحه بدل ما تسوي عميل جديد.</>
          : <>«<bdi>{customer.name}</bdi>» is already your customer — open it instead of making a new one.</>}</p>
        {onLink ? <p className="hr-help" style={{ margin: 0 }}>{t("الربط يقفل العميل المحتمل «تحوّل» ويضيف نشاطاته لملف العميل.", "Linking marks the lead «converted» and adds its activities to the customer's file.")}</p> : null}
      </div>
    </Dialog>
  );
}
