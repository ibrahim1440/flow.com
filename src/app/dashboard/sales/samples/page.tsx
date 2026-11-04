"use client";

/**
 * «العيّنات» (owner-approved Figma page 10, 4 Nov 2026; the list itself is batch 24 WP-B): every sample of the caller's
 * own deals (a sales manager: everyone's). On top, «مسار العميل»; then four status cards that also filter — بانتظار
 * الشحن / انشحنت · ننتظر رأيه / عجبته / ما عجبته (the option-ب cards of «التحصيل»); then one card per open sample
 * with its steps and what to do next; then «عيّنات سابقة» with the result and the next move (a quotation, or another
 * sample). Data: GET /api/sales/samples (scoped through the deal's owner on the server). Requesting a sample and
 * recording the customer's view stay where they were (the customer and the deal): «اطلب عيّنة» opens the shell's
 * «لأي عميل؟» picker, which lands on the customer with the request open.
 */
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { api, useLang, formatDay } from "../_components/ui";
import { PerfLoading, PerfNotice } from "../_components/perf";
import { SalesJourney } from "../_components/journey";
import { Ico } from "@/components/shell/icons";
import { requestShellCreate, useD21Phone, usePhone } from "@/components/shell/page-context";
import "../_components/money.css";
import "../_components/sales-pages.css";

type Row = {
  id: string; description: string; quantity: string; unit: string; status: string;
  sentAt: string | null; feedbackAt: string | null; feedbackScore: number | null; createdAt: string;
  approval?: string;
  productSku: { name: string } | null;
  opportunity: { id: string; title: string; customer: { id: string; name: string } | null; owner: { id: string; name: string } };
};

type Bucket = "ship" | "sent" | "liked" | "disliked";
const DAY = 86_400_000;

/** Where a sample stands, in the four buckets of the cards (null: cancelled, or answered with no score — old rows). */
function bucketOf(r: Row): Bucket | null {
  if (r.status === "REQUESTED" || r.status === "PREPARING") return "ship";
  if (r.status === "SENT") return "sent";
  if (r.status === "FEEDBACK_RECEIVED" && r.feedbackScore !== null) return r.feedbackScore >= 3 ? "liked" : "disliked";
  return null;
}

const CARDS: { key: Bucket; ar: string; en: string; tone: string; icon: "clock" | "truck" | "tick" | "close" }[] = [
  { key: "ship", ar: "بانتظار الشحن", en: "Waiting to ship", tone: "var(--status-warning)", icon: "clock" },
  { key: "sent", ar: "انشحنت · ننتظر رأيه", en: "Sent · awaiting view", tone: "var(--status-info)", icon: "truck" },
  { key: "liked", ar: "عجبته", en: "Liked it", tone: "var(--status-success)", icon: "tick" },
  { key: "disliked", ar: "ما عجبته", en: "Didn't like it", tone: "var(--status-danger)", icon: "close" },
];

