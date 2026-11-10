"use client";

/**
 * «عروض الأسعار» for a rep's own list (owner-approved Figma page 10, 4 Nov 2026): «مسار العميل» on top, four status
 * cards that filter (مسودات / بانتظار رد العميل / مقبولة / انتهت أو انرفضت — the option-ب cards), search with the
 * segment الكل / يحتاج منك / المفتوحة / المنتهية, and one row per quotation with ONE next step:
 *   draft → «كمّل وأرسل»; issued → «سجّل رد العميل»; accepted → «حوّله لطلب», or «افتح الطلب» once it is one.
 * Each step mirrors what the server accepts (see RowAction in page.tsx); the action itself lives on the quotation.
 * Every number is the server's (`counts`, `summary` of GET /api/sales/quotes).
 */
import { useState, type ReactNode } from "react";
import Link from "next/link";
import { formatMoney } from "../_components/ui";
import { SalesJourney } from "../_components/journey";
import { Ico, type D21IconName } from "@/components/shell/icons";
import { shortDate } from "@/components/d21/format";
import "../_components/money.css";
import "../_components/sales-pages.css";

export type RepStage = "" | "need" | "open" | "ended" | "lost";

type Q = {
  id: string; quoteNumber: string; status: string; currency: string; validUntil: string | null; grandTotal: string;
  createdAt: string; issuedAt: string | null; acceptedAt: string | null;
  discountApproval: "NOT_NEEDED" | "PENDING" | "APPROVED" | "REJECTED";
  customer: { id: string; name: string; nameAr: string | null } | null;
  opportunity: { id: string; title: string } | null;
  _count: { lines: number; orderLinks: number };
  orderLinks?: { order: { orderNumber: number } }[];
};
type Data = {
  rows: Q[]; total: number;
  counts: Record<string, number>;
  summary: { openValue?: string };
};

const CARDS: { key: string; stage?: RepStage; ar: string; en: string; tone: string; icon: D21IconName }[] = [
  { key: "DRAFT", ar: "مسودات", en: "Drafts", tone: "var(--text-secondary)", icon: "edit" },
  { key: "ISSUED", ar: "بانتظار رد العميل", en: "Awaiting the customer", tone: "var(--status-info)", icon: "clock" },
  { key: "ACCEPTED", ar: "مقبولة", en: "Accepted", tone: "var(--status-success)", icon: "tick" },
  { key: "LOST", stage: "lost", ar: "انتهت أو انرفضت", en: "Lapsed or refused", tone: "var(--status-danger)", icon: "close" },
];
const SEGS: { key: RepStage; ar: string; en: string }[] = [
  { key: "", ar: "الكل", en: "All" },
  { key: "need", ar: "يحتاج منك", en: "Needs you" },
  { key: "open", ar: "المفتوحة", en: "Open" },
  { key: "ended", ar: "المنتهية", en: "Ended" },
];

