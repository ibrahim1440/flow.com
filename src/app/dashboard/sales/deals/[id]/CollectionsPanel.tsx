"use client";

import { localizeApiError } from "@/lib/i18n/api-errors";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Camera, Paperclip, Plus, Upload } from "lucide-react";
import {
  Field, TextInput, TextArea, Button, Modal,
  Money, Num, ROW_ACTION, api, formatDay, num, moneyText,
} from "../../_components/ui";
import { RIYAL } from "@/lib/money/riyal";
import { amountForServer, amountValue, cleanAmount, hasMinusSign, parsePastedAmount } from "@/lib/money/amount-input";
import { useUser } from "../../../user-context";
import { prepareReceipt } from "@/lib/files/receipt-prep";
import { hasSubPrivilege } from "@/lib/auth-shared";
import "./collections.css";

/**
 * The money against one deal.
 *
 * Won and paid are two different things, and this panel exists because the pipeline could
 * only say the first. A deal is Won the moment the customer accepts a quotation; whether
 * any of the money has arrived is a separate question with its own evidence, its own
 * approver and its own effect on commission.
 *
 * Every figure here is derived from the collections themselves. There is no "collected so
 * far" column anywhere, because a stored total and a list of receipts are two things that
 * can disagree and the one people would believe is whichever is wrong.
 */

export type CollectionRow = {
  id: string;
  status: "PENDING_VERIFICATION" | "APPROVED" | "REJECTED" | "REVERSED";
  amountGross: string;
  amountTax: string;
  amountNet: string | null;
  currency: string;
  paymentMethod: string;
  collectedAt: string;
  referenceNumber: string | null;
  submittedAt: string;
  decidedAt: string | null;
  decisionReason: string | null;
  /** RETURN_FOR_CORRECTION: «رجع لك» (Abu Fahd friction 12 — one word everywhere) with «صحّحه». */
  decisionReasonCode?: string | null;
  reversedAt: string | null;
  reversalReason: string | null;
  submittedBy: { id: string; name: string } | null;
  decidedBy: { id: string; name: string } | null;
  _count: { evidence: number };
  collectionEvent: {
    accruals: { amount: string; status: string; employee: { id: string; name: string } }[];
  } | null;
};

export type Summary = {
  document: { quoteId: string; quoteNumber: string; currency: string; gross: string; tax: string; net: string } | null;
  approvedGross: string;
  approvedTax: string;
  approvedNet: string | null;
  pendingGross: string;
  reversedGross: string;
  unpaidGross: string;
  availableToSubmitGross: string;
  remainingGross: string;
  state: "UNPAID" | "PARTIALLY_COLLECTED" | "FULLY_COLLECTED";
};

const STATE_LABEL: Record<string, { en: string; ar: string; tone: string }> = {
  UNPAID: { en: "Unpaid", ar: "غير محصَّل", tone: "border-oo-status-blocked bg-oo-status-blocked-bg text-oo-status-blocked" },
  PARTIALLY_COLLECTED: { en: "Partially collected", ar: "محصَّل جزئياً", tone: "border-oo-status-waiting bg-oo-status-waiting-bg text-oo-status-hold" },
  FULLY_COLLECTED: { en: "Fully collected", ar: "محصَّل بالكامل", tone: "border-oo-status-success bg-oo-status-success-bg text-oo-status-success" },
};

const STATUS_LABEL: Record<string, { en: string; ar: string }> = {
  PENDING_VERIFICATION: { en: "Awaiting verification", ar: "بانتظار التحقق" },
  APPROVED: { en: "Approved", ar: "معتمَد" },
  REJECTED: { en: "Rejected", ar: "مرفوض" },
  REVERSED: { en: "Reversed", ar: "معكوس" },
};

const METHODS = ["BANK_TRANSFER", "CASH", "CHEQUE", "POS_CARD", "OTHER"] as const;
const METHOD_LABEL: Record<string, { en: string; ar: string }> = {
  BANK_TRANSFER: { en: "Bank transfer", ar: "تحويل بنكي" },
  CASH: { en: "Cash", ar: "نقداً" },
  CHEQUE: { en: "Cheque", ar: "شيك" },
  POS_CARD: { en: "Card", ar: "شبكة" },
  OTHER: { en: "Other", ar: "أخرى" },
};

/**
 * Why the action is not offered, in the words the person needs.
 *
 * The panel used to render nothing at all when it could not offer the button, so a reviewer
 * looking at an eligible deal saw a blank space and no way to tell whether the feature was
 * missing, broken, or simply not theirs. Every branch here says which it is.
 */
