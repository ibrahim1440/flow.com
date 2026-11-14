"use client";

import { OwnCustomerDialog, ownCustomerOf, type OwnCustomer } from "@/components/customers/own-customer-dialog";
import { displayPhone } from "@/lib/contact/phone";
import { localizeApiError } from "@/lib/i18n/api-errors";
import { useEffect, useRef, useState } from "react";
import { ResultConfirm } from "@/components/confirm/ResultConfirm";
import Link from "next/link";
import { LEAD_STATUS_SPECS, LEAD_SOURCE_LABELS, pick } from "../_components/ui";
import { Ico } from "@/components/shell/icons";
import { ACTIVITY_LABELS } from "@/components/d21/labels";
import { dueText, shortDate, daysFromToday } from "@/components/d21/format";

/**
 * The lead preview of `crm-leads` (1440 `171:2` docked beside the list, 1024 `172:314` over
 * it): the lead's name and status, the next commitment, its particulars, its history, and the
 * two actions of the frame's footer. Everything here exists on the lead's own page; the pane
 * reads the same record (`GET /api/sales/leads/:id`) and converts through the same endpoint.
 */

type Activity = {
  id: string; type: string; subject: string; body: string | null; dueAt: string | null; completedAt: string | null;
  outcome?: string | null; createdAt: string; owner: { id: string; name: string } | null;
};
type Lead = {
  id: string; companyName: string; companyNameAr: string | null; contactName: string; phone: string | null;
  email: string | null; city: string | null; source: string; sourceNote: string | null; status: string;
  nextFollowUpAt: string | null; createdAt: string; owner: { id: string; name: string } | null;
  conversion: { opportunityId: string } | null; activities: Activity[];
};

// The lead page's own wording for each outcome.
const OUTCOME_LABELS: Record<string, { en: string; ar: string }> = {
  NO_ANSWER: { en: "No answer", ar: "لا رد" },
  LEFT_MESSAGE: { en: "Left a message", ar: "تُركت رسالة" },
  INTERESTED: { en: "Spoke — interested", ar: "تواصل ناجح — مهتم" },
  MEETING_SCHEDULED: { en: "Meeting scheduled", ar: "حُدِّد موعد اجتماع مع العميل" },
  VISIT_SCHEDULED: { en: "Visit scheduled", ar: "حُدِّد موعد زيارة للعميل" },
  MEETING_COMPLETED: { en: "Meeting held", ar: "تم الاجتماع" },
  VISIT_COMPLETED: { en: "Visit made", ar: "تمت الزيارة" },
  FOLLOW_UP_REQUIRED: { en: "Needs a follow-up", ar: "يحتاج متابعة" },
  NOT_INTERESTED: { en: "Not interested", ar: "غير مهتم" },
  NOTE_ONLY: { en: "Note / internal task", ar: "ملاحظة أو مهمة داخلية" },
};
const LEAD_ST: Record<string, string> = { NEW: "in", QUALIFIED: "ok", CONVERTED: "ok", UNQUALIFIED: "x" };

