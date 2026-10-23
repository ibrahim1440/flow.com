"use client";
// «طلبات الاستثناء» — Production › Quality, the fourth QC tab (Figma QX-01…06, PHASE9 §2.7; owner
// decisions of 23 Oct 2026). QX-01 the queue (pending first, then decided), QX-02 the review (spec vs
// actual from the request's frozen measurements, the request, the people, the decision panel,
// history), QX-03 the confirmation (the password step-up is the dashboard's own dialog on
// REAUTH_REQUIRED), QX-04 approved / QX-05 rejected, QX-06 the requester's — or the inspector's — own
// view: no decision controls. The server decides who may decide (qc › approve_exception, never the
// requester, never the inspector); this screen only mirrors it.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useI18n } from "@/lib/i18n/context";
import { localizeApiError } from "@/lib/i18n/api-errors";
import { newRequestKey } from "@/lib/request-key";
import { Btn, Dot, KV, Notice, OpsEmpty, OpsError, OpsLoading, SecHead, Timeline, Field } from "@/components/ops/ui";
import {
  DEFECT_KEYS, DEFECT_WORD, EXCEPTION_REASON_WORD, HOLD_REASON_WORD, PERMITTED_USE_WORD, SENSORY_WORD, VERDICT_WORD,
  type ExceptionReason, type HoldReason, type PermittedUse, type SensoryResult, type SpecSnapshot, type Verdict,
} from "@/lib/qc/spec";

type Measurements = {
  recordId: string; at: string; inspectorName: string | null; spec: SpecSnapshot | null; whole: number | null; ground: number | null; wholeVerdict: Verdict | null; groundVerdict: Verdict | null;
  wholeDevice: string | null; wholeScale: string | null; defects: Record<string, boolean>; sensory: SensoryResult | null; sensoryNotes: string | null; lossPct: number | null; holdReasons: HoldReason[];
};
export type ExceptionRow = {
  id: string; number: string; status: string; reason: ExceptionReason; reasonNote: string | null; quantityKg: number; permittedUse: PermittedUse; permittedUseNote: string | null;
  measurements: Measurements; requestedById: string; requestedByName: string; inspectorId: string | null; inspectorName: string | null; stationId: string | null; createdAt: string;
  decidedById: string | null; decidedByName: string | null; decisionReason: string | null; decidedAt: string | null;
  batch: { id: string; batchNumber: string; status: string; availableKg: number; roastedKg: number; roastedAt: string; nameEn: string; nameAr: string | null; orderNumber: number | null; productionNumber: string | null; green: { serialNumber: string; beanType: string; beanTypeAr: string | null; country: string; countryAr: string | null } | null; roaster: string | null; releasedByThis: boolean };
  can?: { decide: boolean; holds: boolean; sod: "requester" | "inspector" | null };
};

const TZ = "Asia/Riyadh";
const at = (iso: string | null, lang: "ar" | "en") => (iso ? new Date(iso).toLocaleString(lang === "ar" ? "ar-SA-u-nu-latn-ca-gregory" : "en-GB", { timeZone: TZ, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }) : "—");
const kg2 = (v: number) => (Math.round(v * 100) / 100).toFixed(2);