const UNAVAILABLE: Record<string, { ar: string; en: string }> = {
  NO_PRIVILEGE: {
    ar: "لا تملك صلاحية تسجيل التحصيل. تُمنح من إعدادات المستخدمين: المبيعات ← تسجيل تحصيل.",
    en: "You do not have the collection-submit permission. It is granted in user settings under Sales → Record a collection.",
  },
  NOT_YOUR_DEAL: {
    ar: "هذه الصفقة ليست لك. التحصيل يسجّله مالك الصفقة.",
    en: "This deal is not yours. A collection is recorded by the deal's owner.",
  },
  NO_ACCEPTED_DOCUMENT: {
    ar: "لا يوجد عرض سعر مقبول على هذه الصفقة، فلا شيء يُحصَّل مقابله. سجّل قبول العميل أولاً.",
    en: "There is no accepted quotation on this deal, so there is nothing to collect against. Record the customer's acceptance first.",
  },
  NOTHING_OUTSTANDING: {
    ar: "لا يوجد متبقٍ على هذه الصفقة — حُصّل كامل المبلغ أو هو بانتظار التحقق.",
    en: "Nothing is outstanding on this deal — it is fully collected, or the rest is awaiting verification.",
  },
};

export function CollectionsPanel({
  dealId, ar, lang, summary, rows, action, onChanged, heldOrder = null, dealOrders = [], collectFor = null,
}: {
  dealId: string;
  /** Owner أ (the manual-collection trap): the deal's order held for its money — paid only from the order. Abu Fahd R4
   *  F2: when it waits for the accountant (the sale's collection, or a top-up) nothing is asked of the rep. */
  heldOrder?: { id: string; orderNumber: number; paymentHold?: string | null; topUpPending?: boolean; short?: string | null; needsRep?: boolean } | null;
  /** Abu Fahd R4 F1: the deal's orders — «لأي طلب؟» when there is more than one (held ones listed, not choosable). */
  dealOrders?: { id: string; orderNumber: number; held: boolean }[];
  /** «سجّل تحصيل» from a normal order's panel: open the form on that order. */
  collectFor?: string | null;
  ar: boolean;
  lang: "ar" | "en";
  summary: Summary;
  rows: CollectionRow[];
  /** The server's verdict. Never recomputed here — see `collectionAction`. */
  action: { available: boolean; reason: string };
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // D20: a receipt attached LATER to the rep's own pending collection (POST …/evidence enforces the same rule).
  const viewer = useUser();
  const me = viewer?.id ?? null;
  // أبو فهد: the accountant's lines (the net basis, «لم يُنشئ عمولة», the manual-verification note) are Finance's
  // reading; a rep sees one plain line instead — «بانتظار المحاسب يعتمد». Finance's view is unchanged.
  const financeView = !!viewer && hasSubPrivilege(viewer.permissions, "commissions", "collection_verify");
  const laterInput = useRef<HTMLInputElement>(null);
  const [laterFor, setLaterFor] = useState<string | null>(null);
  const [laterBusy, setLaterBusy] = useState<string | null>(null);
  // أبو فهد B1: the answer is said ON the row (the panel's `error` only shows inside the record dialog): the refusal or
  // failure in words, and «✓ انرفع الإيصال» once it is in.
  const [laterMsg, setLaterMsg] = useState<{ id: string; ok: boolean; text: string } | null>(null);
  async function attachLater(collectionId: string, chosen: File) {
    setLaterBusy(collectionId);
    setLaterMsg(null);
    // Gate L1: JPEG / PNG / PDF within 5 MB; another photo (HEIC, WebP, large) becomes a JPEG first.
    const ready = await prepareReceipt(chosen);
    if (!ready.ok) { setLaterBusy(null); setLaterMsg({ id: collectionId, ok: false, text: ar ? ready.ar : ready.en }); return; }
    const form = new FormData();
    form.append("file", ready.file);
    const up = await fetch(`/api/sales/collections/${collectionId}/evidence`, { method: "POST", body: form }).catch(() => null);
    setLaterBusy(null);
    if (!up || !up.ok) {
      const data = up ? await up.json().catch(() => ({})) : {};
      setLaterMsg({ id: collectionId, ok: false, text: (ar ? "ما انرفع الإيصال: " : "The receipt did not upload: ") + (localizeApiError(data) ?? (ar ? "تعذّر الاتصال." : "Could not connect.")) });
      return;
    }
    setLaterMsg({ id: collectionId, ok: true, text: ar ? "✓ انرفع الإيصال" : "✓ Receipt uploaded" });
    onChanged();
  }
  const [error, setError] = useState("");
  const [amount, setAmount] = useState("");
  const [pasteBad, setPasteBad] = useState(false);
  const [minusBad, setMinusBad] = useState(false);
  const [method, setMethod] = useState<string>("BANK_TRANSFER");
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [collectedAt, setCollectedAt] = useState(() => new Date().toISOString().slice(0, 10));
  // D19 (owner-approved Figma 1988:2): «متى استلمته؟» — اليوم / أمس / تاريخ ثاني (a date field only for the last).
  const [dateChoice, setDateChoice] = useState<"today" | "yesterday" | "other">("today");
  const [file, setFile] = useState<File | null>(null);
  // P1 ERR-01: the receipt is checked the moment it is chosen (JPEG / PNG / PDF, not empty, 5 MB; another photo becomes a
  // JPEG) — a refused file is said under the field and never sent.
  const [fileErr, setFileErr] = useState("");
  async function chooseFile(f: File | null) {
    setFileErr(""); setFile(null);
    if (!f) return;
    const ready = await prepareReceipt(f);
    if (ready.ok) setFile(ready.file); else setFileErr(ar ? ready.ar : ready.en);
  }
  /**
   * One key per opened form, not per click.
   *
   * This is what makes a double-clicked Save one collection rather than two. Generated when
   * the dialog opens and reused for every attempt, so a retry after a network failure lands
   * on the same row the first attempt may already have created.
   */
  const [key, setKey] = useState("");
  const payable = dealOrders.filter((o) => !o.held);
  const pickOrder = dealOrders.length > 1;
  const [orderChoice, setOrderChoice] = useState("");
  const autoOpened = useRef(false);

  const label = (m: Record<string, { en: string; ar: string }>, k: string) =>
    ar ? (m[k]?.ar ?? k) : (m[k]?.en ?? k);

  function start() {
    setAmount("");
    setPasteBad(false);
    setReference("");
    setNote("");
    setFile(null);
    setError("");
    setCollectedAt(new Date().toISOString().slice(0, 10));
    setDateChoice("today");
    setMethod("BANK_TRANSFER");
    setKey(`col-${dealId}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
    // One order: as before (the server's default). Several: the chosen one (the order panel's, else the first payable).
    setOrderChoice(!pickOrder ? "" : collectFor && payable.some((o) => o.id === collectFor) ? collectFor : payable[0]?.id ?? "");
    setOpen(true);
  }
  // «سجّل تحصيل» from a normal order's panel opens the form here, on that order (once).
  useEffect(() => {
    if (!autoOpened.current && collectFor && action.available && summary.document && payable.some((o) => o.id === collectFor)) { autoOpened.current = true; start(); }
  });

  async function submit() {
    if (busy) return;
    setBusy(true);
    setError("");
    const res = await api<{ collectionId: string }>("/api/sales/collections", {
      method: "POST",
      body: {
        opportunityId: dealId,
        amountGross: amountForServer(amount.trim()),
        currency: summary.document?.currency ?? "SAR",
        collectedAt: new Date(collectedAt).toISOString(),
        paymentMethod: method,
        referenceNumber: reference.trim() || null,
        note: note.trim() || null,
        idempotencyKey: key,
        // Abu Fahd R4 F1: the order chosen explicitly (the server pays a held order only from the order itself).
        ...(orderChoice ? { orderId: orderChoice } : {}),
      },
    });
    if (!res.ok) {
      setBusy(false);
      setError(res.data.error ?? (ar ? "تعذّر التسجيل." : "Could not record it."));
      return;
    }

    // The evidence is a second request on purpose: it is multipart, and a failed upload must
    // not lose the collection that was already accepted. If it fails the row exists and the
    // person is told to attach the file again rather than re-entering the amount.
    if (file) {
      const form = new FormData();
      form.append("file", file);
      const up = await fetch(`/api/sales/collections/${res.data.collectionId}/evidence`, {
        method: "POST",
        body: form,
      }).catch(() => null);
      if (!up || !up.ok) {
        const data = up ? await up.json().catch(() => ({})) : {};
        setBusy(false);
        setOpen(false);
        onChanged();
        // P1 ERR-01 (approved Figma 2033:95): the failure is said ON the collection's row — the dialog is closed, so an
        // error inside it was never seen — with «أرفق الإيصال» right there.
        setLaterMsg({
          id: res.data.collectionId, ok: false,
          text: (ar ? "الإيصال ما انرفع — التحصيل انحفظ بدون إيصال. " : "The receipt did not upload — the collection was saved without it. ") + (localizeApiError(data) ?? (ar ? "تعذّر الاتصال." : "Could not connect.")),
        });
        return;
      }
    }

    setBusy(false);
    setOpen(false);
    onChanged();
  }

  const state = STATE_LABEL[summary.state];
  const doc = summary.document;

  // Drawn with the deal page's own section pattern (`.bh` heading, `.props` figures, plain rows),
  // not a card of its own: the panel sits inside the Direction 2.1 deal frame. What it shows and
  // when — the server's verdict, the reason when the action is withheld — is unchanged.
  const stTone = summary.state === "FULLY_COLLECTED" ? "ok" : summary.state === "PARTIALLY_COLLECTED" ? "wa" : "er";
  const showReason = !action.available && action.reason !== "NOTHING_OUTSTANDING" && !!UNAVAILABLE[action.reason];

  return (
    <section id="collections" className="scroll-mt-24" aria-labelledby="collections-title">
      <div className="bh">
        <h2 className="bt" id="collections-title">{ar ? "التحصيل" : "Collections"}</h2>
        {doc && (
          <span className="sub">
            <span className={`st ${stTone}`} data-testid="collection-state">{ar ? state.ar : state.en}</span>
            {" · "}{ar ? "مقابل " : "against "}<bdi className="id" dir="ltr">{doc.quoteNumber}</bdi>
          </span>
        )}
      </div>
      {/* D19 (owner, 10 Nov 2026: «خل زر تسجيل تحصيل اوضح للموظف عشان ما يتوه»): what is still owed, big, and one
          clear button — full width on a phone, beside the heading on a desktop (collections.css). */}
      {doc && (
        <div className="col-top">
          <div className="col-owed" data-testid="collection-owed">
            <span className="k">{ar ? "المتبقي على العميل" : "Still owed by the customer"}</span>
            <b className="v"><Money value={summary.unpaidGross} currency={doc.currency} strong /></b>
            {Number(summary.pendingGross) > 0 ? <span className="s">{ar ? "منها " : "of which "}<Money value={summary.pendingGross} currency={doc.currency} />{ar ? " بانتظار التحقق" : " awaiting verification"}</span> : null}
          </div>
          {!action.available && heldOrder && payable.length === 0 && heldOrder.needsRep === false
            // Nothing left to record on the deal (the rest is recorded and waits): say so — the button is not there.
            ? <span className="col-record" style={{ opacity: 0.75, cursor: "default" }} data-testid="record-collection-waiting">{ar ? "بانتظار اعتماد المحاسب للباقي" : "Waiting for the accountant to approve the rest"}</span>
            : null}
          {action.available && (heldOrder && payable.length === 0
            // The held order's money goes through «سجّل الباقي» on the order — the button takes the rep there; while it
            // waits for the accountant (F2) there is nothing to press.
            ? heldOrder.needsRep === false
              ? <span className="col-record" style={{ opacity: 0.75, cursor: "default" }} data-testid="record-collection-waiting">{ar ? "بانتظار اعتماد المحاسب للباقي" : "Waiting for the accountant to approve the rest"}</span>
              : <Link className="col-record" href={`/dashboard/orders?order=${encodeURIComponent(heldOrder.id)}`} data-testid="record-collection-held">
                  <Plus size={18} aria-hidden />{heldOrder.short || heldOrder.needsRep === undefined ? (ar ? `سجّل الباقي من الطلب #${heldOrder.orderNumber}` : `Record the rest from order #${heldOrder.orderNumber}`) : (ar ? `افتح الطلب #${heldOrder.orderNumber}` : `Open order #${heldOrder.orderNumber}`)}
                </Link>
            : <button type="button" className="col-record" onClick={start} data-testid="record-collection">
                <Plus size={18} aria-hidden />{ar ? "سجّل تحصيل من العميل" : "Record a payment from the customer"}
              </button>
          )}
        </div>
      )}
      {heldOrder ? (
        <p className="notice" data-testid="collection-held-banner" style={{ marginBottom: 12 }}>
          {heldOrder.needsRep === false
            ? (ar ? "فيه طلب موقوف بانتظار اعتماد المحاسب للمبلغ — ما عليك شي الحين. " : "An order is held until the accountant approves its money — nothing for you now. ")
            : (ar ? "فيه طلب موقوف بانتظار المبلغ — سجّل الباقي من الطلب. " : "An order is held for its money — record the rest from the order. ")}
          <Link href={`/dashboard/orders?order=${encodeURIComponent(heldOrder.id)}`} data-testid="collection-held-link">{ar ? `افتح الطلب #${heldOrder.orderNumber}` : `Open order #${heldOrder.orderNumber}`}</Link>
        </p>
      ) : null}

      {/* Why the button is not there, whenever the person can act on the reason (NOTHING_OUTSTANDING
          is excluded: the state already says the deal is fully collected). */}
      {showReason && (
        <p className="notice" data-testid="collection-unavailable" data-reason={action.reason} style={{ marginBottom: 12 }}>
          {ar ? UNAVAILABLE[action.reason].ar : UNAVAILABLE[action.reason].en}
        </p>
      )}

      {!doc ? (
        !showReason && (
          <p className="lbl" style={{ fontWeight: 400 }}>
            {ar
              ? "لا يوجد عرض سعر مقبول بعد، فلا شيء يُحصَّل مقابله."
              : "No accepted quotation yet, so there is nothing to collect against."}
          </p>
        )
      ) : (
        <>
          <dl className="props" style={{ gridTemplateColumns: "180px minmax(0,1fr)", marginBottom: 14 }}>
            {[
              [ar ? "قيمة العرض المقبول" : "Accepted quotation", doc.gross, null],
              [ar ? "محصَّل ومعتمَد" : "Approved", summary.approvedGross, financeView ? (ar ? `الأساس الصافي ${moneyText(summary.approvedNet ?? "0", doc.currency, lang)}` : `net basis ${moneyText(summary.approvedNet ?? "0", doc.currency, lang)}`) : null],
              [ar ? "بانتظار التحقق" : "Awaiting verification", summary.pendingGross, financeView ? (ar ? "لم يُنشئ عمولة" : "no commission yet") : (Number(summary.pendingGross) > 0 ? (ar ? "بانتظار المحاسب يعتمد" : "waiting for the accountant to approve") : null)],
              // D19: the unpaid balance is the big figure above; the capacity («المتاح») is the form's ceiling.
            ].map(([k, v, hint]) => (
              <div key={k as string} style={{ display: "contents" }}>
                <dt>{k as string}</dt>
                <dd>
                  <Money value={v as string} currency={doc.currency} />
                  {hint && <span style={{ color: "var(--text-muted)", fontSize: 12.5 }}> · {hint as string}</span>}
                </dd>
              </div>
            ))}
          </dl>

          {rows.length === 0 ? (
            <p className="lbl" style={{ fontWeight: 400 }}>{ar ? "لم يُسجَّل أي تحصيل بعد." : "Nothing recorded yet."}</p>
          ) : (
            <ul data-testid="collection-history" style={{ listStyle: "none", margin: 0, padding: 0, borderTop: "1px solid var(--border-strong)" }}>
              {rows.map((r) => {
                const accruals = r.collectionEvent?.accruals ?? [];
                return (
                  <li key={r.id} style={{ padding: "10px 0", borderBottom: "1px solid var(--border-subtle)", fontSize: 13.5 }}>
                    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: 12 }}>
                      <span>
                        {r.status === "REJECTED" && r.decisionReasonCode === "RETURN_FOR_CORRECTION"
                          ? <>{ar ? "رجع لك" : "Back to you"} · <Link href="/dashboard/sales/collections" data-testid={`deal-collection-fix-${r.id}`}>{ar ? "صحّحه" : "Fix it"}</Link></>
                          : label(STATUS_LABEL, r.status)}
                        <span style={{ color: "var(--text-muted)" }}>
                          {" · "}{label(METHOD_LABEL, r.paymentMethod)}{" · "}<Num>{formatDay(r.collectedAt)}</Num>
                        </span>
                      </span>
                      <span style={{ marginInlineStart: "auto" }}><Money value={r.amountGross} currency={r.currency} /></span>
                    </div>
                    <div style={{ color: "var(--text-muted)", fontSize: 12.5 }}>
                      {[
                        r.submittedBy ? `${ar ? "سجّله" : "recorded by"} ${r.submittedBy.name}` : null,
                        r.decidedBy ? `${ar ? "قرّره" : "decided by"} ${r.decidedBy.name}` : null,
                        r.referenceNumber ? `${ar ? "مرجع" : "ref"} ${r.referenceNumber}` : null,
                      ].filter(Boolean).join(" · ")}
                    </div>
                    {(r.decisionReason || r.reversalReason) && (
                      <div className="diff">{r.reversalReason ?? r.decisionReason}</div>
                    )}
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 4, fontSize: 12.5 }}>
                      {/* The commission each approved collection produced, named per person. */}
                      {r.status === "PENDING_VERIFICATION" ? (
                        <span style={{ color: "var(--text-muted)" }} data-testid={`collection-wait-${r.id}`}>
                          {financeView ? (ar ? "العمولة بانتظار الاعتماد المالي" : "commission pending finance approval") : (ar ? "بانتظار المحاسب يعتمد" : "Waiting for the accountant to approve")}
                        </span>
                      ) : accruals.length > 0 ? (
                        accruals.map((a, i) => (
                          <span key={i} style={{ color: "var(--text-secondary)" }}>
                            {ar ? "عمولة" : "commission"} <Money value={a.amount} currency={r.currency} />{" · "}{a.employee.name}
                          </span>
                        ))
                      ) : null}
                      {r._count.evidence === 0 && r.paymentMethod === "BANK_TRANSFER" ? (
                        <span className="col-noreceipt" data-testid={`collection-no-receipt-${r.id}`}>{ar ? "بدون إيصال" : "No receipt"}</span>
                      ) : null}
                      {r._count.evidence > 0 && (
                        <Link href={`/api/sales/collections/${r.id}/evidence`} style={{ color: "var(--action-primary)", display: "inline-flex", alignItems: "center", gap: 4 }}>
                          <Paperclip size={12} aria-hidden /> <Num>{num(r._count.evidence, lang)}</Num>
                        </Link>
                      )}
                    </div>
                    {laterMsg && laterMsg.id === r.id ? (
                      <p className={laterMsg.ok ? "col-later-ok" : "col-later-err"} role={laterMsg.ok ? "status" : "alert"} data-testid={`collection-attach-msg-${r.id}`}>{laterMsg.text}</p>
                    ) : null}
                    {r.status === "PENDING_VERIFICATION" && r._count.evidence === 0 && me && r.submittedBy?.id === me ? (
                      <button type="button" className="col-later" disabled={laterBusy === r.id}
                        onClick={() => { setLaterFor(r.id); laterInput.current?.click(); }} data-testid={`collection-attach-later-${r.id}`}>
                        <Camera size={15} aria-hidden /> {laterBusy === r.id ? (ar ? "يرفع…" : "Uploading…") : (ar ? "أرفق الإيصال" : "Attach the receipt")}
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}

          <input ref={laterInput} type="file" accept="image/*,application/pdf" capture="environment" hidden data-testid="collection-attach-later-input"
            onChange={(e) => { const picked = e.target.files?.[0]; e.target.value = ""; if (picked && laterFor) void attachLater(laterFor, picked); }} />
          {financeView ? (
            <p className="lbl" style={{ fontWeight: 400, marginTop: 10 }} data-testid="collection-finance-note">
              {ar
                ? "تحقّق مالي يدوي. لا يوجد ربط بنكي، ولا يُنشئ أي مبلغ عمولةً قبل اعتماده."
                : "Manual finance verification. There is no bank connection, and no amount creates commission before it is approved."}
            </p>
          ) : null}
        </>
      )}

      {open && doc && (() => {
        // D19 (owner-approved Figma 1988:2, D/E): the amount first and largest («كم استلمت؟», digits and commas only,
        // the riyal sign on its left), «المبلغ كامل»; the date and the method as buttons; the reference, the receipt
        // and the notes under «تفاصيل إضافية». The server's rules are unchanged (the same request, the same limits).
        const cap = Number(summary.availableToSubmitGross);
        const value = amountValue(amount);
        const over = value !== null && value > cap + 0.0001;
        const okAmount = value !== null && value > 0 && !over;
        const today = new Date().toISOString().slice(0, 10);
        const pickDate = (c: "today" | "yesterday" | "other") => {
          setDateChoice(c);
          if (c === "today") setCollectedAt(today);
          if (c === "yesterday") { const d = new Date(); d.setDate(d.getDate() - 1); setCollectedAt(d.toISOString().slice(0, 10)); }
        };
        return (
        <Modal
          title={ar ? "تسجيل تحصيل" : "Record a collection"}
          onClose={() => setOpen(false)}
          testId="collection-dialog"
          wide
          footer={
            <div className="col-foot">
              <Button disabled={busy || !okAmount || !collectedAt || (pickOrder && !orderChoice)} onClick={submit} testId="confirm-collection">
                {busy ? "…" : (ar ? "سجّل التحصيل" : "Record the collection")}
              </Button>
              <Button variant="secondary" onClick={() => setOpen(false)}>{ar ? "إلغاء" : "Cancel"}</Button>
            </div>
          }
        >
          {error && (
            <p className="mb-3 rounded-[10px] border border-oo-status-rejected bg-oo-status-rejected-bg px-3 py-[9px] text-[12px] leading-[18px] text-oo-status-rejected">
              {error}
            </p>
          )}
          {/* Which document this is against, named rather than implied: the one eligible quotation of the deal (the
              latest accepted revision) — a fact, not a choice. The ceiling is what may still be submitted. */}
          <div className="col-sum" data-testid="collection-against">
            <span><b>{ar ? "المتبقي " : "Remaining "}<Money value={summary.availableToSubmitGross} currency={doc.currency} strong /></b>
              {Number(summary.pendingGross) > 0 ? <small>{ar ? " · بعد خصم ما ينتظر التحقق" : " · after what awaits verification"}</small> : null}</span>
            <small>{ar ? "مقابل عرض " : "Against quotation "}<bdi dir="ltr"><Num>{doc.quoteNumber}</Num></bdi></small>
          </div>

          {pickOrder ? (
            <div className="col-field" data-testid="collection-order-pick" style={{ marginBottom: 12 }}>
              <label htmlFor="col-order" className="col-l">{ar ? "لأي طلب؟" : "For which order?"} <span className="req">*</span></label>
              <select id="col-order" className="hr-input" value={orderChoice} onChange={(e) => setOrderChoice(e.target.value)} data-testid="collection-order">
                {dealOrders.map((o) => (
                  <option key={o.id} value={o.id} disabled={o.held}>{o.held ? (ar ? `#${o.orderNumber} — موقوف، سجّل الباقي من الطلب` : `#${o.orderNumber} — held, record the rest from the order`) : `#${o.orderNumber}`}</option>
                ))}
              </select>
              {dealOrders.filter((o) => o.held).map((o) => (
                <p key={o.id} className="col-hint" data-testid={`collection-order-held-${o.orderNumber}`}>{ar ? `الطلب #${o.orderNumber} موقوف — ` : `Order #${o.orderNumber} is held — `}<Link href={`/dashboard/orders?order=${encodeURIComponent(o.id)}`}>{ar ? "سجّل الباقي من الطلب" : "record the rest from the order"}</Link></p>
              ))}
            </div>
          ) : null}

          <div className="col-grid">
            <div className="col-field">
              <label htmlFor="col-amount" className="col-l">{ar ? "كم استلمت؟ (شامل الضريبة)" : "How much did you receive? (incl. tax)"} <span className="req">*</span></label>
              <div className={`col-amount${over ? " bad" : ""}`} dir="ltr">
                <span className="col-cur" aria-hidden>{RIYAL}</span>
                <input id="col-amount" value={amount} onChange={(e) => { setPasteBad(false); if (hasMinusSign(e.target.value)) { setMinusBad(true); return; } setMinusBad(false); setAmount(cleanAmount(e.target.value)); }} inputMode="decimal" autoComplete="off"
                  onPaste={(e) => {
                    // A paste is taken only when it is one clean figure; otherwise it is refused and the field kept (gate L2).
                    e.preventDefault();
                    const got = parsePastedAmount(e.clipboardData.getData("text"));
                    if (got === null) { setPasteBad(true); return; }
                    const el = e.currentTarget;
                    const a = el.selectionStart ?? amount.length, z = el.selectionEnd ?? amount.length;
                    setPasteBad(false);
                    setAmount(cleanAmount(amount.slice(0, a) + got + amount.slice(z)));
                  }}
                  placeholder="0.00" aria-describedby="col-amount-hint" aria-invalid={over || undefined} />
              </div>
              <div className="col-quick">
                <button type="button" onClick={() => { setPasteBad(false); setMinusBad(false); setAmount(Number(summary.availableToSubmitGross).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })); }} data-testid="collection-full">
                  {ar ? "المبلغ كامل · " : "Full amount · "}<Money value={summary.availableToSubmitGross} currency={doc.currency} />
                </button>
              </div>
              {minusBad
                ? <p className="col-err" role="alert" data-testid="collection-minus">{ar ? "المبلغ ما يكون بالسالب — اكتب المبلغ اللي استلمته. الاسترجاع عند المحاسب." : "The amount can't be negative — type what you received. Refunds are the accountant's."}</p>
                : pasteBad
                ? <p className="col-err" role="alert" data-testid="collection-paste-bad">{ar ? "الصيغة غير صحيحة — الصق رقم فقط، مثل 1,500.50" : "Not a valid amount — paste a number only, e.g. 1,500.50"}</p>
                : over
                ? <p className="col-err" role="alert" data-testid="collection-over">{ar ? "أكثر من المتبقي (" : "More than what remains ("}<Money value={summary.availableToSubmitGross} currency={doc.currency} />{ar ? "). عدّل المبلغ." : "). Change the amount."}</p>
                : <p className="col-hint" id="col-amount-hint">{ar ? "أرقام وفواصل فقط — مثال 1,500.50. النظام يحسب الضريبة." : "Digits and commas only — e.g. 1,500.50. The tax is worked out by the system."}</p>}
            </div>
            <div className="col-field">
              <span className="col-l">{ar ? "متى استلمته؟" : "When did you receive it?"} <span className="req">*</span></span>
              <div className="col-chips" role="group" aria-label={ar ? "تاريخ التحصيل" : "Collection date"}>
                {(["today", "yesterday", "other"] as const).map((c) => (
                  <button key={c} type="button" aria-pressed={dateChoice === c} onClick={() => pickDate(c)} data-testid={`collection-date-${c}`}>
                    {c === "today" ? (ar ? "اليوم" : "Today") : c === "yesterday" ? (ar ? "أمس" : "Yesterday") : (ar ? "تاريخ ثاني" : "Another date")}
                  </button>
                ))}
              </div>
              {dateChoice === "other" ? <input id="col-date" type="date" className="col-input" value={collectedAt} max={today} onChange={(e) => setCollectedAt(e.target.value)} aria-label={ar ? "تاريخ التحصيل" : "Collection date"} /> : null}
            </div>
          </div>

          <div className="col-field">
            <span className="col-l">{ar ? "كيف دفع؟" : "How did they pay?"}</span>
            <div className="col-chips" role="radiogroup" aria-label={ar ? "طريقة الدفع" : "Payment method"}>
              {METHODS.map((m) => (
                <button key={m} type="button" role="radio" aria-checked={method === m} aria-pressed={method === m} onClick={() => setMethod(m)} data-testid={`collection-method-${m}`}>{label(METHOD_LABEL, m)}</button>
              ))}
            </div>
          </div>

          <details className="col-more">
            <summary>{ar ? "تفاصيل إضافية (اختياري)" : "More details (optional)"}</summary>
            <div className="col-grid">
              <Field id="col-ref" label={ar ? "رقم المرجع" : "Reference number"}>
                <TextInput id="col-ref" value={reference} onChange={setReference} placeholder={ar ? "مثال: رقم الحوالة" : "e.g. the transfer number"} />
              </Field>
              <Field
                id="col-file"
                label={ar ? "المرفق" : "Evidence"}
                hint={ar ? "PDF أو صورة، حتى 5 ميجابايت." : "PDF or an image, up to 5 MB."}
              >
                <label className={`${ROW_ACTION} w-full cursor-pointer justify-center gap-2 text-oo-text-secondary`}>
                  <Upload size={14} aria-hidden />
                  {file ? file.name : (ar ? "أرفق صورة الإيصال" : "Attach the receipt")}
                  <input
                    id="col-file"
                    type="file"
                    accept="application/pdf,image/jpeg,image/png"
                    className="sr-only"
                    onChange={(e) => void chooseFile(e.target.files?.[0] ?? null)}
                    data-testid="collection-file"
                  />
                </label>
                {fileErr ? <span className="col-later-err" role="alert" data-testid="collection-file-error">{fileErr}</span> : null}
              </Field>
            </div>
            <Field id="col-note" label={ar ? "ملاحظات" : "Notes"}>
              <TextArea id="col-note" value={note} onChange={setNote} rows={2} />
            </Field>
          </details>
        </Modal>
        );
      })()}
    </section>
  );
}
