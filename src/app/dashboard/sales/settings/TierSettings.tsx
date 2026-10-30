"use client";

// «تصنيف العملاء ويومي» — the thresholds «يومي» classifies a rep's book with (batch 24 WP-B, owner decision 2026-10-30).
// Everybody who opens the sales settings reads them; only the admin role changes them (PUT /api/sales/my-day/settings:
// admin gate with a step-up, audited in the settings trail). Tiers are computed from them at read time, never stored.
import { useEffect, useState } from "react";
import { api, useLang } from "../_components/ui";
import { PerfNote, PerfNotice } from "../_components/perf";
import { useUser } from "../../user-context";

type Settings = Record<string, number>;
const FIELDS: { key: string; ar: string; en: string; unitAr: string; unitEn: string; group: "tier" | "growth" | "contact" | "contract" }[] = [
  { key: "tierVipTopPct", ar: "VIP: أعلى نسبة من عملاء المندوب", en: "VIP: top share of the rep's customers", unitAr: "%", unitEn: "%", group: "tier" },
  { key: "tierVipMinKgMonth", ar: "VIP: أقل كمية بالشهر", en: "VIP: minimum per month", unitAr: "كجم", unitEn: "kg", group: "tier" },
  { key: "tierSmallMaxKgMonth", ar: "صغير: أقل من", en: "Small: below", unitAr: "كجم بالشهر", unitEn: "kg/month", group: "tier" },
  { key: "growthMinPct", ar: "ينمو: زيادة لا تقل عن", en: "Growing: up at least", unitAr: "%", unitEn: "%", group: "growth" },
  { key: "growthMinKgMonth", ar: "ينمو: وزيادة لا تقل عن", en: "Growing: and at least", unitAr: "كجم بالشهر", unitEn: "kg/month", group: "growth" },
  { key: "contactDaysVip", ar: "تواصل مع VIP كل", en: "Contact a VIP every", unitAr: "يوم", unitEn: "days", group: "contact" },
  { key: "contactDaysRegular", ar: "تواصل مع العادي كل", en: "Contact a regular every", unitAr: "يوم", unitEn: "days", group: "contact" },
  { key: "contactDaysSmall", ar: "تواصل مع الصغير كل", en: "Contact a small one every", unitAr: "يوم", unitEn: "days", group: "contact" },
  { key: "contactDaysNew", ar: "تواصل مع الجديد (أول 3 شهور) كل", en: "Contact a new one (first 3 months) every", unitAr: "يوم", unitEn: "days", group: "contact" },
  { key: "callAwaitDays", ar: "بعد ما تكلّم عميل متأخر، يبقى «بانتظار الطلب»", en: "After calling a late customer, keep it «awaiting the order» for", unitAr: "يوم", unitEn: "days", group: "contact" },
  { key: "contractRenewalNoticeDays", ar: "نبّه المندوب قبل نهاية العقد بـ", en: "Tell the rep before a contract ends", unitAr: "يوم", unitEn: "days", group: "contract" },
];

