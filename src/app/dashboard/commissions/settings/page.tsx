"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useLang, api, formatDay, num } from "../../sales/_components/ui";
import { PerfHeader, PerfNotice, PerfLoading, PerfNote } from "../../sales/_components/perf";

/**
 * «إعدادات العمولات» — commission plan builder, owner decisions of 24 Oct (Direction 2.1, a new page
 * of «الأداء والعمولات»; no frame exists, built from the A-P07 family's primitives).
 *
 * The new-client window (default 12 months), the lapse period (default 12 months with no collected
 * order), the eligibility (default forever — until the client lapses) and the activation date. A
 * plan inherits these unless it overrides them. Every save is logged with a reason.
 */
type Dur = { value: number; unit: "DAYS" | "MONTHS" };
type Settings = { newClientWindow: Dur; lapse: Dur; eligibility: Dur | null; activationDate: string | null; updatedAt: string | null };
type Log = { id: string; createdAt: string; actorId: string; reason: string | null; before: Record<string, unknown> | null; after: Record<string, unknown> | null };

function DurField({ id, label, value, onChange, allowBlank, blankText, ar }: { id: string; label: string; value: Dur | null; onChange: (v: Dur | null) => void; allowBlank?: boolean; blankText?: string; ar: boolean }) {
  return (
    <div className="cb-f">
      <label htmlFor={`${id}-v`}>{label}</label>
      <span className="cb-dur">
        <span className="cb-num"><input id={`${id}-v`} dir="ltr" inputMode="numeric" style={{ width: 80 }} value={value ? String(value.value) : ""} placeholder={allowBlank ? "—" : ""} data-testid={`${id}-value`}
          onChange={(e) => onChange(e.target.value.trim() === "" && allowBlank ? null : { value: Number(e.target.value) || 0, unit: value?.unit ?? "MONTHS" })} /></span>
        <select value={value?.unit ?? "MONTHS"} disabled={!value} onChange={(e) => value && onChange({ ...value, unit: e.target.value as Dur["unit"] })} data-testid={`${id}-unit`}>
          <option value="MONTHS">{ar ? "شهر" : "months"}</option>
          <option value="DAYS">{ar ? "يوم" : "days"}</option>
        </select>
        {!value && blankText && <span className="cb-hint">{blankText}</span>}
      </span>
    </div>
  );
}

