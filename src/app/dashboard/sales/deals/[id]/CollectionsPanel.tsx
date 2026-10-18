"use client";

import { useState } from "react";
import Link from "next/link";
import { Paperclip, Upload } from "lucide-react";
import {
  Field, TextInput, TextArea, Select, Button, Modal,
  Money, Num, ROW_ACTION, api, formatDay, num, moneyText,
} from "../../_components/ui";

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
  amountNet: string;
  currency: string;
  paymentMethod: string;
  collectedAt: string;
  referenceNumber: string | null;
  submittedAt: string;
  decidedAt: string | null;
  decisionReason: string | null;
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
  approvedNet: string;
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
  dealId, ar, lang, summary, rows, action, onChanged,
}: {
  dealId: string;
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
  const [error, setError] = useState("");
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<string>("BANK_TRANSFER");
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [collectedAt, setCollectedAt] = useState(() => new Date().toISOString().slice(0, 10));
  const [file, setFile] = useState<File | null>(null);
  /**
   * One key per opened form, not per click.
   *
   * This is what makes a double-clicked Save one collection rather than two. Generated when
   * the dialog opens and reused for every attempt, so a retry after a network failure lands
   * on the same row the first attempt may already have created.
   */
  const [key, setKey] = useState("");

  const label = (m: Record<string, { en: string; ar: string }>, k: string) =>
    ar ? (m[k]?.ar ?? k) : (m[k]?.en ?? k);

  function start() {
    setAmount("");
    setReference("");
    setNote("");
    setFile(null);
    setError("");
    setCollectedAt(new Date().toISOString().slice(0, 10));
    setKey(`col-${dealId}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
    setOpen(true);
  }

  async function submit() {
    if (busy) return;
    setBusy(true);
    setError("");
    const res = await api<{ collectionId: string }>("/api/sales/collections", {
      method: "POST",
      body: {
        opportunityId: dealId,
        amountGross: amount.trim(),
        currency: summary.document?.currency ?? "SAR",
        collectedAt: new Date(collectedAt).toISOString(),
        paymentMethod: method,
        referenceNumber: reference.trim() || null,
        note: note.trim() || null,
        idempotencyKey: key,
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
      });
      if (!up.ok) {
        const data = await up.json().catch(() => ({}));
        setBusy(false);
        setOpen(false);
        onChanged();
        setError(
          (ar ? "سُجِّل التحصيل، لكن تعذّر رفع المرفق: " : "The collection was recorded, but the attachment failed: ") +
            (data.error ?? ""),
        );
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
        {action.available && (
          <button type="button" className="lk" onClick={start} data-testid="record-collection">
            + {ar ? "تسجيل تحصيل" : "Record a collection"}
          </button>
        )}
      </div>

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
              [ar ? "محصَّل ومعتمَد" : "Approved", summary.approvedGross, ar ? `الأساس الصافي ${moneyText(summary.approvedNet, doc.currency, lang)}` : `net basis ${moneyText(summary.approvedNet, doc.currency, lang)}`],
              [ar ? "بانتظار التحقق" : "Awaiting verification", summary.pendingGross, ar ? "لم يُنشئ عمولة" : "no commission yet"],
              // Two figures, not one. The debt ignores pending claims; the capacity does not.
              [ar ? "المتبقي غير المسدد" : "Unpaid balance", summary.unpaidGross, ar ? "قيمة العرض ناقص المعتمَد" : "quotation less approved"],
              [ar ? "المتاح لتسجيل تحصيل إضافي" : "Available to submit", summary.availableToSubmitGross, ar ? "غير المسدد ناقص ما هو بانتظار التحقق" : "unpaid less what is pending"],
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
                        {label(STATUS_LABEL, r.status)}
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
                        <span style={{ color: "var(--text-muted)" }}>
                          {ar ? "العمولة بانتظار الاعتماد المالي" : "commission pending finance approval"}
                        </span>
                      ) : accruals.length > 0 ? (
                        accruals.map((a, i) => (
                          <span key={i} style={{ color: "var(--text-secondary)" }}>
                            {ar ? "عمولة" : "commission"} <Money value={a.amount} currency={r.currency} />{" · "}{a.employee.name}
                          </span>
                        ))
                      ) : null}
                      {r._count.evidence > 0 && (
                        <Link href={`/api/sales/collections/${r.id}/evidence`} style={{ color: "var(--action-primary)", display: "inline-flex", alignItems: "center", gap: 4 }}>
                          <Paperclip size={12} aria-hidden /> <Num>{num(r._count.evidence, lang)}</Num>
                        </Link>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          <p className="lbl" style={{ fontWeight: 400, marginTop: 10 }}>
            {ar
              ? "تحقّق مالي يدوي. لا يوجد ربط بنكي، ولا يُنشئ أي مبلغ عمولةً قبل اعتماده."
              : "Manual finance verification. There is no bank connection, and no amount creates commission before it is approved."}
          </p>
        </>
      )}

      {open && doc && (
        <Modal
          title={ar ? "تسجيل تحصيل" : "Record a collection"}
          onClose={() => setOpen(false)}
          testId="collection-dialog"
          footer={
            <>
              <Button variant="secondary" onClick={() => setOpen(false)}>{ar ? "إلغاء" : "Cancel"}</Button>
              <Button disabled={busy || !amount.trim()} onClick={submit} testId="confirm-collection">
                {busy ? "…" : (ar ? "تسجيل" : "Record")}
              </Button>
            </>
          }
        >
          {error && (
            <p className="mb-3 rounded-[10px] border border-oo-status-rejected bg-oo-status-rejected-bg px-3 py-[9px] text-[12px] leading-[18px] text-oo-status-rejected">
              {error}
            </p>
          )}
          {/* Which document this is against, named rather than implied. There is exactly one
              eligible quotation per deal — the latest accepted revision — so it is shown as a
              fact, not offered as a choice: a picker here would be a way to pick the wrong
              one, and the server would refuse it anyway. */}
          <div
            className="mb-3 rounded-xl bg-oo-bg-subtle px-3.5 py-2.5"
            data-testid="collection-against"
          >
            <p className="text-[12px] leading-[18px] text-oo-text-secondary">
              {ar ? "مقابل عرض السعر المقبول " : "Against the accepted quotation "}
              <span className="font-medium text-oo-text-primary">
                <Num>{doc.quoteNumber}</Num>
              </span>
              {" · "}
              {ar ? "إجمالي " : "total "}
              <Money value={doc.gross} currency={doc.currency} />
            </p>
            {/* Inside the submission form this is the ceiling, so it is named as one. */}
            <p className="mt-0.5 text-[12px] leading-[18px] text-oo-text-secondary">
              {ar ? "المتاح لتسجيل تحصيل إضافي " : "Available to submit "}
              <span className="font-medium text-oo-text-primary">
                <Money value={summary.availableToSubmitGross} currency={doc.currency} />
              </span>
              {" · "}
              {ar ? "غير المسدد " : "unpaid "}
              <Money value={summary.unpaidGross} currency={doc.currency} />
            </p>
          </div>
          <p className="mb-3 text-[12px] leading-[18px] text-oo-text-muted">
            {ar
              ? "الضريبة والأساس الصافي يحسبهما النظام من عرض السعر المقبول — لا تُدخلهما."
              : "The tax and the net basis are derived by the server from the accepted quotation; you do not enter them."}
          </p>

          <div className="space-y-2">
            <Field id="col-amount" label={ar ? "المبلغ المستلم (شامل الضريبة)" : "Amount received (including tax)"} required>
              <TextInput id="col-amount" value={amount} onChange={setAmount} inputMode="decimal" />
            </Field>
            <Field id="col-date" label={ar ? "تاريخ التحصيل" : "Collection date"} required>
              <TextInput id="col-date" type="date" value={collectedAt} onChange={setCollectedAt} />
            </Field>
            <Field id="col-method" label={ar ? "طريقة الدفع" : "Payment method"}>
              <Select id="col-method" value={method} onChange={setMethod}>
                {METHODS.map((m) => (
                  <option key={m} value={m}>{label(METHOD_LABEL, m)}</option>
                ))}
              </Select>
            </Field>
            <Field id="col-ref" label={ar ? "رقم المرجع" : "Reference number"}>
              <TextInput id="col-ref" value={reference} onChange={setReference} />
            </Field>
            <Field
              id="col-file"
              label={ar ? "المرفق" : "Evidence"}
              hint={ar ? "PDF أو JPEG أو PNG، حتى 5 ميجابايت." : "PDF, JPEG or PNG, up to 5 MB."}
            >
              <label className={`${ROW_ACTION} w-full cursor-pointer justify-center gap-2 text-oo-text-secondary`}>
                <Upload size={14} aria-hidden />
                {file ? file.name : (ar ? "اختر ملفاً" : "Choose a file")}
                <input
                  id="col-file"
                  type="file"
                  accept="application/pdf,image/jpeg,image/png"
                  className="sr-only"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                />
              </label>
            </Field>
            <Field id="col-note" label={ar ? "ملاحظات" : "Notes"}>
              <TextArea id="col-note" value={note} onChange={setNote} rows={2} />
            </Field>
          </div>
        </Modal>
      )}
    </section>
  );
}
