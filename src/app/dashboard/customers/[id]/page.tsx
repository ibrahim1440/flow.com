"use client";

import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useI18n } from "@/lib/i18n/context";
import { Ico } from "@/components/shell/icons";
import { useD21Title, usePhone, useD21Phone, useCreateRequest } from "@/components/shell/page-context";
import { Bean, MessageCircle } from "lucide-react";
import { contactKind, lastContact } from "@/lib/services/customers/facts";
import { telHref, waNumber } from "@/lib/services/search/normalize";
import { rememberRecent } from "@/components/shell/recent";
import { HrRoot } from "@/components/hr/ui";
import { ACTIVITY_LABELS, OUTCOME_LABELS, initials, splitTitle } from "@/components/d21/labels";
import { longDate, qtyText, dayCount, dayUnit, daysFromToday, dueText, money2, relativeDays, shortDate, whole } from "@/components/d21/format";
import { api, pick, QUOTE_STATUS_SPECS, LEAD_SOURCE_LABELS } from "../../sales/_components/ui";
import { ActivityDialog, ContactDialog, DealPickDialog, DetailsDialog, FileDialog, FILE_CATEGORY_LABELS, SEGMENT_LABELS, type ActivityKind } from "./dialogs";
import { MessagingCard } from "./_components/messaging";
import type { Account, Activity, AgingKey, Contact, CustomerFile, TimelineEntry } from "./types";
import { CreditBadges, CreditCallout, HoldDialog, LiftDialog, badgesOf, fullDate } from "@/components/credit/credit-ui";
import { orderProgress, progressText } from "@/lib/order-stage";
import { ORDER_STATUS_LABEL_KEYS } from "@/components/OrderLifecyclePanel";
import { useUser } from "../../user-context";
import { canViewInvoices } from "@/lib/services/invoicing/access";
import { useAccountantView } from "../../accounting/_ui/qoyod-pages";
import { ValidityDates, ValidityDialog, ValidityPill } from "./_components/contract-validity";
import { hasValidity } from "@/lib/services/customers/contract-rules";
import { ContractFact } from "./_components/contract-fact";
import { SampleDialog } from "../../sales/_components/SampleDialog";
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
 * The files tab (feat/customer-file) lists, uploads, downloads and removes the customer's documents
 * (/api/customers/[id]/files; bytes in Postgres like collection evidence — no object store exists).
 * The invoices tab adds «كشف الحساب» and «أعمار الديون», derived from the same accepted quotations
 * and approved collections as «الرصيد المستحق» (aggregates.ts statementOfAccount) — not accounting.
 * The orders tab reads each order by the owner's one display rule (lib/order-stage orderProgress).
 */

type Tab = "overview" | "orders" | "invoices" | "deals" | "quotes" | "samples" | "files";