export default function CommissionSettingsPage() {
  const lang = useLang();
  const ar = lang === "ar";
  const [data, setData] = useState<{ settings: Settings; active: boolean; opening: { customers: number; withPriorOrders: number; excluded: number }; log: Log[]; can: { edit: boolean } } | null>(null);
  const [form, setForm] = useState<{ newClientWindow: Dur; lapse: Dur; eligibility: Dur | null; activationDate: string } | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState(0);

  useEffect(() => {
    let off = false;
    (async () => {
      const r = await api<NonNullable<typeof data>>("/api/commissions/settings");
      if (off) return;
      if (r.ok) {
        setData(r.data);
        const s = r.data.settings;
        setForm({ newClientWindow: s.newClientWindow, lapse: s.lapse, eligibility: s.eligibility, activationDate: s.activationDate ? new Date(new Date(s.activationDate).getTime() + 3 * 3600_000).toISOString().slice(0, 10) : "" });
      } else setError(r.data.error ?? "");
    })();
    return () => { off = true; };
  }, [token]);

  if (!data || !form) return error ? <div className="pg"><PerfNotice kind="error" ar={ar}>{error}</PerfNotice></div> : <PerfLoading ar={ar} />;
  const s = data.settings;
  const active = data.active;
  const dur = (d: Dur | null | undefined) => (d ? `${num(d.value, lang)} ${d.unit === "DAYS" ? (ar ? "يوم" : "days") : (ar ? "شهر" : "months")}` : (ar ? "للأبد" : "forever"));

  async function save() {
    setBusy(true); setError("");
    const r = await api("/api/commissions/settings", { method: "PUT", body: { ...form, activationDate: form!.activationDate || null, reason } });
    setBusy(false);
    if (r.ok) { setSuccess(ar ? "حُفظت الإعدادات وسُجّل التغيير." : "Settings saved and logged."); setReason(""); setToken((x) => x + 1); }
    else setError(r.data.error ?? "");
  }

  return (
    <div className="pg">
      <PerfHeader ar={ar} title={ar ? "الأداء والعمولات" : "Performance and commissions"} phoneTitle={ar ? "إعدادات العمولات" : "Commission settings"}
        meta={[
          s.activationDate
            ? <span data-testid="activation-state">{ar ? "تفعيل العمولات من" : "Commissions active from"} <span className="n">{formatDay(s.activationDate, lang)}</span></span>
            : <span data-testid="activation-state" className="flag wa">{ar ? "العمولات غير مفعّلة بعد" : "Commissions not activated yet"}</span>,
          <>{num(data.opening.withPriorOrders, lang)} {ar ? "عميل مُهيّأ" : "customers set up"} · {num(data.opening.excluded, lang)} {ar ? "مستثنى" : "excluded"} · {num(data.opening.customers, lang)} {ar ? "عميل" : "customers"}</>,
        ]}
        actions={<Link className="btn" href="/dashboard/commissions/opening" data-testid="go-opening">{ar ? "تهيئة العملاء الحاليين" : "Existing customers setup"}</Link>} />

      <PerfNotice kind="error" ar={ar} onDismiss={() => setError("")}>{error}</PerfNotice>
      <PerfNotice kind="success" ar={ar} onDismiss={() => setSuccess("")}>{success}</PerfNotice>

      {!s.activationDate && (
        <p className="callout" data-testid="activation-steps">
          {ar
            ? "قبل التفعيل: ١) أكمل «تهيئة العملاء الحاليين» — كل عميل حالي يُعامل عميلاً حالياً بنسبة العملاء الحاليين ما لم تحدد الطلب القادم له. ٢) حدّد تاريخ التفعيل هنا. لا تُحتسب عمولة على تحصيل قبل هذا التاريخ، ويرفض احتساب الشهر حتى يُحدَّد."
            : "Before activation: 1) complete the existing customers setup — every existing customer is an existing client at the existing-client rate unless you set its next order. 2) set the activation date here. No commission is computed on a collection before it, and the monthly run refuses until it is set."}
        </p>
      )}

      <section className="cb-sec" data-testid="settings-form">
        <div className="cb-sec-h"><h3>{ar ? "قواعد العميل الجديد" : "New-client rules"}</h3></div>
        <div className="cb-grid">
          <DurField ar={ar} id="set-window" label={ar ? "العميل الجديد: لم يشترِ خلال" : "New client: bought nothing within"} value={form.newClientWindow} onChange={(v) => v && setForm({ ...form, newClientWindow: v })} />
          <DurField ar={ar} id="set-lapse" label={ar ? "ينقطع العميل بعد (بلا طلب محصّل)" : "A client lapses after (no collected order)"} value={form.lapse} onChange={(v) => v && setForm({ ...form, lapse: v })} />
          <DurField ar={ar} id="set-elig" label={ar ? "مدة الأهلية بعد الاكتساب" : "Eligibility after acquisition"} value={form.eligibility} allowBlank blankText={ar ? "فارغ = للأبد حتى انقطاع العميل" : "blank = forever, until the client lapses"} onChange={(v) => setForm({ ...form, eligibility: v })} />
          <div className="cb-f"><label htmlFor="set-activation">{ar ? "تاريخ تفعيل العمولات" : "Commission activation date"}</label>
            <input id="set-activation" type="date" value={form.activationDate} onChange={(e) => setForm({ ...form, activationDate: e.target.value })} data-testid="set-activation" /></div>
        </div>
        <p className="cb-hint">
          {ar
            ? "تنقطع العمولة بانقطاع العميل: إذا مرّت مدة الانقطاع بلا طلب محصّل توقفت عمولة ترتيب الطلب للعميل. إذا عاد واشترى بعدها يُعامل عميلاً جديداً وفق قاعدة «لم يشترِ خلال»، ويبدأ الترتيب من الطلب الأول للمندوب الذي أعاده. العملاء الذين أُنشئوا بعد تاريخ التفعيل يتبعون قواعد العميل الجديد تلقائياً."
            : "Commission ends when the client lapses: after the lapse period with no collected order the order-sequence commission stops. If the client buys again it counts as a new client under the “bought nothing within” rule, starting again at order 1 for the rep who brings it back. Customers created after the activation date follow the new-client rules automatically."}
        </p>
        <p className="cb-hint">{ar ? "الخطط بالمكوّنات ترث هذه القيم ما لم تتجاوزها الخطة نفسها في منشئ الخطط." : "Component plans inherit these values unless the plan overrides them in the builder."}</p>
        {data.can.edit && (
          <div className="cb-grid" style={{ alignItems: "end" }}>
            <div className="cb-f" style={{ gridColumn: "span 2" }}><label htmlFor="set-reason">{ar ? "سبب التغيير" : "Reason for the change"}</label>
              <input id="set-reason" value={reason} onChange={(e) => setReason(e.target.value)} data-testid="set-reason" /></div>
            <div><button type="button" className="btn p" disabled={busy} onClick={save} data-testid="settings-save">{ar ? "حفظ الإعدادات" : "Save settings"}</button></div>
          </div>
        )}
        {active && <p className="cb-hint">{ar ? "العمولات مفعّلة: تغيير هذه القيم يصل إلى الأشهر عند إعادة احتسابها، ولا يغيّر رقماً معتمداً." : "Commissions are active: a change reaches a month when it is recomputed and never changes an approved figure."}</p>}
      </section>

      <section className="cb-sec" data-testid="settings-log">
        <div className="cb-sec-h"><h3>{ar ? "سجل التغييرات" : "Change log"}</h3></div>
        {data.log.length === 0 ? <p className="cb-hint">{ar ? "لا تغييرات بعد." : "No changes yet."}</p> : (
          <div className="perf-scroll">
            <table className="t dense">
              <thead><tr><th scope="col">{ar ? "الوقت" : "When"}</th><th scope="col">{ar ? "قبل" : "Before"}</th><th scope="col">{ar ? "بعد" : "After"}</th><th scope="col">{ar ? "السبب" : "Reason"}</th></tr></thead>
              <tbody>
                {data.log.map((l) => {
                  const show = (x: Record<string, unknown> | null) => x ? `${ar ? "جديد" : "new"} ${dur(x.newClientWindow as Dur)} · ${ar ? "انقطاع" : "lapse"} ${dur(x.lapse as Dur)} · ${ar ? "أهلية" : "eligibility"} ${dur(x.eligibility as Dur | null)} · ${ar ? "تفعيل" : "activation"} ${x.activationDate ? formatDay(String(x.activationDate), lang) : "—"}` : "—";
                  return (
                    <tr key={l.id}>
                      <td className="n">{formatDay(l.createdAt, lang)}</td>
                      <td className="sm">{show(l.before)}</td>
                      <td className="sm">{show(l.after)}</td>
                      <td>{l.reason ?? "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <PerfNote><span>{ar ? "التاريخ بتوقيت الرياض. الحساب الشهري يرفض قبل تحديد تاريخ التفعيل." : "Dates are Riyadh dates. The monthly run refuses until the activation date is set."}</span></PerfNote>
    </div>
  );
}