export function ExceptionsTab({ onCount, focusId }: { onCount?: (n: number) => void; focusId?: string | null }) {
  const { lang } = useI18n();
  const L = useCallback((ar: string, en: string) => (lang === "ar" ? ar : en), [lang]);
  const [data, setData] = useState<{ pending: ExceptionRow[]; decided: ExceptionRow[]; canDecide: boolean } | null>(null);
  const [failed, setFailed] = useState(false);
  const [openId, setOpenId] = useState<string | null>(focusId ?? null);
  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/qc/exceptions", { cache: "no-store" });
      if (!r.ok) { setFailed(true); return; }
      const j = await r.json();
      setData(j); setFailed(false); onCount?.(j.pending.length);
    } catch { setFailed(true); }
  }, [onCount]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- the list is read on mount
  useEffect(() => { void load(); }, [load]);

  if (openId) return <ExceptionReview id={openId} onBack={() => { setOpenId(null); void load(); }} />;
  if (failed) return <OpsError message={L("تعذّر تحميل طلبات الاستثناء.", "Could not load the exception requests.")} onRetry={load} />;
  if (!data) return <OpsLoading />;
  const row = (e: ExceptionRow, decided: boolean) => (
    <tr key={e.id} className="is-click" onClick={() => setOpenId(e.id)} data-testid={`qx-row-${e.number}`}>
      <td className="hr-id"><bdi>{e.number}</bdi></td>
      <td className="hr-id"><bdi>{e.batch.batchNumber}</bdi></td>
      <td><b>{lang === "ar" ? e.batch.nameAr || e.batch.nameEn : e.batch.nameEn}</b><div className="hr-caption">{e.batch.orderNumber ? L(`للطلب #${e.batch.orderNumber}`, `Order #${e.batch.orderNumber}`) : L("للمخزون", "For stock")}</div></td>
      <td className="hr-num"><b style={{ color: "var(--hr-danger)" }}>{e.measurements.whole ?? "—"} / {e.measurements.ground ?? "—"}</b>{e.measurements.spec?.state === "APPROVED" ? <div className="hr-caption">{L("الهدف", "target")} {e.measurements.spec.whole.target} ± {e.measurements.spec.whole.tol}</div> : null}</td>
      <td>{EXCEPTION_REASON_WORD[e.reason][lang]}</td>
      <td>{decided ? <>{e.requestedByName} ← {e.decidedByName}<div className="hr-caption">{at(e.decidedAt, lang)}</div></> : <>{e.requestedByName}<div className="hr-caption">{at(e.createdAt, lang)}</div></>}</td>
      <td>{decided ? <Dot tone={e.status === "APPROVED" ? "success" : "danger"}>{e.status === "APPROVED" ? L("اعتُمد · أُفرج", "Approved · released") : e.status === "REJECTED" ? L("رُفض · محجوزة", "Rejected · held") : L("سُحب", "Withdrawn")}</Dot> : <Dot tone="warning">{L("غير متاحة", "Not available")}</Dot>}</td>
    </tr>
  );
  const head = (decided: boolean) => (
    <thead><tr>
      <th scope="col">{L("الطلب", "Request")}</th><th scope="col">{L("الدفعة", "Batch")}</th><th scope="col">{L("المنتج", "Product")}</th>
      <th scope="col">{L("حبوب / مطحون", "Whole / ground")}</th><th scope="col">{L("سبب الطلب", "Reason")}</th>
      <th scope="col">{decided ? L("طلبه ← قرّره", "Requested ← decided") : L("طلبه", "Requested by")}</th><th scope="col">{decided ? L("النتيجة", "Result") : L("التوفر", "Availability")}</th>
    </tr></thead>
  );
  return (
    <div data-testid="qx-queue" style={{ display: "grid", gap: 20 }}>
      <Notice tone="info">{L("الطلب لا يحرر الدفعة. يعتمده أو يرفضه مخوّل غير صاحب الطلب وغير فاحص الدفعة، ثم يُطبَّق القرار عبر مسار الإفراج المعتمد. ما دام الطلب معلّقًا أو مرفوضًا تبقى الدفعة محجوزة غير متاحة للتعبئة والخلط والحجز.", "A request releases nothing. Someone other than the requester and the inspector approves or rejects it; an approval goes through the QC release workflow. While pending or rejected the batch stays held.")}</Notice>
      <section>
        <SecHead title={L("بانتظار القرار", "Awaiting decision")} caption={L(`${data.pending.length} طلب · يصل من محطة الجودة فور إرساله`, `${data.pending.length} request(s) · arrive from the QC station`)} />
        {data.pending.length === 0 ? <OpsEmpty title={L("لا طلبات بانتظار القرار.", "No request awaits a decision.")} /> : (
          <div className="hr-tablewrap"><table className="hr-table" aria-label={L("بانتظار القرار", "Awaiting decision")}>{head(false)}<tbody>{data.pending.map((e) => row(e, false))}</tbody></table></div>
        )}
      </section>
      <section>
        <SecHead title={L("قُرّرت مؤخرًا", "Recently decided")} />
        {data.decided.length === 0 ? <OpsEmpty title={L("لا قرارات بعد.", "No decisions yet.")} /> : (
          <div className="hr-tablewrap"><table className="hr-table" aria-label={L("قُرّرت مؤخرًا", "Recently decided")}>{head(true)}<tbody>{data.decided.map((e) => row(e, true))}</tbody></table></div>
        )}
        <p className="hr-caption" style={{ marginTop: 8 }}>{L("يقرر الطلبات من يملك «اعتماد استثناءات الجودة». صاحب الطلب وفاحص الدفعة لا يريان أزرار القرار على الطلب.", "Holders of «approve QC exceptions» decide. The requester and the inspector see no decision controls on it.")}</p>
      </section>
    </div>
  );
}

