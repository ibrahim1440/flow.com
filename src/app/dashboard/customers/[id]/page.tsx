"use client";

import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n/context";
import { Ico } from "@/components/shell/icons";
import { useD21Title, usePhone, useD21Phone } from "@/components/shell/page-context";
import { HrRoot } from "@/components/hr/ui";
import { ACTIVITY_LABELS, OUTCOME_LABELS, initials, splitTitle } from "@/components/d21/labels";
import { currencyLabel, dayCount, dayUnit, daysFromToday, dueText, money2, relativeDays, shortDate, whole } from "@/components/d21/format";
import { api, pick, QUOTE_STATUS_SPECS, LEAD_SOURCE_LABELS } from "../../sales/_components/ui";
import { ActivityDialog, ContactDialog, DetailsDialog, QuoteDialog, SEGMENT_LABELS } from "./dialogs";
import type { Account, Activity, Contact, TimelineEntry } from "./types";
import "../customers.css";
import "./account.css";

/**
 * Customer account — the approved frame `crm-account` (Figma 179:1312, 1024 180:1470, 390
 * 178:1353; English 1527:1602 / 1527:2793; markup docs/design/direction-2.1-rc/src/crm.py
 * `account()`), in its order: header (name · category since · city · owner · CR; «تسجيل نشاط»,
 * «عرض سعر», «⋯») → five figures → tabs → the open deal with its stage track and next step →
 * the activity composer and timeline, with contacts, usual items and details beside them.
 *
 * Every figure comes from GET /api/customers/[id]/account and is defined there and in
 * services/customers/aggregates.ts; nothing is computed or invented here. A section the viewer
 * may not read arrives as null and says so («لا تملك صلاحية …») rather than showing zero.
 * The files tab is drawn disabled: the system has no file storage for customers (CRM.md
 * backend dependencies; only collection evidence and finance attachments store bytes).
 */

type Tab = "overview" | "orders" | "invoices" | "deals" | "quotes" | "samples" | "files";

