"use client";
// «المحجوزة» — Production › Quality: every held batch («محجوزة», status "QC Hold") and its
// disposition (owner decision 5; UR-S19). QC (qc › manage) asks for one — convert to another
// product (its approved spec must be met), blend by an approved recipe (released partners, the
// output goes to QC), destroy (reason and quantity) — and another person (qc › dispose, password
// step-up; never the requester nor the inspector) decides it. Re-inspection and the exception
// request are the inspector's, at the QC station (or its desktop equivalent, /station/quality).
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useI18n } from "@/lib/i18n/context";
import { localizeApiError } from "@/lib/i18n/api-errors";
import { newRequestKey } from "@/lib/request-key";
import { Btn, Dot, Field, Notice, OpsEmpty, OpsError, OpsLoading, SecHead } from "@/components/ops/ui";
import { DISPOSITION_WORD, HOLD_REASON_WORD, type DispositionKind } from "@/lib/qc/spec";
import type { HeldBatch } from "@/lib/services/qc/inspection";

type Disp = {
  id: string; number: string; batchId: string; kind: DispositionKind; status: string; quantityKg: number; reason: string; targetProductId: string | null; recipe: { heldQuantityKg: number; partners: { batchId: string; batchNumber: string; quantityKg: number }[] } | null;
  blendBatchId: string | null; requestedById: string; requestedByName: string; inspectorId: string | null; decidedByName: string | null; decisionReason: string | null; createdAt: string; decidedAt: string | null;
};
type Data = { held: HeldBatch[]; dispositions: Disp[]; me: string; can: { request: boolean; decide: boolean; inspect: boolean; blend: boolean } };
type Product = { id: string; productNameEn: string; productNameAr: string | null };
type Passed = { id: string; batchNumber: string; roastedAvailableKg: number; status: string; isBlend: boolean };

const kg2 = (v: number) => (Math.round(v * 100) / 100).toFixed(2);
const TZ = "Asia/Riyadh";
const at = (iso: string | null, lang: "ar" | "en") => (iso ? new Date(iso).toLocaleString(lang === "ar" ? "ar-SA-u-nu-latn-ca-gregory" : "en-GB", { timeZone: TZ, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }) : "—");

