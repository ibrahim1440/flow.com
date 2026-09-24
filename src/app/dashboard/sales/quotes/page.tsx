"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { FileText } from "lucide-react";
import {
  useLang, pick, ProvisionalBanner, PageHeader, Alert, Card, EmptyState, Spinner,
  Field, TextInput, Select, Money, Pill, TableWrap, api,
  QuoteStatusBadge,
} from "../_components/ui";
import { formatDate } from "@/lib/utils";

/** Quotation list. PROVISIONAL INTERFACE — see the banner. */

type Quote = {
  id: string;
  quoteNumber: string;
  revision: number;
  status: string;
  currency: string;
  validUntil: string | null;
  subtotal: string;
  discountTotal: string;
  grandTotal: string;
  issuedAt: string | null;
  acceptedAt: string | null;
  createdAt: string;
  customer: { id: string; name: string; nameAr: string | null } | null;
  opportunity: { id: string; title: string; outcome: string; owner: { id: string; name: string } | null };
  _count: { lines: number; orderLinks: number };
};

const STATUS_LABELS: Record<string, { en: string; ar: string }> = {
  DRAFT: { en: "Draft", ar: "مسودة" },
  ISSUED: { en: "Issued", ar: "صادر" },
  ACCEPTED: { en: "Accepted", ar: "مقبول" },
  REJECTED: { en: "Rejected", ar: "مرفوض" },
  EXPIRED: { en: "Expired", ar: "منتهي" },
  SUPERSEDED: { en: "Superseded", ar: "مستبدل" },
};