export default function SamplesPage() {
  const lang = useLang();
  const ar = lang === "ar";
  const phone = usePhone();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [scope, setScope] = useState<"own" | "all">("own");
  const [error, setError] = useState("");
  const [only, setOnly] = useState<Bucket | null>(null);
  const [now, setNow] = useState(0);
  useD21Phone({ title: ar ? "العيّنات" : "Samples" });

  useEffect(() => {
    api<{ rows: Row[]; scope: "own" | "all" }>("/api/sales/samples").then((r) => {
      if (r.ok) { setRows(r.data.rows); setScope(r.data.scope); setNow(Date.now()); } else setError(r.data.error ?? (ar ? "تعذّر التحميل." : "Could not load."));
    });
  }, [ar]);

  const counts = useMemo(() => {
    const c: Record<Bucket, number> = { ship: 0, sent: 0, liked: 0, disliked: 0 };
    for (const r of rows ?? []) { const b = bucketOf(r); if (b) c[b] += 1; }
    return c;
  }, [rows]);
  if (error) return <div className="pg"><PerfNotice kind="error" ar={ar}>{error}</PerfNotice></div>;
  if (!rows) return <PerfLoading ar={ar} />;

  const shown = only ? rows.filter((r) => bucketOf(r) === only) : rows;
  const open = shown.filter((r) => r.status === "REQUESTED" || r.status === "PREPARING" || r.status === "SENT");
  const past = shown.filter((r) => r.status === "FEEDBACK_RECEIVED" || r.status === "CANCELLED");
  const days = (iso: string) => Math.max(0, Math.floor((now - new Date(iso).getTime()) / DAY));
  const ago = (iso: string) => {
    const d = days(iso);
    return ar ? (d === 0 ? "اليوم" : d === 1 ? "أمس" : d === 2 ? "قبل يومين" : d <= 10 ? `قبل ${d} أيام` : `قبل ${d} يوم`) : d === 0 ? "today" : `${d}d ago`;
  };
  const what = (r: Row) => r.productSku?.name ?? r.description;
  const qty = (r: Row) => `${Number(r.quantity)} ${r.unit === "KG" ? (ar ? "كجم" : "kg") : r.unit === "GRAM" ? (ar ? "جرام" : "g") : (ar ? "وحدة" : "unit")}`;
  const who = (r: Row) => r.opportunity.customer?.name ?? r.opportunity.title;
  const dealHref = (r: Row) => `/dashboard/sales/deals/${r.opportunity.id}`;

  return (
    <div className="pg spg">
      {!phone ? (
        <div className="spg-top">
          <div>
            <h1>{ar ? "العيّنات" : "Samples"}</h1>
            <p>
              {scope === "own" ? (ar ? "عيّنات صفقاتك" : "Samples of your deals") : (ar ? "عيّنات كل الفريق" : "The whole team's samples")}
              {counts.ship + counts.sent > 0 ? ` · ${counts.ship + counts.sent} ${ar ? "مفتوحة" : "open"}` : ""}
            </p>
          </div>
          <div className="act">
            <button type="button" className="spg-cta p" data-testid="samples-new" onClick={() => requestShellCreate("sales.sample.new")}>
              <Ico name="plus" small />{ar ? "اطلب عيّنة" : "Request a sample"}
            </button>
          </div>
        </div>
      ) : null}
      <SalesJourney current="samples" ar={ar} />

      <div className="spg-cards" style={{ ["--n" as string]: 4 }}>
        {CARDS.map((c) => (
          <button key={c.key} type="button" className="mny-stt" style={{ color: c.tone }} aria-pressed={only === c.key}
            data-testid={`samples-card-${c.key}`} onClick={() => setOnly((v) => (v === c.key ? null : c.key))}>
            <span className="h"><Ico name={c.icon} small />{ar ? c.ar : c.en}</span>
            <b>{counts[c.key]}</b>
          </button>
        ))}
      </div>

      {open.length === 0 && past.length === 0 ? (
        <p className="spg-tip" data-testid="samples-empty">
          <Ico name="flask" small />
          {only
            ? (ar ? "ما فيه عيّنات بهذي الحالة. اضغط البطاقة مرة ثانية لعرض الكل." : "No samples in this state. Tap the card again to show all.")
            : (ar ? "ما عندك عيّنات. اطلب عيّنة لعميل من زر «اطلب عيّنة» أو من صفحة العميل." : "No samples yet. Request one with «Request a sample» or from the customer.")}
        </p>
      ) : null}

      {open.map((r) => {
        const sent = r.status === "SENT";
        const pending = r.approval === "PENDING";
        const wait = sent && r.sentAt ? days(r.sentAt) : 0;
        const steps = [
          { ar: "طُلبت", en: "Requested", at: r.createdAt, done: true },
          { ar: "انشحنت", en: "Sent", at: r.sentAt, done: sent },
          { ar: "رأي العميل", en: "Customer's view", at: null, done: false },
          { ar: "عرض سعر", en: "Quotation", at: null, done: false },
        ];
        const nowAt = sent ? 2 : 1;
        return (
          <section key={r.id} className="smp" data-testid="sample-card">
            <div className="smp-h">
              <span className="smp-ic" style={sent ? { background: "var(--status-info-tint)", color: "var(--status-info)" } : undefined}><Ico name="flask" /></span>
              <div className="spg-main">
                <div>
                  <b><bdi>{what(r)}</bdi> · {qty(r)}</b>
                  <span className={`mny-pill ${sent ? "t-in" : "t-wa"}`}>{sent ? (ar ? "انشحنت · ننتظر رأيه" : "Sent") : (ar ? "بانتظار الشحن" : "Waiting to ship")}</span>
                  {pending ? <span className="mny-pill t-wa">{ar ? "بانتظار موافقة المدير" : "Awaiting approval"}</span> : null}
                </div>
                <small>
                  <Link href={dealHref(r)} className="who" style={{ fontSize: "inherit", fontWeight: 600, color: "inherit" }}><bdi>{who(r)}</bdi></Link>
                  {" · "}{ar ? "طلبتها" : "requested"} {ago(r.createdAt)}
                  {scope === "all" ? ` · ${r.opportunity.owner.name}` : ""}
                </small>
              </div>
              <Link href={dealHref(r)} className={`spg-cta${sent ? " p" : ""}`} data-testid="sample-action">
                {sent ? <><Ico name="edit" small />{ar ? "سجّل رأيه" : "Record the view"}</> : <><Ico name="deal" small />{ar ? "افتح الصفقة" : "Open the deal"}</>}
              </Link>
            </div>
            <ol className="smp-steps" style={{ ["--n" as string]: steps.length }}>
              {steps.map((s, i) => (
                <li key={s.en} className={s.done ? "done" : i === nowAt ? "now" : undefined}>
                  <i>{s.done ? <Ico name="tick" small /> : null}</i>
                  <span>{ar ? s.ar : s.en}</span>
                  {s.done && s.at ? <small>{ago(s.at)}</small> : null}
                </li>
              ))}
            </ol>
            <p className={`smp-next${sent && wait >= 5 ? " wa" : ""}`}>
              <Ico name="clock" small />
              {pending
                ? (ar ? "الخطوة الجاية: موافقة المدير (سبق للعميل عيّنة من نفس المحصول)، وبعدها يشحنها المستودع." : "Next: the manager's approval (a second sample of the same coffee), then dispatch ships it.")
                : sent
                  ? (wait >= 5
                    ? (ar ? `انشحنت ${ago(r.sentAt!)} وما وصلنا رأيه. كلّمه اليوم وسجّل رأيه.` : `Sent ${ago(r.sentAt!)} with no view yet. Call today and record it.`)
                    : (ar ? "الخطوة الجاية: اسأل العميل عن رأيه وسجّله. لو عجبته سوّ له عرض سعر مباشرة." : "Next: ask for the customer's view and record it. If they liked it, send a quotation."))
                  : (ar ? "الخطوة الجاية: المستودع يشحنها. لما توصل العميل اسأله رأيه، ولو عجبته سوّ له عرض سعر." : "Next: dispatch ships it. Once it arrives, ask for the view; if they like it, send a quotation.")}
            </p>
          </section>
        );
      })}

      {past.length > 0 ? (
        <section className="mny-card flush" data-testid="samples-past">
          <div className="mny-h"><h2>{ar ? "عيّنات سابقة" : "Past samples"}</h2></div>
          <div className="spg-list">
            {past.map((r) => {
              const b = bucketOf(r);
              const pill = r.status === "CANCELLED"
                ? { cls: "t-er", ar: "ملغاة", en: "Cancelled" }
                : b === "liked" ? { cls: "t-ok", ar: "عجبته", en: "Liked it" }
                  : b === "disliked" ? { cls: "t-er", ar: "ما عجبته", en: "Didn't like it" }
                    : { cls: "t-pr", ar: "وصل رأيه", en: "View received" };
              return (
                <div key={r.id} className="spg-row" data-testid="sample-row">
                  <span className="smp-ic" style={{ width: 36, height: 36, background: "var(--surface-subtle)", color: "var(--text-muted)" }}><Ico name="flask" small /></span>
                  <div className="spg-main">
                    <b><bdi>{what(r)}</bdi> · {qty(r)}</b>
                    <small><bdi>{who(r)}</bdi> · <bdi>{formatDay(r.feedbackAt ?? r.sentAt ?? r.createdAt)}</bdi>{scope === "all" ? ` · ${r.opportunity.owner.name}` : ""}</small>
                  </div>
                  <span className={`mny-pill ${pill.cls}`}>{ar ? pill.ar : pill.en}{r.feedbackScore !== null ? ` · ${r.feedbackScore}/5` : ""}</span>
                  {b === "liked" ? (
                    <Link className="spg-cta p" href={`/dashboard/sales/quotes/new?opportunityId=${encodeURIComponent(r.opportunity.id)}`} data-testid="sample-to-quote">
                      <Ico name="quote" small />{ar ? "سوّ عرض سعر" : "Make a quotation"}
                    </Link>
                  ) : b === "disliked" && r.opportunity.customer ? (
                    <Link className="spg-cta" href={`/dashboard/customers/${r.opportunity.customer.id}?new=sample`} data-testid="sample-again">
                      {ar ? "جرّب عيّنة ثانية" : "Try another sample"}
                    </Link>
                  ) : (
                    <Link className="spg-cta" href={dealHref(r)}>{ar ? "افتح الصفقة" : "Open the deal"}</Link>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      ) : null}
    </div>
  );
}
