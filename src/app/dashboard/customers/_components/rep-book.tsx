"use client";

/**
 * «العملاء» for a rep's own book (owner-approved Figma page 10, 4 Nov 2026): «مسار العميل» on top, the book's filters
 * as compact chips (the counts «لوحة دفتري» showed as tiles), «يحتاجون انتباهك» — the three customers most worth a
 * call today, each with its one action — and the table: status, how much a month, last order, and the quick actions
 * a rep needs on any customer (call, order, quotation, sample). Figures are «يومي»'s own book (GET /api/sales/my-day →
 * `book`, see my-book.tsx), so a number here and on «يومي» are the same customers.
 */
import { displayPhone } from "@/lib/contact/phone";
import { useState, type ReactNode } from "react";
import Link from "next/link";
import { Ico } from "@/components/shell/icons";
import { telHref } from "@/lib/services/search/normalize";
import { SalesJourney } from "../../sales/_components/journey";
import { filterLabel, inFilter, statusOf, type BookFilter, type BookRow, type MyBook } from "./my-book";
import "../../sales/_components/money.css";
import "../../sales/_components/sales-pages.css";

type Cust = { id: string; name: string; nameAr: string | null; phone: string | null; address: string | null };

const CHIPS: { f: BookFilter; dot: string }[] = [
  { f: "active", dot: "var(--status-success)" },
  { f: "negotiating", dot: "var(--status-info)" },
  { f: "stopped", dot: "var(--status-warning)" },
  { f: "growing", dot: "var(--status-success)" },
  { f: "declining", dot: "var(--status-danger)" },
  { f: "contracts", dot: "#8a673a" },
];
const TONE: Record<string, string> = { ok: "t-ok", in: "t-in", wa: "t-wa", er: "t-er", "": "t-pr" };
const DAY = 86_400_000;

