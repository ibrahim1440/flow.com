"use client";
// Settings › Inventory («المخزون» in the settings navigation of GX F-P01 1205:2). No Figma frame
// draws this page: it holds the one inventory figure the system already used as a constant — the
// green-coffee low-stock line of the inventory screen («أصناف أقل من 20 كغ», Figma 251:2482) —
// in the label-column sections of F-P01, and points to where the per-item reorder points live.
// GET / PUT /api/settings/inventory (admin role, step-up, audited). «حد النقص عند الاستلام» (feat/shortfall-threshold):
// above any limit a receiver's shortfall needs inventory › adjust and the stock-change gate (a supervisor).
import Link from "next/link";
import { useEffect, useState } from "react";
import { Btn, OpsLoading, OpsRoot, PageHeader, useL } from "@/components/ops/ui";
import { Ico } from "@/components/shell/icons";
import { useD21Phone } from "@/components/shell/page-context";
import { routeAllowed } from "@/lib/nav/registry";
import { Sec, SettingsFrame, useViewer } from "../../_components/tools-ui";
import { SingleSetting } from "../_parts/single-setting";
import "../_parts/sections.css";

type Shortfall = {
  stored: { percent: string | null; valueSar: string | null; zeroNeedsAdjust: boolean | null; rollingMultiple: string | null };
  effective: { percent: number; valueSar: number; zeroNeedsAdjust: boolean; rollingMultiple: number };
  defaults: { percent: number; valueSar: number; zeroNeedsAdjust: boolean; rollingMultiple: number };
  /** Council F3: the limits set high enough that a large shortfall passes without a supervisor. */
  high: ("PERCENT" | "VALUE" | "ZERO")[];
};
type Inv = { lowStockGreenKg: string | null; effectiveLowStockGreenKg: string; isDefault: boolean; range: { default: number }; shortfall: Shortfall; supplierShortfall: SupplierShortfall; can: { edit: boolean } };
/** «نقص من المورد» (20261119090000_supplier_shortfall): the weight tolerance and the abandonment's VAT reversal. */
type SupplierShortfall = { stored: { tolerancePercent: string | null; abandonReverseVat: boolean | null }; effective: { tolerancePercent: number; abandonReverseVat: boolean }; defaults: { tolerancePercent: number; abandonReverseVat: boolean } };