export function LeadPane({
  id, lang, canConvert, canWrite, onClose, onChanged,
}: {
  id: string; lang: "ar" | "en"; canConvert: boolean; canWrite: boolean;
  onClose: () => void; onChanged: (message: string) => void;
}) {
  const ar = lang === "ar";
  const [lead, setLead] = useState<Lead | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ownDup, setOwnDup] = useState<OwnCustomer | null>(null);
  const [askConvert, setAskConvert] = useState(false); // P2 ب3: name the result before converting
  const [error, setError] = useState("");
  const [token, setToken] = useState(0);
  const head = useRef<HTMLHeadingElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch(`/api/sales/leads/${id}`).catch(() => null);
      if (cancelled) return;
      if (res?.ok) { const j = await res.json(); setLead(j.lead); setFailed(false); }
      else setFailed(true);
    })();
    return () => { cancelled = true; };
  }, [id, token]);

  // Escape closes the preview, as it does every overlay in the shell.
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape" && !document.querySelector("[role=dialog]")) onClose(); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);
  useEffect(() => { if (lead) head.current?.focus(); }, [lead?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function convert(linkToCustomerId?: string) {
    if (busy || !lead) return;
    setAskConvert(false);
    setBusy(true); setError("");
    try {
      const res = await fetch(`/api/sales/leads/${lead.id}/convert`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(linkToCustomerId ? { linkToCustomerId } : {}),
      });
      const data = await res.json().catch(() => ({}));
      // P1 ERR-08: the rep's own customer matches — open it or link the lead to it (Figma 2033:83).
      if (!res.ok && ownCustomerOf(data)) { setOwnDup(ownCustomerOf(data)); return; }
      setOwnDup(null);
      if (!res.ok) { setError(localizeApiError(data) ?? (ar ? "تعذّر التحويل." : "Could not convert.")); return; }
      onChanged(data.replayed
        ? (ar ? "هذا العميل المحتمل محوَّل مسبقاً." : "This lead was already converted.")
        : (ar ? "تم التحويل إلى عميل وصفقة." : "Converted to a customer and a deal."));
      setToken((t) => t + 1);
    } finally { setBusy(false); }
  }

  const name = lead ? (ar && lead.companyNameAr ? lead.companyNameAr : lead.companyName) : "";
  const ownDupDialog = ownDup ? <OwnCustomerDialog ar={ar} customer={ownDup} onLink={() => convert(ownDup.id)} onClose={() => setOwnDup(null)} /> : null;
  const when = (v: string) => (Math.abs(daysFromToday(v)) <= 1 ? dueText(v, lang) : shortDate(v, lang));
  // The next commitment: the soonest open activity, else the lead's own follow-up date.
  const open = (lead?.activities ?? []).filter((a) => !a.completedAt && a.dueAt)
    .sort((a, b) => new Date(a.dueAt!).getTime() - new Date(b.dueAt!).getTime())[0];
  // The history as the frame writes it: «مكالمة · يحتاج متابعة» over «1 أكتوبر · <note>».
  const history = (lead?.activities ?? []).map((a) => {
    const type = pick(ACTIVITY_LABELS, a.type, lang);
    const done = !!a.completedAt;
    const title = a.outcome ? `${type} · ${pick(OUTCOME_LABELS, a.outcome, lang)}` : done ? type : a.subject;
    const note = a.outcome || done ? [a.subject, a.body].filter(Boolean).join(" ") : a.owner?.name ?? "";
    const at = done ? a.completedAt! : (a.dueAt ?? a.createdAt);
    return { key: a.id, title, sub: [when(at), note].filter(Boolean).join(" · "), planned: !done };
  });
  const convertible = lead && !lead.conversion && lead.status !== "UNQUALIFIED" && canConvert;

  return (
    <aside className="pane" aria-label={ar ? "معاينة العميل المحتمل" : "Lead preview"} data-testid="lead-pane">
      <div className="pane-h">
        <span className="lbl">{ar ? "عميل محتمل" : "Lead"}</span>
        <span className="sp" />
        <Link href={`/dashboard/sales/leads/${id}`} className="lk" data-testid="open-lead-page">
          {ar ? "فتح الصفحة" : "Open page"} <Ico name="back" small className="fwd" />
        </Link>
        <button type="button" className="ib" onClick={onClose} aria-label={ar ? "إغلاق المعاينة" : "Close preview"} data-testid="close-lead-pane">
          <Ico name="close" small />
        </button>
      </div>
      <div className="pane-b">
        {failed ? (
          <p className="notice er" role="alert">{ar ? "تعذّر تحميل العميل المحتمل." : "Could not load the lead."}</p>
        ) : !lead ? (
          <p className="lbl" role="status" style={{ fontWeight: 400 }}>{ar ? "جارٍ التحميل…" : "Loading…"}</p>
        ) : (
          <>
            <h2 ref={head} tabIndex={-1} className="pane-t">{name}</h2>
            <div className="meta" style={{ marginTop: 0, marginBottom: 20 }}>
              <span className={`st ${LEAD_ST[lead.status] ?? ""}`}>{pick(LEAD_STATUS_SPECS, lead.status, lang)}</span>
              {lead.city && <><i aria-hidden /><span>{lead.city}</span></>}
            </div>
            {error && <p className="notice er" role="alert" style={{ marginBottom: 12 }}>{error}</p>}
            {(open || lead.nextFollowUpAt) && (
              <div className="callout" style={{ marginBottom: 24 }}>
                <Ico name="cal" small />
                <span>
                  <b style={{ fontWeight: 600 }}>{ar ? "الالتزام القادم:" : "Next commitment:"}</b>{" "}
                  {open ? <><bdi>{open.subject}</bdi> · {when(open.dueAt!)}</> : when(lead.nextFollowUpAt!)}
                </span>
              </div>
            )}
            <dl className="props" style={{ marginBottom: 24 }}>
              <dt>{ar ? "جهة الاتصال" : "Contact"}</dt><dd>{lead.contactName}</dd>
              {lead.phone && <><dt>{ar ? "الهاتف" : "Phone"}</dt><dd><bdi dir="ltr" className="n">{displayPhone(lead.phone)}</bdi></dd></>}
              <dt>{ar ? "المصدر" : "Source"}</dt>
              <dd>{pick(LEAD_SOURCE_LABELS, lead.source, lang)}{lead.sourceNote && <> · <bdi>{lead.sourceNote}</bdi></>}</dd>
              <dt>{ar ? "المالك" : "Owner"}</dt><dd>{lead.owner?.name ?? (ar ? "غير مُسنَد" : "Unassigned")}</dd>
            </dl>
            <div className="lbl" style={{ marginBottom: 12 }}>{ar ? "السجل" : "History"}</div>
            <ol className="tl" style={{ fontSize: 13.5 }}>
              {history.map((h, i) => (
                <li key={h.key}>
                  <span className={`m${i === 0 ? " b" : ""}`} />
                  <bdi>{h.title}</bdi>
                  <div className="when">{h.sub}</div>
                </li>
              ))}
              <li>
                <span className={`m${history.length === 0 ? " b" : ""}`} />
                {ar ? "أُضيف العميل المحتمل" : "Lead added"} · {pick(LEAD_SOURCE_LABELS, lead.source, lang)}
                <div className="when">{[shortDate(lead.createdAt, lang), lead.sourceNote].filter(Boolean).join(" · ")}</div>
              </li>
            </ol>
            <p className="sm" style={{ marginTop: 4, lineHeight: "20px" }}>
              {ar
                ? "تسجيل نتيجة «تمت الزيارة» أو «تم الاجتماع» أو «مهتم» يحوّله تلقائيًا إلى عميل وصفقة في مرحلة التأهيل."
                : "Logging “Visited”, “Met” or “Interested” converts it automatically into a customer and a deal in the Qualification stage."}
            </p>
          </>
        )}
      </div>
      {lead && (convertible || canWrite) && (
        <div className="pane-f">
          {ownDupDialog}
          {askConvert ? <ConvertConfirm ar={ar} name={name} busy={busy} onConfirm={() => void convert()} onClose={() => setAskConvert(false)} /> : null}
          {convertible && (
            <button type="button" className="btn p" onClick={() => setAskConvert(true)} disabled={busy} aria-busy={busy || undefined} data-testid="convert-lead">
              {busy ? (ar ? "جارٍ التحويل…" : "Converting…") : (ar ? "حوّله لفرصة" : "Convert to customer")}
            </button>
          )}
          {/* The activity form lives on the lead's page; this takes you to it. */}
          {canWrite && (
            <Link href={`/dashboard/sales/leads/${id}`} className="btn">{ar ? "تسجيل نشاط" : "Log activity"}</Link>
          )}
        </div>
      )}
    </aside>
  );
}

/** P2 ب3 (Figma 8أ): «حوّله لفرصة» says what it creates before it does. */
export function ConvertConfirm({ ar, name, busy, onConfirm, onClose }: { ar: boolean; name: string; busy?: boolean; onConfirm: () => void; onClose: () => void }) {
  return (
    <ResultConfirm ar={ar} testId="convert-confirm" busy={busy} onConfirm={onConfirm} onClose={onClose}
      title={ar ? <>تحوّل «<bdi>{name}</bdi>» لفرصة؟</> : <>Make «<bdi>{name}</bdi>» a deal?</>}
      body={ar ? "بينشأ عميل جديد وصفقة باسمك، والعميل المحتمل يتقفل." : "A new customer and a deal are created in your name, and the lead is closed."}
      confirmLabel={ar ? "حوّله" : "Convert"} />
  );
}
