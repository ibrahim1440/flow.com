"use client";

// «طلب فاتورة ضريبية» (BATCH 22 WP-C) — the request workflow's shared pieces:
//   SplitButton    the Q-F2 split button: one primary act, a ▾ menu of the same act chained to a navigation (print / PDF)
//                  or the plain draft save; no menu item does anything the primary cannot;
//   IssueConfirm   «حفظ وإصدار» / «مراجعة وإصدار»'s confirm dialog (the council ruling): customer + VAT number, the type with
//                  its ZATCA path, totals and VAT per category, the series, «الإصدار نهائي؛ التصحيح بإشعار دائن فقط» and the
//                  required «راجعت البيانات»;
//   ReturnDialog   «إعادة إلى المبيعات» (Q-F3): a reason code and at least 10 characters;
//   RequestHistory the append-only history (who, what, when, why).
import { useEffect, useRef, useState, type ReactNode } from "react";
import { D21Dialog } from "@/components/ui/Dialog";
import { Select } from "@/components/ui/Select";
import { RETURN_REASONS, RETURN_REASON_LABEL, RETURN_REASON_MIN, type ReturnReason } from "@/lib/services/invoicing/request-math";
import { CATEGORY, money, useLang } from "./inv";

export type MenuItem = { id: string; label: string; onSelect: () => void; testId?: string };

export function SplitButton({ label, onPrimary, items, disabled, testId, hint }: { label: string; onPrimary: () => void; items: MenuItem[]; disabled?: boolean; testId: string; hint?: string }) {
  const { L } = useLang();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => { window.removeEventListener("mousedown", close); window.removeEventListener("keydown", esc); };
  }, [open]);
  return (
    <span className="inv-split" ref={box} data-testid={testId}>
      <button type="button" className="hr-btn is-primary inv-split-main" disabled={disabled} onClick={onPrimary} data-testid={`${testId}-primary`} title={hint}>{label}</button>
      {items.length ? (
        <button type="button" className="hr-btn is-primary inv-split-caret" disabled={disabled} aria-haspopup="menu" aria-expanded={open}
          aria-label={L("خيارات الحفظ الأخرى", "More save options")} onClick={() => setOpen((v) => !v)} data-testid={`${testId}-more`}>▾</button>
      ) : null}
      {open ? (
        <span className="inv-split-menu" role="menu">
          {items.map((it) => (
            <button key={it.id} type="button" role="menuitem" onClick={() => { setOpen(false); it.onSelect(); }} data-testid={it.testId ?? `${testId}-${it.id}`}>{it.label}</button>
          ))}
        </span>
      ) : null}
    </span>
  );
}

export type ConfirmFacts = {
  customer: string; vatNumber: string | null; family: "STANDARD" | "SIMPLIFIED"; kind?: string;
  taxable: string; tax: string; grand: string; breakdown: { category: string; rate: string; taxable: string; tax: string }[];
  series: string | null; credit?: { overLimit: boolean; overdueDays: number; hold: unknown } | null;
};

export function IssueConfirm({ facts, onConfirm, onClose, busy, title }: { facts: ConfirmFacts; onConfirm: () => void; onClose: () => void; busy?: boolean; title?: string }) {
  const { L, lang } = useLang();
  const [checked, setChecked] = useState(false);
  const standard = facts.family === "STANDARD";
  const note = facts.kind && facts.kind !== "INVOICE";
  return (
    <D21Dialog lang={lang === "en" ? "en" : "ar"} width={520} title={title ?? (note ? L("إصدار الإشعار", "Issue the note") : L("إصدار الفاتورة الضريبية", "Issue the tax invoice"))} onClose={onClose} testId="issue-dialog"
      actions={<>
        <button type="button" className="hr-btn is-primary" disabled={!checked || busy} onClick={onConfirm} data-testid="confirm-issue">{L("إصدار نهائي", "Issue (final)")}</button>
        <button type="button" className="hr-btn" onClick={onClose}>{L("رجوع", "Back")}</button>
      </>}>
      <dl className="acct-kv-grid inv-confirm" data-testid="issue-confirm-facts">
        <div><dt>{L("العميل", "Customer")}</dt><dd><bdi>{facts.customer}</bdi></dd></div>
        <div><dt>{L("الرقم الضريبي", "VAT number")}</dt><dd className="acct-code"><bdi dir="ltr">{facts.vatNumber || "—"}</bdi></dd></div>
        <div className="inv-confirm-wide"><dt>{L("النوع ومسار الهيئة", "Type and ZATCA path")}</dt>
          <dd data-testid="issue-confirm-path">{standard ? L("فاتورة ضريبية ← اعتماد (Clearance)", "Tax invoice → clearance") : L("مبسطة ← إبلاغ خلال 24 ساعة", "Simplified → reported within 24 hours")}</dd></div>
        <div><dt>{L("الإجمالي قبل الضريبة", "Total before VAT")}</dt><dd className="hr-num">{money(facts.taxable)}</dd></div>
        {facts.breakdown.map((b) => (
          <div key={`${b.category}${b.rate}`}><dt>{b.category === "S" ? L(`ضريبة ${Number(b.rate)}%`, `VAT ${Number(b.rate)}%`) : L(CATEGORY[b.category]?.[0] ?? b.category, CATEGORY[b.category]?.[1] ?? b.category)}</dt><dd className="hr-num">{money(b.tax)}</dd></div>
        ))}
        <div><dt>{L("الإجمالي شامل الضريبة · ر.س", "Total incl. VAT · SAR")}</dt><dd className="hr-num" data-testid="issue-confirm-grand"><b>{money(facts.grand)}</b></dd></div>
      </dl>
      {facts.credit ? (
        <p className="inv-chip is-warn" data-testid="issue-confirm-credit">
          {facts.credit.hold ? L("العميل موقوف عن البيع؛ الإصدار لا يتوقف على الائتمان (التوريد تم).", "The customer is on a sales hold; issue never blocks on credit (the supply happened).")
            : facts.credit.overLimit ? L("العميل تجاوز حد الائتمان.", "The customer is over the credit limit.")
              : L(`على العميل مستحقات متأخرة ${facts.credit.overdueDays} يومًا.`, `The customer has items ${facts.credit.overdueDays} days overdue.`)}
        </p>
      ) : null}
      <p className="acct-hint" data-testid="issue-confirm-series">{facts.series ? L(`سيُعطى الرقم التالي في سلسلة ${facts.series}`, `It takes the next number of the ${facts.series} series`) : L("سيُعطى الرقم التالي في السلسلة", "It takes the next number of the series")}</p>
      <p><b>{L("الإصدار نهائي؛ التصحيح بإشعار دائن فقط.", "Issue is final; a correction is a credit note only.")}</b></p>
      <label className="inv-check-row"><input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} data-testid="confirm-reviewed" /> {L("راجعت البيانات", "I have reviewed the data")}</label>
    </D21Dialog>
  );
}