export default function InventorySettingsPage() {
  const L = useL();
  const viewer = useViewer();
  const [s, setS] = useState<Inv | null>(null);
  const [failed, setFailed] = useState(false);
  useD21Phone({ title: L("المخزون", "Inventory"), sub: L("الإعدادات", "Settings"), back: "/dashboard/settings" });
  useEffect(() => {
    fetch("/api/settings/inventory", { cache: "no-store" }).then((r) => (r.ok ? r.json() : Promise.reject())).then(setS).catch(() => setFailed(true));
  }, []);

  return (
    <OpsRoot className="tl-root">
      <SettingsFrame>
        <PageHeader title={L("المخزون", "Inventory")} />
        <p className="tl-sub">{L("إعدادات النظام", "System settings")}<span className="tl-sep">·</span>{L("للمدير فقط", "admins only")}</p>
        {failed ? <div className="hr-notice tone-danger" role="alert">{L("تعذّر التحميل.", "Could not load.")}</div> : !s ? <OpsLoading rows={4} /> : (
          <div data-testid="inventory-settings">
            <Sec title={L("المخزون المنخفض", "Low stock")} caption={L("يُعلَّم البن الأخضر الأقل من هذا الحد «مخزون منخفض» في شاشة المخزون", "Green coffee below this line is flagged «low stock» on the inventory screen")} testId="low-stock">
              <SingleSetting
                url="/api/settings/inventory" field="lowStockGreenKg" testId="low-stock"
                stored={s.lowStockGreenKg} effective={s.effectiveLowStockGreenKg} isDefault={s.isDefault} canEdit={s.can.edit}
                label={L("حد المخزون المنخفض للبن الأخضر", "Green coffee low-stock line")}
                help={L(`فارغ = الافتراضي ${s.range.default} كغ · لكل صنف`, `Empty = the default ${s.range.default} kg · per bean`)}
                unit={L("كغ", "kg")}
                onSaved={(j) => setS((x) => (x ? { ...x, ...(j as Partial<Inv>) } : x))}
                savedText={(j) => L(`حُفظ. شاشة المخزون تعلّم الآن الأصناف الأقل من ${String(j.effectiveLowStockGreenKg)} كغ.`, `Saved. The inventory screen now flags beans below ${String(j.effectiveLowStockGreenKg)} kg.`)}
              />
            </Sec>
            <Sec title={L("حد النقص عند الاستلام", "Shortfall limit at receipt")} caption={L("نقص أكبر من أي حد هنا لا يسجّله المستلم وحده: يحتاج صلاحية «تسوية المخزون» وتأكيد الهوية (مشرف)", "A shortfall above any limit here is not recorded on the receiver's word alone: it needs «adjust stock» and an identity confirmation (a supervisor)")} testId="shortfall-limit">
              <SingleSetting
                url="/api/settings/inventory" field="shortfallPercent" testId="shortfall-percent"
                stored={s.shortfall.stored.percent} effective={String(s.shortfall.effective.percent)} isDefault={s.shortfall.stored.percent === null} canEdit={s.can.edit}
                label={L("نسبة النقص من كمية السطر", "Shortfall as a share of the line")}
                help={L(`من 0 إلى 100 · فارغ = الافتراضي ${s.shortfall.defaults.percent}٪`, `0 to 100 · empty = the default ${s.shortfall.defaults.percent} %`)}
                unit="%"
                onSaved={(j) => setS((x) => (x ? { ...x, ...(j as Partial<Inv>) } : x))}
                savedText={(j) => L(`حُفظ. النقص أكثر من ${String((j as Inv).shortfall.effective.percent)}٪ من السطر يحتاج مشرفًا.`, `Saved. A shortfall above ${String((j as Inv).shortfall.effective.percent)} % of the line needs a supervisor.`)}
              />
              <SingleSetting
                url="/api/settings/inventory" field="shortfallValueSar" testId="shortfall-value"
                stored={s.shortfall.stored.valueSar} effective={String(s.shortfall.effective.valueSar)} isDefault={s.shortfall.stored.valueSar === null} canEdit={s.can.edit}
                label={L("قيمة النقص بمتوسط التكلفة", "Shortfall value at the moving average")}
                help={L(`صفر فأكثر · فارغ = الافتراضي ${s.shortfall.defaults.valueSar} ر.س`, `0 or more · empty = the default SAR ${s.shortfall.defaults.valueSar}`)}
                unit={L("ر.س", "SAR")}
                onSaved={(j) => setS((x) => (x ? { ...x, ...(j as Partial<Inv>) } : x))}
                savedText={(j) => L(`حُفظ. النقص بقيمة أكثر من ${String((j as Inv).shortfall.effective.valueSar)} ر.س يحتاج مشرفًا.`, `Saved. A shortfall worth more than SAR ${String((j as Inv).shortfall.effective.valueSar)} needs a supervisor.`)}
              />
              <ZeroToggle s={s} onSaved={(j) => setS((x) => (x ? { ...x, ...(j as Partial<Inv>) } : x))} />
              <SingleSetting
                url="/api/settings/inventory" field="shortfallRollingMultiple" testId="shortfall-rolling"
                stored={s.shortfall.stored.rollingMultiple} effective={String(s.shortfall.effective.rollingMultiple)} isDefault={s.shortfall.stored.rollingMultiple === null} canEdit={s.can.edit}
                label={L("مجموع نقص المستلم خلال 30 يومًا (مضاعف حد القيمة)", "A receiver's shortfalls over 30 days (times the value limit)")}
                help={L(`فارغ = الافتراضي ${s.shortfall.defaults.rollingMultiple} × · الآن ${s.shortfall.effective.rollingMultiple * s.shortfall.effective.valueSar} ر.س`, `Empty = the default ${s.shortfall.defaults.rollingMultiple} × · now SAR ${s.shortfall.effective.rollingMultiple * s.shortfall.effective.valueSar}`)}
                unit="×"
                onSaved={(j) => setS((x) => (x ? { ...x, ...(j as Partial<Inv>) } : x))}
                savedText={(j) => L(`حُفظ. من تجاوز نقصُه خلال 30 يومًا ${String((j as Inv).shortfall.effective.rollingMultiple)} × حد القيمة يحتاج مشرفًا.`, `Saved. A receiver past ${String((j as Inv).shortfall.effective.rollingMultiple)} × the value limit in 30 days needs a supervisor.`)}
              />
              {s.shortfall.high.length ? (
                <div className="hr-notice tone-warning" role="status" data-testid="shortfall-high">
                  <strong>{L("تحذير: الحد مرتفع، النقص الكبير سيمر بدون مشرف", "Warning: the limit is high — a large shortfall will pass without a supervisor")}</strong>
                  {" · "}{s.shortfall.high.map((h) => h === "PERCENT" ? L(`النسبة ${s.shortfall.effective.percent}٪ (50٪ فأكثر)`, `percent ${s.shortfall.effective.percent} % (50 % or more)`) : h === "VALUE" ? L(`القيمة ${s.shortfall.effective.valueSar} ر.س (10,000 فأكثر)`, `value SAR ${s.shortfall.effective.valueSar} (10,000 or more)`) : L("الاستلام بصفر لا يحتاج مشرفًا", "a line received at zero needs no supervisor")).join(L("، ", ", "))}
                </div>
              ) : null}
            </Sec>
            <Sec title={L("نقص من المورد", "Supplier shortfall")} caption={L("فاتورة المشتريات حين يصل أقل مما فوترَه المورد: النقص ضمن حد التسامح يُحمَّل على التكلفة، وما فوقه مطالبة على المورد", "A purchase invoice that received less than the supplier billed: a shortfall within the tolerance goes into the cost, above it it is a claim on the supplier")} testId="supplier-shortfall">
              <SingleSetting
                url="/api/settings/inventory" field="purchaseShortfallTolerancePercent" testId="supplier-shortfall-tolerance"
                stored={s.supplierShortfall.stored.tolerancePercent} effective={String(s.supplierShortfall.effective.tolerancePercent)} isDefault={s.supplierShortfall.stored.tolerancePercent === null} canEdit={s.can.edit}
                label={L("حد التسامح في الوزن (من كمية الفاتورة)", "Weight tolerance (of the billed quantity)")}
                help={L(`من 0 إلى 2 · فارغ = الافتراضي ${s.supplierShortfall.defaults.tolerancePercent}٪ · فاقد طبيعي (IAS 2)`, `0 to 2 · empty = the default ${s.supplierShortfall.defaults.tolerancePercent} % · a normal loss (IAS 2)`)}
                unit="%"
                onSaved={(j) => setS((x) => (x ? { ...x, ...(j as Partial<Inv>) } : x))}
                savedText={(j) => L(`حُفظ. نقص حتى ${String((j as Inv).supplierShortfall.effective.tolerancePercent)}٪ يُحمَّل على التكلفة ما لم يُختر غير ذلك.`, `Saved. A shortfall up to ${String((j as Inv).supplierShortfall.effective.tolerancePercent)} % goes into the cost unless chosen otherwise.`)}
              />
              {s.supplierShortfall.effective.tolerancePercent > 1 ? (
                <div className="hr-notice tone-warning" role="status" data-testid="supplier-shortfall-high">
                  <strong>{L("تحذير: حد التسامح أعلى من 1٪", "Warning: the tolerance is above 1 %")}</strong>
                  {" · "}{L(`نقص حتى ${s.supplierShortfall.effective.tolerancePercent}٪ من الفاتورة يُحمَّل على تكلفة المخزون بلا مطالبة ولا خسارة`, `a shortfall up to ${s.supplierShortfall.effective.tolerancePercent} % of the invoice goes into the stock's cost with no claim and no loss`)}
                </div>
              ) : null}
              <AbandonVatToggle s={s} onSaved={(j) => setS((x) => (x ? { ...x, ...(j as Partial<Inv>) } : x))} />
            </Sec>
            <Sec title={L("مواد التعبئة", "Packaging materials")} caption={L("تُدار في صفحاتها المعتمدة ولا تتكرر هنا", "Managed on their own approved pages, not repeated here")}>
              {viewer && routeAllowed(viewer, "/dashboard/inventory") ? (
                <div className="tl-card">
                  <Ico name="box" />
                  <div>
                    <strong>{L("نقاط إعادة الطلب", "Reorder points")}</strong>
                    <p>{L("لكل مادة تعبئة حدّها، يُعدَّل من بطاقتها في «المخزون › مواد التعبئة»", "Each packaging material has its own point, edited on its card in «Inventory › Packaging materials»")}</p>
                  </div>
                  <Link href="/dashboard/inventory?tab=pack" className="hr-btn is-sm" style={{ textDecoration: "none" }}>{L("فتح", "Open")}</Link>
                </div>
              ) : <p className="ss-muted">{L("لا تملك صلاحية فتح المخزون.", "You cannot open inventory.")}</p>}
            </Sec>
          </div>
        )}
      </SettingsFrame>
    </OpsRoot>
  );
}