export function HeldTab({ onCount }: { onCount?: (n: number) => void }) {
  const { lang } = useI18n();
  const L = useCallback((ar: string, en: string) => (lang === "ar" ? ar : en), [lang]);
  const [data, setData] = useState<Data | null>(null);
  const [failed, setFailed] = useState(false);
  const [products, setProducts] = useState<Product[]>([]);
  const [passed, setPassed] = useState<Passed[]>([]);
  const [form, setForm] = useState<{ batch: HeldBatch; kind: DispositionKind } | null>(null);
  const [msg, setMsg] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/qc/held", { cache: "no-store" });
      if (!r.ok) { setFailed(true); return; }
      const j = (await r.json()) as Data;
      setData(j); setFailed(false); onCount?.(j.held.length);
    } catch { setFailed(true); }
  }, [onCount]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- read on mount
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!form) return;
    void fetch("/api/qc/profiles", { cache: "no-store" }).then(async (r) => { if (r.ok) setProducts((await r.json()).products); });
    void fetch("/api/roasting-batches?statuses=Passed", { cache: "no-store" }).then(async (r) => { if (r.ok) setPassed(((await r.json()) as Passed[]).filter((b) => !b.isBlend && b.roastedAvailableKg > 0.0005)); });
  }, [form]);

  if (failed) return <OpsError message={L("تعذّر تحميل الدفعات المحجوزة.", "Could not load the held batches.")} onRetry={load} />;
  if (!data) return <OpsLoading />;
  const name = (b: { nameEn: string; nameAr: string | null }) => (lang === "ar" ? b.nameAr || b.nameEn : b.nameEn);
  const openFor = (batchId: string) => data.dispositions.find((d) => d.batchId === batchId && (d.status === "PENDING" || d.status === "APPROVED")) ?? null;

  return (
    <div style={{ display: "grid", gap: 20 }} data-testid="qc-held-tab">
      <Notice tone="info">{L("الدفعة المحجوزة لا تُعبّأ ولا تُجهّز ولا تُشحن ولا تُصرف للإنتاج أو الخلط. لا رفض تلقائي ولا إتلاف تلقائي: يطلب فريق الجودة التصرف، ويقرّره شخص آخر غير الطالب وغير الفاحص.", "A held batch is not packed, picked, shipped, or issued to production or blends. No automatic rejection or destruction: QC asks, and someone other than the requester and the inspector decides.")}</Notice>
      {msg ? <Notice tone={msg.tone}>{msg.text}</Notice> : null}
      <section>
        <SecHead title={L("الدفعات المحجوزة", "Held batches")} caption={L(`${data.held.length} دفعة`, `${data.held.length} batch(es)`)} />
        {data.held.length === 0 ? <OpsEmpty title={L("لا دفعات محجوزة.", "No held batches.")} /> : (
          <div className="hr-tablewrap"><table className="hr-table" aria-label={L("الدفعات المحجوزة", "Held batches")}>
            <thead><tr><th scope="col">{L("الدفعة", "Batch")}</th><th scope="col">{L("المنتج", "Product")}</th><th scope="col">{L("السبب", "Why")}</th><th scope="col">{L("الكمية", "Quantity")}</th><th scope="col">{L("قيد القرار", "Pending")}</th><th scope="col">{L("الإجراء", "Action")}</th></tr></thead>
            <tbody>{data.held.map((h) => {
              const open = openFor(h.id);
              return (
                <tr key={h.id} data-testid={`held-row-${h.batchNumber}`}>
                  <td className="hr-id"><bdi>{h.batchNumber}</bdi><div className="hr-caption">{at(h.heldAt, lang)}</div></td>
                  <td>{name(h)}<div className="hr-caption">{h.inspectorName ? L(`فحصها ${h.inspectorName}`, `Inspected by ${h.inspectorName}`) : ""}</div></td>
                  <td>{h.foreign ? <Dot tone="danger">{L("أجسام غريبة / تلوث", "Foreign objects")}</Dot> : null} {h.reasons.filter((x) => x !== "FOREIGN_OBJECT").map((x) => HOLD_REASON_WORD[x][lang]).join("، ")}</td>
                  <td className="hr-num">{kg2(h.availableKg)} {L("كغ", "kg")}</td>
                  <td>{h.exception ? <bdi className="hr-id">{h.exception.number}</bdi> : null}{open ? <><bdi className="hr-id">{open.number}</bdi> · {DISPOSITION_WORD[open.kind][lang]}</> : null}{!h.exception && !open ? "—" : null}</td>
                  <td style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {data.can.inspect && !h.exception && !open ? <Link className="hr-btn is-sm" href={`/station/quality?batch=${encodeURIComponent(h.id)}`}>{L("إعادة الفحص / استثناء", "Re-inspect / exception")}</Link> : null}
                    {data.can.request && !h.exception && !open ? (["DESTROY", ...(h.foreign ? [] : ["CONVERT", "BLEND"])] as DispositionKind[]).map((k) => (
                      <Btn key={k} size="sm" onClick={() => { setMsg(null); setForm({ batch: h, kind: k }); }} data-testid={`held-${k}-${h.batchNumber}`}>{DISPOSITION_WORD[k][lang]}</Btn>
                    )) : null}
                  </td>
                </tr>
              );
            })}</tbody>
          </table></div>
        )}
      </section>
      {form ? <RequestForm key={`${form.batch.id}-${form.kind}`} batch={form.batch} kind={form.kind} products={products} passed={passed} onDone={(t) => { setForm(null); setMsg(t); void load(); }} onCancel={() => setForm(null)} /> : null}
      <section>
        <SecHead title={L("قرارات التصرف", "Dispositions")} caption={L("الطلب ثم القرار ثم التنفيذ · كل خطوة باسم صاحبها ووقتها", "Request, decision, execution · each with its actor and time")} />
        {data.dispositions.length === 0 ? <OpsEmpty title={L("لا قرارات تصرف بعد.", "No dispositions yet.")} /> : (
          <div className="hr-tablewrap"><table className="hr-table" aria-label={L("قرارات التصرف", "Dispositions")}>
            <thead><tr><th scope="col">{L("الطلب", "Request")}</th><th scope="col">{L("النوع", "Kind")}</th><th scope="col">{L("الكمية", "Quantity")}</th><th scope="col">{L("السبب", "Reason")}</th><th scope="col">{L("طلبه ← قرّره", "Requested ← decided")}</th><th scope="col">{L("الحالة", "Status")}</th><th scope="col">{L("الإجراء", "Action")}</th></tr></thead>
            <tbody>{data.dispositions.map((d) => <DispRow key={d.id} d={d} data={data} onDone={(t) => { setMsg(t); void load(); }} />)}</tbody>
          </table></div>
        )}
      </section>
    </div>
  );
}