export function TierSettings() {
  const lang = useLang();
  const ar = lang === "ar";
  const admin = useUser()?.role === "admin";
  const [saved, setSaved] = useState<Settings | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");

  useEffect(() => {
    api<{ settings: Settings }>("/api/sales/my-day/settings").then((r) => {
      if (!r.ok) { setError(r.data.error ?? (ar ? "تعذّر التحميل." : "Could not load.")); return; }
      setSaved(r.data.settings);
      setForm(Object.fromEntries(Object.entries(r.data.settings).map(([k, v]) => [k, String(v)])));
    });
  }, [ar]);

  async function save() {
    if (busy) return;
    setBusy(true); setError(""); setOk("");
    const body = Object.fromEntries(Object.entries(form).map(([k, v]) => [k, v.trim()]));
    const r = await api<{ settings: Settings; changed: string[]; errorEn?: string }>("/api/sales/my-day/settings", { method: "PUT", body });
    setBusy(false);
    if (!r.ok) { setError((ar ? r.data.error : r.data.errorEn) ?? r.data.error ?? (ar ? "تعذّر الحفظ." : "Could not save.")); return; }
    setSaved(r.data.settings);
    setOk(r.data.changed.length ? (ar ? "حُفظت الحدود. «يومي» يحسب بها من الحين." : "Saved. «My day» uses them from now on.") : (ar ? "ما فيه تغيير." : "Nothing changed."));
  }

  if (!saved) return error ? <PerfNotice kind="error" ar={ar}>{error}</PerfNotice> : null;
  const groups: { id: "tier" | "growth" | "contact" | "contract"; ar: string; en: string }[] = [
    { id: "tier", ar: "التصنيف (بالكيلو، آخر 3 شهور)", en: "Tiers (kg, last 3 months)" },
    { id: "growth", ar: "«ينمو» (آخر 3 شهور مقابل الـ3 اللي قبلها)", en: "«Growing» (last 3 months vs the 3 before)" },
    { id: "contact", ar: "«ما تواصلت» في قائمة الاتصال", en: "«No contact» on the call list" },
    { id: "contract", ar: "العقود", en: "Contracts" },
  ];
  return (
    <section data-testid="tier-settings" style={{ display: "grid", gap: 12 }}>
      <div className="bh">
        <h2 className="bt">{ar ? "تصنيف العملاء و«يومي»" : "Customer tiers and «My day»"}</h2>
        <span className="sub">{admin ? (ar ? "يعدّلها المدير العام فقط، وكل تعديل يُسجَّل" : "the administrator edits them; every change is logged") : (ar ? "للعرض · يعدّلها المدير العام" : "for reference · the administrator edits them")}</span>
      </div>
      <PerfNotice kind="error" ar={ar} onDismiss={() => setError("")}>{error}</PerfNotice>
      <PerfNotice kind="success" ar={ar} onDismiss={() => setOk("")}>{ok}</PerfNotice>
      <div className="cols perf-cols" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 28 }}>
        {groups.map((g) => (
          <div key={g.id} style={{ display: "grid", gap: 10, alignContent: "start" }}>
            <b style={{ fontWeight: 600, fontSize: 13.5 }}>{ar ? g.ar : g.en}</b>
            {FIELDS.filter((f) => f.group === g.id).map((f) => (
              <label key={f.key} style={{ display: "grid", gap: 4, fontSize: 13 }}>
                <span>{ar ? f.ar : f.en}</span>
                {admin ? (
                  <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <input className="q-set-input" style={{ width: 110 }} inputMode="decimal" value={form[f.key] ?? ""} dir="ltr"
                      onChange={(e) => setForm((x) => ({ ...x, [f.key]: e.target.value }))} data-testid={`tier-${f.key}`} />
                    <span style={{ color: "var(--text-muted)" }}>{ar ? f.unitAr : f.unitEn}</span>
                  </span>
                ) : <b className="num" data-testid={`tier-${f.key}`}>{saved[f.key]} <span style={{ color: "var(--text-muted)", fontWeight: 400 }}>{ar ? f.unitAr : f.unitEn}</span></b>}
              </label>
            ))}
          </div>
        ))}
      </div>
      {admin ? <div><button type="button" className="btn p" disabled={busy} onClick={save} data-testid="tier-save">{busy ? (ar ? "جارٍ الحفظ…" : "Saving…") : (ar ? "حفظ الحدود" : "Save thresholds")}</button></div> : null}
      <PerfNote>
        {ar
          ? "VIP = أعلى نسبة من عملاء المندوب نفسه بكمية الطلبات، بشرط ما يقل عن الحد الأدنى بالشهر. لو عند المندوب أقل من 8 عملاء طلبوا آخر 3 شهور نستخدم الحدود فقط، واللي ما طلب آخر 3 شهور يظهر «بدون طلبات حديثة»."
          : "VIP = the top share of the rep's own customers by kg ordered, and at least the monthly floor. With fewer than 8 customers who ordered in the last 3 months only the floors apply; one with no order in 3 months shows «No recent orders»."}
      </PerfNote>
    </section>
  );
}