function ExceptionReview({ id, onBack }: { id: string; onBack: () => void }) {
  const { lang } = useI18n();
  const L = useCallback((ar: string, en: string) => (lang === "ar" ? ar : en), [lang]);
  const [e, setE] = useState<ExceptionRow | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [decision, setDecision] = useState<"APPROVE" | "REJECT">("APPROVE");
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [key, setKey] = useState(() => newRequestKey());
  const load = useCallback(async () => {
    const r = await fetch(`/api/qc/exceptions/${encodeURIComponent(id)}`, { cache: "no-store" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { setFailed(localizeApiError(j, lang) ?? "—"); return; }
    setE(j);
  }, [id, lang]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- the request is read on mount
  useEffect(() => { void load(); }, [load]);
  async function decide() {
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`/api/qc/exceptions/${encodeURIComponent(id)}/decide`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify({ decision, reason: reason.trim() }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(localizeApiError(j, lang) ?? L("تعذّر حفظ القرار.", "Could not save the decision.")); if (r.status !== 401) setKey(newRequestKey()); return; }
      setConfirming(false); setE({ ...e!, ...j, can: { decide: false, holds: true, sod: null } });
    } finally { setBusy(false); }
  }
  if (failed) return <OpsError message={failed} onRetry={load} />;
  if (!e) return <OpsLoading />;
  const m = e.measurements;
  const spec = m.spec;
  const name = lang === "ar" ? e.batch.nameAr || e.batch.nameEn : e.batch.nameEn;
  const tone = (v: Verdict | null) => (v === "ON_TARGET" ? "success" : "danger");
  const rows: [ReactNode, ReactNode, ReactNode, ReactNode][] = [];
  if (spec?.state === "APPROVED") {
    rows.push([`${spec.scale} · ${L("حبوب", "whole")}`, `${spec.whole.target} ± ${spec.whole.tol}`, m.whole ?? "—", m.wholeVerdict ? <Dot tone={tone(m.wholeVerdict)}>{VERDICT_WORD[m.wholeVerdict][lang]}</Dot> : "—"]);
    rows.push([`${spec.scale} · ${L("مطحون", "ground")}`, `${spec.ground.target} ± ${spec.ground.tol}`, m.ground ?? "—", m.groundVerdict ? <Dot tone={tone(m.groundVerdict)}>{VERDICT_WORD[m.groundVerdict][lang]}</Dot> : "—"]);
  }
  const defects = DEFECT_KEYS.filter((k) => m.defects?.[k]);
  rows.push([L("عيوب ظاهرة", "Visible defects"), L("لا عيوب", "None"), defects.length ? defects.map((k) => DEFECT_WORD[k][lang]).join("، ") : L("لا عيوب", "None"), <Dot key="d" tone={defects.length ? "danger" : "success"}>{defects.length ? L("خارج الحد", "Outside") : L("ضمن المواصفة", "Within")}</Dot>]);
  rows.push([L("التقييم الحسي", "Sensory"), L("مطابق", "Conforming"), m.sensory ? SENSORY_WORD[m.sensory][lang] : "—", m.sensory ? <Dot key="s" tone={m.sensory === "CONFORMING" ? "success" : "danger"}>{m.sensory === "CONFORMING" ? L("ضمن المواصفة", "Within") : L("خارج الحد", "Outside")}</Dot> : "—"]);
  rows.push([L("فاقد التحميص", "Roast loss"), L("للمرجع فقط", "Reference only"), m.lossPct === null ? "—" : `${m.lossPct.toFixed(1)}%`, <span key="l" className="hr-caption">{L("لا يحجز ولا يُفرج", "Never holds or releases")}</span>]);
  const sod = e.can?.sod ?? null;
  const decided = e.status !== "PENDING";
  const history = [
    ...(decided ? [{ key: "d", text: <>{e.status === "APPROVED" ? L(`اعتُمد الاستثناء · أُفرج عن الدفعة (مقبولة باستثناء ${e.number})`, `Exception approved · batch released`) : L("رُفض الاستثناء · الدفعة محجوزة", "Exception rejected · batch held")} · {e.decisionReason}</>, when: <>{at(e.decidedAt, lang)} · {e.decidedByName}</>, tone: e.status === "APPROVED" ? ("success" as const) : ("danger" as const) }] : []),
    { key: "r", text: <>{L("طُلب الاستثناء · السبب:", "Exception requested · reason:")} {EXCEPTION_REASON_WORD[e.reason][lang]}</>, when: <>{at(e.createdAt, lang)} · {e.requestedByName}{e.stationId ? L(" · محطة الجودة", " · QC station") : ""}</> },
    { key: "i", text: <>{L("سجل فحص · حبوب", "Inspection · whole")} {m.whole ?? "—"} / {L("مطحون", "ground")} {m.ground ?? "—"} · {(m.holdReasons ?? []).map((x) => HOLD_REASON_WORD[x][lang]).join("، ")}</>, when: <>{at(m.at, lang)} · {m.inspectorName ?? "—"}</> },
  ];
  return (
    <div data-testid={decided ? (e.status === "APPROVED" ? "qx-approved" : "qx-rejected") : sod ? "qx-own" : "qx-review"} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 320px", gap: 32 }} className="qx-grid">
      <div style={{ display: "grid", gap: 20, alignContent: "start" }}>
        <div>
          <button type="button" className="hr-btn is-ghost is-sm" onClick={onBack} data-testid="qx-back">{L("طلبات الاستثناء", "Exception requests")} ‹</button>
          <div className="hr-caption hr-id"><bdi>{e.number}</bdi></div>
          <h2 className="hr-title" style={{ fontSize: 24 }}>{L("طلب استثناء", "Exception request")} · {name}</h2>
          <div className="hr-caption">{L("الدفعة", "Batch")} <bdi className="hr-id">{e.batch.batchNumber}</bdi> · {L("طلبه", "requested by")} {e.requestedByName} · {at(e.createdAt, lang)} · {decided ? (e.status === "APPROVED" ? L("اعتُمد", "Approved") : L("رُفض", "Rejected")) : L("بانتظار القرار", "Awaiting decision")}</div>
        </div>
        <section>
          <SecHead title={L("المتوقع مقابل الفعلي", "Expected vs actual")} caption={spec?.state === "APPROVED" ? L(`مواصفة ${spec.profileName} · الإصدار ${spec.version} · سجل الفحص ${at(m.at, lang)}`, `${spec.profileName} v${spec.version} · inspection ${at(m.at, lang)}`) : L("المواصفة قيد المعايرة", "Spec under calibration")} />
          <div className="hr-tablewrap"><table className="hr-table" aria-label={L("المتوقع مقابل الفعلي", "Expected vs actual")} data-testid="qx-measurements">
            <thead><tr><th scope="col">{L("المعيار", "Criterion")}</th><th scope="col">{L("المتوقع", "Expected")}</th><th scope="col">{L("الفعلي", "Actual")}</th><th scope="col">{L("النتيجة", "Result")}</th></tr></thead>
            <tbody>{rows.map((r, i) => <tr key={i}><td>{r[0]}</td><td className="hr-num">{r[1]}</td><td className="hr-num"><b>{r[2]}</b></td><td>{r[3]}</td></tr>)}</tbody>
          </table></div>
        </section>
        <section>
          <SecHead title={L("الطلب", "Request")} />
          <KV rows={[
            [L("سبب الطلب", "Reason"), <>{EXCEPTION_REASON_WORD[e.reason][lang]}{e.reasonNote ? ` · ${e.reasonNote}` : ""}</>],
            [L("الاستخدام المسموح", "Permitted use"), <>{PERMITTED_USE_WORD[e.permittedUse][lang]}{e.permittedUseNote ? ` · ${e.permittedUseNote}` : ""}</>],
            [L("الكمية", "Quantity"), <>{kg2(e.quantityKg)} {L("كغ", "kg")}</>],
            [L("صاحب الطلب", "Requested by"), <>{e.requestedByName} · {at(e.createdAt, lang)}</>],
            [L("فاحص الدفعة", "Inspected by"), <>{e.inspectorName ?? "—"} · {at(m.at, lang)}</>],
          ]} />
        </section>
        <section data-testid="qx-decision">
          <SecHead title={L("القرار", "Decision")} caption={e.decidedByName ? L(`المراجع: ${e.decidedByName}`, `Reviewer: ${e.decidedByName}`) : L("يقرّره من يملك «اعتماد استثناءات الجودة»", "Decided by a holder of «approve QC exceptions»")} />
          {decided ? (
            <Notice tone={e.status === "APPROVED" ? "success" : "danger"}>
              {e.status === "APPROVED"
                ? L(`اعتُمد الاستثناء بواسطة ${e.decidedByName}: أُفرج عن الدفعة عبر مسار الإفراج المعتمد (القرار النهائي «قبول» بمرجع ${e.number}) وأصبحت ${kg2(e.quantityKg)} كغ متاحة للتعبئة. الاستخدام: ${PERMITTED_USE_WORD[e.permittedUse].ar}.`, `Approved by ${e.decidedByName}: released through the QC workflow with reference ${e.number}; ${kg2(e.quantityKg)} kg available for packing.`)
                : L(`رُفض الاستثناء بواسطة ${e.decidedByName}. تبقى الدفعة محجوزة غير متاحة؛ التصرف فيها قرار منفصل (إعادة فحص، تحويل، خلط بوصفة، إتلاف).`, `Rejected by ${e.decidedByName}. The batch stays held; its disposition is a separate decision.`)}
              {e.decisionReason ? <div>{L("سبب القرار:", "Reason:")} {e.decisionReason}</div> : null}
            </Notice>
          ) : sod ? (
            <Notice tone="warning">{sod === "requester" ? L("قدّمت هذا الطلب، فلا يمكنك اعتماده أو رفضه. يقرّره شخص آخر. فصل المهام يُفرض في النظام.", "You made this request, so you cannot approve or reject it. Separation of duties is enforced on the server.") : L("أنت من فحص هذه الدفعة، فلا يمكنك قرار استثنائها. يقرّره شخص آخر. فصل المهام يُفرض في النظام.", "You inspected this batch, so you cannot decide its exception. Separation of duties is enforced on the server.")}</Notice>
          ) : !e.can?.holds ? (
            <Notice tone="info">{L("القرار لمن يملك «اعتماد استثناءات الجودة».", "Decided by a holder of «approve QC exceptions».")}</Notice>
          ) : confirming ? (
            <div style={{ display: "grid", gap: 12 }} data-testid="qx-confirm">
              <Notice tone={decision === "APPROVE" ? "info" : "warning"}>{decision === "APPROVE" ? L(`تأكيد الاعتماد: يُفرج عن الدفعة ${e.batch.batchNumber} (${kg2(e.quantityKg)} كغ) للاستخدام «${PERMITTED_USE_WORD[e.permittedUse].ar}». سيُطلب منك إدخال كلمة المرور.`, `Confirm the approval: batch ${e.batch.batchNumber} is released. Your password will be asked.`) : L("تأكيد الرفض: تبقى الدفعة محجوزة. سيُطلب منك إدخال كلمة المرور.", "Confirm the rejection: the batch stays held. Your password will be asked.")}</Notice>
              <p className="hr-caption">{L("يُرسل القرار مرة واحدة بمفتاح تكرار. إن قرّر مراجع آخر الطلب قبلك يُعرض قراره ولا يتكرر الإفراج.", "Sent once with an idempotency key. If another reviewer decided first, their decision is shown and nothing is released twice.")}</p>
              {err ? <Notice tone="danger">{err}</Notice> : null}
              <div style={{ display: "flex", gap: 8 }}>
                <Btn variant={decision === "APPROVE" ? "primary" : "danger"} busy={busy} onClick={() => void decide()} data-testid="qx-confirm-submit">{decision === "APPROVE" ? L("تأكيد الاعتماد", "Confirm approval") : L("تأكيد الرفض", "Confirm rejection")}</Btn>
                <Btn onClick={() => setConfirming(false)}>{L("رجوع", "Back")}</Btn>
              </div>
            </div>
          ) : (
            <div style={{ display: "grid", gap: 12 }}>
              <div className="hr-tabs" role="tablist" aria-label={L("القرار", "Decision")}>
                <button type="button" role="tab" className="hr-tab" aria-selected={decision === "APPROVE"} onClick={() => setDecision("APPROVE")} data-testid="qx-approve">{L("اعتماد الاستثناء", "Approve")}</button>
                <button type="button" role="tab" className="hr-tab" aria-selected={decision === "REJECT"} onClick={() => setDecision("REJECT")} data-testid="qx-reject">{L("رفض الاستثناء", "Reject")}</button>
              </div>
              <Field label={L("سبب القرار *", "Decision reason *")} help={L("مطلوب للاعتماد والرفض · يُحفظ في سجل الطلب والدفعة", "Required for both · kept in the request and batch history")}>
                <textarea className="hr-textarea" style={{ height: 72, padding: 10 }} value={reason} onChange={(ev) => setReason(ev.target.value)} data-testid="qx-reason" />
              </Field>
              <Notice tone="info">{L(`عند الاعتماد يُفرج عن الدفعة عبر مسار الإفراج المعتمد (القرار النهائي «قبول» بمرجع الطلب) وتصبح ${kg2(e.quantityKg)} كغ متاحة للتعبئة. عند الرفض تبقى الدفعة محجوزة. لا يتغير شيء قبل تأكيد النظام.`, `On approval the batch is released through the QC workflow and ${kg2(e.quantityKg)} kg become available. On rejection it stays held. Nothing changes before the system confirms.`)}</Notice>
              <div><Btn variant="primary" disabled={reason.trim().length < 3} onClick={() => setConfirming(true)} data-testid="qx-decide">{decision === "APPROVE" ? L("اعتماد الاستثناء", "Approve the exception") : L("رفض الاستثناء", "Reject the exception")}</Btn></div>
            </div>
          )}
        </section>
      </div>
      <aside style={{ display: "grid", gap: 20, alignContent: "start" }}>
        <section>
          <SecHead title={L("الدفعة", "Batch")} />
          <KV rows={[
            [L("الدفعة", "Batch"), <bdi key="b" className="hr-id">{e.batch.batchNumber}</bdi>],
            [L("أمر الإنتاج", "Production order"), e.batch.productionNumber ?? (e.batch.orderNumber ? L(`للطلب #${e.batch.orderNumber}`, `Order #${e.batch.orderNumber}`) : L("لا يوجد · تحميص للمخزون", "None · roasted for stock"))],
            [L("المنتج", "Product"), name],
            [L("البن الأخضر", "Green coffee"), e.batch.green ? <bdi key="g" className="hr-id">{e.batch.green.serialNumber}</bdi> : "—"],
            [L("التحميص", "Roasted"), <>{at(e.batch.roastedAt, lang)}{e.batch.roaster ? ` · ${e.batch.roaster}` : ""}</>],
            [L("المحمص", "Roasted kg"), <>{kg2(e.batch.roastedKg)} {L("كغ", "kg")}</>],
          ]} />
        </section>
        <section>
          <SecHead title={L("التوفر الآن", "Availability now")} />
          {e.batch.status === "QC Hold" ? <Dot tone="warning">{L("غير متاحة · محجوزة", "Not available · held")}</Dot> : e.batch.releasedByThis ? <Dot tone="success">{L("متاحة للتعبئة", "Available for packing")}</Dot> : <Dot tone="neutral">{e.batch.status}</Dot>}
          <p className="hr-caption">{e.batch.status === "QC Hold" ? L("لا تُعبّأ ولا تُخلط ولا تُحجز حتى القرار", "Not packed, blended or reserved until the decision") : ""}</p>
        </section>
        <section>
          <SecHead title={L("سجل الطلب", "Request history")} />
          <Timeline items={history} />
        </section>
      </aside>
    </div>
  );
}