const ORDER_STATUS: Record<string, { ar: string; en: string; tone?: string }> = {
  "Waiting Approval": { ar: "بانتظار الاعتماد", en: "Waiting approval" },
  "Waiting Preparation Review": { ar: "بانتظار مراجعة التجهيز", en: "Preparation review", tone: "in" },
  Preparing: { ar: "قيد التجهيز", en: "Preparing", tone: "in" },
  "Ready for Shipping": { ar: "جاهز للشحن", en: "Ready to ship", tone: "in" },
  Completed: { ar: "مكتمل", en: "Completed", tone: "ok" },
  "On Hold": { ar: "معلّق مؤقتاً", en: "On hold", tone: "wa" },
  Cancelled: { ar: "ملغى", en: "Cancelled", tone: "x" },
  Rejected: { ar: "مرفوض", en: "Rejected", tone: "er" },
};
const PAYMENT_STATUS: Record<string, { ar: string; en: string; tone?: string }> = {
  Paid: { ar: "مدفوع", en: "Paid", tone: "ok" }, "Not Paid": { ar: "غير مدفوع", en: "Not paid", tone: "wa" }, "Partial Paid": { ar: "مدفوع جزئيًا", en: "Partly paid", tone: "in" },
};
const VAT_STATUS: Record<string, { ar: string; en: string; tone?: string }> = {
  Sent: { ar: "أُرسلت", en: "Sent", tone: "ok" }, "Not Yet": { ar: "لم تُرسل بعد", en: "Not yet" }, "Not Paid": { ar: "أُرسلت · غير مدفوعة", en: "Sent · unpaid", tone: "wa" },
};
const COLLECTION_STATUS: Record<string, { ar: string; en: string; tone?: string }> = {
  PENDING_VERIFICATION: { ar: "بانتظار التحقق", en: "Pending verification", tone: "in" },
  APPROVED: { ar: "معتمدة", en: "Approved", tone: "ok" },
  REJECTED: { ar: "مرفوضة", en: "Rejected", tone: "er" },
  REVERSED: { ar: "مستردّة", en: "Reversed", tone: "x" },
};
const METHOD: Record<string, { ar: string; en: string }> = {
  BANK_TRANSFER: { ar: "تحويل بنكي", en: "bank transfer" }, CASH: { ar: "نقدًا", en: "cash" }, CHEQUE: { ar: "شيك", en: "cheque" },
  POS_CARD: { ar: "بطاقة (نقاط بيع)", en: "card (POS)" }, OTHER: { ar: "أخرى", en: "other" },
};
const SAMPLE_STATUS: Record<string, { ar: string; en: string; tone?: string }> = {
  PREPARING: { ar: "قيد التحضير", en: "Preparing" }, SENT: { ar: "أُرسلت", en: "Sent", tone: "in" },
  FEEDBACK_RECEIVED: { ar: "وصل التقييم", en: "Feedback received", tone: "ok" }, CANCELLED: { ar: "ملغاة", en: "Cancelled", tone: "x" },
};
const QUOTE_TONE: Record<string, string> = { DRAFT: "", ISSUED: "in", ACCEPTED: "ok", REJECTED: "er", EXPIRED: "wa", SUPERSEDED: "x" };
const UNIT: Record<string, { ar: string; en: string }> = { KG: { ar: "كغ", en: "kg" }, G: { ar: "غ", en: "g" }, PCS: { ar: "قطعة", en: "pcs" } };
const AR_MONTHS = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
const EN_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export default function CustomerAccountPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { lang } = useI18n();
  const ar = lang === "ar";
  const L = useCallback((a: string, e: string) => (ar ? a : e), [ar]);
  const lx = (x: { ar: string; en: string } | undefined, fallback = "—") => (x ? (ar ? x.ar : x.en) : fallback);
  const phone = usePhone();
  const router = useRouter();

  const [data, setData] = useState<Account | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [dialog, setDialog] = useState<null | "activity" | "quote" | "details" | { contact: Contact | null }>(null);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [allEntries, setAllEntries] = useState(false);
  const noteRef = useRef<HTMLInputElement>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const reload = () => setReloadToken((t) => t + 1);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await api<Account>(`/api/customers/${id}/account`);
      if (cancelled) return;
      if (res.ok) { setData(res.data); setError(""); }
      else setError(res.status === 404 ? L("العميل غير موجود.", "Customer not found.") : res.status === 403 ? L("لا تملك صلاحية عرض حساب العميل.", "You do not have access to customer accounts.") : (res.data.error ?? L("تعذّر تحميل الحساب.", "Could not load the account.")));
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [id, reloadToken, L]);

  const c = data?.customer;
  const name = c ? (ar ? c.nameAr || c.name : c.name) : "";
  useD21Title(name || undefined);
  useD21Phone({ title: name, sub: c?.commercialRegNo ? `CR-${c.commercialRegNo}` : undefined, back: "/dashboard/customers", ownBar: true });

  // «N» focuses the composer (bound to event.code so it works on an Arabic layout — Kbd 10:55).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.code !== "KeyN" || e.ctrlKey || e.metaKey || e.altKey || dialog) return;
      if (t && (t.closest("input, textarea, select, [role=combobox], [data-hq-popup], [contenteditable=true]"))) return;
      if (!noteRef.current) return;
      e.preventDefault();
      setTab("overview");
      noteRef.current.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dialog]);
  useEffect(() => {
    if (!more) return;
    const close = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest("[data-acc-more]")) setMore(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setMore(false); };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => { window.removeEventListener("mousedown", close); window.removeEventListener("keydown", esc); };
  }, [more]);

  const stageById = useMemo(() => new Map((data?.stages ?? []).map((s) => [s.id, s])), [data?.stages]);

  if (loading) {
    return (
      <HrRoot>
        <div className="pg" role="status" aria-live="polite" data-testid="account-loading">
          <div className="cu-skel" aria-hidden><i /><i /><i /><i /><i /></div>
          <span className="sr-only">{L("جارٍ التحميل…", "Loading…")}</span>
        </div>
      </HrRoot>
    );
  }
  if (!data || !c) {
    return (
      <HrRoot>
        <div className="pg">
          <p className="notice er" role="alert" data-testid="account-error">{error}</p>
          <p style={{ marginTop: 16 }}><Link href="/dashboard/customers" className="btn">{L("العودة إلى العملاء", "Back to customers")}</Link></p>
        </div>
      </HrRoot>
    );
  }

  const { metrics: m, sections, can } = data;
  const cur = currencyLabel("SAR", lang);
  const amountWithUnit = (v: string, big = false, two = false) => {
    const n = <span className={`n${big ? " acc-big" : ""}`}>{two ? money2(v) : whole(v)}</span>;
    return ar ? <>{n}<span className="unit">{cur}</span></> : <><span className="unit pre">{cur}</span>{n}</>;
  };
  const monthName = (key: string) => {
    const mm = Number(key.slice(5, 7)) - 1;
    return ar ? AR_MONTHS[mm] : EN_MONTHS[mm];
  };
  const since = new Date(c.createdAt);
  const sinceText = ar ? `${AR_MONTHS[since.getMonth()]} ${since.getFullYear()}` : `${EN_MONTHS[since.getMonth()]} ${since.getFullYear()}`;
  const segment = c.segment ? lx(SEGMENT_LABELS[c.segment]) : null;
  const headLine = segment
    ? (ar ? `عميل ${segment} منذ ${sinceText}` : `${segment} customer since ${sinceText}`)
    : (ar ? `عميل منذ ${sinceText}` : `Customer since ${sinceText}`);
  const noAccess = (what: string) => <span className="acc-muted" data-testid="no-access">{ar ? `لا تملك صلاحية ${what}` : `No access to ${what}`}</span>;
  const notSet = <span className="acc-muted">{L("غير محدد", "Not set")}</span>;

  // ── Actions ──
  async function completeActivity(a: Activity) {
    if (busy) return;
    setBusy(true);
    const res = await api(`/api/sales/activities/${a.id}`, { method: "PATCH", body: { completed: true } });
    setBusy(false);
    if (res.ok) { setNotice({ text: L("اكتمل النشاط.", "Activity completed."), ok: true }); reload(); }
    else setNotice({ text: res.data.error ?? L("تعذّر الإكمال.", "Could not complete it."), ok: false });
  }
  async function saveNote(e: React.FormEvent) {
    e.preventDefault();
    const text = note.trim();
    if (text.length < 2 || busy) return;
    setBusy(true);
    const res = await api(`/api/customers/${id}/activities`, { method: "POST", body: { type: "NOTE", outcome: "NOTE_ONLY", subject: text.slice(0, 500), completed: true } });
    setBusy(false);
    if (res.ok) { setNote(""); setNotice({ text: L("سُجّلت الملاحظة.", "Note logged."), ok: true }); reload(); }
    else setNotice({ text: res.data.error ?? L("تعذّر الحفظ.", "Could not save."), ok: false });
  }
  async function deleteCustomer() {
    if (!c || !confirm(L("حذف هذا العميل؟ لا يمكن التراجع.", "Delete this customer? This cannot be undone."))) return;
    const res = await api(`/api/customers/${id}`, { method: "DELETE" });
    if (res.ok) router.push("/dashboard/customers");
    else setNotice({ text: res.data.error ?? L("تعذّر الحذف.", "Could not delete."), ok: false });
  }

  const openDeals = (data.deals ?? []).filter((d) => d.outcome === "OPEN");
  const logBtn = sections.sales && can.logActivity ? (
    <button type="button" className="btn" data-testid="log-activity" onClick={() => setDialog("activity")}>
      <Ico name="phone" small />{L("تسجيل نشاط", "Log activity")}
    </button>
  ) : null;
  const quoteBtn = sections.sales && can.quote ? (
    <button type="button" className="btn p" data-testid="new-quote" onClick={() => setDialog("quote")}>
      <Ico name="plus" small />{L("عرض سعر", "Quotation")}
    </button>
  ) : null;
  const moreItems = can.edit ? [
    <button key="edit" type="button" role="menuitem" data-testid="edit-customer" onClick={() => { setMore(false); setDialog("details"); }}>{L("تعديل بيانات العميل", "Edit customer details")}</button>,
    <Link key="profiles" role="menuitem" href={`/dashboard/customers?open=${id}&tab=profiles`}>{L("مسارات التحميص", "Roast profiles")}</Link>,
    <button key="del" type="button" role="menuitem" className="danger" data-testid="delete-customer" onClick={() => { setMore(false); deleteCustomer(); }}>{L("حذف العميل", "Delete customer")}</button>,
  ] : [];

  // ── Figures ──
  const sales = m.sales12m;
  const delta = sales?.changePercent;
  const unpricedNote = sections.sales && m.unpricedOrders != null && m.unpricedOrders > 0 ? (ar
    ? `المبيعات والرصيد محسوبة من عروض الأسعار المقبولة والدفعات المعتمدة؛ ${m.unpricedOrders} من طلبات العميل بلا عرض سعر ولا قيمة لها في النظام.`
    : `Sales and balance come from accepted quotations and approved payments; ${m.unpricedOrders} of the customer's orders have no quotation and carry no value in the system.`) : undefined;
  const salesFig = (
    <div data-testid="metric-sales" title={unpricedNote}>
      <dt className="lbl">{L("مبيعات 12 شهرًا", "12-month sales")}</dt>
      {sales ? <>
        <dd className="mid n">{whole(sales.net)}</dd>
        <dd className="d">{cur}{delta != null && <> · <span className={`delta ${delta >= 0 ? "up" : "down"}`}>{delta >= 0 ? "▲" : "▼"} <span className="n">{Math.abs(delta)}%</span></span></>}</dd>
      </> : <><dd className="mid">—</dd><dd className="d">{noAccess(L("المبيعات", "sales"))}</dd></>}
    </div>
  );
  const bal = m.balance;
  const balFig = (
    <div data-testid="metric-balance">
      <dt className="lbl">{L("الرصيد المستحق", "Balance due")}</dt>
      {bal ? <>
        <dd className={`mid n${Number(bal.outstanding) > 0 ? " acc-warn" : ""}`}>{whole(bal.outstanding)}</dd>
        <dd className="d">{bal.lastPayment
          ? (bal.lastPayment.orderNumber != null
            ? (ar ? <>الطلب <bdi className="id">#{bal.lastPayment.orderNumber}</bdi> · بعد دفعة <span className="n">{whole(bal.lastPayment.amount)}</span></>
              : <><bdi className="id">#{bal.lastPayment.orderNumber}</bdi> · after a <span className="n">{whole(bal.lastPayment.amount)}</span> payment</>)
            : (ar ? <>آخر دفعة <span className="n">{whole(bal.lastPayment.amount)}</span> · {shortDate(bal.lastPayment.collectedAt, lang)}</>
              : <>Last payment <span className="n">{whole(bal.lastPayment.amount)}</span> · {shortDate(bal.lastPayment.collectedAt, lang)}</>))
          : bal.documents === 0 ? L("لا عروض مقبولة", "No accepted quotations") : L("لا دفعات معتمدة بعد", "No approved payments yet")}</dd>
      </> : <><dd className="mid">—</dd><dd className="d">{noAccess(L("المبيعات", "sales"))}</dd></>}
    </div>
  );
  // Whole days on the viewer's calendar (as every other date on the page), not the server's.
  const lastDays = m.lastOrder ? Math.max(0, -daysFromToday(m.lastOrder.createdAt)) : 0;
  const lastFig = (
    <div data-testid="metric-last-order">
      <dt className="lbl">{L("آخر طلب", "Last order")}</dt>
      {!sections.orders ? <><dd className="mid">—</dd><dd className="d">{noAccess(L("الطلبات", "orders"))}</dd></>
        : m.lastOrder ? <>
          <dd className="mid n">{lastDays === 0 ? <span className="acc-today">{L("اليوم", "Today")}</span> : <>{lastDays}<span className="unit">{dayUnit(lastDays, lang)}</span></>}</dd>
          <dd className="d">{m.cadenceDays != null
            ? (ar ? `يطلب كل ${dayCount(m.cadenceDays, lang)} تقريبًا` : `Orders about every ${dayCount(m.cadenceDays, lang)}`)
            : <><bdi className="id">#{m.lastOrder.orderNumber}</bdi> · {shortDate(m.lastOrder.createdAt, lang)}</>}</dd>
        </> : <><dd className="mid">—</dd><dd className="d">{L("لا طلبات بعد", "No orders yet")}</dd></>}
    </div>
  );
  const monthly = m.monthly;
  const complete = monthly ? monthly.filter((x) => !x.partial) : [];
  const lastMonth = complete[complete.length - 1];
  const running = monthly?.find((x) => x.partial);
  const anyKg = complete.some((x) => x.kg > 0);
  const maxKg = Math.max(1, ...complete.map((x) => x.kg));
  const qtyFig = (
    <div data-testid="metric-monthly">
      <dt className="lbl">{L("الكمية الشهرية", "Monthly quantity")}</dt>
      {!monthly ? <><dd className="mid">—</dd><dd className="d">{noAccess(L("الطلبات", "orders"))}</dd></> : <>
        <dd className="acc-spark">
          <svg viewBox="0 0 180 38" width="100%" height="38" role="img" style={{ direction: "ltr" }}
            aria-label={complete.map((x) => `${monthName(x.month)} ${x.kg}`).join(", ")}>
            {complete.map((x, i) => {
              const bw = (180 - 11 * 4) / 12;
              const h = x.kg > 0 ? Math.max(2, (x.kg / maxKg) * 34) : 0;
              return <rect key={x.month} x={(i * (bw + 4)).toFixed(1)} y={(38 - h).toFixed(1)} width={bw.toFixed(1)} height={h.toFixed(1)} rx="1.5"
                fill={i === complete.length - 1 ? "var(--action-primary)" : "var(--chart-3)"}><title>{`${monthName(x.month)}: ${x.kg}`}</title></rect>;
            })}
          </svg>
        </dd>
        <dd className="d">{anyKg && lastMonth
          ? (ar ? <><span className="n">{whole(lastMonth.kg)}</span> كغ في {monthName(lastMonth.month)}</> : <><span className="n">{whole(lastMonth.kg)}</span> kg in {monthName(lastMonth.month)}</>)
          : running && running.kg > 0
            ? (ar ? <><span className="n">{whole(running.kg)}</span> كغ في {monthName(running.month)} حتى الآن</> : <><span className="n">{whole(running.kg)}</span> kg in {monthName(running.month)} so far</>)
            : L("لا طلبات في آخر 12 شهرًا", "No orders in the last 12 months")}</dd>
      </>}
    </div>
  );
  const termsFig = (
    <div data-testid="metric-terms">
      <dt className="lbl">{L("شروط الدفع", "Payment terms")}</dt>
      <dd className="mid acc-terms">{c.paymentTermsDays != null ? <><span className="n">{c.paymentTermsDays}</span> {dayUnit(c.paymentTermsDays, lang) === "يوم" && c.paymentTermsDays !== 1 ? "يومًا" : dayUnit(c.paymentTermsDays, lang)}</> : notSet}</dd>
      <dd className="d">{c.creditLimit != null
        ? (ar ? <>حد ائتمان <span className="n">{whole(c.creditLimit)}</span> ر.س</> : <>Credit limit SAR <span className="n">{whole(c.creditLimit)}</span></>)
        : L("حد الائتمان غير محدد", "No credit limit set")}</dd>
    </div>
  );

  // ── Tabs ──
  const count = (n: number | undefined | null) => (n != null ? <span className="c">{n}</span> : null);
  const invoiced = (data.orders ?? []).filter((o) => o.vatInvoiceStatus !== "Not Yet").length;
  const tabs: { id: Tab; text: string; n?: number | null; disabled?: string }[] = [
    { id: "overview", text: L("نظرة عامة", "Overview") },
    { id: "orders", text: L("الطلبات", "Orders"), n: data.orders?.length, disabled: sections.orders ? undefined : L("يتطلب صلاحية الطلبات", "Needs the orders permission") },
    { id: "invoices", text: L("الفواتير", "Invoices"), n: sections.orders ? invoiced : null, disabled: sections.orders || sections.sales ? undefined : L("يتطلب صلاحية الطلبات أو المبيعات", "Needs the orders or sales permission") },
    { id: "deals", text: L("الصفقات", "Deals"), n: data.deals?.length, disabled: sections.sales ? undefined : L("يتطلب صلاحية المبيعات", "Needs the sales permission") },
    { id: "quotes", text: L("عروض الأسعار", "Quotations"), n: data.quotes?.length, disabled: sections.sales ? undefined : L("يتطلب صلاحية المبيعات", "Needs the sales permission") },
    { id: "samples", text: L("العينات", "Samples"), n: data.samples?.length, disabled: sections.sales ? undefined : L("يتطلب صلاحية المبيعات", "Needs the sales permission") },
    { id: "files", text: L("الملفات", "Files") },
  ];
  const tabBar = (
    <div className="tabs acc-tabs" role="tablist" aria-label={L("أقسام الحساب", "Account sections")}>
      {tabs.map((t) => (
        <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={`${tab === t.id ? "on" : ""}${t.disabled || t.id === "files" ? " acc-off" : ""}`.trim() || undefined}
          aria-disabled={t.disabled ? true : undefined} title={t.disabled ?? (t.id === "files" ? L("غير متاح: لا يوجد مخزن ملفات بعد", "Unavailable: no file storage yet") : undefined)}
          data-testid={`tab-${t.id}`} onClick={() => { if (!t.disabled) setTab(t.id); }}>
          {t.text}{count(t.n)}
        </button>
      ))}
    </div>
  );

  // ── The open deal ──
  const deal = data.openDeal;
  // The track shows the active stages (plus the deal's own if it is hidden); the history's
  // labels use every stage (`stageById`).
  const stages = (data.stages ?? []).filter((s) => s.isActive !== false);
  const nextStep = deal?.nextStep ?? data.nextStep;
  const lateBy = nextStep?.dueAt && new Date(nextStep.dueAt) < new Date() ? Math.max(1, -daysFromToday(nextStep.dueAt)) : 0;
  const reached = new Map<string, string>();
  for (const e of deal?.stageEvents ?? []) if (e.toStageId && !reached.has(e.toStageId)) reached.set(e.toStageId, e.createdAt);
  const atIdx = deal ? stages.findIndex((s) => s.id === deal.stage.id) : -1;
  const shownStages = deal && atIdx < 0 ? [...stages, deal.stage].sort((a, b) => a.position - b.position) : stages;
  const curIdx = deal ? shownStages.findIndex((s) => s.id === deal.stage.id) : -1;
  const dealSub = deal ? splitTitle(deal.title, c.nameAr && ar ? c.nameAr : c.name).sub || (ar ? deal.stage.nameAr : deal.stage.nameEn) : "";
  const nextStepBand = nextStep ? (
    <div data-testid="next-step" className={`callout${phone ? " ph" : ""}${lateBy ? " er" : ""}`}>
      {lateBy > 0 && <span className="flag">{ar ? `متأخرة ${dayCount(lateBy, lang)}` : `${dayCount(lateBy, lang)} overdue`}</span>}
      <span>
        <b style={{ fontWeight: 600 }}>{L("الخطوة التالية:", "Next step:")}</b> <bdi>{nextStep.subject}</bdi>
        {nextStep.dueAt && <> · {lateBy ? L("كانت مستحقة ", "was due ") : ""}{dueText(nextStep.dueAt, lang)}</>}
      </span>
      {can.logActivity && nextStep.mine && (
        <button type="button" className="btn sm" data-testid={`complete-${nextStep.id}`} disabled={busy} onClick={() => completeActivity(nextStep)}>{L("إكمال", "Complete")}</button>
      )}
    </div>
  ) : null;

  const dealBlock = !sections.sales ? (
    <p className="acc-muted" style={{ margin: "0 0 32px" }}>{noAccess(L("الصفقات", "deals"))}</p>
  ) : deal ? (
    <section data-testid="open-deal" style={{ marginBottom: 36 }}>
      <div className="bh">
        <h2 className="bt">{L("الصفقة المفتوحة", "Open deal")}</h2>
        <span className="sub"><bdi>{dealSub}</bdi></span>
        <Link className="lk" href={`/dashboard/sales/deals/${deal.id}`} data-testid="open-deal-link">{L("فتح الصفقة", "Open deal")}<Ico name="chev" small className="acc-chev" /></Link>
      </div>
      <div className="acc-deal">
        <div>
          {amountWithUnit(deal.amount, true)}
          <div className="d acc-deal-d">{ar
            ? <>احتمال <span className="n">{deal.probability}%</span>{deal.expectedCloseAt && <> · إغلاق متوقع {shortDate(deal.expectedCloseAt, lang)}</>}</>
            : <>Probability <span className="n">{deal.probability}%</span>{deal.expectedCloseAt && <> · expected close {shortDate(deal.expectedCloseAt, lang)}</>}</>}</div>
        </div>
        <div className="track-wrap acc-track">
          <ol className="track" aria-label={L("المرحلة", "Stage")}>
            {shownStages.map((s, i) => {
              const done = i < curIdx, current = i === curIdx;
              const at = reached.get(s.id);
              return (
                <li key={s.id} className={done ? "done" : current ? "cur" : undefined} aria-current={current ? "step" : undefined}>
                  <span className="acc-step"><b className={done || current ? undefined : "later"}>{ar ? s.nameAr : s.nameEn}</b>
                    {current ? <small>{relativeDays(at ?? deal.createdAt, lang)}</small> : done && at ? <small>{shortDate(at, lang)}</small> : null}</span>
                </li>
              );
            })}
          </ol>
        </div>
      </div>
      {nextStepBand}
      {data.openDeals > 1 && (
        <button type="button" className="lk-inline acc-more-deals" onClick={() => setTab("deals")} data-testid="more-open-deals">
          {ar ? `و${data.openDeals - 1} ${data.openDeals - 1 === 1 ? "صفقة أخرى مفتوحة" : "صفقات أخرى مفتوحة"}` : `and ${data.openDeals - 1} more open deal${data.openDeals - 1 === 1 ? "" : "s"}`}
        </button>
      )}
    </section>
  ) : (
    <section data-testid="open-deal" style={{ marginBottom: 32 }}>
      <div className="bh"><h2 className="bt">{L("الصفقة المفتوحة", "Open deal")}</h2></div>
      <p className="acc-muted" style={{ margin: "0 0 12px" }}>{data.sections.scope === "own" ? L("لا صفقة مفتوحة لك مع هذا العميل.", "You have no open deal with this customer.") : L("لا صفقة مفتوحة مع هذا العميل.", "No open deal with this customer.")}</p>
      {nextStepBand}
      {quoteBtn && can.createDeal && <button type="button" className="btn sm" onClick={() => setDialog("quote")} data-testid="start-deal">{L("فتح صفقة وعرض سعر", "Open a deal and quote")}</button>}
    </section>
  );

  // ── Timeline ──
  const stageName = (sid?: string | null) => { const s = sid ? stageById.get(sid) : undefined; return s ? (ar ? s.nameAr : s.nameEn) : ""; };
  const entryText = (e: TimelineEntry): { title: React.ReactNode; detail?: React.ReactNode; diff?: string; activity?: Activity } => {
    switch (e.kind) {
      case "activity": {
        const a = e.activity;
        const type = lx(ACTIVITY_LABELS[a.type]);
        const otherDeal = a.opportunity && a.opportunity.id !== deal?.id ? a.opportunity : null;
        return {
          activity: a,
          title: a.type === "NOTE"
            ? <><b>{a.owner.name}</b> {L("كتب ملاحظة", "wrote a note")}</>
            : <><b>{a.owner.name}</b> {ar ? `سجّل ${type}` : `logged a ${type.toLowerCase()}`}{otherDeal ? <span className="acc-muted"> · <bdi>{otherDeal.title}</bdi></span> : null}</>,
          // The outcome of a logged call/visit leads its note («يحتاج متابعة — …»); a plain note is its text.
          detail: [a.completedAt && a.outcome && a.outcome !== "NOTE_ONLY" ? lx(OUTCOME_LABELS[a.outcome]) : null, a.subject, a.body].filter(Boolean).join(" — "),
        };
      }
      case "sample": return { title: <>{L("أُرسلت عيّنة", "Sample sent")} <span className="n">{Number(e.sample.quantity)}</span> {lx(UNIT[e.sample.unit], e.sample.unit)} · <bdi>{e.sample.name}</bdi></> };
      case "quote_issued": return {
        title: ar ? <>أُصدر العرض <bdi className="id">{e.quote.quoteNumber}</bdi> · المراجعة {e.quote.revision} بقيمة <span className="n">{money2(e.quote.grandTotal)}</span> ر.س</>
          : <>Quotation <bdi className="id">{e.quote.quoteNumber}</bdi> issued · revision {e.quote.revision} for SAR <span className="n">{money2(e.quote.grandTotal)}</span></>,
        diff: e.stageMove ? `${L("المرحلة", "Stage")}: ${stageName(e.stageMove.from)} ${ar ? "←" : "→"} ${stageName(e.stageMove.to)}` : undefined,
      };
      case "quote_accepted": return { title: ar ? <>قُبل العرض <bdi className="id">{e.quote.quoteNumber}</bdi> بقيمة <span className="n">{money2(e.quote.grandTotal)}</span> ر.س</> : <>Quotation <bdi className="id">{e.quote.quoteNumber}</bdi> accepted for SAR <span className="n">{money2(e.quote.grandTotal)}</span></> };
      case "order": return {
        title: ar ? <>أُنشئ الطلب <bdi className="id">#{e.order.orderNumber}</bdi> · <span className="n">{money2(e.order.totalKg)}</span> كغ{e.order.value && <> · <span className="n">{money2(e.order.value)}</span> ر.س</>}</>
          : <>Order <bdi className="id">#{e.order.orderNumber}</bdi> created · <span className="n">{money2(e.order.totalKg)}</span> kg{e.order.value && <> · SAR <span className="n">{money2(e.order.value)}</span></>}</>,
      };
      case "delivery": return {
        title: ar
          ? <>سُلّم للطلب <bdi className="id">#{e.delivery.orderNumber}</bdi> · {e.delivery.units != null ? <><span className="n">{e.delivery.units}</span> وحدة</> : <><span className="n">{money2(e.delivery.kg)}</span> كغ</>} · <bdi>{e.delivery.item}</bdi>{e.delivery.type === "full" ? " · اكتمل السطر" : ""}</>
          : <>Delivered for order <bdi className="id">#{e.delivery.orderNumber}</bdi> · {e.delivery.units != null ? <><span className="n">{e.delivery.units}</span> units</> : <><span className="n">{money2(e.delivery.kg)}</span> kg</>} · <bdi>{e.delivery.item}</bdi>{e.delivery.type === "full" ? " · line complete" : ""}</>,
        detail: e.delivery.lots.length ? `${L("اللوتات", "Lots")}: ${e.delivery.lots.join(ar ? "، " : ", ")}` : undefined,
      };
      case "payment": return {
        title: ar ? <>دفعة <span className="n">{money2(e.payment.amount)}</span> ر.س{e.payment.orderNumber != null && <> للطلب <bdi className="id">#{e.payment.orderNumber}</bdi></>} · {lx(METHOD[e.payment.method])}</>
          : <>Payment SAR <span className="n">{money2(e.payment.amount)}</span>{e.payment.orderNumber != null && <> for order <bdi className="id">#{e.payment.orderNumber}</bdi></>} · {lx(METHOD[e.payment.method])}</>,
      };
    }
  };
  // The next step is the band above the timeline, so it is not repeated in it (as on the deal page).
  const entries = data.timeline.filter((e) => !(e.kind === "activity" && e.activity.id === nextStep?.id));
  const visible = allEntries ? entries : entries.slice(0, phone ? 3 : 12);
  const timeline = (
    <ol className="tl acc-tl" data-testid="account-timeline">
      {visible.map((e, i) => {
        const t = entryText(e);
        const a = t.activity;
        const openA = a && !a.completedAt;
        const late = openA && a.dueAt && new Date(a.dueAt) < new Date();
        return (
          <li key={e.key} data-kind={e.kind}>
            <span className={`m${i === 0 && !openA ? " b" : ""}`} />
            <div className="row">
              <span className="acc-tl-t">{t.title}</span>
              {late && <span className="flag">{L("متأخرة", "Overdue")}</span>}
              <span className="when">{openA ? `${L("مستحقة ", "due ")}${a.dueAt ? dueText(a.dueAt, lang) : "—"}` : shortDate(e.at, lang)}</span>
            </div>
            {t.detail && <div className="acc-tl-d" dir="auto">{t.detail}</div>}
            {t.diff && <span className="diff">{t.diff}</span>}
            {openA && a.mine && can.logActivity && a.id !== nextStep?.id && (
              <div style={{ marginTop: 6 }}><button type="button" className="btn sm" disabled={busy} onClick={() => completeActivity(a)} data-testid={`complete-${a.id}`}>{L("إكمال", "Complete")}</button></div>
            )}
          </li>
        );
      })}
    </ol>
  );
  const activityBlock = (
    <section data-testid="activity">
      <div className="bh">
        <h2 className="bt">{L("النشاط", "Activity")}</h2>
        <span className="sub">{L("مكالمات، عيّنات، عروض، طلبات، مدفوعات", "Calls, samples, quotations, orders, payments")}</span>
      </div>
      {sections.sales && can.logActivity && (
        <form className="acc-composer" onSubmit={saveNote} data-testid="composer">
          <Ico name="note" small />
          <input ref={noteRef} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500}
            placeholder={L("اكتب ملاحظة أو سجّل مكالمة…", "Write a note or log a call…")} aria-label={L("ملاحظة", "Note")} data-testid="composer-input" />
          {note.trim().length >= 2
            ? <button type="submit" className="btn sm p" disabled={busy} data-testid="composer-save">{L("حفظ", "Save")}</button>
            : <span className="kbd" aria-hidden>N</span>}
        </form>
      )}
      {entries.length === 0
        ? <p className="acc-muted">{sections.sales || sections.orders ? L("لم يُسجَّل أي نشاط بعد.", "Nothing logged yet.") : noAccess(L("النشاط", "activity"))}</p>
        : timeline}
      {entries.length > visible.length || allEntries ? (
        <button type="button" className="btn sm" onClick={() => setAllEntries((v) => !v)} aria-expanded={allEntries} data-testid="toggle-timeline">
          {allEntries ? L("عرض أقل", "Show fewer") : (ar ? `عرض الكل (${entries.length})` : `Show all (${entries.length})`)}
        </button>
      ) : null}
      {sections.scope === "own" && <p className="acc-note">{L("يُعرض نشاطك وصفقاتك أنت فقط مع هذا العميل.", "Only your own activities and deals with this customer are shown.")}</p>}
    </section>
  );

  // ── Side column ──
  const contacts = (
    <section data-testid="contacts" style={{ marginBottom: 28 }}>
      <div className="lbl acc-side-h">{L("جهات الاتصال", "Contacts")}
        {can.edit && <button type="button" className="lk-inline" onClick={() => setDialog({ contact: null })} data-testid="add-contact">{L("إضافة", "Add")}</button>}
      </div>
      {c.contacts.length === 0 ? (
        <p className="acc-muted" style={{ margin: 0 }}>{L("لا جهات اتصال مسجلة.", "No contacts recorded.")}{c.phone && <> {L("هاتف العميل:", "Customer phone:")} <bdi dir="ltr" className="n">{c.phone}</bdi></>}</p>
      ) : (
        <ul className="acc-contacts">
          {c.contacts.map((p) => (
            <li key={p.id} data-testid={`contact-${p.id}`}>
              <span className="av" aria-hidden>{initials(p.name).slice(0, 1)}</span>
              <div className="acc-contact-main">
                {can.edit ? <button type="button" className="acc-contact-name" onClick={() => setDialog({ contact: p })}>{p.name}</button> : <div className="acc-contact-name">{p.name}</div>}
                {(p.phone || p.email) && <div className="acc-contact-sub">{p.phone ? <a href={`tel:${p.phone.replace(/\s/g, "")}`} dir="ltr" className="n">{p.phone}</a> : <a href={`mailto:${p.email}`} dir="ltr">{p.email}</a>}</div>}
              </div>
              {p.role && <span className="acc-contact-role">{p.role}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
  const usual = (
    <section data-testid="usual-items" style={{ marginBottom: 28 }}>
      <div className="lbl acc-side-h">{L("الأصناف المعتادة", "Usual items")}</div>
      {!m.usualItems ? <p className="acc-muted" style={{ margin: 0 }}>{noAccess(L("الطلبات", "orders"))}</p>
        : m.usualItems.length === 0 ? <p className="acc-muted" style={{ margin: 0 }}>{L("لا طلبات في آخر ستة أشهر.", "No orders in the last six months.")}</p>
        : <table className="t dense acc-usual"><tbody>
            {m.usualItems.map((u) => <tr key={u.name}><td><bdi>{u.name}</bdi></td><td className="num">{ar ? <><span className="n">{u.kgPerMonth}</span> كغ/شهر</> : <><span className="n">{u.kgPerMonth}</span> kg / month</>}</td></tr>)}
          </tbody></table>}
      {c.roastPreferences.length > 0 && (
        <div className="acc-profiles" data-testid="roast-profiles">
          <div className="lbl" style={{ margin: "14px 0 6px" }}>{L("مسارات التحميص", "Roast profiles")}</div>
          <ul>
            {c.roastPreferences.map((r) => (
              <li key={r.id}><b>{r.profileName}</b> <span className="acc-muted">· <bdi>{r.greenBean.beanType}</bdi>{r.targetColorWhole != null && <> · {L("كاملة", "whole")} <span className="n">{r.targetColorWhole}{r.targetToleranceWhole != null ? ` ±${r.targetToleranceWhole}` : ""}</span></>}</span></li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
  const sourceText = data.source
    ? (data.source.sourceNote || pick(LEAD_SOURCE_LABELS, data.source.source, lang))
    : null;
  const details = (
    <section data-testid="details">
      <div className="lbl acc-side-h">{L("التفاصيل", "Details")}
        {can.edit && <button type="button" className="lk-inline" onClick={() => setDialog("details")} data-testid="edit-details">{L("تعديل", "Edit")}</button>}
      </div>
      <dl className="props acc-props">
        <dt>{L("الرقم الضريبي", "VAT number")}</dt><dd className="n" data-testid="detail-vat">{c.vatNumber ?? notSet}</dd>
        <dt>{L("قائمة الأسعار", "Price list")}</dt><dd>{c.priceList ?? notSet}</dd>
        <dt>{L("التوصيل", "Delivery")}</dt><dd style={{ whiteSpace: "pre-line" }}>{c.address ?? notSet}</dd>
        <dt>{L("المصدر", "Source")}</dt><dd>{sourceText ?? (sections.sales ? L("أُضيف مباشرة", "Added directly") : "—")}</dd>
      </dl>
    </section>
  );

  // ── Other tabs ──
  const st = (spec: { ar: string; en: string; tone?: string } | undefined, raw: string) => <span className={`st ${spec?.tone ?? ""}`}>{spec ? lx(spec) : raw}</span>;
  const empty = (t: string) => <p className="acc-muted acc-empty" data-testid="tab-empty">{t}</p>;
  const ordersTab = !data.orders ? empty(L("لا تملك صلاحية الطلبات.", "No access to orders.")) : data.orders.length === 0 ? empty(L("لا طلبات لهذا العميل.", "No orders for this customer.")) : (
    <div className="acc-scroll"><table className="t" data-testid="orders-table">
      <thead><tr><th>{L("الطلب", "Order")}</th><th>{L("التاريخ", "Date")}</th><th>{L("الحالة", "Status")}</th><th className="num">{L("الكمية (كغ)", "Quantity (kg)")}</th><th className="num">{L("البنود", "Lines")}</th><th>{L("الدفع", "Payment")}</th><th>{L("الفاتورة الضريبية", "VAT invoice")}</th></tr></thead>
      <tbody>{data.orders.map((o) => (
        <tr key={o.id}><td><Link href={`/dashboard/orders?order=${o.orderNumber}`}><bdi className="id">#{o.orderNumber}</bdi></Link></td><td>{shortDate(o.createdAt, lang)}</td><td>{st(ORDER_STATUS[o.status], o.status)}</td>
          <td className="num">{money2(o.totalKg)}</td><td className="num">{o.itemCount}</td><td>{st(PAYMENT_STATUS[o.paymentStatus], o.paymentStatus)}</td><td>{st(VAT_STATUS[o.vatInvoiceStatus], o.vatInvoiceStatus)}</td></tr>
      ))}</tbody>
    </table></div>
  );
  const invoicesTab = (
    <div data-testid="invoices-tab">
      <p className="callout acc-info" data-testid="invoices-note">
        {L("لا يوجد في النظام نظام فواتير بعد: الفواتير الضريبية تُصدر خارجه. يُعرض هنا ما سُجّل منها لكل طلب، والدفعات المسجّلة على صفقات العميل.",
          "The system has no invoicing yet: VAT invoices are issued outside it. Shown here is what is recorded of them per order, and the payments recorded against the customer's deals.")}
      </p>
      {unpricedNote && <p className="acc-note" style={{ margin: "10px 0 0" }} data-testid="unpriced-note">{unpricedNote}</p>}
      {data.orders && (<>
        <div className="lbl" style={{ margin: "18px 0 6px" }}>{L("الفاتورة الضريبية لكل طلب", "VAT invoice per order")}</div>
        {data.orders.length === 0 ? empty(L("لا طلبات.", "No orders.")) : (
          <div className="acc-scroll"><table className="t dense"><thead><tr><th>{L("الطلب", "Order")}</th><th>{L("التاريخ", "Date")}</th><th>{L("الفاتورة الضريبية", "VAT invoice")}</th><th>{L("الدفع", "Payment")}</th><th>{L("رقم العرض", "Quotation no.")}</th></tr></thead>
            <tbody>{data.orders.map((o) => <tr key={o.id}><td><bdi className="id">#{o.orderNumber}</bdi></td><td>{shortDate(o.createdAt, lang)}</td><td>{st(VAT_STATUS[o.vatInvoiceStatus], o.vatInvoiceStatus)}</td><td>{st(PAYMENT_STATUS[o.paymentStatus], o.paymentStatus)}</td><td>{o.quotationNumber ? <bdi className="id">{o.quotationNumber}</bdi> : "—"}</td></tr>)}</tbody></table></div>
        )}
      </>)}
      {data.collections && (<>
        <div className="lbl" style={{ margin: "22px 0 6px" }}>{L("الدفعات", "Payments")}</div>
        {data.collections.length === 0 ? empty(L("لا دفعات مسجّلة.", "No payments recorded.")) : (
          <div className="acc-scroll"><table className="t dense" data-testid="payments-table"><thead><tr><th>{L("التاريخ", "Date")}</th><th className="num">{L("المبلغ", "Amount")}</th><th>{L("الطريقة", "Method")}</th><th>{L("الصفقة", "Deal")}</th><th>{L("الطلب", "Order")}</th><th>{L("الحالة", "Status")}</th></tr></thead>
            <tbody>{data.collections.map((p) => <tr key={p.id}><td>{shortDate(p.collectedAt, lang)}</td><td className="num">{money2(p.amountGross)}</td><td>{lx(METHOD[p.paymentMethod])}</td><td><Link href={`/dashboard/sales/deals/${p.opportunity.id}`}><bdi>{p.opportunity.title}</bdi></Link></td><td>{p.order ? <bdi className="id">#{p.order.orderNumber}</bdi> : "—"}</td><td>{st(COLLECTION_STATUS[p.status], p.status)}</td></tr>)}</tbody></table></div>
        )}
      </>)}
    </div>
  );
  const dealsTab = !data.deals ? empty(L("لا تملك صلاحية المبيعات.", "No access to sales.")) : data.deals.length === 0 ? empty(L("لا صفقات.", "No deals.")) : (
    <div className="acc-scroll"><table className="t" data-testid="deals-table">
      <thead><tr><th>{L("الصفقة", "Deal")}</th><th>{L("المرحلة", "Stage")}</th><th>{L("النتيجة", "Outcome")}</th><th className="num">{L("القيمة", "Value")}</th><th className="num">{L("الاحتمال", "Probability")}</th><th>{L("الإغلاق المتوقع", "Expected close")}</th><th>{L("المالك", "Owner")}</th></tr></thead>
      <tbody>{data.deals.map((d) => (
        <tr key={d.id}><td><Link className="who" href={`/dashboard/sales/deals/${d.id}`}><bdi>{d.title}</bdi></Link></td><td>{ar ? d.stage.nameAr : d.stage.nameEn}</td>
          <td><span className={`st ${d.outcome === "WON" ? "ok" : d.outcome === "LOST" ? "er" : "in"}`}>{d.outcome === "OPEN" ? L("مفتوحة", "Open") : d.outcome === "WON" ? L("رابحة", "Won") : L("خاسرة", "Lost")}</span></td>
          <td className="num">{whole(d.amount)}</td><td className="num">{d.probability}%</td><td>{d.expectedCloseAt ? shortDate(d.expectedCloseAt, lang) : "—"}</td><td>{d.owner?.name ?? "—"}</td></tr>
      ))}</tbody>
    </table></div>
  );
  const quotesTab = !data.quotes ? empty(L("لا تملك صلاحية المبيعات.", "No access to sales.")) : data.quotes.length === 0 ? empty(L("لا عروض أسعار.", "No quotations.")) : (
    <div className="acc-scroll"><table className="t" data-testid="quotes-table">
      <thead><tr><th>{L("العرض", "Quotation")}</th><th>{L("الصفقة", "Deal")}</th><th>{L("الحالة", "Status")}</th><th className="num">{L("الإجمالي · ر.س", "Total · SAR")}</th><th>{L("صالح حتى", "Valid until")}</th><th>{L("أُصدر", "Issued")}</th></tr></thead>
      <tbody>{data.quotes.map((q) => (
        <tr key={q.id}><td><Link href={`/dashboard/sales/quotes/${q.id}`}><bdi className="id">{q.quoteNumber}</bdi></Link> <span className="sm">{L("م", "rev")} {q.revision}</span></td><td><bdi>{q.opportunity.title}</bdi></td>
          <td><span className={`st ${QUOTE_TONE[q.status] ?? ""}`}>{pick(QUOTE_STATUS_SPECS, q.status, lang)}</span></td><td className="num">{money2(q.grandTotal)}</td>
          <td>{q.validUntil ? shortDate(q.validUntil, lang) : "—"}</td><td>{q.issuedAt ? shortDate(q.issuedAt, lang) : "—"}</td></tr>
      ))}</tbody>
    </table></div>
  );
  const samplesTab = !data.samples ? empty(L("لا تملك صلاحية المبيعات.", "No access to sales.")) : data.samples.length === 0 ? empty(L("لا عيّنات.", "No samples.")) : (
    <div className="acc-scroll"><table className="t" data-testid="samples-table">
      <thead><tr><th>{L("العيّنة", "Sample")}</th><th>{L("الصفقة", "Deal")}</th><th className="num">{L("الكمية", "Quantity")}</th><th>{L("الحالة", "Status")}</th><th>{L("أُرسلت", "Sent")}</th><th className="num">{L("التقييم", "Score")}</th></tr></thead>
      <tbody>{data.samples.map((s) => (
        <tr key={s.id}><td className="who"><bdi>{s.productSku?.name ?? s.productSku?.skuCode ?? s.description ?? "—"}</bdi></td><td><Link href={`/dashboard/sales/deals/${s.opportunity.id}`}><bdi>{s.opportunity.title}</bdi></Link></td>
          <td className="num">{Number(s.quantity)} {lx(UNIT[s.unit], s.unit)}</td><td>{st(SAMPLE_STATUS[s.status], s.status)}</td><td>{s.sentAt ? shortDate(s.sentAt, lang) : "—"}</td><td className="num">{s.feedbackScore != null ? `${s.feedbackScore}/5` : "—"}</td></tr>
      ))}</tbody>
    </table></div>
  );
  const filesTab = (
    <div className="callout acc-info" data-testid="files-unavailable" role="note">
      <span>{L("الملفات غير متاحة بعد: لا يوجد في النظام مخزن ملفات للعملاء. يُفعَّل هذا القسم حين يُعتمد مخزن للملفات.",
        "Files are not available yet: the system has no file storage for customers. This tab is enabled once a file store is approved.")}</span>
    </div>
  );
  const tabBody = tab === "orders" ? ordersTab : tab === "invoices" ? invoicesTab : tab === "deals" ? dealsTab : tab === "quotes" ? quotesTab : tab === "samples" ? samplesTab : tab === "files" ? filesTab : null;

  const noticeEl = notice ? (
    <p className={`notice ${notice.ok ? "ok" : "er"}`} role={notice.ok ? "status" : "alert"} data-testid="account-notice" style={{ marginBottom: 16 }}>
      {notice.text}<button type="button" onClick={() => setNotice(null)} aria-label={L("إغلاق", "Dismiss")}>×</button>
    </p>
  ) : null;

  const dialogs = (
    <>
      {dialog === "activity" && <ActivityDialog ar={ar} customerId={id} deals={openDeals} defaultDealId={null}
        onClose={() => setDialog(null)} onDone={() => { setDialog(null); setNotice({ text: L("سُجّل النشاط.", "Activity logged."), ok: true }); reload(); }} />}
      {dialog === "quote" && <QuoteDialog ar={ar} customer={c} openDeals={openDeals} canCreateDeal={can.createDeal} onClose={() => setDialog(null)} />}
      {dialog === "details" && <DetailsDialog ar={ar} customer={c} onClose={() => setDialog(null)} onDone={() => { setDialog(null); setNotice({ text: L("حُفظت البيانات.", "Saved."), ok: true }); reload(); }} />}
      {dialog && typeof dialog === "object" && <ContactDialog ar={ar} customerId={id} contact={dialog.contact} onClose={() => setDialog(null)} onDone={() => { setDialog(null); reload(); }} />}
    </>
  );

  const metaParts = [headLine, c.city, c.accountOwner ? `${L("المسؤول", "Account owner")} ${c.accountOwner.name}` : null].filter(Boolean) as string[];

  // ── Phone (below 768): the 390 frame 178:1353 ──
  if (phone) {
    const subline = [segment ? (ar ? `عميل ${segment}` : `${segment} customer`) : null, c.city, c.accountOwner?.name].filter(Boolean).join(" · ");
    return (
      <HrRoot>
        <div className="pg acc acc-phone" data-testid="customer-account">
          {noticeEl}
          {subline && <p className="acc-subline">{subline}</p>}
          <dl className="phrows" data-testid="account-metrics">
            <div><dt className="lbl">{L("الرصيد المستحق", "Balance due")}</dt><dd className={bal && Number(bal.outstanding) > 0 ? "acc-warn" : undefined}>{bal ? amountWithUnit(bal.outstanding, false, true) : "—"}</dd></div>
            <div><dt className="lbl">{L("مبيعات 12 شهرًا", "12-month sales")}</dt><dd>{sales ? amountWithUnit(sales.net) : "—"}</dd></div>
            <div><dt className="lbl">{L("آخر طلب", "Last order")}</dt><dd>{m.lastOrder ? <><bdi className="id">#{m.lastOrder.orderNumber}</bdi> · {ar ? `قبل ${dayCount(lastDays, lang)}` : `${dayCount(lastDays, lang)} ago`}</> : "—"}</dd></div>
          </dl>
          {sections.sales && (
            <section data-testid="open-deal" className="acc-ph-deal">
              <div className="bh" style={{ marginBottom: 8 }}><h2 className="bt">{L("الصفقة المفتوحة", "Open deal")}</h2>
                {deal && <span className="sub">{ar ? deal.stage.nameAr : deal.stage.nameEn} · <span className="n">{deal.probability}%</span></span>}</div>
              {deal ? (
                <Link href={`/dashboard/sales/deals/${deal.id}`} className="mrow acc-ph-dealrow">
                  <div className="who"><bdi>{dealSub || deal.title}</bdi></div>
                  <span className="n" style={{ fontWeight: 600 }}>{whole(deal.amount)}</span>
                  <div className="r2">
                    <span style={{ flex: 1 }}>{nextStep ? <>{lx(ACTIVITY_LABELS[nextStep.type])}{nextStep.dueAt && <> · {shortDate(nextStep.dueAt, lang)}</>}</> : L("لا خطوة تالية", "No next step")}</span>
                    {lateBy > 0 && <span className="flag">{ar ? `متأخرة ${dayCount(lateBy, lang)}` : `${dayCount(lateBy, lang)} overdue`}</span>}
                  </div>
                </Link>
              ) : <p className="acc-muted">{L("لا صفقة مفتوحة.", "No open deal.")}</p>}
            </section>
          )}
          {contacts}
          {tabBar}
          {tab === "overview" ? <>{activityBlock}<div style={{ marginTop: 24 }}>{usual}{details}</div></> : tabBody}
          <div className="sticky-act" data-acc-more>
            {logBtn && <div className="grow" style={{ flex: 1, display: "flex" }}><button type="button" className="btn p" style={{ flex: 1, justifyContent: "center" }} data-testid="log-activity" onClick={() => setDialog("activity")}>{L("تسجيل نشاط", "Log activity")}</button></div>}
            {quoteBtn && <button type="button" className="btn" data-testid="new-quote" onClick={() => setDialog("quote")}>{L("عرض سعر", "Quotation")}</button>}
          </div>
          {dialogs}
        </div>
      </HrRoot>
    );
  }

  return (
    <HrRoot>
      <div className="pg acc" data-testid="customer-account">
        {noticeEl}
        <div className="ph" style={{ alignItems: "flex-start" }}>
          <div style={{ minWidth: 0 }}>
            <h1 data-testid="account-name">{name}</h1>
            <div className="meta">
              {metaParts.map((t, i) => <span key={i} className="acc-meta-item">{i > 0 && <i aria-hidden />}<span>{t}</span></span>)}
              {c.commercialRegNo && <span className="acc-meta-item">{metaParts.length > 0 && <i aria-hidden />}<span className="id" data-testid="account-cr">CR-{c.commercialRegNo}</span></span>}
            </div>
          </div>
          <div className="act">
            {logBtn}
            {quoteBtn}
            {moreItems.length > 0 && (
              <div style={{ position: "relative" }} data-acc-more>
                <button type="button" className="btn" style={{ width: 34, padding: 0, justifyContent: "center" }} aria-haspopup="menu" aria-expanded={more} aria-label={L("المزيد", "More")} data-testid="account-more" onClick={() => setMore((v) => !v)}><Ico name="more" small /></button>
                {more && <div className="menu down" role="menu">{moreItems}</div>}
              </div>
            )}
          </div>
        </div>

        <dl className="metrics acc-metrics" data-testid="account-metrics">
          {salesFig}{balFig}{lastFig}{qtyFig}{termsFig}
        </dl>
        {tabBar}

        {tab === "overview" ? (
          <div className="cols acc-cols">
            <div style={{ minWidth: 0 }}>{dealBlock}{activityBlock}</div>
            <aside style={{ minWidth: 0 }}>
              {contacts}
              <div className="acc-rule" />
              {usual}
              {details}
            </aside>
          </div>
        ) : <div className="acc-tabbody">{tabBody}</div>}
        {dialogs}
      </div>
    </HrRoot>
  );
}