export function RepBook({
  ar, phone, book, customers, shown, filter, onFilter, search, notice, viewTabs, addButton, onPreview,
}: {
  ar: boolean; phone: boolean; book: MyBook; customers: Cust[]; shown: Cust[];
  filter: BookFilter | null; onFilter: (f: BookFilter | null) => void; search: ReactNode;
  notice: ReactNode; viewTabs: ReactNode; addButton: ReactNode; onPreview: (id: string) => void;
}) {
  const L = (a: string, e: string) => (ar ? a : e);
  const byId = new Map(book.book.map((r) => [r.id, r]));
  const custById = new Map(customers.map((c) => [c.id, c]));
  const name = (c: Cust) => (ar ? c.nameAr || c.name : c.name);
  // The clock read once per mount (a render must stay pure).
  const [now] = useState(() => Date.now());
  const daysSince = (iso: string | null) => (iso ? Math.max(0, Math.floor((now - new Date(iso).getTime()) / DAY)) : null);
  const agoText = (d: number | null) => d === null ? L("ما طلب للحين", "Never")
    : d === 0 ? L("اليوم", "Today") : d === 1 ? L("أمس", "Yesterday")
      : ar ? `قبل ${d} ${d <= 10 ? "أيام" : "يوم"}` : `${d}d ago`;

  // «يحتاجون انتباهك»: stopped first (longest since the last order), then declining (biggest drop), then contracts
  // ending (soonest) — three at most, each with the one thing to do.
  type Attn = { r: BookRow; c: Cust; dot: string; why: string; cta: ReactNode };
  const attn: Attn[] = [];
  const add = (rows: BookRow[], make: (r: BookRow, c: Cust) => Omit<Attn, "r" | "c">) => {
    for (const r of rows) {
      if (attn.length >= 3) return;
      const c = custById.get(r.id);
      if (!c || attn.some((a) => a.r.id === r.id)) continue;
      attn.push({ r, c, ...make(r, c) });
    }
  };
  add(book.book.filter((r) => r.status === "STOPPED").sort((a, b) => (daysSince(b.lastOrderAt) ?? 0) - (daysSince(a.lastOrderAt) ?? 0)), (r, c) => {
    const tel = telHref(c.phone);
    return {
      dot: "var(--status-warning)",
      why: L(`ما طلب من ${daysSince(r.lastOrderAt) ?? "—"} يوم — فات موعد طلبه`, `No order for ${daysSince(r.lastOrderAt) ?? "—"} days`),
      cta: tel ? <a href={tel} className="mny-lk"><Ico name="phone" small />{L("اتصل الحين", "Call now")}</a>
        : <Link href={`/dashboard/customers/${c.id}?new=activity`} className="mny-lk"><Ico name="phone" small />{L("سجّل تواصل", "Log contact")}</Link>,
    };
  });
  add(book.book.filter((r) => r.declining).sort((a, b) => (a.growthPct ?? 0) - (b.growthPct ?? 0)), (r, c) => ({
    dot: "var(--status-danger)",
    why: L(`طلباته نقصت ${Math.abs(Math.round(r.growthPct ?? 0))}% عن الفترة اللي قبل`, `Ordering ${Math.abs(Math.round(r.growthPct ?? 0))}% less`),
    cta: <Link href={`/dashboard/customers/${c.id}?new=activity`} className="mny-lk"><Ico name="users" small />{L("خطّط زيارة", "Plan a visit")}</Link>,
  }));
  add(book.book.filter((r) => r.contractDaysLeft !== null).sort((a, b) => (a.contractDaysLeft ?? 0) - (b.contractDaysLeft ?? 0)), (r, c) => ({
    dot: "#8a673a",
    why: L(`عقده ينتهي بعد ${r.contractDaysLeft} يوم`, `Contract ends in ${r.contractDaysLeft} days`),
    cta: <Link href={`/dashboard/customers/${c.id}?new=quote`} className="mny-lk"><Ico name="quote" small />{L("جهّز عرض تجديد", "Prepare a renewal")}</Link>,
  }));
  const needCount = book.book.filter((r) => r.status === "STOPPED" || r.declining || r.contractDaysLeft !== null).length;
  const count = (f: BookFilter) => book.book.filter((r) => inFilter(r, f)).length;

  return (
    <div className="spg" data-testid="rep-book">
      {notice}
      {!phone ? (
        <div className="spg-top">
          <div>
            <h1>{L("العملاء", "Customers")}</h1>
            <p data-testid="customers-total">{/* P2 ERR-13: one count per word — «دفترك» is the customers you own (the same book as «يومي» and the
                chips); the list also shows the customers you reach through your deals and orders, counted apart. */}
              {L(`${book.book.length} ${book.book.length === 1 ? "عميل" : "عملاء"} في دفترك`, `${book.book.length} in your book`)}
              {customers.length > book.book.length ? L(` · و${customers.length - book.book.length} من صفقاتك وطلباتك`, ` · and ${customers.length - book.book.length} through your deals and orders`) : ""}{needCount > 0 ? L(` · ${needCount} يحتاجون انتباهك`, ` · ${needCount} need attention`) : ""}</p>
          </div>
          <div className="act">{addButton}</div>
        </div>
      ) : null}
      <SalesJourney current="customers" ar={ar} />

      <div className="mny-chips" role="group" aria-label={L("صفّ القائمة حسب", "Filter the list by")} data-testid="my-book">
        <button type="button" aria-pressed={!filter} onClick={() => onFilter(null)} data-testid="book-chip-all">{L("الكل", "All")} · {customers.length}</button>
        {CHIPS.map((k) => {
          const on = filter === k.f;
          return (
            <button key={k.f} type="button" aria-pressed={on} onClick={() => onFilter(on ? null : k.f)} data-testid={`book-tile-${k.f}`}>
              <i aria-hidden style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: k.dot, marginInlineEnd: 6 }} />
              {filterLabel(k.f, ar)} · {count(k.f)}
            </button>
          );
        })}
      </div>

      {attn.length > 0 ? (
        <section className="mny-card" data-testid="book-attention">
          <div className="mny-h"><div><h2>{L("يحتاجون انتباهك", "Need your attention")}</h2><small>{L(`أهم ${attn.length} — من «انتبه لعملائك»`, `Top ${attn.length}`)}</small></div></div>
          <div className="spg-attn">
            {attn.map((a) => (
              <div key={a.r.id}>
                <Link href={`/dashboard/customers/${a.c.id}`} style={{ color: "inherit", textDecoration: "none" }}>
                  <b><i aria-hidden style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: a.dot, marginInlineEnd: 8 }} /><bdi>{name(a.c)}</bdi></b>
                </Link>
                <small>{a.why}</small>
                {a.cta}
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <div className="spg-tool">{search}{viewTabs}</div>

      {shown.length === 0 ? (
        <p className="spg-tip" data-testid="customers-no-results">
          <Ico name="user" small />
          {filter ? L(`ما فيه عملاء في «${filterLabel(filter, true)}» الحين.`, `No customers in «${filterLabel(filter, false)}» right now.`)
            : customers.length === 0 ? L("ما عندك عملاء بعد. اطلب من المدير يعيّنك مسؤولًا عن عملائك.", "No customers yet. Ask your manager to assign yours.")
              : L("ما فيه عملاء بهذا البحث.", "No customers match.")}
        </p>
      ) : (
        <section className="mny-card flush">
          <div className="spg-list" data-testid="customers-table">
            {shown.map((c) => {
              const r = byId.get(c.id);
              const s = r ? statusOf(r, ar) : null;
              const d = r ? daysSince(r.lastOrderAt) : null;
              const tel = telHref(c.phone);
              return (
                <div key={c.id} className="spg-row" data-testid={`customer-${c.id}`}>
                  <span className="spg-av">{(name(c).trim()[0] ?? "؟")}</span>
                  <div className="spg-main">
                    <div>
                      <Link href={`/dashboard/customers/${c.id}`} className="who" data-testid={`account-link-${c.id}`}><bdi>{name(c)}</bdi></Link>
                      {r?.tier === "VIP" ? <span className="mny-pill t-sa">VIP</span> : null}
                      {s ? <span className={`mny-pill ${TONE[s.tone] ?? "t-pr"}`} data-testid={`customer-status-${c.id}`}>{s.text}</span> : null}
                    </div>
                    <small>{c.address?.split("\n")[0] || (c.phone ? <bdi dir="ltr">{displayPhone(c.phone)}</bdi> : "—")}</small>
                  </div>
                  <div className="spg-amt" style={{ justifyItems: "start" }}>
                    <span>{L("كم يطلب شهريًا", "Per month")}</span>
                    <b>{r && r.kgPerMonth > 0 ? `${Math.round(r.kgPerMonth)} ${L("كجم", "kg")}` : "—"}</b>
                  </div>
                  <div className="spg-amt" style={{ justifyItems: "start", minWidth: 96 }}>
                    <span>{L("آخر طلب", "Last order")}</span>
                    <b style={d !== null && d > 30 ? { color: "var(--status-warning)" } : undefined}>{agoText(d)}</b>
                  </div>
                  <div className="spg-acts">
                    {tel ? <a className="spg-ib" href={tel} aria-label={L(`اتصل بـ ${name(c)}`, `Call ${name(c)}`)} title={L("اتصال", "Call")}><Ico name="phone" small /></a> : null}
                    <Link className="spg-ib" href={`?new=order&customerId=${encodeURIComponent(c.id)}`} aria-label={L(`طلب لـ ${name(c)}`, `Order for ${name(c)}`)} title={L("طلب", "Order")}><Ico name="orders" small /></Link>
                    <Link className="spg-ib" href={`/dashboard/customers/${c.id}?new=quote`} aria-label={L(`عرض سعر لـ ${name(c)}`, `Quotation for ${name(c)}`)} title={L("عرض سعر", "Quotation")}><Ico name="quote" small /></Link>
                    <Link className="spg-ib" href={`/dashboard/customers/${c.id}?new=sample`} aria-label={L(`عيّنة لـ ${name(c)}`, `Sample for ${name(c)}`)} title={L("عيّنة", "Sample")}><Ico name="flask" small /></Link>
                    {!phone ? <button type="button" className="spg-ib" onClick={() => onPreview(c.id)} aria-label={L(`معاينة ${name(c)}`, `Preview ${name(c)}`)} title={L("معاينة", "Preview")} data-testid={`open-customer-${c.id}`}><Ico name="more" small /></button> : null}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}
      <p className="spg-tip">
        <Ico name="users" small />
        {L("من أي عميل: اتصل، ابدأ طلب، سوّ عرض سعر، أو اطلب عيّنة — بضغطة وحدة، والعرض أو العيّنة يطلعون في صفحاتهم بالمسار فوق.",
          "From any customer: call, start an order, a quotation or a sample in one tap — they show up on their pages in the journey above.")}
      </p>
    </div>
  );
}