function DispRow({ d, data, onDone }: { d: Disp; data: Data; onDone: (m: { tone: "success" | "danger"; text: string }) => void }) {
  const { lang } = useI18n();
  const L = (ar: string, en: string) => (lang === "ar" ? ar : en);
  const [deciding, setDeciding] = useState<"APPROVE" | "REJECT" | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const own = d.requestedById === data.me ? "requester" : d.inspectorId === data.me ? "inspector" : null;
  async function decide() {
    setBusy(true);
    try {
      const r = await fetch(`/api/qc/dispositions/${encodeURIComponent(d.id)}/decide`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision: deciding, reason: reason.trim() }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { onDone({ tone: "danger", text: localizeApiError(j, lang) ?? "—" }); return; }
      setDeciding(null);
      onDone({ tone: "success", text: j.status === "EXECUTED" ? L(`نُفّذ ${d.number}.`, `${d.number} executed.`) : j.status === "APPROVED" ? L(`اعتُمدت الوصفة ${d.number}. يسجّل الإنتاج الخلط بها.`, `Recipe ${d.number} approved. Production records the blend with it.`) : L(`رُفض ${d.number}.`, `${d.number} rejected.`) });
    } finally { setBusy(false); }
  }
  async function blend() {
    if (!d.recipe) return;
    setBusy(true);
    try {
      const sources = [{ batchId: d.batchId, quantityKg: d.recipe.heldQuantityKg }, ...d.recipe.partners.map((p) => ({ batchId: p.batchId, quantityKg: p.quantityKg }))];
      const r = await fetch("/api/roasting-batches/blend", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": newRequestKey() }, body: JSON.stringify({ sources, dispositionId: d.id }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { onDone({ tone: "danger", text: localizeApiError(j, lang) ?? "—" }); return; }
      onDone({ tone: "success", text: L(`سُجّل الخلط ${j.batchNumber}: الناتج بانتظار فحص الجودة.`, `Blend ${j.batchNumber} recorded: the output awaits QC.`) });
    } finally { setBusy(false); }
  }
  return (
    <tr data-testid={`disp-row-${d.number}`}>
      <td className="hr-id"><bdi>{d.number}</bdi><div className="hr-caption">{at(d.createdAt, lang)}</div></td>
      <td>{DISPOSITION_WORD[d.kind][lang]}{d.recipe ? <div className="hr-caption">{L("مع", "with")} {d.recipe.partners.map((p) => `${p.batchNumber} (${kg2(p.quantityKg)})`).join("، ")}</div> : null}</td>
      <td className="hr-num">{kg2(d.quantityKg)} {L("كغ", "kg")}</td>
      <td>{d.reason}{d.decisionReason ? <div className="hr-caption">{L("القرار:", "Decision:")} {d.decisionReason}</div> : null}</td>
      <td>{d.requestedByName}{d.decidedByName ? ` ← ${d.decidedByName}` : ""}<div className="hr-caption">{at(d.decidedAt, lang)}</div></td>
      <td><Dot tone={d.status === "EXECUTED" ? "success" : d.status === "REJECTED" ? "danger" : d.status === "APPROVED" ? "info" : "warning"}>{d.status === "PENDING" ? L("بانتظار القرار", "Awaiting decision") : d.status === "APPROVED" ? L("معتمدة · بانتظار التنفيذ", "Approved · to execute") : d.status === "EXECUTED" ? L("نُفّذ", "Executed") : d.status === "REJECTED" ? L("رُفض", "Rejected") : d.status}</Dot></td>
      <td>
        {d.status === "PENDING" && data.can.decide ? (own ? <span className="hr-caption">{own === "requester" ? L("طلبته: يقرّره غيرك", "Your request: someone else decides") : L("فحصتها: يقرّره غيرك", "You inspected it: someone else decides")}</span> : deciding ? (
          <div style={{ display: "grid", gap: 6, minWidth: 220 }}>
            <textarea className="hr-textarea" style={{ height: 56, padding: 8 }} placeholder={L("سبب القرار *", "Decision reason *")} value={reason} onChange={(e) => setReason(e.target.value)} data-testid={`disp-reason-${d.number}`} />
            <div style={{ display: "flex", gap: 6 }}>
              <Btn size="sm" variant={deciding === "APPROVE" ? "primary" : "danger"} busy={busy} disabled={reason.trim().length < 3} onClick={() => void decide()} data-testid={`disp-confirm-${d.number}`}>{deciding === "APPROVE" ? L("تأكيد الاعتماد", "Confirm approval") : L("تأكيد الرفض", "Confirm rejection")}</Btn>
              <Btn size="sm" onClick={() => setDeciding(null)}>{L("رجوع", "Back")}</Btn>
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", gap: 6 }}>
            <Btn size="sm" variant="primary" onClick={() => setDeciding("APPROVE")} data-testid={`disp-approve-${d.number}`}>{L("اعتماد", "Approve")}</Btn>
            <Btn size="sm" onClick={() => setDeciding("REJECT")} data-testid={`disp-reject-${d.number}`}>{L("رفض", "Reject")}</Btn>
          </div>
        )) : null}
        {d.status === "APPROVED" && d.kind === "BLEND" && data.can.blend ? <Btn size="sm" variant="primary" busy={busy} onClick={() => void blend()} data-testid={`disp-blend-${d.number}`}>{L("تسجيل الخلط بالوصفة", "Record the blend")}</Btn> : null}
      </td>
    </tr>
  );
}

function RequestForm({ batch, kind, products, passed, onDone, onCancel }: { batch: HeldBatch; kind: DispositionKind; products: Product[]; passed: Passed[]; onDone: (m: { tone: "success" | "danger"; text: string }) => void; onCancel: () => void }) {
  const { lang } = useI18n();
  const L = (ar: string, en: string) => (lang === "ar" ? ar : en);
  const [reason, setReason] = useState("");
  const [qty, setQty] = useState(kg2(batch.availableKg));
  const [target, setTarget] = useState("");
  const [partners, setPartners] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [key] = useState(() => newRequestKey());
  const partnerList = useMemo(() => Object.entries(partners).filter(([, q]) => Number(q) > 0).map(([batchId, q]) => ({ batchId, quantityKg: Number(q) })), [partners]);
  async function send() {
    setBusy(true); setErr(null);
    try {
      const body = { batchId: batch.id, kind, reason: reason.trim(), ...(kind === "DESTROY" ? { quantityKg: Number(qty) } : {}), ...(kind === "CONVERT" ? { targetProductId: target } : {}), ...(kind === "BLEND" ? { heldQuantityKg: Number(qty), partners: partnerList } : {}) };
      const r = await fetch("/api/qc/dispositions", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(localizeApiError(j, lang) ?? "—"); return; }
      onDone({ tone: "success", text: L("أُرسل طلب التصرف. يقرّره شخص آخر.", "Disposition requested. Someone else decides it.") });
    } finally { setBusy(false); }
  }
  return (
    <section data-testid={`disp-form-${kind}`} style={{ display: "grid", gap: 12, padding: 16, borderRadius: 12, background: "var(--hr-surface-subtle, #f6f3ec)" }}>
      <SecHead title={`${DISPOSITION_WORD[kind][lang]} · ${batch.batchNumber}`} caption={kind === "CONVERT" ? L("تُقارن قراءات آخر فحص بمواصفة المنتج الهدف المعتمدة؛ لا يُحوَّل إلا ما يطابقها.", "The last inspection's readings are checked against the target product's approved spec.") : kind === "BLEND" ? L("الوصفة: كمية من الدفعة المحجوزة مع دفعات مقبولة فقط. الناتج يذهب إلى فحص الجودة.", "The recipe: a quantity of the held batch with released batches only. The output goes to QC.") : L("يُسجَّل الإتلاف بحركة فاقد للبن المحمص عند الاعتماد.", "On approval the destruction is written as a roasted-coffee loss movement.")} />
      {kind === "CONVERT" ? (
        <Field label={L("المنتج الهدف *", "Target product *")}>
          <select className="hr-select" value={target} onChange={(e) => setTarget(e.target.value)} data-testid="disp-target">
            <option value="">{L("اختر", "Choose")}</option>
            {products.map((p) => <option key={p.id} value={p.id}>{lang === "ar" ? p.productNameAr || p.productNameEn : p.productNameEn}</option>)}
          </select>
        </Field>
      ) : (
        <Field label={kind === "BLEND" ? L("كمية الدفعة المحجوزة في الوصفة (كغ)", "Held quantity in the recipe (kg)") : L("الكمية (كغ)", "Quantity (kg)")} help={L(`المتاح ${kg2(batch.availableKg)} كغ`, `${kg2(batch.availableKg)} kg held`)}>
          <input className="hr-input" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} data-testid="disp-qty" />
        </Field>
      )}
      {kind === "BLEND" ? (
        <div style={{ display: "grid", gap: 6 }}>
          <span className="hr-label">{L("الدفعات المقبولة في الوصفة", "Released batches in the recipe")}</span>
          {passed.length === 0 ? <span className="hr-caption">{L("لا دفعات مقبولة متاحة.", "No released batch available.")}</span> : passed.slice(0, 12).map((p) => (
            <label key={p.id} style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <bdi className="hr-id" style={{ minWidth: 110 }}>{p.batchNumber}</bdi>
              <span className="hr-caption" style={{ minWidth: 90 }}>{kg2(p.roastedAvailableKg)} {L("كغ", "kg")}</span>
              <input className="hr-input" style={{ width: 110 }} inputMode="decimal" placeholder="0" value={partners[p.id] ?? ""} onChange={(e) => setPartners({ ...partners, [p.id]: e.target.value })} data-testid={`disp-partner-${p.batchNumber}`} />
            </label>
          ))}
        </div>
      ) : null}
      <Field label={L("السبب *", "Reason *")}>
        <textarea className="hr-textarea" style={{ height: 64, padding: 10 }} value={reason} onChange={(e) => setReason(e.target.value)} data-testid="disp-reason" />
      </Field>
      {err ? <Notice tone="danger">{err}</Notice> : null}
      <div style={{ display: "flex", gap: 8 }}>
        <Btn variant="primary" busy={busy} disabled={reason.trim().length < 3 || (kind === "CONVERT" && !target) || (kind === "BLEND" && partnerList.length === 0)} onClick={() => void send()} data-testid="disp-send">{L("إرسال الطلب", "Send the request")}</Btn>
        <Btn onClick={onCancel}>{L("إلغاء", "Cancel")}</Btn>
      </div>
    </section>
  );
}