export function ReturnDialog({ onSubmit, onClose, busy }: { onSubmit: (code: ReturnReason, reason: string) => void; onClose: () => void; busy?: boolean }) {
  const { L, lang } = useLang();
  const [code, setCode] = useState<ReturnReason>("PRICE");
  const [reason, setReason] = useState("");
  const ok = reason.trim().length >= RETURN_REASON_MIN;
  return (
    <D21Dialog lang={lang === "en" ? "en" : "ar"} title={L("إعادة إلى المبيعات", "Send back to Sales")} onClose={onClose} testId="return-dialog"
      actions={<>
        <button type="button" className="hr-btn is-primary" disabled={!ok || busy} onClick={() => onSubmit(code, reason.trim())} data-testid="confirm-return">{L("إعادة الطلب", "Send back")}</button>
        <button type="button" className="hr-btn" onClick={onClose}>{L("رجوع", "Back")}</button>
      </>}>
      <p className="acct-hint">{L("السعر والكمية والخصم والبنود والعميل شروط تجارية تصححها المبيعات؛ يظهر السبب لهم على المسودة.", "Price, quantity, discount, lines and the customer are commercial terms Sales corrects; they see the reason on the draft.")}</p>
      <label className="hr-field"><span className="hr-label">{L("السبب", "Reason")}</span>
        <Select value={code} onChange={(e) => setCode(e.target.value as ReturnReason)} data-testid="return-code">
          {RETURN_REASONS.map((r) => <option key={r} value={r}>{L(RETURN_REASON_LABEL[r][0], RETURN_REASON_LABEL[r][1])}</option>)}
        </Select></label>
      <label className="hr-field"><span className="hr-label">{L("التوضيح (10 أحرف على الأقل)", "Explanation (at least 10 characters)")}</span>
        <textarea className="hr-input" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} data-testid="return-reason" /></label>
    </D21Dialog>
  );
}

export type HistoryRow = { id: string; kind: string; actorName: string | null; reasonCode: string | null; reason: string | null; at: string; diff?: unknown };
const KIND_LABEL: Record<string, [string, string]> = {
  REQUESTED: ["أُرسل الطلب للمحاسب", "Sent to the accountant"], WITHDRAWN: ["سُحب الطلب", "Request withdrawn"], RETURNED: ["أُعيد إلى المبيعات", "Sent back to Sales"],
  EDITED_BY_ACCOUNTANT: ["صحّح المحاسب بيانات الامتثال", "Accountant corrected compliance data"], ISSUED: ["صدرت الفاتورة", "Issued"], CANCELLED: ["أُلغيت المسودة", "Draft cancelled"],
};

export function RequestHistory({ rows }: { rows: HistoryRow[] }) {
  const { L } = useLang();
  if (!rows.length) return null;
  return (
    <div className="acct-card" data-testid="request-history">
      <h3>{L("سجل الطلب", "Request history")}</h3>
      <ul className="ops-list">{rows.map((r) => (
        <li key={r.id}><span>{L(KIND_LABEL[r.kind]?.[0] ?? r.kind, KIND_LABEL[r.kind]?.[1] ?? r.kind)}{r.actorName ? <> · <bdi>{r.actorName}</bdi></> : null}
          {r.reasonCode ? <> · {L(RETURN_REASON_LABEL[r.reasonCode as ReturnReason]?.[0] ?? r.reasonCode, RETURN_REASON_LABEL[r.reasonCode as ReturnReason]?.[1] ?? r.reasonCode)}</> : null}
          {r.reason ? <> — <bdi>{r.reason}</bdi></> : null}</span>
          <span className="hr-num">{fmtAt(r.at)}</span></li>
      ))}</ul>
    </div>
  );
}

/** A Riyadh date and time (UTC+3), shown with its zone. */
export function fmtAt(iso: string): string {
  const d = new Date(new Date(iso).getTime() + 3 * 3600_000).toISOString();
  return `${d.slice(0, 10)} ${d.slice(11, 16)} (AST)`;
}

export function Banner({ tone, children, testId }: { tone: "warning" | "info"; children: ReactNode; testId?: string }) {
  return <div className={`inv-banner is-${tone}`} role="status" data-testid={testId}>{children}</div>;
}
