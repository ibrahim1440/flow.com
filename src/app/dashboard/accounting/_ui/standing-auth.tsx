"use client";

// «التفويض الدائم» — the scheduler's standing authorisation of one register-wide monthly run (batch 22 WP-A): deferral
// recognition on «قوالب التأجيل», depreciation on «الإهلاك». Shows who authorised it and since when (or that the scheduler
// does not post it — person-run from «تشغيل المستحق الآن»), the last revocation (a lapse of the authoriser's rights says
// so), and the act the viewer may take: grant (the register's sub + journal_post, a step-up at the server), or revoke
// with a reason (the register's sub). No 403-only button: without journal_post the card says what is needed.
import { useState } from "react";
import { Btn, Field } from "@/components/ops/ui";
import { Dialog } from "@/components/hr/ui";
import { Msg, useApi, useLang, useWrite } from "./shell";

type Register = "DEFERRAL_RECOGNITION" | "DEPRECIATION";
type Row = { id: string; register: Register; authorisedBy: string; authorisedAt: string; sodBypass: boolean; revokedAt: string | null; revokedBy: string | null; revokeReason: string | null; lapsed: boolean };
type Data = {
  live: Record<Register, Row | null>; history: Row[]; names: Record<string, string>;
  can: Record<Register, { grant: boolean; revoke: boolean; needsPost: boolean }>;
};

const WHAT: Record<Register, [string, string]> = {
  DEFERRAL_RECOGNITION: ["الاعتراف الشهري بالمؤجلات", "the monthly deferral recognition"],
  DEPRECIATION: ["الإهلاك الشهري", "the monthly depreciation"],
};

export function StandingAuthCard({ register, onChange }: { register: Register; onChange?: () => void }) {
  const { L } = useLang();
  const d = useApi<Data>(`/api/accounting/standing-authorisations?register=${register}`);
  const w = useWrite();
  const [revoking, setRevoking] = useState(false);
  const [reason, setReason] = useState("");
  if (!d.data) return d.error ? <p role="alert" className="hr-err">{d.error}</p> : null;
  const live = d.data.live[register];
  const can = d.data.can[register];
  const last = d.data.history.find((h) => h.revokedAt);
  // Names isolated from the sentence direction (an Arabic name in an English sentence and back).
  const who = (id: string | null) => `\u2068${id ? d.data!.names[id] ?? (id.startsWith("system:") ? L("النظام", "the system") : id) : "—"}\u2069`;
  const at = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-CA", { timeZone: "Asia/Riyadh" }) : "—");
  const [ar, en] = WHAT[register];

  async function grant() {
    if (await w.run("grant", "/api/accounting/standing-authorisations", "POST", { register }, L("مُنح التفويض الدائم: ترحّل الجدولة اليومية هذا السجل باسمك.", "Standing authorisation granted: the daily scheduler posts this register in your name."))) { d.reload(); onChange?.(); }
  }
  async function revoke() {
    if (!live) return;
    if (await w.run("revoke", `/api/accounting/standing-authorisations/${live.id}/revoke`, "POST", { reason }, L("أُلغي التفويض الدائم.", "Standing authorisation revoked."))) { setRevoking(false); setReason(""); d.reload(); onChange?.(); }
  }

  return (
    <div className="acct-banner-note" data-testid={`standing-${register}`} data-state={live ? "AUTHORISED" : "NOT_AUTHORISED"}>
      <Msg error={w.error} done={w.done} onClose={() => { w.setError(null); w.setDone(null); }} />
      <p>
        <b>{L("الجدولة التلقائية", "Scheduler")}: </b>
        {live
          ? <span data-testid="standing-live">{L(`مفوّضة بترحيل ${ar} — فوّضها ${who(live.authorisedBy)} في ${at(live.authorisedAt)}؛ تُرحَّل القيود باسمه بعد انتهاء كل شهر.`, `authorised to post ${en} — by ${who(live.authorisedBy)} on ${at(live.authorisedAt)}; the entries post in their name after each month ends.`)}
            {live.sodBypass ? <span className="acct-warn">{L(" (تفويض ذاتي — استثناء فصل مهام)", " (self-authorised — an SoD exception)")}</span> : null}</span>
          : <span data-testid="standing-none">{L(`لا ترحّل الجدولة ${ar} (لا تفويض دائم): يُشغَّل من «تشغيل المستحق الآن».`, `The scheduler does not post ${en} (no standing authorisation): run it with «Run due now».`)}</span>}
        {!live && last ? <span className="acct-th-sub" data-testid="standing-last">{last.lapsed
          ? L(`أُلغي آخر تفويض تلقائيًا في ${at(last.revokedAt)}: لم يعد مانحه يملك الصلاحية.`, `The last authorisation was revoked automatically on ${at(last.revokedAt)}: its authoriser no longer holds the right.`)
          : L(`أُلغي آخر تفويض في ${at(last.revokedAt)} بواسطة ${who(last.revokedBy)}.`, `The last authorisation was revoked on ${at(last.revokedAt)} by ${who(last.revokedBy)}.`)}</span> : null}
      </p>
      <p className="acct-actions">
        {live
          ? (can.revoke ? <Btn busy={w.busy === "revoke"} onClick={() => setRevoking(true)} data-testid="standing-revoke">{L("إلغاء التفويض", "Revoke")}</Btn> : null)
          : can.grant ? <Btn variant="primary" busy={w.busy === "grant"} onClick={grant} data-testid="standing-grant">{L("تفويض الجدولة بالترحيل", "Authorise the scheduler")}</Btn>
            : can.needsPost ? <span className="acct-hint" data-testid="standing-needs-post">{L("يتطلب صلاحية الترحيل (journal_post)", "Needs the posting duty (journal_post)")}</span> : null}
      </p>
      <Dialog open={revoking} title={L("إلغاء التفويض الدائم", "Revoke the standing authorisation")} sub={L(ar, en)} onClose={() => setRevoking(false)}
        actions={<><Btn variant="danger" disabled={reason.trim().length < 3} busy={w.busy === "revoke"} onClick={revoke} data-testid="standing-revoke-confirm">{L("إلغاء التفويض", "Revoke")}</Btn><Btn onClick={() => setRevoking(false)}>{L("رجوع", "Back")}</Btn></>}>
        <p>{L("لن ترحّل الجدولة هذا السجل بعد الآن؛ يبقى تشغيله من «تشغيل المستحق الآن». ما رُحّل لا يتغير.", "The scheduler stops posting this register; it is still run with «Run due now». What was posted stays.")}</p>
        <Field label={L("السبب (يُسجَّل)", "Reason (recorded)")}><textarea className="hr-input hr-textarea" value={reason} onChange={(e) => setReason(e.target.value)} data-testid="standing-reason" /></Field>
      </Dialog>
    </div>
  );
}