/** lib/order-stage ProgressTone → the Direction 2.1 status pill (`.st`) tones. */
const PROGRESS_TONE: Record<string, string> = { warn: "wa", danger: "er", ok: "ok", info: "in" };
const AGING_LABELS: Record<AgingKey, { ar: string; en: string }> = {
  notDue: { ar: "غير مستحق بعد", en: "Not due yet" },
  d1_30: { ar: "1–30 يومًا", en: "1–30 days" },
  d31_60: { ar: "31–60 يومًا", en: "31–60 days" },
  d61_90: { ar: "61–90 يومًا", en: "61–90 days" },
  d90plus: { ar: "أكثر من 90 يومًا", en: "Over 90 days" },
};
const AGING_KEYS: AgingKey[] = ["notDue", "d1_30", "d31_60", "d61_90", "d90plus"];
const fileSize = (n: number, ar: boolean) => n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} ${ar ? "م.ب" : "MB"}` : `${Math.max(1, Math.round(n / 1024))} ${ar ? "ك.ب" : "KB"}`;
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
  REQUESTED: { ar: "مطلوبة · بانتظار الشحن", en: "Requested · awaiting dispatch" },
  PREPARING: { ar: "قيد التحضير", en: "Preparing" }, SENT: { ar: "أُرسلت", en: "Sent", tone: "in" },
  FEEDBACK_RECEIVED: { ar: "وصل التقييم", en: "Feedback received", tone: "ok" }, CANCELLED: { ar: "ملغاة", en: "Cancelled", tone: "x" },
};
const QUOTE_TONE: Record<string, string> = { DRAFT: "", ISSUED: "in", ACCEPTED: "ok", REJECTED: "er", EXPIRED: "wa", SUPERSEDED: "x" };
// FOLLOWUPS sales UI bug 3: a stock sample is counted in UNIT (and GRAM), which the map lacked — the raw code showed.
const UNIT: Record<string, { ar: string; en: string }> = { KG: { ar: "كجم", en: "kg" }, G: { ar: "غ", en: "g" }, GRAM: { ar: "غ", en: "g" }, PCS: { ar: "قطعة", en: "pcs" }, UNIT: { ar: "عبوة", en: "pack" } };
const AR_MONTHS = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
const EN_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export default function CustomerAccountPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { lang, t } = useI18n();
  const ar = lang === "ar";
  const L = useCallback((a: string, e: string) => (ar ? a : e), [ar]);
  const lx = (x: { ar: string; en: string } | undefined, fallback = "—") => (x ? (ar ? x.ar : x.en) : fallback);
  const phone = usePhone();
  const router = useRouter();

  const [data, setData] = useState<Account | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<{ text: string; ok: boolean; href?: string; link?: string } | null>(null);
  // `?tab=files` (the contract notice links there, batch 24 WP-C) opens on the files tab.
  const search = useSearchParams();
  const [tab, setTab] = useState<Tab>(search?.get("tab") === "files" ? "files" : "overview");
  type QuickPick = { purpose: "quote" | "sample"; deals: { id: string; title: string; stageAr: string; stageEn: string; amount: string | null }[] };
  const [dialog, setDialog] = useState<null | { activity: ActivityKind } | { pick: QuickPick } | { sample: { dealId: string | null; sampled: string[]; manager: boolean } } | "details" | "file" | "hold" | "holdDirect" | "lift" | { contact: Contact | null }>(null);
  const [quickBusy, setQuickBusy] = useState(false);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [allEntries, setAllEntries] = useState(false);
  const noteRef = useRef<HTMLInputElement>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const reload = () => setReloadToken((t) => t + 1);
  // «صلاحية العقد» (batch 24 WP-C): the file whose dates are being edited.
  const [validityFile, setValidityFile] = useState<CustomerFile | null>(null);
  // Qoyod parity (accountant workspace only): Qoyod's five customer tiles — الرصيد الختامي · إجمالي المستحق · متأخرة ·
  // عدد جميع الفواتير · مجموع مبالغ كل الفواتير — from the AR statement and the issued sales invoices (read-only), with
  // one-click links to the invoices and the statement of account. Everyone else keeps this page as it was.
  const viewer = useUser();
  const qoyod = useAccountantView() && !!viewer && canViewInvoices(viewer.permissions);
  const [arTiles, setArTiles] = useState<{ balance: string; open: string; overdue: string; count: number; sum: string; more: boolean } | null>(null);
  useEffect(() => {
    if (!qoyod) return;
    let off = false;
    Promise.all([
      fetch(`/api/accounting/ar/customers/${encodeURIComponent(id)}`).then((r) => (r.ok ? r.json() : null)),
      fetch(`/api/sales/invoices?customerId=${encodeURIComponent(id)}&status=ISSUED&take=200&skip=0`).then((r) => (r.ok ? r.json() : null)),
    ]).then(([a, inv]: [{ aging: Record<string, string | number> } | null, { items: { kind: string; grandTotal: string }[]; total: number } | null]) => {
      if (off || !a || !inv) return;
      const invoices = inv.items.filter((x) => x.kind === "INVOICE");
      const cents = invoices.reduce((t, x) => t + Math.round(Number(x.grandTotal) * 100), 0);
      setArTiles({ balance: String(a.aging.balance ?? "0"), open: String(a.aging.totalOpen ?? "0"), overdue: String(a.aging.overdue ?? "0"), count: invoices.length, sum: (cents / 100).toFixed(2), more: inv.total > inv.items.length });
    }).catch(() => undefined);
    return () => { off = true; };
  }, [qoyod, id]);

  // The issued invoices and notes themselves (I-46): every document the receivables balance counts — with or without a
  // deal or an order, manual ones included — for a viewer who may read invoices. Same API (and scope) as the invoices list.
  const readsInvoices = !!viewer && canViewInvoices(viewer.permissions);
  type IssuedDoc = { id: string; kind: string; number: string | null; issueDate: string | null; dueDate: string | null; grandTotal: string; open: string | null; overdue: boolean; orderNumber: number | null };
  const [issued, setIssued] = useState<{ items: IssuedDoc[]; more: boolean } | null>(null);
  useEffect(() => {
    if (!readsInvoices) return;
    let off = false;
    const q = (tab: string) => fetch(`/api/sales/invoices?customerId=${encodeURIComponent(id)}&status=ISSUED&take=200&skip=0${tab}`).then((r) => (r.ok ? r.json() : null));
    Promise.all([q(""), q("&tab=notes")]).then(([inv, notes]: ({ items: IssuedDoc[]; total: number } | null)[]) => {
      if (off || !inv || !notes) return;
      const items = [...inv.items, ...notes.items].sort((a, b) => (b.issueDate ?? "").localeCompare(a.issueDate ?? ""));
      setIssued({ items, more: inv.total > inv.items.length || notes.total > notes.items.length });
    }).catch(() => undefined);
    return () => { off = true; };
  }, [readsInvoices, id, reloadToken]);

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
  useD21Phone({ title: name, sub: c?.commercialRegNo ? `CR-${c.commercialRegNo}` : undefined, back: "/dashboard/customers", ownBar: true, replacesRepBar: true });

  // Ctrl K «فتحتها مؤخرًا»: this customer, on this device (components/shell/recent.ts).
  useEffect(() => { if (c) rememberRecent(viewer?.id, { kind: "customer", id: c.id, title: c.nameAr || c.name, titleEn: c.name, sub: c.city ?? null, href: `/dashboard/customers/${c.id}` }); }, [c, viewer?.id]);

  // ── One tap «عرض سعر» / «عيّنة» (batch 24 WP-A §3): the deal is chosen for the rep (services/sales/quick-deal.ts). ──
  // «عيّنة» opens the request in place (council fix round 1): the rep stays on the customer; the deal stays behind it.
  const goWithDeal = useCallback(async (purpose: "quote" | "sample", dealId: string) => {
    if (purpose === "quote") { router.push(`/dashboard/sales/quotes/new?opportunityId=${encodeURIComponent(dealId)}&from=customer`); return; }
    const d = await api<{ sampledProductIds?: string[]; can?: { approveSample?: boolean } }>(`/api/sales/opportunities/${encodeURIComponent(dealId)}`);
    setDialog({ sample: { dealId, sampled: d.ok ? d.data.sampledProductIds ?? [] : [], manager: d.ok ? !!d.data.can?.approveSample : false } });
  }, [router]);
  const held = !!data?.creditState?.hold;
  const startQuick = useCallback(async (purpose: "quote" | "sample") => {
    if (quickBusy) return;
    if (purpose === "quote" && held) {
      setNotice({ text: L("البيع موقوف لهذا العميل، فما يمكن إصدار عرض سعر الآن.", "Sales to this customer are on hold, so no quotation can be raised now."), ok: false });
      return;
    }
    setQuickBusy(true);
    // «عيّنة» asks first WITHOUT writing (`preview`): when no deal exists yet, the request opens it on «إرسال الطلب» —
    // cancelling the dialog leaves nothing behind (council fix round 2, item 3).
    const res = await api<{ kind: "use" | "created" | "pick" | "none" | "new"; opportunityId?: string; deals?: QuickPick["deals"] }>(`/api/customers/${id}/quick-deal`, { method: "POST", body: { purpose, preview: purpose === "sample" } });
    setQuickBusy(false);
    if (!res.ok) { setNotice({ text: res.data.error ?? L("تعذّر فتح الصفقة.", "Could not open the deal."), ok: false }); return; }
    const r = res.data;
    if (r.kind === "new" && purpose === "sample") setDialog({ sample: { dealId: null, sampled: [], manager: false } });
    else if ((r.kind === "use" || r.kind === "created") && r.opportunityId) void goWithDeal(purpose, r.opportunityId);
    else if (r.kind === "pick" && r.deals?.length) setDialog({ pick: { purpose, deals: r.deals } });
    else setNotice({ text: L("ما عندك صفقة مفتوحة مع هذا العميل، وما عندك صلاحية تفتح وحدة. كلّم مديرك.", "You have no open deal with this customer and may not open one. Ask your manager."), ok: false });
  }, [quickBusy, held, id, L, goWithDeal]);
  // The «+ جديد» menu and Ctrl K open these on this page with the customer already chosen (?new=…).
  const salesOn = !!data?.sections.sales;
  useCreateRequest("activity", () => setDialog({ activity: "CALL" }), salesOn && !!data?.can.logActivity);
  useCreateRequest("quote", () => { void startQuick("quote"); }, salesOn && !!data?.can.quote);
  useCreateRequest("sample", () => { void startQuick("sample"); }, salesOn && !!data?.can.logActivity);

  // «N» (and Q, S) are the shell's now (batch 24 WP-A): on this page they open the dialogs below through ?new=.
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
  const cur = (lang === "ar" ? "ريال" : "SAR");
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
  async function deleteFile(f: CustomerFile) {
    if (busy || !confirm(ar ? `حذف «${f.title}» من ملف العميل؟` : `Remove “${f.title}” from the customer file?`)) return;
    setBusy(true);
    const res = await api(`/api/customers/${id}/files/${f.id}`, { method: "DELETE" });
    setBusy(false);
    if (res.ok) { setNotice({ text: L("حُذف الملف.", "File removed."), ok: true }); reload(); }
    else setNotice({ text: res.data.error ?? L("تعذّر الحذف.", "Could not remove it."), ok: false });
  }
  async function deleteCustomer() {
    if (!c || !confirm(L("حذف هذا العميل؟ لا يمكن التراجع.", "Delete this customer? This cannot be undone."))) return;
    const res = await api(`/api/customers/${id}`, { method: "DELETE" });
    if (res.ok) router.push("/dashboard/customers");
    else setNotice({ text: res.data.error ?? L("تعذّر الحذف.", "Could not delete."), ok: false });
  }

  const openDeals = (data.deals ?? []).filter((d) => d.outcome === "OPEN");
  // ── The rep's action bar (batch 24 WP-A §3): 📞 اتصال · 💬 واتساب · 📝 سجّل نشاط · 🫘 عيّنة · 📄 عرض سعر (primary). ──
  // The number dialled is the customer's own, else its first contact's.
  const dialPhone = c.phone || c.contacts.find((x) => x.phone)?.phone || null;
  const tel = telHref(dialPhone);
  const wa = waNumber(dialPhone);
  const mayLog = sections.sales && can.logActivity;
  // اتصال: the phone dials AND the activity dialog opens on «مكالمة», ready for what was said.
  const callBtn = mayLog && tel ? (
    <a className="btn" href={tel} data-testid="act-call" onClick={() => setDialog({ activity: "CALL" })}>
      <Ico name="phone" small />{L("اتصال", "Call")}
    </a>
  ) : null;
  // واتساب: wa.me in a new tab, and the dialog on «واتساب».
  const waBtn = mayLog && wa ? (
    <a className="btn" href={`https://wa.me/${wa}`} target="_blank" rel="noopener noreferrer" data-testid="act-whatsapp" onClick={() => setDialog({ activity: "WHATSAPP" })}>
      <MessageCircle size={16} strokeWidth={1.5} aria-hidden />{L("واتساب", "WhatsApp")}
    </a>
  ) : null;
  const logBtn = mayLog ? (
    <button type="button" className="btn" data-testid="log-activity" onClick={() => setDialog({ activity: "CALL" })}>
      <Ico name="note" small />{L("سجّل نشاط", "Log activity")}
    </button>
  ) : null;
  const sampleBtn = mayLog ? (
    <button type="button" className="btn" data-testid="act-sample" disabled={quickBusy} onClick={() => startQuick("sample")}>
      <Bean size={16} strokeWidth={1.5} aria-hidden />{L("عيّنة", "Sample")}
    </button>
  ) : null;
  const quoteBtn = sections.sales && can.quote ? (
    <button type="button" className="btn p" data-testid="new-quote" disabled={quickBusy} onClick={() => startQuick("quote")}>
      <Ico name="quote" small />{L("عرض سعر", "Quotation")}
    </button>
  ) : null;
  const cs = data.creditState ?? null;
  const holdItem = cs?.can.hold && !cs.hold
    ? [<button key="hold" type="button" role="menuitem" className="danger" data-testid="menu-hold" onClick={() => { setMore(false); setDialog("holdDirect"); }}>{L("إيقاف البيع", "Hold sales")}</button>]
    : cs?.can.hold && cs.hold
      ? [<button key="lift" type="button" role="menuitem" data-testid="menu-lift" onClick={() => { setMore(false); setDialog("lift"); }}>{L("رفع الإيقاف", "Lift hold")}</button>]
      : [];
  const moreItems = [...holdItem, ...(can.edit ? [
    <button key="edit" type="button" role="menuitem" data-testid="edit-customer" onClick={() => { setMore(false); setDialog("details"); }}>{L("تعديل بيانات العميل", "Edit customer details")}</button>,
    <Link key="profiles" role="menuitem" href={`/dashboard/customers?open=${id}&tab=profiles`}>{L("مسارات التحميص", "Roast profiles")}</Link>,
    <button key="del" type="button" role="menuitem" className="danger" data-testid="delete-customer" onClick={() => { setMore(false); deleteCustomer(); }}>{L("حذف العميل", "Delete customer")}</button>,
  ] : [])];
  // feat/credit-hold: the warning / hold / grace band, and the badges by the name.
  const creditBand = cs ? <CreditCallout ar={ar} c={cs} phone={phone} onHold={() => setDialog("hold")} onLift={() => setDialog("lift")} /> : null;
  const creditBadges = cs ? <CreditBadges ar={ar} s={badgesOf(cs)} /> : null;

  // ── Figures ──
  const sales = m.sales12m;
  // THE monthly kilograms (last 90 days ÷ 3): the same figure as the tier and «يومي» (aggregates.monthlyKg).
  const monthKg = m.kgPerMonth ?? null;
  const delta = sales?.changePercent;
  const unpricedNote = sections.sales && m.unpricedOrders != null && m.unpricedOrders > 0 ? (ar
    ? `المبيعات والرصيد محسوبة من عروض الأسعار المقبولة والدفعات المعتمدة؛ ${m.unpricedOrders} من طلبات العميل بلا عرض سعر ولا قيمة لها في النظام.`
    : `Sales and balance come from accepted quotations and approved payments; ${m.unpricedOrders} of the customer's orders have no quotation and carry no value in the system.`) : undefined;
  // «مبيعات 12 شهرًا» comes from accepted quotations; with none and orders that carry no quotation, a «0» would be
  // wrong next to «26 طلب» (council fix round 1, P0-9): the tile says why there is no figure instead.
  const salesUnknown = !!sales && Number(sales.net) === 0 && (m.unpricedOrders ?? 0) > 0;
  const salesFig = (
    <div data-testid="metric-sales" title={unpricedNote}>
      <dt className="lbl">{L("مبيعات 12 شهرًا", "12-month sales")}</dt>
      {sales && salesUnknown ? <>
        <dd className="mid">—</dd>
        <dd className="d" data-testid="metric-sales-note">{ar ? `طلباته (${m.unpricedOrders}) بدون عرض سعر، فما لها قيمة في النظام` : `His ${m.unpricedOrders} orders carry no quotation, so no value`}</dd>
      </> : sales ? <>
        <dd className="mid n">{whole(sales.net)}</dd>
        <dd className="d">{cur} · {L("من العروض المقبولة", "from accepted quotations")}{delta != null && <> · <span className={`delta ${delta >= 0 ? "up" : "down"}`}>{delta >= 0 ? "▲" : "▼"} <span className="n">{Math.abs(delta)}%</span></span></>}</dd>
      </> : <><dd className="mid">—</dd><dd className="d">{noAccess(L("المبيعات", "sales"))}</dd></>}
    </div>
  );
  const bal = m.balance;
  const balFig = (
    <div data-testid="metric-balance">
      {/* The balance owed is the receivables ledger's once the customer is invoiced; until then the tile
          says what it is: accepted quotations not yet invoiced or paid (council gate S5). */}
      <dt className="lbl">{bal?.ar ? L("الرصيد المستحق", "Balance due") : L("عروض مقبولة لم تُفوتر", "Accepted, not invoiced")}</dt>
      {bal ? <>
        <dd className={`mid n${Number(bal.ar?.outstanding ?? bal.outstanding) > 0 ? " acc-warn" : ""}`}>{whole(bal.ar?.outstanding ?? bal.outstanding)}</dd>
        {bal.ar ? <dd className="d">{L("عروض مقبولة لم تُفوتر: ", "Accepted, not invoiced: ")}<span className="n">{whole(bal.outstanding)}</span></dd> : null}
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
        <dd className="d">{monthKg
          ? (ar ? <>متوسط <span className="n">{whole(monthKg)}</span> كجم/شهر · آخر 3 شهور</> : <>Average <span className="n">{whole(monthKg)}</span> kg/month · last 3 months</>)
          : anyKg && lastMonth
          ? (ar ? <><span className="n">{whole(lastMonth.kg)}</span> كجم في {monthName(lastMonth.month)}</> : <><span className="n">{whole(lastMonth.kg)}</span> kg in {monthName(lastMonth.month)}</>)
          : running && running.kg > 0
            ? (ar ? <><span className="n">{whole(running.kg)}</span> كجم في {monthName(running.month)} حتى الآن</> : <><span className="n">{whole(running.kg)}</span> kg in {monthName(running.month)} so far</>)
            : L("لا طلبات في آخر 12 شهرًا", "No orders in the last 12 months")}</dd>
      </>}
    </div>
  );
  const credit = m.credit;
  const termsFig = (
    <div data-testid="metric-terms">
      <dt className="lbl">{L("شروط الدفع", "Payment terms")}</dt>
      <dd className="mid acc-terms">{c.paymentTermsDays != null ? <><span className="n">{c.paymentTermsDays}</span> {dayUnit(c.paymentTermsDays, lang) === "يوم" && c.paymentTermsDays !== 1 ? "يومًا" : dayUnit(c.paymentTermsDays, lang)}</> : notSet}</dd>
      <dd className="d" data-testid="metric-credit" title={credit && credit.scope === "all" ? (ar ? `المستخدم ${whole(credit.used)} · المتاح ${whole(credit.available)} ريال` : `Used ${whole(credit.used)} · available SAR ${whole(credit.available)}`) : undefined}>{c.creditLimit != null
        ? (ar ? <>حد ائتمان <span className="n">{whole(c.creditLimit)}</span> ريال</> : <>Credit limit SAR <span className="n">{whole(c.creditLimit)}</span></>)
        : L("حد الائتمان غير محدد", "No credit limit set")}
        {credit?.over && <> · <span className="acc-warn" data-testid="credit-over">{L("متجاوز", "exceeded")}</span></>}</dd>
    </div>
  );

  // ── The facts row (batch 24 WP-A §3): آخر تواصل · يطلب عادةً · آخر طلب · عليه ──
  const contact = lastContact(data.timeline.flatMap((e) => (e.kind === "activity" ? [e.activity] : [])));
  const contactDays = contact?.completedAt ? Math.max(0, -daysFromToday(contact.completedAt)) : null;
  const ago = (n: number) => (n === 0 ? L("اليوم", "today") : ar ? `قبل ${dayCount(n, lang)}` : `${dayCount(n, lang)} ago`);
  // «عليه»: ONE figure everywhere (FOLLOWUPS bugs 1–2) — the receivables balance once invoiced, else the
  // accepted quotations not yet paid, and the label says which.
  const owed = bal ? (bal.ar?.outstanding ?? bal.outstanding) : null;
  const owedLabel = bal?.ar ? L("عليه", "Owes") : L("عليه (من العروض المقبولة)", "Owes (accepted quotations)");
  // The derived tier within the account owner's book (WP-B «يومي»: kg in the last 90 days), beside the name.
  const tierPill = data.tier ? (
    <span className={`acc-tier is-${data.tier.toLowerCase()}`} data-testid="account-tier" data-tier={data.tier}
      title={L("حسب الكميات في آخر 90 يوم، مقارنة ببقية عملاء المندوب", "By kg in the last 90 days, within the rep's book")}>
      {({ VIP: ["VIP", "VIP"], REGULAR: ["عادي", "Regular"], SMALL: ["صغير", "Small"], QUIET: ["بدون طلبات حديثة", "No recent orders"] } as const)[data.tier][ar ? 0 : 1]}
    </span>
  ) : null;
  const facts = (
    <dl className="acc-facts" data-testid="account-facts">
      <div data-testid="fact-contact"><dt>{L("آخر تواصل", "Last contact")}</dt>
        <dd>{!sections.sales ? "—" : contact && contactDays != null ? <>{ago(contactDays)} · {contactKind(contact, ar)}</> : L("ما فيه تواصل مسجّل", "No contact logged")}</dd></div>
      <div data-testid="fact-rhythm"><dt>{L("يطلب عادةً", "Usually orders")}</dt>
        <dd>{!sections.orders ? "—" : m.cadenceDays != null
          ? <>{ar ? `كل ${dayCount(m.cadenceDays, lang)}` : `every ${dayCount(m.cadenceDays, lang)}`}{monthKg ? <> · <span className="n">{whole(monthKg)}</span> {L("كجم/شهر", "kg/month")}</> : null}</>
          : monthKg ? <><span className="n">{whole(monthKg)}</span> {L("كجم/شهر", "kg/month")}</> : L("ما فيه طلبات كافية", "Not enough orders yet")}</dd></div>
      <div data-testid="fact-last-order"><dt>{L("آخر طلب", "Last order")}</dt>
        <dd>{!sections.orders ? "—" : m.lastOrder ? ago(lastDays) : L("ما طلب بعد", "No orders yet")}</dd></div>
      <div data-testid="fact-owed"><dt>{owedLabel}</dt>
        <dd className={owed != null && Number(owed) > 0 ? "warn" : undefined}>{owed == null ? "—" : ar ? <><bdi className="n">{whole(owed)}</bdi> ريال</> : <>SAR <bdi className="n">{whole(owed)}</bdi></>}</dd></div>
      {/* WP-C's contract fact («العقد: ينتهي بعد X يوم»): a fifth fact only while a contract is in its notice window. */}
      <ContractFact ar={ar} files={data.files ?? []} noticeDays={data.contractNoticeDays} />
    </dl>
  );

  // ── Tabs ──
  const count = (n: number | undefined | null) => (n != null ? <span className="c">{n}</span> : null);
  const invoiced = (data.orders ?? []).filter((o) => o.vatInvoiceStatus !== "Not Yet").length;
  const tabs: { id: Tab; text: string; n?: number | null; disabled?: string }[] = [
    { id: "overview", text: L("نظرة عامة", "Overview") },
    { id: "orders", text: L("الطلبات", "Orders"), n: data.orders?.length, disabled: sections.orders ? undefined : L("يتطلب صلاحية الطلبات", "Needs the orders permission") },
    { id: "invoices", text: L("الفواتير", "Invoices"), n: issued?.items.length ? issued.items.length : sections.orders ? invoiced : null, disabled: sections.orders || sections.sales ? undefined : L("يتطلب صلاحية الطلبات أو المبيعات", "Needs the orders or sales permission") },
    { id: "deals", text: L("الصفقات", "Deals"), n: data.deals?.length, disabled: sections.sales ? undefined : L("يتطلب صلاحية المبيعات", "Needs the sales permission") },
    { id: "quotes", text: L("عروض الأسعار", "Quotations"), n: data.quotes?.length, disabled: sections.sales ? undefined : L("يتطلب صلاحية المبيعات", "Needs the sales permission") },
    { id: "samples", text: L("العينات", "Samples"), n: data.samples?.length, disabled: sections.sales ? undefined : L("يتطلب صلاحية المبيعات", "Needs the sales permission") },
    { id: "files", text: L("الملفات", "Files"), n: data.files.length || null },
  ];
  const tabBar = (
    <div className="tabs acc-tabs" role="tablist" aria-label={L("أقسام الحساب", "Account sections")}>
      {tabs.map((tb) => (
        <button key={tb.id} type="button" role="tab" aria-selected={tab === tb.id} className={`${tab === tb.id ? "on" : ""}${tb.disabled ? " acc-off" : ""}`.trim() || undefined}
          aria-disabled={tb.disabled ? true : undefined} title={tb.disabled}
          data-testid={`tab-${tb.id}`} onClick={() => { if (!tb.disabled) setTab(tb.id); }}>
          {tb.text}{count(tb.n)}
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
      {quoteBtn && can.createDeal && <button type="button" className="btn sm" onClick={() => startQuick("quote")} data-testid="start-deal">{L("فتح صفقة وعرض سعر", "Open a deal and quote")}</button>}
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
      case "sample": return { title: <>{L("أُرسلت عيّنة", "Sample sent")} <span className="n">{Number(e.sample.quantity)}</span> {lx(UNIT[e.sample.unit], e.sample.unit)} · <bdi>{(ar ? e.sample.nameAr : null) || e.sample.name}</bdi></> };
      case "quote_issued": return {
        title: ar ? <>أُصدر العرض <bdi className="id">{e.quote.quoteNumber}</bdi> · المراجعة {e.quote.revision} بقيمة <span className="n">{money2(e.quote.grandTotal)}</span> ريال</>
          : <>Quotation <bdi className="id">{e.quote.quoteNumber}</bdi> issued · revision {e.quote.revision} for SAR <span className="n">{money2(e.quote.grandTotal)}</span></>,
        diff: e.stageMove ? `${L("المرحلة", "Stage")}: ${stageName(e.stageMove.from)} ${ar ? "←" : "→"} ${stageName(e.stageMove.to)}` : undefined,
      };
      case "quote_accepted": return { title: ar ? <>قُبل العرض <bdi className="id">{e.quote.quoteNumber}</bdi> بقيمة <span className="n">{money2(e.quote.grandTotal)}</span> ريال</> : <>Quotation <bdi className="id">{e.quote.quoteNumber}</bdi> accepted for SAR <span className="n">{money2(e.quote.grandTotal)}</span></> };
      case "order": return {
        title: ar ? <>أُنشئ الطلب <bdi className="id">#{e.order.orderNumber}</bdi> · <span className="n">{qtyText(e.order.totalKg)}</span> كجم{e.order.value && <> · <span className="n">{money2(e.order.value)}</span> ريال</>}</>
          : <>Order <bdi className="id">#{e.order.orderNumber}</bdi> created · <span className="n">{qtyText(e.order.totalKg)}</span> kg{e.order.value && <> · SAR <span className="n">{money2(e.order.value)}</span></>}</>,
      };
      case "delivery": return {
        title: ar
          ? <>سُلّم للطلب <bdi className="id">#{e.delivery.orderNumber}</bdi> · {e.delivery.units != null ? <><span className="n">{e.delivery.units}</span> وحدة</> : <><span className="n">{qtyText(e.delivery.kg)}</span> كجم</>} · <bdi>{e.delivery.item}</bdi>{e.delivery.type === "full" ? " · اكتمل السطر" : ""}</>
          : <>Delivered for order <bdi className="id">#{e.delivery.orderNumber}</bdi> · {e.delivery.units != null ? <><span className="n">{e.delivery.units}</span> units</> : <><span className="n">{qtyText(e.delivery.kg)}</span> kg</>} · <bdi>{e.delivery.item}</bdi>{e.delivery.type === "full" ? " · line complete" : ""}</>,
        detail: e.delivery.lots.length ? `${L("اللوتات", "Lots")}: ${e.delivery.lots.join(ar ? "، " : ", ")}` : undefined,
      };
      case "credit": {
        const k = e.credit;
        const who = k.by?.name ?? L("النظام", "The system");
        if (k.kind === "GRACE") return { title: ar ? <><b>{who}</b> منح مهلة سماح {dayCount(k.days ?? 0, lang)} حتى {k.untilAt ? fullDate(k.untilAt, true) : "—"}</> : <><b>{who}</b> gave {dayCount(k.days ?? 0, lang)} of grace until {k.untilAt ? fullDate(k.untilAt, false) : "—"}</>, detail: k.reason ?? undefined };
        if (k.kind === "HOLD") return { title: ar ? <><b>{who}</b> أوقف البيع {k.untilPaid ? "حتى السداد" : k.untilAt ? `حتى ${fullDate(k.untilAt, true)}` : ""}</> : <><b>{who}</b> held sales {k.untilPaid ? "until paid" : k.untilAt ? `until ${fullDate(k.untilAt, false)}` : ""}</>, detail: k.reason ?? undefined };
        if (k.kind === "LIFT") return { title: ar ? <><b>{who}</b> رفع الإيقاف</> : <><b>{who}</b> lifted the hold</>, detail: k.reason ?? undefined };
        return { title: k.liftKind === "PAID" ? L("رُفع الإيقاف تلقائيًا: العميل ضمن الحد ولا متأخرات", "Hold lifted automatically: within the limit, nothing overdue") : L("رُفع الإيقاف تلقائيًا بانتهاء مدته", "Hold lifted automatically at its end") };
      }
      case "payment": return {
        title: ar ? <>دفعة <span className="n">{money2(e.payment.amount)}</span> ريال{e.payment.orderNumber != null && <> للطلب <bdi className="id">#{e.payment.orderNumber}</bdi></>} · {lx(METHOD[e.payment.method])}</>
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
            placeholder={L("اكتب ملاحظة سريعة…", "Write a quick note…")} aria-label={L("ملاحظة", "Note")} data-testid="composer-input" />
          {note.trim().length >= 2
            ? <button type="submit" className="btn sm p" disabled={busy} data-testid="composer-save">{L("حفظ", "Save")}</button>
            : null}
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
        <p className="acc-muted" style={{ margin: 0 }}>{L("لا جهات اتصال مسجلة.", "No contacts recorded.")}{c.phone && <> {L("هاتف العميل:", "Customer phone:")} {telHref(c.phone) ? <a href={telHref(c.phone)!} dir="ltr" className="n">{c.phone}</a> : <bdi dir="ltr" className="n">{c.phone}</bdi>}</>}</p>
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
            {m.usualItems.map((u) => <tr key={u.name}><td><bdi>{(ar && u.nameAr) || u.name}</bdi></td><td className="num">{ar ? <><span className="n">{u.kgPerMonth}</span> كجم/شهر</> : <><span className="n">{u.kgPerMonth}</span> kg / month</>}</td></tr>)}
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
      {data.newClientCommission && (
        <label className="cb-check" style={{ marginTop: 10, display: "flex", alignItems: "flex-start" }} data-testid="new-client-exclusion">
          <input type="checkbox" checked={data.newClientCommission.newClientCommissionExcluded} disabled={busy}
            data-testid="new-client-exclusion-box"
            onChange={async (e) => {
              const excluded = e.target.checked;
              const reason = excluded ? window.prompt(L("سبب الاستثناء (كان نشطاً أو جارٍ التفاوض معه قبل المندوب):", "Why is the client excluded (active or in negotiation before the rep)?")) ?? "" : "";
              if (excluded && reason.trim().length < 3) return;
              setBusy(true);
              const r = await api(`/api/customers/${id}/commission-exclusion`, { method: "PATCH", body: { excluded, reason } });
              setBusy(false);
              if (r.ok) reload(); else setNotice({ text: r.data.error ?? "", ok: false });
            }} />
          <span>
            {L("مستثنى من عمولة العميل الجديد", "Excluded from new-client commission")}
            {data.newClientCommission.newClientCommissionExcluded && data.newClientCommission.newClientExclusionReason && (
              <span className="acc-muted" style={{ display: "block", fontSize: 12 }}>{data.newClientCommission.newClientExclusionReason}</span>
            )}
          </span>
        </label>
      )}
    </section>
  );

  // «الرسائل» (batch 25): e-mail, «يستقبل إيميلات», the last automated message.
  const messaging = <MessagingCard customerId={id} ar={ar} onSaved={(text) => setNotice({ text, ok: true })} />;

  // ── Other tabs ──
  const st = (spec: { ar: string; en: string; tone?: string } | undefined, raw: string) => <span className={`st ${spec?.tone ?? ""}`}>{spec ? lx(spec) : raw}</span>;
  const empty = (t: string) => <p className="acc-muted acc-empty" data-testid="tab-empty">{t}</p>;
  // One text status per order, by the owner's rule (lib/order-stage, as the orders board): the
  // status when it decides (hold, cancelled, rejected, completed), else the production stage;
  // an order without a computed stage falls back to its status label (the same translation keys).
  const orderStatus = (o: NonNullable<Account["orders"]>[number]) => {
    const d = orderProgress(o);
    if (d) return <span className={`st ${d.muted ? "x" : PROGRESS_TONE[d.tone] ?? ""}`} data-testid={`order-status-${o.orderNumber}`} data-key={d.key}>{progressText(d, t)}</span>;
    const k = ORDER_STATUS_LABEL_KEYS[o.status];
    return <span className="st" data-testid={`order-status-${o.orderNumber}`}>{k ? t(k) : o.status}</span>;
  };
  const ordersTab = !data.orders ? empty(L("لا تملك صلاحية الطلبات.", "No access to orders.")) : data.orders.length === 0 ? empty(L("لا طلبات لهذا العميل.", "No orders for this customer.")) : (
    <div className="acc-scroll"><table className="t" data-testid="orders-table">
      <thead><tr><th>{L("الطلب", "Order")}</th><th>{L("التاريخ", "Date")}</th><th>{L("الحالة", "Status")}</th><th className="num">{L("الكمية (كجم)", "Quantity (kg)")}</th><th className="num">{L("البنود", "Lines")}</th><th>{L("الدفع", "Payment")}</th><th>{L("الفاتورة الضريبية", "VAT invoice")}</th></tr></thead>
      <tbody>{data.orders.map((o) => (
        <tr key={o.id}><td><Link href={`/dashboard/orders?order=${o.orderNumber}`}><bdi className="id">#{o.orderNumber}</bdi></Link></td><td>{shortDate(o.createdAt, lang)}</td><td>{orderStatus(o)}</td>
          <td className="num">{qtyText(o.totalKg)}</td><td className="num">{o.itemCount}</td><td>{st(PAYMENT_STATUS[o.paymentStatus], o.paymentStatus)}</td><td>{st(VAT_STATUS[o.vatInvoiceStatus], o.vatInvoiceStatus)}</td></tr>
      ))}</tbody>
    </table></div>
  );
  // ── «كشف الحساب» and «أعمار الديون» (sales section) ──
  const stm = data.statement;
  const money = (v: string) => <span className="n">{money2(v)}</span>;
  const statementBlock = !stm ? null : (
    <section data-testid="statement" className="acc-tabsec" style={{ marginTop: 22 }}>
      <div className="bh"><h2 className="bt">{L("كشف الحساب", "Statement of account")}</h2>
        <span className="sub">{L("من عروض الأسعار المقبولة والدفعات المعتمدة · ليس قيدًا محاسبيًا", "From accepted quotations and approved payments · not an accounting ledger")}</span></div>
      <dl className="metrics acc-metrics acc-stm-sum" data-testid="statement-totals">
        <div><dt className="lbl">{L("المستحق بالعروض", "Agreed (quotations)")}</dt><dd className="mid n">{money2(stm.totals.debit)}</dd><dd className="d">{cur} · {L("شامل الضريبة", "VAT included")}</dd></div>
        <div><dt className="lbl">{L("المدفوع المعتمد", "Approved payments")}</dt><dd className="mid n">{money2(stm.totals.credit)}</dd><dd className="d">{cur}</dd></div>
        <div><dt className="lbl">{L("المتبقي من العروض المقبولة", "Left to pay on accepted quotations")}</dt><dd className={`mid n${Number(stm.totals.outstanding) > 0 ? " acc-warn" : ""}`} data-testid="statement-outstanding">{money2(stm.totals.outstanding)}</dd>
          <dd className="d">{Number(stm.totals.unapplied) > 0 ? (ar ? <>ورصيد دائن <span className="n">{money2(stm.totals.unapplied)}</span> لم يُطبَّق</> : <>and SAR <span className="n">{money2(stm.totals.unapplied)}</span> unapplied credit</>) : cur}</dd></div>
        <div data-testid="statement-credit"><dt className="lbl">{L("حد الائتمان", "Credit limit")}</dt>
          {credit ? <><dd className="mid n">{money2(credit.limit)}</dd>
            <dd className="d">{credit.scope === "all"
              ? (credit.over ? <span className="acc-warn">{ar ? <>متجاوز · مستخدم <span className="n">{credit.percent}%</span></> : <>Exceeded · <span className="n">{credit.percent}%</span> used</>}</span>
                : (ar ? <>المتاح <span className="n">{money2(credit.available)}</span> · مستخدم <span className="n">{credit.percent ?? 0}%</span></> : <>Available <span className="n">{money2(credit.available)}</span> · <span className="n">{credit.percent ?? 0}%</span> used</>))
              : L("الاستخدام يظهر لمن يرى صفقات الفريق", "Usage is shown to viewers of the whole team's deals")}</dd></>
            : <><dd className="mid">—</dd><dd className="d">{L("غير محدد", "Not set")}</dd></>}</div>
      </dl>

      <div className="lbl" style={{ margin: "22px 0 6px" }}>{L("أعمار الديون", "Aging")}
        <span className="acc-muted" style={{ fontWeight: 400 }}> · {stm.termsDays != null
          ? (ar ? `الاستحقاق بعد ${dayCount(stm.termsDays, lang)} من التسليم، أو من قبول العرض قبل التسليم` : `Due ${dayCount(stm.termsDays, lang)} after delivery, or after acceptance before any delivery`)
          : L("شروط الدفع غير محددة: يُستحق عند التسليم أو قبول العرض", "No payment terms set: due at delivery or acceptance")}</span></div>
      <dl className="acc-aging" data-testid="aging">
        {AGING_KEYS.map((k) => (
          <div key={k} data-testid={`aging-${k}`} className={k !== "notDue" && Number(stm.aging[k]) > 0 ? "late" : undefined}>
            <dt>{lx(AGING_LABELS[k])}</dt><dd className="n">{money2(stm.aging[k])}</dd>
          </div>
        ))}
      </dl>
      {stm.open.length > 0 && (
        <div className="acc-scroll" style={{ marginTop: 10 }}><table className="t dense" data-testid="open-documents">
          <thead><tr><th>{L("العرض", "Quotation")}</th><th>{L("الصفقة", "Deal")}</th><th className="num">{L("الإجمالي", "Total")}</th><th className="num">{L("المدفوع", "Paid")}</th><th className="num">{L("المتبقي", "Unpaid")}</th><th>{L("الاستحقاق", "Due")}</th><th>{L("العمر", "Age")}</th></tr></thead>
          <tbody>{stm.open.map((o) => (
            <tr key={o.quoteId}><td><Link href={`/dashboard/sales/quotes/${o.quoteId}`}><bdi className="id">{o.quoteNumber}</bdi></Link></td><td><bdi>{o.dealTitle}</bdi></td>
              <td className="num">{money(o.total)}</td><td className="num">{money(o.paid)}</td><td className="num"><b>{money(o.unpaid)}</b></td>
              <td>{shortDate(o.dueAt, lang)} <span className="acc-muted">· {o.basis === "delivery" ? L("من التسليم", "from delivery") : L("من القبول", "from acceptance")}</span></td>
              <td>{o.daysOverdue > 0 ? <span className="st er">{ar ? `متأخر ${dayCount(o.daysOverdue, lang)}` : `${dayCount(o.daysOverdue, lang)} overdue`}</span> : <span className="st">{lx(AGING_LABELS.notDue)}</span>}</td></tr>
          ))}</tbody></table></div>
      )}

      <div className="lbl" style={{ margin: "22px 0 6px" }}>{L("الحركات", "Entries")}</div>
      {stm.lines.length === 0 ? empty(L("لا عروض مقبولة ولا دفعات معتمدة بعد.", "No accepted quotations or approved payments yet.")) : (
        <div className="acc-scroll"><table className="t dense" data-testid="statement-lines">
          <thead><tr><th>{L("التاريخ", "Date")}</th><th>{L("البيان", "Description")}</th><th>{L("الصفقة", "Deal")}</th><th className="num">{L("مدين", "Debit")}</th><th className="num">{L("دائن", "Credit")}</th><th className="num">{L("الرصيد", "Balance")}</th></tr></thead>
          <tbody>{stm.lines.map((l) => (
            <tr key={l.key} data-kind={l.kind}><td>{shortDate(l.at, lang)}</td>
              <td>{l.kind === "document"
                ? <>{L("عرض مقبول", "Accepted quotation")} <Link href={`/dashboard/sales/quotes/${l.quoteId}`}><bdi className="id">{l.quoteNumber}</bdi></Link></>
                : <>{L("دفعة", "Payment")} · {lx(METHOD[l.method ?? ""], l.method ?? "")}{l.orderNumber != null && <> · <bdi className="id">#{l.orderNumber}</bdi></>}{l.reference && <span className="acc-muted"> · <bdi>{l.reference}</bdi></span>}</>}</td>
              <td><bdi>{l.dealTitle}</bdi></td>
              <td className="num">{Number(l.debit) ? money(l.debit) : ""}</td><td className="num">{Number(l.credit) ? money(l.credit) : ""}</td><td className="num">{money(l.balance)}</td></tr>
          ))}</tbody>
          <tfoot><tr><td colSpan={3}><b>{L("الإجمالي", "Total")}</b></td><td className="num"><b>{money(stm.totals.debit)}</b></td><td className="num"><b>{money(stm.totals.credit)}</b></td><td className="num"><b>{money(stm.totals.net)}</b></td></tr></tfoot>
        </table></div>
      )}
    </section>
  );
  const invoicesTab = (
    <div data-testid="invoices-tab">
      {issued && (<>
        <div className="lbl" style={{ margin: "0 0 6px" }}>{L("الفواتير والإشعارات المُصدرة", "Issued invoices and notes")}</div>
        {issued.items.length === 0 ? empty(L("لا فواتير مُصدرة.", "No issued invoices.")) : (
          <div className="acc-scroll"><table className="t dense" data-testid="issued-invoices-table"><thead><tr><th>{L("المستند", "Document")}</th><th>{L("النوع", "Type")}</th><th>{L("تاريخ الإصدار", "Issued")}</th><th>{L("الاستحقاق", "Due")}</th><th className="num">{L("الإجمالي · ريال", "Total · SAR")}</th><th className="num">{L("المتبقي · ريال", "Open · SAR")}</th><th>{L("الطلب", "Order")}</th></tr></thead>
            <tbody>{issued.items.map((x) => <tr key={x.id} data-testid={`issued-invoice-${x.id}`}>
              <td><Link href={`/dashboard/sales/invoices/${x.id}`}><bdi className="id">{x.number ?? "—"}</bdi></Link></td>
              <td>{x.kind === "CREDIT_NOTE" ? L("إشعار دائن", "Credit note") : x.kind === "DEBIT_NOTE" ? L("إشعار مدين", "Debit note") : L("فاتورة", "Invoice")}</td>
              <td>{x.issueDate ? shortDate(x.issueDate, lang) : "—"}</td>
              <td>{x.dueDate ? <span className={x.overdue ? "acc-warn" : undefined}>{shortDate(x.dueDate, lang)}</span> : "—"}</td>
              <td className="num">{money2(x.grandTotal)}</td><td className="num">{x.open === null ? "—" : money2(x.open)}</td>
              <td>{x.orderNumber ? <bdi className="id">#{x.orderNumber}</bdi> : "—"}</td></tr>)}</tbody></table></div>
        )}
        {issued.more && <p className="acc-note" style={{ margin: "6px 0 0" }}>{L("أول 200 مستند من كل نوع — القائمة الكاملة في ", "First 200 of each — the full list is in ")}<Link href={`/dashboard/sales/invoices?customerId=${encodeURIComponent(id)}`}>{L("فواتير العميل", "the customer's invoices")}</Link>.</p>}
      </>)}
      {!issued?.items.length && (
        <p className="callout acc-info" data-testid="invoices-note" style={issued ? { marginTop: 10 } : undefined}>
          {L("يُعرض هنا ما سُجّل من الفواتير الضريبية الصادرة خارج النظام لكل طلب، والدفعات المسجّلة على صفقات العميل.",
            "Shown here is what is recorded per order of VAT invoices issued outside the system, and the payments recorded against the customer's deals.")}
        </p>
      )}
      {unpricedNote && <p className="acc-note" style={{ margin: "10px 0 0" }} data-testid="unpriced-note">{unpricedNote}</p>}
      {statementBlock}
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
      <thead><tr><th>{L("العرض", "Quotation")}</th><th>{L("الصفقة", "Deal")}</th><th>{L("الحالة", "Status")}</th><th className="num">{L("الإجمالي · ريال", "Total · SAR")}</th><th>{L("صالح حتى", "Valid until")}</th><th>{L("أُصدر", "Issued")}</th></tr></thead>
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
        <tr key={s.id}><td className="who"><bdi>{(ar ? s.productSku?.nameAr : null) || s.productSku?.name || s.productSku?.skuCode || s.description || "—"}</bdi></td><td><Link href={`/dashboard/sales/deals/${s.opportunity.id}`}><bdi>{s.opportunity.title}</bdi></Link></td>
          <td className="num">{Number(s.quantity)} {lx(UNIT[s.unit], s.unit)}</td><td>{st(SAMPLE_STATUS[s.status], s.status)}</td><td>{s.sentAt ? shortDate(s.sentAt, lang) : "—"}</td><td className="num">{s.feedbackScore != null ? `${s.feedbackScore}/5` : "—"}</td></tr>
      ))}</tbody>
    </table></div>
  );
  const files = data.files;
  const filesTab = (
    <section data-testid="files-tab" className="acc-tabsec">
      <div className="bh"><h2 className="bt">{L("ملفات العميل", "Customer files")}</h2>
        <span className="sub">{ar ? `عقود، سجل تجاري، شهادة ضريبية، اتفاقيات أسعار · PDF أو JPEG أو PNG حتى ${Math.round((data.fileLimits?.direct ? 20971520 : data.fileLimits?.maxBytes ?? 5242880) / 1048576)} م.ب` : `Contracts, commercial register, VAT certificate, price agreements · PDF, JPEG or PNG up to ${Math.round((data.fileLimits?.direct ? 20971520 : data.fileLimits?.maxBytes ?? 5242880) / 1048576)} MB`}</span>
        {can.manageFiles && <button type="button" className="btn sm p acc-bh-act" onClick={() => setDialog("file")} data-testid="upload-file"><Ico name="plus" small />{L("رفع ملف", "Upload a file")}</button>}
      </div>
      {files.length === 0 ? empty(can.manageFiles ? L("لا ملفات على ملف العميل بعد. ارفع العقد أو السجل التجاري أو الشهادة الضريبية.", "No files yet. Upload the contract, the commercial register or the VAT certificate.") : L("لا ملفات على ملف العميل بعد.", "No files on the customer file yet.")) : phone ? (
        // The phone (390): one card per file, so the validity (ساري / ينتهي خلال X يوم / منتهي) is never cut off.
        <ul className="acc-file-cards" data-testid="files-cards">
          {files.map((f) => (
            <li key={f.id} data-testid={`file-${f.id}`}>
              <div className="acc-file-top">
                <a href={`/api/customers/${id}/files/${f.id}`} download={f.fileName} data-testid={`file-download-${f.id}`}><bdi>{f.title}</bdi></a>
                <span className="acc-muted sm">{lx(FILE_CATEGORY_LABELS[f.category], f.category)}</span>
              </div>
              {hasValidity(f.category) && (f.validFrom || f.validUntil)
                ? <div className="acc-file-validity" data-testid={`file-validity-cell-${f.id}`}><ValidityPill ar={ar} file={f} files={files} noticeDays={data.contractNoticeDays} /><ValidityDates ar={ar} file={f} /></div>
                : null}
              <div className="acc-file-sub">
                <span>{fileSize(f.sizeBytes, ar)}</span>
                {f.uploadedBy?.name ? <span><bdi>{f.uploadedBy.name}</bdi></span> : null}
                <span>{longDate(f.createdAt, lang)}</span>
              </div>
              <div className="acc-file-act">
                <a className="btn sm" href={`/api/customers/${id}/files/${f.id}`} download={f.fileName}>{L("تنزيل", "Download")}</a>
                {can.editFileDates && hasValidity(f.category) && <button type="button" className="btn sm" onClick={() => setValidityFile(f)} data-testid={`file-dates-${f.id}`}>{f.validUntil || f.validFrom ? L("تعديل التواريخ", "Edit dates") : L("إضافة التواريخ", "Add dates")}</button>}
                {can.manageFiles && <button type="button" className="btn sm" disabled={busy} onClick={() => deleteFile(f)} data-testid={`file-delete-${f.id}`}>{L("حذف", "Remove")}</button>}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <div className="acc-scroll"><table className="t" data-testid="files-table">
          <thead><tr><th>{L("الملف", "File")}</th><th>{L("التصنيف", "Category")}</th><th>{L("الصلاحية", "Validity")}</th><th className="num">{L("الحجم", "Size")}</th><th>{L("رفعه", "Uploaded by")}</th><th>{L("التاريخ", "Date")}</th><th aria-label={L("إجراءات", "Actions")} /></tr></thead>
          <tbody>{files.map((f) => (
            <tr key={f.id} data-testid={`file-${f.id}`}>
              <td className="who"><a href={`/api/customers/${id}/files/${f.id}`} download={f.fileName} data-testid={`file-download-${f.id}`}><bdi>{f.title}</bdi></a><div className="acc-muted sm" dir="auto">{f.fileName}</div></td>
              <td>{lx(FILE_CATEGORY_LABELS[f.category], f.category)}</td>
              <td data-testid={`file-validity-cell-${f.id}`}>
                {hasValidity(f.category) && (f.validFrom || f.validUntil)
                  ? <><ValidityPill ar={ar} file={f} files={files} noticeDays={data.contractNoticeDays} /><ValidityDates ar={ar} file={f} /></>
                  : <span className="acc-muted">—</span>}
              </td>
              <td className="num">{fileSize(f.sizeBytes, ar)}</td>
              <td>{f.uploadedBy?.name ?? "—"}</td>
              <td>{longDate(f.createdAt, lang)}</td>
              <td className="acc-file-act">
                <a className="btn sm" href={`/api/customers/${id}/files/${f.id}`} download={f.fileName}>{L("تنزيل", "Download")}</a>
                {can.editFileDates && hasValidity(f.category) && <button type="button" className="btn sm" onClick={() => setValidityFile(f)} data-testid={`file-dates-${f.id}`}>{f.validUntil || f.validFrom ? L("تعديل التواريخ", "Edit dates") : L("إضافة التواريخ", "Add dates")}</button>}
                {can.manageFiles && <button type="button" className="btn sm" disabled={busy} onClick={() => deleteFile(f)} data-testid={`file-delete-${f.id}`}>{L("حذف", "Remove")}</button>}
              </td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </section>
  );
  const tabBody = tab === "orders" ? ordersTab : tab === "invoices" ? invoicesTab : tab === "deals" ? dealsTab : tab === "quotes" ? quotesTab : tab === "samples" ? samplesTab : tab === "files" ? filesTab : null;

  const noticeEl = notice ? (
    <p className={`notice ${notice.ok ? "ok" : "er"}`} role={notice.ok ? "status" : "alert"} data-testid="account-notice" style={{ marginBottom: 16 }}>
      {notice.text}{notice.href ? <> · <Link href={notice.href} data-testid="account-notice-link">{notice.link}</Link></> : null}<button type="button" onClick={() => setNotice(null)} aria-label={L("إغلاق", "Dismiss")}>×</button>
    </p>
  ) : null;

  const dialogs = (
    <>
      {dialog && typeof dialog === "object" && "activity" in dialog && <ActivityDialog ar={ar} customerId={id} customerName={name} deals={openDeals} defaultDealId={null} initialKind={dialog.activity}
        onClose={() => setDialog(null)} onDone={() => { setDialog(null); setNotice({ text: L("سُجّل النشاط.", "Activity logged."), ok: true }); reload(); }} />}
      {dialog && typeof dialog === "object" && "pick" in dialog && <DealPickDialog ar={ar} purpose={dialog.pick.purpose} deals={dialog.pick.deals}
        onClose={() => setDialog(null)} onPick={(dealId) => { const purpose = dialog.pick.purpose; setDialog(null); void goWithDeal(purpose, dealId); }} />}
      {dialog && typeof dialog === "object" && "sample" in dialog && <SampleDialog ar={ar} opportunityId={dialog.sample.dealId} customerId={id} sampledProductIds={dialog.sample.sampled} manager={dialog.sample.manager}
        onClose={() => setDialog(null)}
        onDone={(_requested, replayed, approval, openedDealId) => {
          const dealId = openedDealId ?? dialog.sample.dealId ?? "";
          setDialog(null);
          setNotice({
            text: replayed ? L("هذا الطلب مسجّل من قبل.", "This request was already recorded.")
              : approval === "PENDING" ? L("تم طلب العيّنة — بانتظار موافقة المدير.", "Sample requested — awaiting the manager's approval.")
              : L("تم طلب العيّنة", "Sample requested"),
            ok: true, href: `/dashboard/sales/deals/${encodeURIComponent(dealId)}`, link: L("عرض الصفقة", "Open the deal"),
          });
          reload();
        }} />}
      {(dialog === "hold" || dialog === "holdDirect") && cs && <HoldDialog ar={ar} customerId={id} customerName={name} c={cs} startAt={dialog === "holdDirect" && !cs.warning.any && !cs.grace ? "hold" : "ask"} onClose={() => setDialog(null)}
        onDone={(what) => { setDialog(null); setNotice({ text: what === "grace" ? L("سُجّلت أيام السماح.", "Grace days recorded.") : L("أُوقف البيع لهذا العميل.", "Sales to this customer are on hold."), ok: true }); reload(); }} />}
      {dialog === "lift" && cs && <LiftDialog ar={ar} customerId={id} customerName={name} c={cs} onClose={() => setDialog(null)} onDone={() => { setDialog(null); setNotice({ text: L("رُفع الإيقاف.", "Hold lifted."), ok: true }); reload(); }} />}
      {dialog === "file" && <FileDialog ar={ar} customerId={id} maxBytes={data.fileLimits?.maxBytes} direct={data.fileLimits?.direct} canDates={can.editFileDates ?? false} onClose={() => setDialog(null)} onDone={(warning) => { setDialog(null); setNotice(warning ? { text: warning, ok: false } : { text: L("رُفع الملف.", "File uploaded."), ok: true }); setTab("files"); reload(); }} />}
      {validityFile && <ValidityDialog ar={ar} customerId={id} file={validityFile} onClose={() => setValidityFile(null)} onDone={() => { setValidityFile(null); setNotice({ text: L("حُفظت تواريخ العقد.", "Contract dates saved."), ok: true }); reload(); }} />}
      {dialog === "details" && <DetailsDialog ar={ar} customer={c} canOwner={can.editOwner ?? false} canCredit={can.editCreditTerms ?? false} onClose={() => setDialog(null)} onDone={() => { setDialog(null); setNotice({ text: L("حُفظت البيانات.", "Saved."), ok: true }); reload(); }} />}
      {dialog && typeof dialog === "object" && "contact" in dialog && <ContactDialog ar={ar} customerId={id} contact={dialog.contact} onClose={() => setDialog(null)} onDone={() => { setDialog(null); reload(); }} />}
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
          {(subline || tierPill) && <p className="acc-subline">{tierPill}{tierPill && subline ? " " : null}{subline}{dialPhone ? <> · {tel ? <a href={tel} className="acc-tel n" dir="ltr" data-testid="account-phone">{dialPhone}</a> : <bdi className="n" dir="ltr">{dialPhone}</bdi>}</> : null}</p>}
          {creditBand}
          {facts}
          <dl className="phrows" data-testid="account-metrics">
            <div><dt className="lbl">{bal?.ar ? L("الرصيد المستحق", "Balance due") : L("عروض مقبولة لم تُفوتر", "Accepted, not invoiced")}</dt><dd className={owed != null && Number(owed) > 0 ? "acc-warn" : undefined} data-testid="phone-balance">{owed != null ? amountWithUnit(owed) : "—"}</dd></div>
            <div><dt className="lbl">{L("مبيعات 12 شهرًا", "12-month sales")}</dt><dd>{sales && !salesUnknown ? amountWithUnit(sales.net) : "—"}</dd></div>
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
              {quoteBtn && sampleBtn ? <div style={{ marginTop: 10 }}>{sampleBtn}</div> : null}
            </section>
          )}
          {contacts}
          {tabBar}
          {tab === "overview" ? <>{activityBlock}<div style={{ marginTop: 24 }}>{usual}{details}{messaging}</div></> : tabBody}
          {mayLog || quoteBtn ? (
            <div className="sticky-act acc-quickbar" data-acc-more data-testid="account-quickbar">
              {mayLog ? (tel ? <a className="btn" href={tel} aria-label={L("اتصال", "Call")} data-testid="act-call" onClick={() => setDialog({ activity: "CALL" })}><Ico name="phone" /></a>
                : <button type="button" className="btn" disabled aria-label={L("لا يوجد رقم جوال", "No phone number")}><Ico name="phone" /></button>) : <span />}
              {mayLog ? (wa ? <a className="btn" href={`https://wa.me/${wa}`} target="_blank" rel="noopener noreferrer" aria-label={L("واتساب", "WhatsApp")} data-testid="act-whatsapp" onClick={() => setDialog({ activity: "WHATSAPP" })}><MessageCircle size={18} strokeWidth={1.5} aria-hidden /></a>
                : <button type="button" className="btn" disabled aria-label={L("لا يوجد رقم واتساب", "No WhatsApp number")}><MessageCircle size={18} strokeWidth={1.5} aria-hidden /></button>) : <span />}
              {mayLog ? <button type="button" className="btn" aria-label={L("سجّل نشاط", "Log activity")} data-testid="log-activity" onClick={() => setDialog({ activity: "CALL" })}><Ico name="note" /></button> : <span />}
              {/* «عيّنة» on the one bar too (seat 5 r2): a quotation keeps the wide primary slot. */}
              {quoteBtn && mayLog ? <button type="button" className="btn" aria-label={L("عيّنة", "Sample")} data-testid="act-sample" disabled={quickBusy} onClick={() => startQuick("sample")}><Bean size={18} strokeWidth={1.5} aria-hidden /></button> : <span />}
              {quoteBtn ? <button type="button" className="btn p" data-testid="new-quote" disabled={quickBusy} onClick={() => startQuick("quote")}><Ico name="quote" small />{L("عرض سعر", "Quotation")}</button>
                : mayLog ? <button type="button" className="btn p" data-testid="act-sample" disabled={quickBusy} onClick={() => startQuick("sample")}><Bean size={16} strokeWidth={1.5} aria-hidden />{L("عيّنة", "Sample")}</button> : <span />}
            </div>
          ) : null}
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
            <h1 data-testid="account-name">{name}{tierPill}{creditBadges ? <span className="acc-credit-badges" data-testid="account-credit-badges">{creditBadges}</span> : null}</h1>
            <div className="meta">
              {metaParts.map((t, i) => <span key={i} className="acc-meta-item">{i > 0 && <i aria-hidden />}<span>{t}</span></span>)}
              {dialPhone && <span className="acc-meta-item"><i aria-hidden />{tel ? <a href={tel} className="acc-tel n" dir="ltr" data-testid="account-phone" onClick={() => { if (mayLog) setDialog({ activity: "CALL" }); }}>{dialPhone}</a> : <bdi className="n" dir="ltr">{dialPhone}</bdi>}</span>}
              {c.commercialRegNo && <span className="acc-meta-item">{metaParts.length > 0 && <i aria-hidden />}<span className="id" data-testid="account-cr">CR-{c.commercialRegNo}</span></span>}
            </div>
          </div>
          <div className="act acc-actbar" data-testid="account-actions">
            {callBtn}
            {waBtn}
            {logBtn}
            {sampleBtn}
            {quoteBtn}
            {moreItems.length > 0 && (
              <div style={{ position: "relative" }} data-acc-more>
                <button type="button" className="btn" style={{ width: 34, padding: 0, justifyContent: "center" }} aria-haspopup="menu" aria-expanded={more} aria-label={L("المزيد", "More")} data-testid="account-more" onClick={() => setMore((v) => !v)}><Ico name="more" small /></button>
                {more && <div className="menu down" role="menu">{moreItems}</div>}
              </div>
            )}
          </div>
        </div>

        {creditBand}
        {facts}
        {qoyod ? (
          <>
            <dl className="metrics acc-metrics" data-testid="account-ar-tiles">
              {[
                [L("الرصيد الختامي", "Closing balance"), arTiles?.balance],
                [L("إجمالي المستحق", "Total due"), arTiles?.open],
                [L("متأخرة", "Overdue"), arTiles?.overdue],
                [L("عدد جميع الفواتير", "Invoices"), arTiles ? String(arTiles.count) : undefined],
                [L("مجموع مبالغ كل الفواتير", "All invoices total"), arTiles?.sum],
              ].map(([k, v], i) => (
                <div key={i}><dt>{k}</dt><dd className="mid"><bdi className="n">{v === undefined ? "…" : i === 3 ? v : money2(Number(v))}</bdi></dd>{i === 4 && arTiles?.more ? <dd className="d">{L("أول 200 فاتورة", "first 200 invoices")}</dd> : null}</div>
              ))}
            </dl>
            <p className="acc-qlinks" style={{ display: "flex", gap: 12, margin: "0 0 16px" }}>
              <Link href={`/dashboard/sales/invoices?customerId=${encodeURIComponent(id)}`} data-testid="account-invoices-link">{L("فواتير العميل", "The customer's invoices")}</Link>
              <Link href={`/dashboard/sales/receivables/${encodeURIComponent(id)}`} data-testid="account-statement-link">{L("كشف الحساب", "Statement of account")}</Link>
            </p>
          </>
        ) : null}
        <dl className="metrics acc-metrics" data-testid="account-metrics">
          {salesFig}{balFig}{qtyFig}{termsFig}
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
              {messaging}
            </aside>
          </div>
        ) : <div className="acc-tabbody">{tabBody}</div>}
        {dialogs}
      </div>
    </HrRoot>
  );
}
