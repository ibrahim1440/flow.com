"use client";
// The evaluator panel and the QC decision (production simplification item 5 / 5b; prototype
// «المقيّمون والقرار», «أضف مقيّمًا ضيفًا», «أرسل رابط التقييم»).
//
//   · Evaluators: each record (✓ / ✕, who, staff or guest, when, why), the guests invited and not
//     evaluated yet, and an empty slot for every evaluation still missing to the minimum (D1).
//   · Decision (qc › manage): the majority is suggested; a decision against any evaluator needs a
//     reason (D3, both directions); below the minimum the decision is an exceptional approval —
//     only with qc › finalize_override, a reason and «أتحمّل المسؤولية» (D2). A rejection writes
//     the batch's roasted coffee off as loss (G05) — said before it is confirmed.
//   · Guests (qc › manage, D4): present on this device (the existing guest form opens with the
//     name filled) or a link — by WhatsApp under the automation sending mode, or copied.
// The server holds every rule (src/lib/services/qc-finalize.ts, qc-invite.ts); this sheet only
// makes them visible before the request is sent.
import { useState } from "react";
import { OpsPane, opsDate, useL } from "@/components/ops/ui";
import { Chips, Cta, NumIn } from "@/components/ops/station";
import { useI18n } from "@/lib/i18n/context";

export type PanelRecord = {
  id: string; decision: string; isExternal: boolean; testerName: string | null; date: string;
  employee: { id: string; name: string } | null; underDeveloped: boolean; overDeveloped: boolean; remarks: string | null;
};
export type PanelBatch = {
  id: string; batchNumber: string; product: string; roastedKg: number; roastedAvailableKg: number | null;
  qcRecords: PanelRecord[]; qcInvites: { id: string; name: string; channel: string }[];
};

const kgText = (v: number) => (Math.round(v * 100) / 100).toFixed(2);

const DECISION_REASONS = {
  override: [["طلب عاجل", "Urgent order"], ["لا يوجد مقيّم متاح", "No evaluator available"], ["دفعة تجريبية", "Trial batch"]],
  Passed: [["الأغلبية قبلت", "The majority accepted"], ["بعد إعادة التذوق", "After re-tasting"], ["ملاحظة بسيطة", "A minor remark"]],
  Rejected: [["الأغلبية رفضت", "The majority rejected"], ["بعد إعادة التذوق", "After re-tasting"], ["عيب واضح", "A clear defect"]],
} as const;

