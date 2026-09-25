"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { FileText } from "lucide-react";
import {
  useLang, pick, ProvisionalBanner, PageHeader, Alert, Card, EmptyState, Spinner,
  Money, Pill, api, QuoteStatusBadge, DataTable, Tr, Td, Toolbar, SearchField,
  FilterSelect, ROW_ACTION, formatDay, formatMoney, num,
} from "../_components/ui";

/**
 * Quotation list — SC-05 in the Sales Screens design.
 *
 * The columns, their order and their widths are the design's; so is the single outlined
 * action per row. What that action SAYS is decided here rather than in the design, because
 * the server decides what a quotation will actually accept: `create-order` refuses anything
 * that is not ACCEPTED with no order against it yet, and `revise` refuses anything that is
 * not ISSUED, REJECTED or EXPIRED. Offering a control the server would reject is worse than
 * a label that differs from the mock, so the one deviation is recorded in the handoff.
 */

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

/**
 * The one next step for a quotation, in the design's slot.
 *
 * Every branch here mirrors a server predicate — `isEditable`, `isRevisable`, and the
 * `orderable` flag the detail endpoint reports — so the list never shows a control that
 * would come back refused. The actions themselves live on the quotation, which is where
 * their forms and confirmations are; the list links to them rather than growing copies.
 */