export default function QuotesPage() {
  const lang = useLang();
  const ar = lang === "ar";

  const [rows, setRows] = useState<Quote[]>([]);
  // Counted when the data arrives, not during render. Reading the clock while rendering is
  // impure — the same props give different output — and it is the shape of bug that shows up
  // as a hydration mismatch rather than as anything legible.
  const [expiringSoon, setExpiringSoon] = useState(0);
  const [total, setTotal] = useState(0);
  const [scope, setScope] = useState<"own" | "all">("own");
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (search.trim()) params.set("q", search.trim());
    const res = await api<{ rows: Quote[]; total: number; scope: "own" | "all" }>(
      `/api/sales/quotes?${params}`,
    );
    if (res.ok) {
      setRows(res.data.rows);
      setTotal(res.data.total);
      setScope(res.data.scope);
      const now = Date.now();
      setExpiringSoon(
        res.data.rows.filter((q) => {
          if (q.status !== "ISSUED" || !q.validUntil) return false;
          const due = new Date(q.validUntil).getTime();
          return due > now && due - now < 7 * 86400_000;
        }).length,
      );
      setError("");
    } else {
      setError(res.data.error ?? (ar ? "تعذّر التحميل." : "Could not load."));
    }
    setLoading(false);
  }, [status, search, ar]);

  useEffect(() => {
    const t = setTimeout(load, search ? 300 : 0);
    return () => clearTimeout(t);
  }, [load, search]);

  if (loading) return <Spinner />;

  return (
    <div className="space-y-6">
      <ProvisionalBanner />

      <PageHeader
        title={ar ? "عروض الأسعار" : "Quotations"}
        subtitle={
          <span className="flex items-center gap-2 flex-wrap mt-1">
            <span>{total}</span>
            {expiringSoon > 0 && (
              <Pill tone="warn" testId="expiring-soon">
                {expiringSoon} {ar ? "تنتهي هذا الأسبوع" : "expiring this week"}
              </Pill>
            )}
            {scope === "own" && (
              <span className="text-[11px] text-brown/60 font-semibold">
                {ar ? "صفقاتك فقط" : "your own deals only"}
              </span>
            )}
          </span>
        }
      />

      {error && <Alert kind="error" onDismiss={() => setError("")}>{error}</Alert>}

      <div className="flex gap-2 flex-wrap items-end">
        <div className="flex-1 min-w-[200px]">
          <Field id="q-search" label={ar ? "بحث" : "Search"}>
            <TextInput
              id="q-search"
              value={search}
              onChange={setSearch}
              placeholder={ar ? "رقم العرض أو العميل أو الصفقة…" : "Quote number, customer or deal…"}
            />
          </Field>
        </div>
        <div className="w-44">
          <Field id="q-status" label={ar ? "الحالة" : "Status"}>
            <Select id="q-status" value={status} onChange={setStatus}>
              <option value="">{ar ? "كل الحالات" : "All statuses"}</option>
              {Object.keys(STATUS_LABELS).map((s) => (
                <option key={s} value={s}>{pick(STATUS_LABELS, s, lang)}</option>
              ))}
            </Select>
          </Field>
        </div>
      </div>

      {rows.length === 0 ? (
        <Card>
          <EmptyState>
            <FileText size={28} className="mx-auto mb-2 opacity-40" aria-hidden />
            {ar
              ? "لا توجد عروض أسعار. يُنشأ العرض من صفحة الصفقة."
              : "No quotations. A quotation is raised from a deal."}
          </EmptyState>
        </Card>
      ) : (
        <Card>
          <TableWrap>
            <table className="w-full text-sm min-w-[720px]">
              <thead>
                <tr className="text-[11px] uppercase text-brown/60 font-bold">
                  <th className="text-start py-2">{ar ? "الرقم" : "Number"}</th>
                  <th className="text-start py-2">{ar ? "العميل" : "Customer"}</th>
                  <th className="text-start py-2">{ar ? "الصفقة" : "Deal"}</th>
                  <th className="text-start py-2">{ar ? "الحالة" : "Status"}</th>
                  <th className="text-end py-2">{ar ? "الخصم" : "Discount"}</th>
                  <th className="text-end py-2">{ar ? "الإجمالي" : "Total"}</th>
                  <th className="text-start py-2">{ar ? "صالح حتى" : "Valid until"}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((q) => {
                  const expired =
                    q.status === "ISSUED" && q.validUntil && new Date(q.validUntil) < new Date();
                  return (
                    <tr
                      key={q.id}
                      className="border-t border-border hover:bg-cream/40"
                      data-testid={`quote-row-${q.quoteNumber}`}
                    >
                      <td className="py-2.5 font-bold">
                        <Link href={`/dashboard/sales/quotes/${q.id}`} className="hover:text-orange">
                          {q.quoteNumber}
                        </Link>
                        {q.revision > 1 && <span className="text-[10px] text-brown/60 ps-1">r{q.revision}</span>}
                      </td>
                      <td className="py-2.5">
                        {q.customer ? (ar ? (q.customer.nameAr ?? q.customer.name) : q.customer.name) : "—"}
                      </td>
                      <td className="py-2.5 text-xs">
                        <Link
                          href={`/dashboard/sales/deals/${q.opportunity.id}`}
                          className="hover:text-orange"
                        >
                          {q.opportunity.title}
                        </Link>
                      </td>
                      <td className="py-2.5">
                        <span className="flex items-center gap-1.5 flex-wrap">
                          <QuoteStatusBadge status={q.status} />
                          {expired && <Pill tone="warn">{ar ? "انتهى" : "lapsed"}</Pill>}
                          {q._count.orderLinks > 0 && (
                            <Pill tone="accent">{ar ? "طلب" : "ordered"}</Pill>
                          )}
                        </span>
                      </td>
                      <td className="py-2.5 text-end text-xs tabular-nums">
                        {Number(q.discountTotal) > 0 ? q.discountTotal : "—"}
                      </td>
                      <td className="py-2.5 text-end">
                        <Money value={q.grandTotal} currency={q.currency} />
                      </td>
                      <td className="py-2.5 text-xs text-brown">
                        {q.validUntil ? formatDate(q.validUntil) : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableWrap>
        </Card>
      )}
    </div>
  );
}