export function PanelSheet({ batch, min, me, canCreate, canManage, canOverride, onClose, onEvaluate, onChanged, onDecided }: {
  batch: PanelBatch;
  min: number;
  me: string | null;
  canCreate: boolean;
  canManage: boolean;
  canOverride: boolean;
  onClose: () => void;
  onEvaluate: () => void;
  /** Something changed on the batch (an invite): reload, keep the sheet open. */
  onChanged: (message: string) => void;
  onDecided: (message: string) => void;
}) {
  const L = useL();
  const { lang } = useI18n();
  const recs = batch.qcRecords;
  const n = recs.length;
  const ok = recs.filter((r) => r.decision === "Accept").length;
  const bad = n - ok;
  const mine = recs.some((r) => !r.isExternal && r.employee?.id === me);
  const pend = batch.qcInvites.length;
  const ready = n >= min;
  const suggested: "Passed" | "Rejected" | null = n ? (bad > ok ? "Rejected" : "Passed") : null;

  const [view, setView] = useState<"panel" | "invite" | "present" | "link">("panel");
  const [res, setRes] = useState<"Passed" | "Rejected" | null>(suggested);
  const [override, setOverride] = useState(false);
  const [reasonChip, setReasonChip] = useState<string | null>(null);
  const [reasonNote, setReasonNote] = useState("");
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // invite
  const [gName, setGName] = useState("");
  const [gPhone, setGPhone] = useState("");
  const [sent, setSent] = useState<{ url: string; note: string } | null>(null);

  const gate = !ready && !override;
  const disagree = (res === "Passed" && bad > 0) || (res === "Rejected" && ok > 0);
  const needReason = override || disagree;
  const reasonText = [reasonChip ?? "", reasonNote.trim()].filter(Boolean).join(" · ");
  const passBlocked = res === "Passed" && ok === 0;
  const canSubmit = canManage && n > 0 && !gate && !!res && !passBlocked && (!needReason || !!reasonText) && (!override || ack);
  const reasons = override ? DECISION_REASONS.override : res ? DECISION_REASONS[res] : [];

  const cta = gate ? L(`بانتظار ${min - n} تقييم`, `Waiting for ${min - n} more`)
    : !res ? L("اختر القرار", "Choose the decision")
    : needReason && !reasonText ? L("اختر السبب", "Choose the reason")
    : override && !ack ? L("أكّد المسؤولية", "Confirm the responsibility")
    : res === "Passed" ? (override ? L("اعتمد استثنائيًا: مقبولة", "Approve exceptionally: accepted") : L("اعتمد: مقبولة", "Approve: accepted"))
    : (override ? L("اعتمد استثنائيًا: مرفوضة", "Approve exceptionally: rejected") : L("اعتمد: مرفوضة", "Approve: rejected"));

  async function decide() {
    if (!canSubmit || busy || !res) return;
    setBusy(true); setError("");
    try {
      const r = await fetch(`/api/qc/${batch.id}/finalize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          outcome: res,
          ...(disagree || (!override && reasonText) ? { finalDecisionReason: reasonText } : {}),
          ...(override ? { override: true, overrideReason: reasonText, confirmed: ack } : {}),
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError((lang === "ar" ? j.error : j.errorEn ?? j.error) || L("تعذّر الاعتماد.", "Could not finalize.")); return; }
      onDecided(res === "Passed"
        ? L(`قُبلت ${batch.batchNumber}${j.override ? " · اعتماد استثنائي" : ""} · ظهرت في التعبئة`, `${batch.batchNumber} accepted${j.override ? " · exceptional approval" : ""} · now in packaging`)
        : L(`رُفضت ${batch.batchNumber} · سُجّل فاقد ${kgText(j.lossKg ?? 0)} كغ وعاد المطلوب لقائمة التحميص`, `${batch.batchNumber} rejected · ${kgText(j.lossKg ?? 0)} kg written off; the demand is back in the roast queue`));
    } catch {
      setError(L("تعذّر الاتصال. أعد المحاولة.", "Network error. Try again."));
    } finally {
      setBusy(false);
    }
  }

  async function invite(channel: "present" | "link") {
    if (busy || !gName.trim()) return;
    setBusy(true); setError("");
    try {
      const r = await fetch(`/api/qc/${batch.id}/invite`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel, name: gName.trim(), ...(channel === "link" && gPhone.trim() ? { phone: gPhone.trim() } : {}) }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError((lang === "ar" ? j.error : j.errorEn ?? j.error) || L("تعذّرت الدعوة.", "Could not invite.")); return; }
      if (channel === "present") {
        // The existing guest form, on this device, with the guest's name already typed.
        window.open(`${j.url}?name=${encodeURIComponent(gName.trim())}`, "_blank", "noopener");
        onChanged(L(`فُتح نموذج الضيف لـ ${gName.trim()} · يظهر تقييمه هنا فور إرساله`, `The guest form is open for ${gName.trim()}`));
        setView("panel"); setGName("");
        return;
      }
      let copied = false;
      try { await navigator.clipboard?.writeText(j.url); copied = true; } catch { /* clipboard unavailable */ }
      const wa = j.whatsapp as null | { status: string; mode: string };
      const note = wa
        ? wa.status === "QUEUED"
          ? (wa.mode === "TEST" ? L("أُرسل إلى رقم الاختبار (وضع الإرسال: اختبار).", "Sent to the test number (sending mode: TEST).") : L("وُضع في قائمة إرسال واتساب.", "Queued for WhatsApp."))
          : L("الإرسال عبر واتساب متوقف (وضع الإرسال: إيقاف). انسخ الرابط وأرسله.", "WhatsApp sending is off. Copy the link and send it.")
        : copied ? L("نُسخ الرابط.", "The link was copied.") : L("انسخ الرابط وأرسله.", "Copy the link and send it.");
      setSent({ url: j.url, note });
      onChanged(L(`أُضيف ${gName.trim()} للمقيّمين بانتظار تقييمه`, `${gName.trim()} added, waiting for the evaluation`));
    } catch {
      setError(L("تعذّر الاتصال. أعد المحاولة.", "Network error. Try again."));
    } finally {
      setBusy(false);
    }
  }

  const head = <>{batch.product} · <span className="ops-serial">{batch.batchNumber}</span> · {kgText(batch.roastedKg)} {L("كغ", "kg")}</>;

  if (view !== "panel") {
    const back = <button type="button" className="st-textlink" onClick={() => { setView("panel"); setSent(null); setError(""); }}>{L("رجوع للمقيّمين", "Back to the evaluators")}</button>;
    return (
      <OpsPane testId="qc-invite-sheet" label={L("أضف مقيّمًا ضيفًا", "Add a guest evaluator")} title={view === "link" ? L("أرسل رابط التقييم", "Send the evaluation link") : L("أضف مقيّمًا ضيفًا", "Add a guest evaluator")} sub={head} busy={busy} onClose={onClose}
        footer={view === "present"
          ? <Cta testId="qc-present-open" disabled={!gName.trim()} busy={busy} onClick={() => invite("present")}>{gName.trim() ? L("افتح نموذج التقييم", "Open the evaluation form") : L("اكتب اسم الضيف", "Type the guest's name")}</Cta>
          : view === "link" && !sent
            ? <Cta testId="qc-link-send" disabled={!gName.trim()} busy={busy} onClick={() => invite("link")}>{!gName.trim() ? L("اكتب اسم الضيف", "Type the guest's name") : gPhone.trim() ? L("أرسل عبر واتساب", "Send by WhatsApp") : L("أضفه وانسخ الرابط", "Add and copy the link")}</Cta>
            : undefined}>
        <div className="st-body">
          {view === "invite" ? (
            <>
              <button type="button" className="st-opt" data-testid="qc-invite-present" onClick={() => setView("present")}>
                <span className="st-oi" aria-hidden="true"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><circle cx="12" cy="8" r="4" /><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" /></svg></span>
                <div><b>{L("ضيف حاضر معك الآن", "A guest here with you")}</b><small>{L("يكتب اسمه ويقيّم على هذا الجهاز", "Types their name and evaluates on this device")}</small></div>
              </button>
              <button type="button" className="st-opt" data-testid="qc-invite-link" onClick={() => setView("link")}>
                <span className="st-oi" aria-hidden="true"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M21 3L10 14M21 3l-7 18-4-7-7-4 18-7z" /></svg></span>
                <div><b>{L("أرسل له رابطًا", "Send a link")}</b><small>{L("يقيّم من مكانه، بدون حساب ولا تسجيل دخول", "Evaluates from anywhere, no account, no sign-in")}</small></div>
              </button>
            </>
          ) : view === "present" ? (
            <>
              <NumIn id="qc-present-name" text inputMode="text" label={L("اسم الضيف", "Guest's name")} value={gName} onChange={setGName} placeholder={L("مثال: أبو فهد", "e.g. Abu Fahd")} autoFocus testId="qc-present-name" />
              <p className="st-note">{L("يفتح نموذج الضيف على هذا الجهاز باسمه. يُطلب سبب عند الرفض، ولا يرى الضيف الطلب ولا العميل.", "The guest form opens on this device with the name. A rejection needs a reason; the guest never sees the order or the customer.")}</p>
            </>
          ) : (
            <>
              <NumIn id="qc-link-name" text inputMode="text" label={L("اسم الضيف", "Guest's name")} value={gName} onChange={setGName} placeholder={L("مثال: أبو فهد", "e.g. Abu Fahd")} autoFocus testId="qc-link-name" />
              <NumIn id="qc-link-phone" inputMode="tel" small label={L("جواله (واتساب، اختياري)", "Mobile (WhatsApp, optional)")} value={gPhone} onChange={setGPhone} placeholder="05XXXXXXXX" testId="qc-link-phone" />
              {sent ? (
                <>
                  <div className="st-linkbox" data-testid="qc-link-box">
                    <code>{sent.url}</code>
                    <button type="button" className="st-qb" onClick={() => { navigator.clipboard?.writeText(sent.url).catch(() => {}); }}>{L("نسخ", "Copy")}</button>
                  </div>
                  <div className="st-auto" role="status"><span className="st-ico" aria-hidden="true">✓</span><div><b>{sent.note}</b><small>{L("الرابط لهذه الدفعة فقط، ويُلغى تلقائيًا عند اعتماد القرار.", "The link is for this batch only and stops working once the decision is taken.")}</small></div></div>
                </>
              ) : (
                <p className="st-note">{L("الرابط لهذه الدفعة فقط، ويُلغى تلقائيًا عند اعتماد القرار. لا يرى الضيف الطلب ولا العميل. يُرسل واتساب حسب وضع الإرسال في الأتمتة.", "The link is for this batch only and stops working once the decision is taken; the guest never sees the order or the customer. WhatsApp follows the automation sending mode.")}</p>
              )}
            </>
          )}
          {error ? <p className="hr-notice tone-danger" role="alert" style={{ margin: 0 }}>{error}</p> : null}
          {back}
        </div>
      </OpsPane>
    );
  }

  const who = (r: PanelRecord) => r.employee?.name ?? r.testerName ?? "—";
  const why = (r: PanelRecord) => [r.underDeveloped ? L("تحت التطوير", "Underdeveloped") : "", r.overDeveloped ? L("محروقة", "Burnt") : "", r.remarks ?? ""].filter(Boolean).join(" · ");
  const slots = Math.max(0, min - n - pend);

  return (
    <OpsPane testId="qc-panel-sheet" label={L("المقيّمون والقرار", "Evaluators and decision")} title={batch.product} sub={<><span className="ops-serial">{batch.batchNumber}</span> · {kgText(batch.roastedKg)} {L("كغ", "kg")}</>} busy={busy} onClose={onClose}
      footer={canManage && n > 0 ? <Cta testId="qc-decide" bad={res === "Rejected" && !gate} disabled={!canSubmit} busy={busy} onClick={decide}>{cta}</Cta> : undefined}>
      <div className="st-body">
        <div className="st-meter-l" style={{ margin: 0 }}><span className="ops-lbl" style={{ margin: 0 }}>{L("المقيّمون", "Evaluators")}</span><span>{L(`${n} من ${min}`, `${n} of ${min}`)}</span></div>
        <ul className="st-evs" data-testid="qc-evaluators">
          {recs.map((r) => (
            <li key={r.id} className="st-ev">
              <span className={`st-av ${r.decision === "Accept" ? "is-ok" : "is-bad"}`} aria-hidden="true">{r.decision === "Accept" ? "✓" : "✕"}</span>
              <div><b>{who(r)}</b><small>{r.isExternal ? L("ضيف", "Guest") : L("موظف", "Staff")} · {opsDate(r.date, lang, true)}{why(r) ? ` · ${why(r)}` : ""}</small></div>
              <span className={`st-tag ${r.decision === "Accept" ? "is-ok" : "is-bad"}`}>{r.decision === "Accept" ? L("مقبولة", "Accepted") : L("مرفوضة", "Rejected")}</span>
            </li>
          ))}
          {batch.qcInvites.map((g) => (
            <li key={g.id} className="st-ev is-pend" data-testid="qc-pending-guest">
              <span className="st-av" aria-hidden="true">…</span>
              <div><b>{g.name}</b><small>{g.channel === "PRESENT" ? L("ضيف حاضر · لم يقيّم بعد", "Guest here · not evaluated yet") : L("رابط أُرسل · لم يقيّم بعد", "Link sent · not evaluated yet")}</small></div>
            </li>
          ))}
          {Array.from({ length: slots }, (_, k) => (
            <li key={`slot-${k}`} className="st-ev is-slot" data-testid="qc-empty-slot"><span className="st-av" aria-hidden="true" /><div><small>{L(`مكان مقيّم ${n + pend + k + 1}`, `Evaluator slot ${n + pend + k + 1}`)}</small></div></li>
          ))}
        </ul>
        <div className="st-row2">
          {canCreate && !mine ? <button type="button" className="st-sec" data-testid="qc-panel-evaluate" onClick={onEvaluate}>{L("قيّم الآن", "Evaluate now")}</button> : null}
          {canManage ? <button type="button" className="st-sec" data-testid="qc-panel-invite" onClick={() => { setView("invite"); setGName(""); setGPhone(""); setSent(null); }}>{L("+ أضف مقيّمًا ضيفًا", "+ Add a guest evaluator")}</button> : null}
        </div>

        {!canManage ? (
          <p className="st-note">{ready ? L("اكتمل الحد الأدنى. القرار الآن عند مسؤول الجودة.", "The minimum is reached. The decision is the QC lead's.") : L(`يعتمد مسؤول الجودة القرار بعد اكتمال ${min} تقييمات.`, `The QC lead decides once ${min} evaluations are in.`)}</p>
        ) : n === 0 ? (
          <p className="st-note">{L("لا تقييمات بعد.", "No evaluations yet.")}</p>
        ) : (
          <>
            <div className={`st-live${bad ? " is-warn" : ""}`} data-testid="qc-suggestion">
              <span>{L(`${ok} مقبولة · ${bad} مرفوضة`, `${ok} accepted · ${bad} rejected`)}</span>
              <span>{L("المقترح: ", "Suggested: ")}{suggested === "Rejected" ? L("رفض", "reject") : L("قبول", "accept")}</span>
            </div>
            {gate ? (
              <div className="st-warnbox" data-testid="qc-below-min">
                <b>{L(`أقل من الحد الأدنى (${n} من ${min})`, `Below the minimum (${n} of ${min})`)}</b>
                <span>{L("الأفضل انتظار مقيّم آخر أو دعوة ضيف.", "Better to wait for another evaluator or invite a guest.")}{canOverride ? L(" عند الضرورة يمكنك الاعتماد الآن بتأكيد.", " If needed, you may approve now with a confirmation.") : L(" الاعتماد الآن يحتاج صلاحية «اعتماد استثنائي بأقل من الحد الأدنى».", " Approving now needs the «exceptional approval» permission.")}</span>
                {canOverride ? <button type="button" className="st-textlink is-sm" data-testid="qc-override" onClick={() => { setOverride(true); setReasonChip(null); setReasonNote(""); setAck(false); }}>{L("اعتماد استثنائي الآن", "Exceptional approval now")}</button> : null}
              </div>
            ) : (
              <>
                {override ? (
                  <div className="st-warnbox"><b>{L(`اعتماد استثنائي بأقل من ${min} تقييمات`, `Exceptional approval with fewer than ${min} evaluations`)}</b><span>{L("يُسجَّل باسمك مع السبب في سجل الدفعة.", "Recorded on the batch under your name, with the reason.")}</span></div>
                ) : null}
                <div className="st-field">
                  <span className="st-label">{L("قرارك", "Your decision")}</span>
                  <Chips testId="qc-decision" label={L("قرارك", "Your decision")} value={res} onChange={(v) => { setRes(v); setReasonChip(null); }}
                    options={[{ value: "Passed", label: L("مقبولة · للتعبئة", "Accepted · to packaging") }, { value: "Rejected", label: L("مرفوضة", "Rejected") }]} />
                </div>
                {passBlocked ? <p className="st-note is-bad">{L("لا يمكن القبول بدون تقييم «مقبولة» واحد على الأقل.", "Cannot accept without at least one «accepted» evaluation.")}</p> : null}
                {needReason ? (
                  <div className="st-field">
                    <span className="st-label">{override ? L("سبب الاعتماد الاستثنائي", "Reason for the exceptional approval") : L("سبب مخالفة رأي أحد المقيّمين", "Why decide against an evaluator")}</span>
                    <Chips testId="qc-decision-reasons" value={reasonChip} onChange={setReasonChip} options={reasons.map(([ar, en]) => ({ value: lang === "ar" ? ar : en, label: lang === "ar" ? ar : en }))} />
                    <div style={{ marginTop: 8 }}><NumIn id="qc-decision-note" text small inputMode="text" label={L("تفصيل (اختياري)", "Detail (optional)")} value={reasonNote} onChange={setReasonNote} /></div>
                  </div>
                ) : null}
                {override ? (
                  <label className="st-check"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} data-testid="qc-override-ack" /><span>{L(`أتحمّل مسؤولية اعتماد هذه الدفعة بتقييم ${n === 1 ? "واحد" : "أقل من الحد الأدنى"}`, "I take responsibility for approving this batch below the minimum")}</span></label>
                ) : null}
                {res === "Rejected" ? <p className="st-note">{L(`يُسجَّل ${kgText(batch.roastedAvailableKg ?? batch.roastedKg)} كغ فاقدًا تلقائيًا، ويعود المطلوب إلى قائمة المحمّص.`, `${kgText(batch.roastedAvailableKg ?? batch.roastedKg)} kg are written off automatically and the demand returns to the roast queue.`)}</p> : null}
              </>
            )}
          </>
        )}
        {error ? <p className="hr-notice tone-danger" role="alert" style={{ margin: 0 }}>{error}</p> : null}
      </div>
    </OpsPane>
  );
}