function RowAction({ quote, lang }: { quote: Quote; lang: "ar" | "en" }) {
  const ar = lang === "ar";
  const href = `/dashboard/sales/quotes/${quote.id}`;
  const link = `${ROW_ACTION} text-oo-action-primary hover:border-oo-action-primary`;
  const inert = `${ROW_ACTION} text-oo-text-muted`;

  if (quote.status === "DRAFT") {
    return <Link href={href} className={link}>{ar ? "متابعة التحرير" : "Continue editing"}</Link>;
  }
  if (quote.status === "ACCEPTED") {
    // Already converted: the convert action is gone, and saying so is more use than an
    // action the server would refuse.
    return quote._count.orderLinks > 0 ? (
      <Link href={href} className={inert + " hover:text-oo-action-primary"}>
        {ar ? "حُوِّل إلى طلب" : "Converted to order"}
      </Link>
    ) : (
      <Link href={href} className={link}>{ar ? "تحويل إلى طلب" : "Convert to order"}</Link>
    );
  }
  if (quote.status === "ISSUED") {
    return <Link href={href} className={link}>{ar ? "تسجيل القرار" : "Record the decision"}</Link>;
  }
  if (quote.status === "REJECTED" || quote.status === "EXPIRED") {
    return <Link href={href} className={link}>{ar ? "إنشاء مراجعة" : "Raise a revision"}</Link>;
  }
  return <Link href={href} className={inert + " hover:text-oo-action-primary"}>{ar ? "عرض" : "View"}</Link>;
}

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

  // The design's caption is three facts about the list, not a bare count. All three come
  // from the rows already on screen, so the caption can never disagree with the table.
  const issued = rows.filter((q) => q.status === "ISSUED").length;
  const issuedValue = rows
    .filter((q) => q.status === "ISSUED")
    .reduce((sum, q) => sum + Number(q.grandTotal), 0);
  const money = (n: number) => {
    const s = formatMoney(n.toFixed(2), 0);
    return ar ? `${s} ر.س` : `${s} SAR`;
  };
  // Each fact is its own element. Joined into one string, the bidi algorithm is free to
  // move a "·" that sits between two Arabic-Indic numerals, and the caption reads as a
  // different number than the one it was given.
  const caption = [
    `${num(total, lang)} ${ar ? "عروض" : "quotations"}`,
    `${num(issued, lang)} ${ar ? "صادرة" : "issued"}`,
    `${ar ? "قيمة الصادر" : "issued value"} ${money(issuedValue)}`,
  ];

  return (
    <div className="space-y-[18px]">
      <ProvisionalBanner />

      <PageHeader
        title={ar ? "عروض الأسعار" : "Quotations"}
        subtitle={
          <span className="flex items-center gap-2 flex-wrap">
            {caption.map((part, i) => (
              <span key={i} className="flex items-center gap-2">
                {i > 0 && <span aria-hidden className="text-oo-border-strong">·</span>}
                <span>{part}</span>
              </span>
            ))}
            {expiringSoon > 0 && (
              <Pill tone="warn" testId="expiring-soon">
                {num(expiringSoon, lang)} {ar ? "تنتهي هذا الأسبوع" : "expiring this week"}
              </Pill>
            )}
            {scope === "own" && <span>{ar ? "· صفقاتك فقط" : "· your own deals only"}</span>}
          </span>
        }
      />

      {error && <Alert kind="error" onDismiss={() => setError("")}>{error}</Alert>}

      <Toolbar>
        <SearchField
          value={search}
          onChange={setSearch}
          label={ar ? "بحث" : "Search"}
          placeholder={ar ? "ابحث برقم العرض أو العميل…" : "Search by quote number or customer…"}
        />
        <FilterSelect value={status} onChange={setStatus} label={ar ? "الحالة" : "Status"}>
          <option value="">{ar ? "كل الحالات" : "All statuses"}</option>
          {Object.keys(STATUS_LABELS).map((s) => (
            <option key={s} value={s}>{pick(STATUS_LABELS, s, lang)}</option>
          ))}
        </FilterSelect>
      </Toolbar>

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
        <>
          {/* ── Desktop: the design's seven columns, right to left ──────────────────── */}
          <div className="hidden lg:block">
            <DataTable
              testId="quotes-table"
              minWidth={1230}
              cols={[
                { label: ar ? "رقم العرض" : "Quote no.", w: "min-w-[150px]" },
                { label: ar ? "العميل" : "Customer", w: "w-[200px]" },
                { label: ar ? "الصفقة" : "Deal", w: "w-[250px]" },
                { label: ar ? "الإجمالي" : "Total", w: "w-[170px]" },
                { label: ar ? "الحالة" : "Status", w: "w-[160px]" },
                { label: ar ? "صالح حتى" : "Valid until", w: "w-[150px]" },
                { label: <span className="sr-only">{ar ? "الإجراء" : "Action"}</span>, w: "w-[150px]" },
              ]}
            >
              {rows.map((q) => {
                const expired =
                  q.status === "ISSUED" && q.validUntil && new Date(q.validUntil) < new Date();
                return (
                  <Tr key={q.id} testId={`quote-row-${q.quoteNumber}`}>
                    <Td>
                      <Link
                        href={`/dashboard/sales/quotes/${q.id}`}
                        className="font-medium text-oo-action-primary hover:underline"
                      >
                        {q.quoteNumber}
                        {/* Inside the link's own Latin run, so the revision stays attached to
                            the number instead of being placed by the bidi algorithm. */}
                        {q.revision > 1 && <span className="text-oo-text-muted"> r{q.revision}</span>}
                      </Link>
                    </Td>
                    <Td>{q.customer ? (ar ? (q.customer.nameAr ?? q.customer.name) : q.customer.name) : "—"}</Td>
                    <Td>
                      <Link
                        href={`/dashboard/sales/deals/${q.opportunity.id}`}
                        className="hover:text-oo-action-primary"
                      >
                        {q.opportunity.title}
                      </Link>
                    </Td>
                    <Td>
                      <Money value={q.grandTotal} currency={q.currency} />
                    </Td>
                    <Td>
                      <QuoteStatusBadge status={q.status} />
                    </Td>
                    <Td className={expired ? "text-oo-status-hold" : ""}>
                      {q.validUntil
                        ? expired
                          ? `${ar ? "انتهى" : "lapsed"} ${formatDay(q.validUntil, lang)}`
                          : formatDay(q.validUntil, lang)
                        : "—"}
                    </Td>
                    <Td>
                      <RowAction quote={q} lang={lang} />
                    </Td>
                  </Tr>
                );
              })}
            </DataTable>
          </div>

          {/* ── Narrow: the same seven facts stacked, not a squeezed table ──────────── */}
          <div className="space-y-2 lg:hidden">
            {rows.map((q) => {
              const expired =
                q.status === "ISSUED" && q.validUntil && new Date(q.validUntil) < new Date();
              return (
                <div
                  key={q.id}
                  data-testid={`m-quote-${q.quoteNumber}`}
                  className="rounded-2xl border border-oo-border-default bg-oo-bg-default p-4"
                >
                  <div className="flex items-start justify-between gap-2">
                    <QuoteStatusBadge status={q.status} />
                    <div className="min-w-0 text-end">
                      <Link
                        href={`/dashboard/sales/quotes/${q.id}`}
                        className="block text-[14px] font-medium leading-[22px] text-oo-action-primary"
                      >
                        {q.quoteNumber}
                        {q.revision > 1 && <span className="text-oo-text-muted"> r{q.revision}</span>}
                      </Link>
                      <span className="block truncate text-[12px] leading-[18px] text-oo-text-muted">
                        {q.customer ? (ar ? (q.customer.nameAr ?? q.customer.name) : q.customer.name) : "—"}
                        {" · "}
                        {q.opportunity.title}
                      </span>
                    </div>
                  </div>
                  <div className="mt-3 flex items-end justify-between gap-2">
                    <RowAction quote={q} lang={lang} />
                    <div className="text-end">
                      <div className="text-[14px] leading-[22px]">
                        <Money value={q.grandTotal} currency={q.currency} strong />
                      </div>
                      <div
                        className={`text-[12px] leading-[18px] ${expired ? "text-oo-status-hold" : "text-oo-text-muted"}`}
                      >
                        {q.validUntil
                          ? `${ar ? "صالح حتى" : "valid until"} ${formatDay(q.validUntil, lang)}`
                          : "—"}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