/** «الاستلام بصفر يحتاج مشرفًا»: on / off (null = the default, on). PUT shortfallZeroNeedsAdjust. */
function ZeroToggle({ s, onSaved }: { s: Inv; onSaved: (j: Record<string, unknown>) => void }) {
  const L = useL();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const on = s.shortfall.effective.zeroNeedsAdjust;
  async function put(v: boolean | null) {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch("/api/settings/inventory", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ shortfallZeroNeedsAdjust: v }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setMsg({ ok: false, text: L(j.error ?? "تعذّر الحفظ. لم يتغير شيء.", j.errorEn ?? j.error ?? "Could not save. Nothing was changed.") }); return; }
      onSaved(j);
      setMsg({ ok: true, text: (j as Inv).shortfall.effective.zeroNeedsAdjust ? L("حُفظ. السطر المستلم بصفر يحتاج مشرفًا.", "Saved. A line received at zero needs a supervisor.") : L("حُفظ. السطر المستلم بصفر يتبع حدّي النسبة والقيمة فقط.", "Saved. A line received at zero follows the percent and value limits only.") });
    } catch {
      setMsg({ ok: false, text: L("تعذّر الحفظ. لم يتغير شيء.", "Could not save. Nothing was changed.") });
    } finally { setBusy(false); }
  }
  return (
    <div className="ss-setrow" data-testid="shortfall-zero">
      <label className="hr-check" style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input type="checkbox" checked={on} disabled={!s.can.edit || busy} onChange={(e) => void put(e.target.checked)} data-testid="shortfall-zero-input" />
        <span>{L("الاستلام بصفر يحتاج مشرفًا", "Receiving a line at zero needs a supervisor")}</span>
        <span className="hr-caption">{s.shortfall.stored.zeroNeedsAdjust === null ? L("(الافتراضي: مفعّل)", "(the default: on)") : null}</span>
      </label>
      {s.can.edit && s.shortfall.stored.zeroNeedsAdjust !== null ? <Btn size="sm" variant="ghost" disabled={busy} onClick={() => void put(null)} data-testid="shortfall-zero-reset">{L("العودة إلى الافتراضي", "Back to the default")}</Btn> : null}
      {msg ? <p className={`hr-caption tone-${msg.ok ? "success" : "danger"}`} role="status" data-testid="shortfall-zero-msg">{msg.text}</p> : null}
    </div>
  );
}