export function RepQuotes({
  lang, phone, data, base, status, stage, search, onStatus, onStage, onSearch, notice, pager, exportLink, onNew, picker, paging,
}: {
  lang: "ar" | "en"; phone: boolean; data: Data; base: string; status: string; stage: RepStage; search: string;
  onStatus: (s: string) => void; onStage: (s: RepStage) => void; onSearch: (s: string) => void;
  notice: ReactNode; pager: ReactNode; exportLink: ReactNode; onNew: (() => void) | null; picker: ReactNode; paging: boolean;
}) {
  const ar = lang === "ar";
  const c = data.counts;
  const sar = ar ? "⃁" : "SAR";
  // The clock read once per mount (a render must stay pure).
  const [now] = useState(() => Date.now());
  const name = (q: Q) => (q.customer ? (ar ? q.customer.nameAr ?? q.customer.name : q.customer.name) : "—");
  const day = (iso: string) => shortDate(iso, lang);
  const filterOn = !!status || !!stage || !!search.trim();

  /** The status pill, the quiet line under the customer, the line under the total, and the one next step. */
  const view = (q: Q) => {
    const href = `${base}/${q.id}`;
    const lapsed = q.status === "ISSUED" && !!q.validUntil && new Date(q.validUntil).getTime() < now;
    const order = q.orderLinks?.[0]?.order.orderNumber;
    switch (q.status) {
      case "DRAFT": {
        const waiting = q.discountApproval === "PENDING";
        return {
          pill: { cls: "t-pr", ar: "مسودة", en: "Draft" }, tone: "t-pr",
          sub: `${ar ? "أنشأته" : "Created"} ${day(q.createdAt)}`,
          under: waiting ? { ar: "الخصم بانتظار اعتماد المدير", en: "Discount awaiting approval", cls: "wa" } : q.validUntil ? { ar: `صالح لين ${day(q.validUntil)}`, en: `Valid until ${day(q.validUntil)}` } : null,
          cta: waiting
            ? <Link href={href} className="spg-cta">{ar ? "افتح العرض" : "Open"}</Link>
            : <Link href={href} className="spg-cta p" data-testid={`rq-act-${q.quoteNumber}`}><Ico name="edit" small />{ar ? "كمّل وأرسل" : "Finish and send"}</Link>,
        };
      }
      case "ISSUED":
        return {
          pill: lapsed ? { cls: "t-wa", ar: "انتهت صلاحيته", en: "Past its date" } : { cls: "t-in", ar: "بانتظار رد العميل", en: "Awaiting the customer" }, tone: lapsed ? "t-wa" : "t-in",
          sub: `${ar ? "أرسلته" : "Sent"} ${day(q.issuedAt ?? q.createdAt)}`,
          under: q.validUntil ? { ar: `${lapsed ? "انتهى" : "صالح لين"} ${day(q.validUntil)}`, en: `${lapsed ? "Ended" : "Valid until"} ${day(q.validUntil)}`, cls: lapsed ? "wa" : undefined } : null,
          cta: <Link href={href} className="spg-cta p" data-testid={`rq-act-${q.quoteNumber}`}><Ico name="phone" small />{ar ? "سجّل رد العميل" : "Record the answer"}</Link>,
        };
      case "ACCEPTED":
        return q._count.orderLinks > 0
          ? {
            pill: { cls: "t-ok", ar: "مقبول · صار طلب", en: "Accepted · ordered" }, tone: "t-ok",
            sub: order ? `${ar ? "طلب" : "Order"} #${order}` : `${ar ? "قبله العميل" : "Accepted"} ${day(q.acceptedAt ?? q.createdAt)}`,
            under: { ar: "تم", en: "Done", cls: "ok" },
            cta: order
              ? <Link href={`/dashboard/orders?order=${order}`} className="spg-cta" data-testid={`rq-act-${q.quoteNumber}`}><Ico name="orders" small />{ar ? "افتح الطلب" : "Open the order"}</Link>
              : <Link href={href} className="spg-cta">{ar ? "افتح العرض" : "Open"}</Link>,
          }
          : {
            pill: { cls: "t-ok", ar: "مقبول", en: "Accepted" }, tone: "t-ok",
            sub: `${ar ? "قبله العميل" : "Accepted"} ${day(q.acceptedAt ?? q.createdAt)}`,
            under: { ar: "ما تحوّل لطلب للحين", en: "Not an order yet", cls: "wa" },
            cta: <Link href={href} className="spg-cta p" data-testid={`rq-act-${q.quoteNumber}`}><Ico name="orders" small />{ar ? "حوّله لطلب" : "Turn into an order"}</Link>,
          };
      case "REJECTED":
      case "EXPIRED":
        return {
          pill: q.status === "REJECTED" ? { cls: "t-er", ar: "انرفض", en: "Refused" } : { cls: "t-wa", ar: "انتهى", en: "Lapsed" }, tone: "t-er",
          sub: `${ar ? "أرسلته" : "Sent"} ${day(q.issuedAt ?? q.createdAt)}`,
          under: null,
          cta: <Link href={href} className="spg-cta" data-testid={`rq-act-${q.quoteNumber}`}>{ar ? "سوّ نسخة جديدة" : "Raise a revision"}</Link>,
        };
      default:
        return { pill: { cls: "t-pr", ar: "مستبدل", en: "Superseded" }, tone: "t-pr", sub: day(q.createdAt), under: null, cta: <Link href={href} className="spg-cta">{ar ? "افتح العرض" : "Open"}</Link> };
    }
  };

  const openN = c.OPEN ?? 0;
  return (
    <div className="pg spg" data-testid="rep-quotes">
      {notice}
      {!phone ? (
        <div className="spg-top">
          <div>
            <h1>{ar ? "عروض الأسعار" : "Quotations"}</h1>
            <p>
              {ar ? `${openN} مفتوحة` : `${openN} open`}
              {data.summary.openValue ? ` · ${ar ? "قيمة المفتوح" : "open value"} ${formatMoney(data.summary.openValue)} ${sar}` : ""}
              {` · ${ar ? "صفقاتك فقط" : "your own deals only"}`}
            </p>
          </div>
          <div className="act">
            {exportLink}
            {onNew ? <button type="button" className="spg-cta p" onClick={onNew} data-testid="new-quote"><Ico name="plus" small />{ar ? "عرض سعر" : "Quotation"}</button> : null}
          </div>
        </div>
      ) : null}
      <SalesJourney current="quotes" ar={ar} />

      <div className="spg-cards" style={{ ["--n" as string]: 4 }}>
        {CARDS.map((k) => {
          const on = k.stage ? stage === k.stage : status === k.key;
          return (
            <button key={k.key} type="button" className="mny-stt" style={{ color: k.tone }} aria-pressed={on} data-testid={`rq-card-${k.key}`}
              onClick={() => (on ? onStatus("") : k.stage ? onStage(k.stage) : onStatus(k.key))}>
              <span className="h"><Ico name={k.icon} small />{ar ? k.ar : k.en}</span>
              <b>{c[k.key] ?? 0}</b>
            </button>
          );
        })}
      </div>

      <div className="spg-tool">
        <label className="spg-search">
          <Ico name="search" small />
          <input value={search} onChange={(e) => onSearch(e.target.value)} data-testid="quote-search"
            placeholder={ar ? "رقم العرض أو العميل" : "Quote no. or customer"} aria-label={ar ? "بحث في عروض الأسعار" : "Search quotations"} />
        </label>
        <span className="sp" />
        <ul className="spg-seg" aria-label={ar ? "عرض" : "Show"}>
          {SEGS.map((s) => (
            <li key={s.key || "all"}>
              <button type="button" aria-current={stage === s.key && (s.key !== "" || !status) ? "page" : undefined}
                data-testid={`rq-seg-${s.key || "all"}`} onClick={() => onStage(s.key)}>
                {ar ? s.ar : s.en}{s.key === "need" && (c.NEED ?? 0) > 0 ? ` · ${c.NEED}` : ""}
              </button>
            </li>
          ))}
        </ul>
      </div>

      {data.rows.length === 0 ? (
        <p className="spg-tip" data-testid={filterOn ? "quotes-no-results" : "quotes-empty"}>
          <Ico name="quote" small />
          {filterOn
            ? (ar ? "ما فيه عروض بهذا البحث أو الحالة." : "No quotations match.")
            : (ar ? "ما عندك عروض أسعار. ابدأ من «عرض سعر» أو من صفحة العميل." : "No quotations yet. Start with «Quotation» or from the customer.")}
        </p>
      ) : (
        <section className="mny-card flush" aria-busy={paging || undefined} style={paging ? { opacity: .6 } : undefined}>
          <div className="spg-list" data-testid="quotes-table">
            {data.rows.map((q) => {
              const v = view(q);
              return (
                <div key={q.id} className="spg-row" data-testid={`quote-row-${q.quoteNumber}`}>
                  <span className={`spg-av ${v.tone}`}><Ico name="quote" small /></span>
                  <div className="spg-main">
                    <div>
                      <Link href={`${base}/${q.id}`} className="who"><bdi>{name(q)}</bdi></Link>
                      <span className={`mny-pill ${v.pill.cls}`} data-testid={`quote-status-${q.quoteNumber}`}>{ar ? v.pill.ar : v.pill.en}</span>
                    </div>
                    <small><bdi dir="ltr">{q.quoteNumber}</bdi> · {v.sub}</small>
                  </div>
                  <div className="spg-amt">
                    <b><bdi>{formatMoney(q.grandTotal)} {q.currency === "SAR" ? sar : q.currency}</bdi></b>
                    {v.under ? <span style={v.under.cls ? { color: `var(--status-${v.under.cls === "ok" ? "success" : "warning"})`, fontWeight: 600 } : undefined}>{ar ? v.under.ar : v.under.en}</span> : null}
                  </div>
                  <div className="spg-acts">{v.cta}</div>
                </div>
              );
            })}
          </div>
        </section>
      )}
      {pager}
      <p className="spg-tip">
        <Ico name="quote" small />
        {ar
          ? "كل عرض فيه الخطوة الجاية بزر واحد: كمّل وأرسل ← سجّل رد العميل ← حوّله لطلب. العرض المقبول يصير طلب، والعميل يطلع في «العملاء»."
          : "Each quotation has its next step on one button: finish and send → record the answer → turn into an order."}
      </p>
      {phone ? <div className="spg-tool">{exportLink}{onNew ? <button type="button" className="spg-cta p" onClick={onNew}><Ico name="plus" small />{ar ? "عرض سعر" : "Quotation"}</button> : null}</div> : null}
      {picker}
    </div>
  );
}