/** «التنازل عن المطالبة يعكس ضريبة مدخلاتها»: on / off (null = the default, on). PUT purchaseAbandonReverseVat. */
function AbandonVatToggle({ s, onSaved }: { s: Inv; onSaved: (j: Record<string, unknown>) => void }) {
  const L = useL();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const on = s.supplierShortfall.effective.abandonReverseVat;
  async function put(v: boolean | null) {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch("/api/settings/inventory", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ purchaseAbandonReverseVat: v }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setMsg({ ok: false, text: L(j.error ?? "تعذّر الحفظ. لم يتغير شيء.", j.errorEn ?? j.error ?? "Could not save. Nothing was changed.") }); return; }
      onSaved(j);
      setMsg({ ok: true, text: (j as Inv).supplierShortfall.effective.abandonReverseVat ? L("حُفظ. التنازل عن مطالبة يعكس ضريبة مدخلاتها.", "Saved. Abandoning a claim reverses its input VAT.") : L("حُفظ. التنازل عن مطالبة يُبقي ضريبة مدخلاتها.", "Saved. Abandoning a claim keeps its input VAT.") });
    } catch {
      setMsg({ ok: false, text: L("تعذّر الحفظ. لم يتغير شيء.", "Could not save. Nothing was changed.") });
    } finally { setBusy(false); }
  }
  return (
    <div className="ss-setrow" data-testid="supplier-shortfall-vat">
      <label className="hr-check" style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input type="checkbox" checked={on} disabled={!s.can.edit || busy} onChange={(e) => void put(e.target.checked)} data-testid="supplier-shortfall-vat-input" />
        <span>{L("التنازل عن مطالبة المورد يعكس ضريبة مدخلاتها", "Abandoning a supplier claim reverses its input VAT")}</span>
        <span className="hr-caption">{s.supplierShortfall.stored.abandonReverseVat === null ? L("(الافتراضي: مفعّل)", "(the default: on)") : null}</span>
      </label>
      <p className="hr-caption">{L("تحقق مع مستشارك الضريبي.", "Check with your tax adviser.")}</p>
      {s.can.edit && s.supplierShortfall.stored.abandonReverseVat !== null ? <Btn size="sm" variant="ghost" disabled={busy} onClick={() => void put(null)} data-testid="supplier-shortfall-vat-reset">{L("العودة إلى الافتراضي", "Back to the default")}</Btn> : null}
      {msg ? <p className={`hr-caption tone-${msg.ok ? "success" : "danger"}`} role="status" data-testid="supplier-shortfall-vat-msg">{msg.text}</p> : null}
    </div>
  );
}
