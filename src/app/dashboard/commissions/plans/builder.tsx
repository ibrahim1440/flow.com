"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api, formatMoney } from "../../sales/_components/ui";
import type { Components, BonusBracket, OverTargetBand, Duration, TemplateExplanation } from "@/lib/services/commissions/builder";

/**
 * «منشئ خطط العمولة» — the plan builder (commission plan builder, Direction 2.1, extending GX
 * A-P07 «خطط العمولات» `1228:113728`, where the frame has only tiered plans).
 *
 * A COMPONENTS plan version is three switchable components, every value editable:
 *   A «عمولة العملاء الجدد حسب ترتيب الطلب» — rows «الطلب رقم N → النسبة», the last meaning
 *     "and after"; the existing-client rate; the new-client window; the eligibility duration;
 *   B «مكافأة تحقيق المستهدف» — brackets «من % إلى % → مبلغ ثابت / تقديري بقرار الإدارة / لا شيء»;
 *   C «الحافز الحدّي فوق المستهدف» — bands «من % إلى % → نسبة على الزائد فقط»;
 * then the general settings (monthly period, SAR, effective date) and «محاكاة» like the
 * workbook's Simulation sheet. Saving: a new plan, an in-place edit of a version nobody is on
 * yet, or a NEW VERSION from an effective date (so past months keep the version they were
 * computed with), optionally moving the people on the plan to it.
 */

export type BuilderMode =
  | { kind: "create"; templateKey?: string | null; components: Components; explanations?: TemplateExplanation[] | null }
  | { kind: "edit"; planId: string; planCode: string; planName: string; versionId: string; version: number; components: Components; effectiveFrom: string; explanations?: TemplateExplanation[] | null; editableInPlace: boolean };


/** English for the builder's Arabic (Arabic-first; the page follows the user's language). */
const EN: Record<string, string> = {
"فترة العميل الجديد والانقطاع والأهلية من «إعدادات العمولات»": "New-client window, lapse and eligibility from the commission settings",
"من الإعدادات الآن:": "From the settings now:",
"العميل الجديد لم يشترِ خلال": "a new client bought nothing within",
"الانقطاع بعد": "lapses after",
"بلا طلب محصّل": "with no collected order",
"الأهلية": "eligibility",
"للأبد حتى انقطاع العميل": "forever, until the client lapses",
"تُقرأ من «إعدادات العمولات».": "Read from the commission settings.",
"مدة الانقطاع (بلا طلب محصّل)": "Lapse period (no collected order)",
"فارغ = لا ينقطع": "blank = never lapses",
"فارغ = للأبد حتى الانقطاع": "blank = forever, until the lapse",
"تنقطع العمولة بانقطاع العميل: إذا مرّت مدة الانقطاع بلا طلب محصّل توقفت عمولة ترتيب الطلب، وإذا عاد العميل واشترى بعدها يُعامل عميلاً جديداً وفق قاعدة فترة العميل الجديد، ويبدأ الترتيب من الطلب الأول للمندوب الذي أعاده.": "Commission ends when the client lapses: after the lapse period with no collected order the order-sequence commission stops, and if the client buys again it counts as a new client under the new-client window rule, starting again at order 1 for the rep who brings it back.",
" وما بعده": " and after",
"+ شريحة حافز": "+ Band",
"+ شريحة مكافأة": "+ Bracket",
"+ صف طلب": "+ Order row",
"أ. عمولة العملاء الجدد حسب ترتيب الطلب": "A. New-client commission by order sequence",
"أُضيف إصدار جديد بتاريخ السريان.": "A new version was added from its effective date.",
"أُنشئت الخطة.": "Plan created.",
"إجمالي التعويض الشهري": "Total monthly pay",
"إجمالي المتغير": "Total variable",
"إصدار جديد بتاريخ سريان": "New version from a date",
"إلغاء": "Cancel",
"إلى %": "To %",
"إلى أقل من %": "Below %",
"احسب المحاكاة": "Run simulation",
"الإعدادات العامة": "General",
"الاسم بالإنجليزية": "English name",
"الاسم بالعربية": "Arabic name",
"الحافز فوق المستهدف": "Over-target incentive",
"الحد الأدنى داخل الشريحة والأعلى خارجها: 99.99% في شريحة 80–100، و100% في التالية. «تقديري» يطلب قرار الإدارة (مبلغ أو صفر مع السبب) قبل اعتماد الشهر.": "The lower bound is inside a bracket and the upper outside it: 99.99% is in 80–100, 100% in the next. “Discretionary” needs management's decision (an amount or zero, with a reason) before the month is approved.",
"الراتب الثابت المُدخل للمحاكاة.": "Fixed pay as entered for the simulation.",
"الراتب الثابت من الموارد البشرية لـ": "Fixed pay from HR for",
"الراتب الثابت من سجل الموارد البشرية.": "Fixed pay from the HR record.",
"الرمز": "Code",
"السيناريو": "Scenario",
"السيناريوهات (% من المستهدف)": "Scenarios (% of target)",
"الطلب المحصّل": "Collected order",
"العملة": "Currency",
"العميل المعلَّم «مستثنى من عمولة العميل الجديد» في ملفه (كان نشطاً أو جارٍ التفاوض معه قبل المندوب) يُعامل كعميل حالي.": "A client flagged “excluded from new-client commission” on its file (active or in negotiation before the rep) counts as an existing client.",
"الفترة": "Period",
"المبلغ": "Amount",
"المبيعات المحصّلة": "Collected sales",
"المدخلات (أرقام الشهر)": "Inputs (the month's figures)",
"المستهدف الشهري": "Monthly target",
"المكافأة": "Bonus",
"النسبة": "Rate",
"النسبة على الزائد فقط": "Rate on the excess only",
"النسخة مُسندة أو لها استحقاقات: التعديل إصدار جديد، والأشهر السابقة تبقى محسوبة بنسختها.": "This version is assigned or has accruals: a change is a new version, and past months stay computed with theirs.",
"ب. مكافأة تحقيق المستهدف الشهري": "B. Monthly target achievement bonus",
"بتوزيع «مبالغ» تبقى عمولة العملاء ثابتة في كل السيناريوهات كما في ملف المحاكاة؛ اختر «نِسَب %» لتتغير مع مبيعات السيناريو.": "With “amounts” the client commission stays the same in every scenario, as in the simulation workbook; choose “%” to scale it with the scenario's sales.",
"تعديل": "Edit",
"تعديل هذه النسخة": "Edit this version",
"تعذّر الحفظ.": "Could not save.",
"تعذّرت المحاكاة.": "The simulation failed.",
"تقديري": "discretionary",
"تقديري بقرار الإدارة": "Discretionary (management)",
"توزيع الطلبات": "Order mix",
"ج. الحافز الإضافي بعد تجاوز المستهدف (حدّي)": "C. Over-target incentive (marginal)",
"حذف": "Remove",
"حذف الشريحة": "Remove the bracket",
"حذف الصف": "Remove the row",
"حفظ التعديلات": "Save changes",
"حفظ الخطة": "Save plan",
"حفظ كإصدار جديد": "Save as a new version",
"حُفظت التعديلات على النسخة.": "The version was saved.",
"خطة عمولة جديدة بالمكوّنات": "New component-based commission plan",
"ر.س": "SAR",
"راتب ثابت للمحاكاة (اختياري)": "Fixed pay for the simulation (optional)",
"ريال سعودي (SAR)": "Saudi riyal (SAR)",
"سارية من": "Effective from",
"سريان الإصدار الجديد من": "New version effective from",
"سيناريوهات بنسبة من المستهدف ومبالغ مخصصة، بتوزيع الطلبات الأول / الثاني / الثالث فأكثر — كجدول المحاكاة في ملف العمولات.": "Scenarios at a percentage of target and custom amounts, with the first / second / third+ order mix — like the workbook's Simulation sheet.",
"شهر": "months",
"شهرية": "Monthly",
"طريقة الحفظ": "How to save",
"عمولة العملاء": "Client commission",
"عمولة العملاء = مبيعات السيناريو موزّعة على الطلبات بالنسب أعلاه.": "Client commission = the scenario's sales split across orders by the percentages above.",
"فأكثر": "and above",
"فارغ = بلا حد": "blank = no limit",
"فارغ = لم يشترِ قط": "blank = never bought",
"فارغ = مبلغ الخطة": "blank = the plan's amount",
"فترة «العميل الجديد»: لم يشترِ خلال": "New-client window: bought nothing within",
"قابلة لقرار بديل": "Override",
"كل المبيعات المحصّلة": "All collected sales",
"كل قيمة قابلة للتعديل، وكل مكوّن يمكن إيقافه. العمولة تُحسب على المبالغ المحصّلة والمعتمدة فقط.": "Every value is editable and every component can be switched off. Commission is computed on collected and approved amounts only.",
"لا راتب ثابت: عمود الإجمالي الشهري فارغ.": "No fixed pay: the total monthly column is empty.",
"لا شيء": "None",
"للإدارة مبلغ بديل": "Management may override",
"لم يُسند أحد إلى هذه النسخة بعد، فيمكن تعديلها مباشرة.": "Nobody is on this version yet, so it can be edited directly.",
"ما يُحتسب من المستهدف": "Counts toward the target",
"مبالغ": "Amounts",
"مبالغ مخصصة": "Custom amounts",
"مبلغ بديل للشريحة العليا": "Top bracket override",
"مبلغ ثابت": "Fixed amount",
"مبلغ ثابت حسب نسبة تحقيق المستهدف الشهري من المبيعات المحصّلة المؤهلة.": "A fixed amount by the month's achievement of qualified collected sales.",
"مبيعات العملاء الجدد المحصّلة (المؤهلة)": "Collected new-client sales (qualified)",
"متوقف": "Off",
"مثال: عند 130% من مستهدف 50,000: ‏10,000 × 0.5% + 5,000 × 1% = 100 ر.س — لا 65,000 × 1%.": "Example: at 130% of a 50,000 target: 10,000 × 0.5% + 5,000 × 1% = SAR 100 — not 65,000 × 1%.",
"محاكاة": "Simulation",
"مدة الأهلية بعد الاكتساب": "Eligibility after acquisition",
"مفعّل": "On",
"مكافأة المستهدف": "Target bonus",
"مكافأة تقديرية (80–99%)": "Discretionary bonus (80–99%)",
"من %": "From %",
"نسبة التحقيق": "Achievement",
"نسبة العملاء الحاليين / غير الجدد": "Existing / non-new client rate",
"نسبة على المبلغ الزائد داخل كل شريحة فقط، لا على كامل المبيعات.": "A rate on the amount inside each band only, never on total sales.",
"نسبة على صافي المبيعات المحصّلة فعلياً حسب رقم طلب العميل؛ الصف الأخير يعني «وما بعده».": "A rate on net sales actually collected, by the client's order number; the last row means “and after”.",
"نقل الموظفين المسندين إلى الإصدار الجديد من تاريخ سريانه": "Move the people on this plan to the new version from its effective date",
"نِسَب %": "%",
"يوم": "days",
"يُقرَّر في مراجعة العمولات": "Decided in the commission review"
};
const ArCtx = createContext(true);
function useT() {
  const ar = useContext(ArCtx);
  return (a: string) => (ar ? a : EN[a] ?? a);
}

/** The Riyadh calendar day of a stored instant (UTC+03:00, no daylight saving) — what a date field shows. */
const riyadhDay = (iso: string) => new Date(new Date(iso).getTime() + 3 * 3600_000).toISOString().slice(0, 10);

const SCENARIOS = ["50", "70", "80", "90", "100", "120", "150", "180", "200"];

function Section({ title, sub, on, onToggle, testId, children }: { title: string; sub?: ReactNode; on?: boolean; onToggle?: (v: boolean) => void; testId: string; children: ReactNode }) {
  const t = useT();
  return (
    <section className="cb-sec" data-testid={testId} data-on={on === undefined ? undefined : on ? "1" : "0"}>
      <div className="cb-sec-h">
        <h3>{title}</h3>
        {onToggle && (
          <label className="cb-switch">
            <input type="checkbox" checked={!!on} onChange={(e) => onToggle(e.target.checked)} data-testid={`${testId}-toggle`} />
            <span>{on ? t("مفعّل") : t("متوقف")}</span>
          </label>
        )}
      </div>
      {sub && <p className="cb-sub">{sub}</p>}
      <div className="cb-sec-b" aria-disabled={on === false || undefined}>{children}</div>
    </section>
  );
}

function Num({ id, value, onChange, label, suffix, width = 110, disabled, placeholder }: { id: string; value: string; onChange: (v: string) => void; label?: string; suffix?: string; width?: number; disabled?: boolean; placeholder?: string }) {
  return (
    <span className="cb-num">
      {label && <label htmlFor={id} className="sr-only">{label}</label>}
      <input id={id} inputMode="decimal" dir="ltr" value={value} placeholder={placeholder} disabled={disabled} style={{ width }} onChange={(e) => onChange(e.target.value)} data-testid={id} />
      {suffix && <span className="cb-suf">{suffix}</span>}
    </span>
  );
}

function DurationInput({ id, value, onChange, emptyLabel }: { id: string; value: Duration | null; onChange: (v: Duration | null) => void; emptyLabel: string }) {
  const t = useT();
  return (
    <span className="cb-dur">
      <Num id={`${id}-value`} value={value ? String(value.value) : ""} width={80} placeholder="—"
        onChange={(v) => onChange(v.trim() === "" ? null : { value: Number(v) || 0, unit: value?.unit ?? "MONTHS" })} />
      <select id={`${id}-unit`} value={value?.unit ?? "MONTHS"} disabled={!value} onChange={(e) => value && onChange({ ...value, unit: e.target.value as Duration["unit"] })} data-testid={`${id}-unit`}>
        <option value="MONTHS">{t("شهر")}</option>
        <option value="DAYS">{t("يوم")}</option>
      </select>
      {!value && <span className="cb-hint">{emptyLabel}</span>}
    </span>
  );
}

const pctLabel = (ar: boolean, from: string, to: string | null) => (to === null || to === "" ? (ar ? `${from}% فأكثر` : `${from}% and above`) : ar ? `من ${from}% إلى أقل من ${to}%` : `${from}% to below ${to}%`);

type SettingsView = { newClientWindow: Duration; lapse: Duration; eligibility: Duration | null; activationDate: string | null };

export function PlanBuilder({ ar, mode, canSeePay, employees, onClose, onSaved }: {
  ar: boolean;
  mode: BuilderMode;
  canSeePay: boolean;
  employees: { id: string; name: string }[];
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const t = (a: string) => (ar ? a : EN[a] ?? a);
  const [c, setC] = useState<Components>(() => JSON.parse(JSON.stringify(mode.components)) as Components);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [nameAr, setNameAr] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState(mode.kind === "edit" ? riyadhDay(mode.effectiveFrom) : new Date().toISOString().slice(0, 8) + "01");
  const [saveAs, setSaveAs] = useState<"inplace" | "version">(mode.kind === "edit" && mode.editableInPlace ? "inplace" : "version");
  const [moveAssignees, setMoveAssignees] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string[]>([]);
  const [settings, setSettings] = useState<SettingsView | null>(null);
  useEffect(() => {
    let off = false;
    void api<{ settings: SettingsView }>("/api/commissions/settings").then((r) => { if (!off && r.ok) setSettings(r.data.settings); });
    return () => { off = true; };
  }, []);
  const durText = (d: Duration) => `${d.value} ${d.unit === "DAYS" ? t("يوم") : t("شهر")}`;

  const os = c.orderSequence, tb = c.targetBonus, ot = c.overTarget;
  const set = (patch: Partial<Components>) => setC((x) => ({ ...x, ...patch }));
  const setOS = (patch: Partial<Components["orderSequence"]>) => setC((x) => ({ ...x, orderSequence: { ...x.orderSequence, ...patch } }));
  const setBracket = (i: number, patch: Partial<BonusBracket>) => setC((x) => ({ ...x, targetBonus: { ...x.targetBonus, brackets: x.targetBonus.brackets.map((b, j) => (j === i ? { ...b, ...patch } : b)) } }));
  const setBand = (i: number, patch: Partial<OverTargetBand>) => setC((x) => ({ ...x, overTarget: { ...x.overTarget, bands: x.overTarget.bands.map((b, j) => (j === i ? { ...b, ...patch } : b)) } }));
  const explain = (k: TemplateExplanation["key"]) => mode.explanations?.find((e) => e.key === k)?.ar;

  async function save() {
    setBusy(true);
    setErr([]);
    const version = { components: c, currency: "SAR", effectiveFrom, effectiveTo: null };
    let res;
    if (mode.kind === "create") {
      res = await api("/api/commissions/plans", { method: "POST", body: { code, name, nameAr, version } });
    } else if (saveAs === "inplace") {
      res = await api(`/api/commissions/plans/${mode.planId}/versions/${mode.versionId}`, { method: "PATCH", body: version });
    } else {
      res = await api(`/api/commissions/plans/${mode.planId}/versions`, { method: "POST", body: { ...version, moveAssignees } });
    }
    setBusy(false);
    if (res.ok) {
      onSaved(mode.kind === "create" ? t("أُنشئت الخطة.") : saveAs === "inplace" ? t("حُفظت التعديلات على النسخة.") : t("أُضيف إصدار جديد بتاريخ السريان."));
    } else {
      const problems = (res.data as { problems?: { messageAr: string }[] }).problems;
      setErr(problems?.length ? problems.map((p) => p.messageAr) : [res.data.error ?? t("تعذّر الحفظ.")]);
    }
  }

  return (
    <ArCtx.Provider value={ar}>
    <div className="cb" data-testid="plan-builder">
      <div className="cb-top">
        <div>
          <h2 className="bt" style={{ margin: 0 }}>
            {mode.kind === "create" ? t("خطة عمولة جديدة بالمكوّنات") : <>{t("تعديل")} <bdi dir="ltr">{mode.planCode} v{mode.version}</bdi> · {mode.planName}</>}
          </h2>
          <p className="cb-sub" style={{ margin: "4px 0 0" }}>
            {t("كل قيمة قابلة للتعديل، وكل مكوّن يمكن إيقافه. العمولة تُحسب على المبالغ المحصّلة والمعتمدة فقط.")}
          </p>
        </div>
        <span style={{ flex: 1 }} />
        <button type="button" className="btn" onClick={onClose} data-testid="builder-cancel">{t("إلغاء")}</button>
        <button type="button" className="btn p" disabled={busy || (mode.kind === "create" && (code.trim().length < 2 || name.trim().length < 2))} onClick={save} data-testid="builder-save">
          {mode.kind === "create" ? t("حفظ الخطة") : saveAs === "inplace" ? t("حفظ التعديلات") : t("حفظ كإصدار جديد")}
        </button>
      </div>

      {err.length > 0 && (
        <div className="notice er" role="alert" data-testid="builder-errors">
          <ul style={{ margin: 0, paddingInlineStart: 18 }}>{err.map((e, i) => <li key={i}>{e}</li>)}</ul>
        </div>
      )}

      {explain("general") && <p className="callout" data-testid="explain-general">{explain("general")}</p>}

      {/* ── General ─────────────────────────────────────────────── */}
      <Section title={t(t("الإعدادات العامة"))} testId="sec-general">
        <div className="cb-grid">
          {mode.kind === "create" && (
            <>
              <label className="cb-f"><span>{t("الرمز")}</span><input value={code} onChange={(e) => setCode(e.target.value)} dir="ltr" placeholder="HIQBAH" data-testid="b-code" /></label>
              <label className="cb-f"><span>{t("الاسم بالعربية")}</span><input value={nameAr} onChange={(e) => setNameAr(e.target.value)} data-testid="b-namear" /></label>
              <label className="cb-f"><span>{t("الاسم بالإنجليزية")}</span><input value={name} onChange={(e) => setName(e.target.value)} dir="ltr" data-testid="b-name" /></label>
            </>
          )}
          <label className="cb-f"><span>{t("الفترة")}</span><select value="MONTHLY" disabled><option value="MONTHLY">{t("شهرية")}</option></select></label>
          <label className="cb-f"><span>{t("العملة")}</span><select value="SAR" disabled><option value="SAR">{t("ريال سعودي (SAR)")}</option></select></label>
          <label className="cb-f"><span>{mode.kind === "edit" && saveAs === "version" ? t("سريان الإصدار الجديد من") : t("سارية من")}</span>
            <input type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} data-testid="b-from" /></label>
          <label className="cb-f"><span>{t("ما يُحتسب من المستهدف")}</span>
            <select value={c.achievementBase} onChange={(e) => set({ achievementBase: e.target.value as Components["achievementBase"] })} data-testid="b-achbase">
              <option value="NEW_CLIENT_SALES">{t("مبيعات العملاء الجدد المحصّلة (المؤهلة)")}</option>
              <option value="ALL_COLLECTED">{t("كل المبيعات المحصّلة")}</option>
            </select></label>
        </div>
        {mode.kind === "edit" && (
          <div className="cb-save-as">
            <div className="seg" role="radiogroup" aria-label={t(t("طريقة الحفظ"))}>
              <button type="button" className={saveAs === "inplace" ? "on" : ""} disabled={!mode.editableInPlace} onClick={() => setSaveAs("inplace")} data-testid="b-save-inplace">{t("تعديل هذه النسخة")}</button>
              <button type="button" className={saveAs === "version" ? "on" : ""} onClick={() => setSaveAs("version")} data-testid="b-save-version">{t("إصدار جديد بتاريخ سريان")}</button>
            </div>
            <span className="cb-hint">
              {mode.editableInPlace
                ? t("لم يُسند أحد إلى هذه النسخة بعد، فيمكن تعديلها مباشرة.")
                : t("النسخة مُسندة أو لها استحقاقات: التعديل إصدار جديد، والأشهر السابقة تبقى محسوبة بنسختها.")}
            </span>
            {saveAs === "version" && (
              <label className="cb-check"><input type="checkbox" checked={moveAssignees} onChange={(e) => setMoveAssignees(e.target.checked)} data-testid="b-move" /> {t("نقل الموظفين المسندين إلى الإصدار الجديد من تاريخ سريانه")}</label>
            )}
          </div>
        )}
      </Section>

      {/* ── A ───────────────────────────────────────────────────── */}
      <Section title={t(t("أ. عمولة العملاء الجدد حسب ترتيب الطلب"))} testId="sec-order" on={os.enabled} onToggle={(v) => setOS({ enabled: v })}
        sub={explain("orderSequence") ?? t("نسبة على صافي المبيعات المحصّلة فعلياً حسب رقم طلب العميل؛ الصف الأخير يعني «وما بعده».")}>
        <div className="perf-scroll"><table className="t dense cb-tbl">
          <thead><tr><th scope="col">{t("الطلب المحصّل")}</th><th scope="col" className="num">{t("النسبة")}</th><th scope="col"><span className="sr-only">{t("حذف")}</span></th></tr></thead>
          <tbody>
            {os.rows.map((r, i) => (
              <tr key={i} data-testid={`seq-row-${i}`}>
                <td>{ar ? `الطلب رقم ${i + 1}` : `Order ${i + 1}`}{i === os.rows.length - 1 ? t(" وما بعده") : ""}</td>
                <td className="num"><Num id={`seq-rate-${i}`} value={r.ratePercent} suffix="%" label={ar ? `نسبة الطلب ${i + 1}` : `Order ${i + 1} rate`} onChange={(v) => setOS({ rows: os.rows.map((x, j) => (j === i ? { ratePercent: v } : x)) })} /></td>
                <td style={{ textAlign: "end" }}>{os.rows.length > 1 && <button type="button" className="btn g sm" aria-label={t(t("حذف الصف"))} onClick={() => setOS({ rows: os.rows.filter((_, j) => j !== i) })}>×</button>}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
        <button type="button" className="btn g sm" onClick={() => setOS({ rows: [...os.rows, { ratePercent: os.rows[os.rows.length - 1]?.ratePercent ?? "0" }] })} data-testid="seq-add">{t("+ صف طلب")}</button>
        <div className="cb-grid" style={{ marginTop: 12 }}>
          <div className="cb-f"><span>{t("نسبة العملاء الحاليين / غير الجدد")}</span><Num id="seq-existing" value={os.existingClientRatePercent} suffix="%" onChange={(v) => setOS({ existingClientRatePercent: v })} /></div>
        </div>
        <div className="cb-inherit" data-testid="seq-inherit-box">
          <label className="cb-check">
            <input type="checkbox" checked={os.inheritSettings} onChange={(e) => setOS({ inheritSettings: e.target.checked })} data-testid="seq-inherit" />
            {t("فترة العميل الجديد والانقطاع والأهلية من «إعدادات العمولات»")}
          </label>
          {os.inheritSettings ? (
            <p className="cb-hint" data-testid="seq-inherited">
              {settings
                ? <>{t("من الإعدادات الآن:")} {t("العميل الجديد لم يشترِ خلال")} {durText(settings.newClientWindow)} · {t("الانقطاع بعد")} {durText(settings.lapse)} {t("بلا طلب محصّل")} · {t("الأهلية")} {settings.eligibility ? durText(settings.eligibility) : t("للأبد حتى انقطاع العميل")}</>
                : t("تُقرأ من «إعدادات العمولات».")}
            </p>
          ) : (
            <div className="cb-grid">
              <div className="cb-f"><span>{t("فترة «العميل الجديد»: لم يشترِ خلال")}</span>
                <DurationInput id="seq-window" value={os.newClientWindow} onChange={(v) => setOS({ newClientWindow: v })} emptyLabel={t("فارغ = لم يشترِ قط")} /></div>
              <div className="cb-f"><span>{t("مدة الانقطاع (بلا طلب محصّل)")}</span>
                <DurationInput id="seq-lapse" value={os.lapse} onChange={(v) => setOS({ lapse: v })} emptyLabel={t("فارغ = لا ينقطع")} /></div>
              <div className="cb-f"><span>{t("مدة الأهلية بعد الاكتساب")}</span>
                <DurationInput id="seq-elig" value={os.eligibilityAfterAcquisition} onChange={(v) => setOS({ eligibilityAfterAcquisition: v })} emptyLabel={t("فارغ = للأبد حتى الانقطاع")} /></div>
            </div>
          )}
        </div>
        <p className="cb-hint">{t("تنقطع العمولة بانقطاع العميل: إذا مرّت مدة الانقطاع بلا طلب محصّل توقفت عمولة ترتيب الطلب، وإذا عاد العميل واشترى بعدها يُعامل عميلاً جديداً وفق قاعدة فترة العميل الجديد، ويبدأ الترتيب من الطلب الأول للمندوب الذي أعاده.")}</p>
        <p className="cb-hint">{t("العميل المعلَّم «مستثنى من عمولة العميل الجديد» في ملفه (كان نشطاً أو جارٍ التفاوض معه قبل المندوب) يُعامل كعميل حالي.")}</p>
      </Section>

      {/* ── B ───────────────────────────────────────────────────── */}
      <Section title={t(t("ب. مكافأة تحقيق المستهدف الشهري"))} testId="sec-bonus" on={tb.enabled} onToggle={(v) => set({ targetBonus: { ...tb, enabled: v } })}
        sub={explain("targetBonus") ?? t("مبلغ ثابت حسب نسبة تحقيق المستهدف الشهري من المبيعات المحصّلة المؤهلة.")}>
        <div className="perf-scroll">
          <table className="t dense cb-tbl">
            <thead><tr><th scope="col">{t("من %")}</th><th scope="col">{t("إلى أقل من %")}</th><th scope="col">{t("المكافأة")}</th><th scope="col" className="num">{t("المبلغ")}</th><th scope="col">{t("قابلة لقرار بديل")}</th><th scope="col"><span className="sr-only">{t("حذف")}</span></th></tr></thead>
            <tbody>
              {tb.brackets.map((b, i) => (
                <tr key={i} data-testid={`bracket-${i}`}>
                  <td><Num id={`br-from-${i}`} value={b.fromPercent} width={70} onChange={(v) => setBracket(i, { fromPercent: v })} /></td>
                  <td><Num id={`br-to-${i}`} value={b.toPercent ?? ""} width={70} placeholder={t(t("فأكثر"))} onChange={(v) => setBracket(i, { toPercent: v === "" ? null : v })} /></td>
                  <td>
                    <select value={b.kind} onChange={(e) => setBracket(i, { kind: e.target.value as BonusBracket["kind"], amount: e.target.value === "FIXED" ? b.amount ?? "0" : null, overridable: e.target.value === "FIXED" ? b.overridable : false })} data-testid={`br-kind-${i}`}>
                      <option value="NONE">{t("لا شيء")}</option>
                      <option value="FIXED">{t("مبلغ ثابت")}</option>
                      <option value="DISCRETIONARY">{t("تقديري بقرار الإدارة")}</option>
                    </select>
                  </td>
                  <td className="num">{b.kind === "FIXED" ? <Num id={`br-amt-${i}`} value={b.amount ?? ""} suffix={t(t("ر.س"))} onChange={(v) => setBracket(i, { amount: v })} /> : <span className="cb-hint">{b.kind === "DISCRETIONARY" ? t("يُقرَّر في مراجعة العمولات") : "—"}</span>}</td>
                  <td>{b.kind === "FIXED" && <label className="cb-check"><input type="checkbox" checked={b.overridable} onChange={(e) => setBracket(i, { overridable: e.target.checked })} data-testid={`br-ovr-${i}`} /> {t("للإدارة مبلغ بديل")}</label>}</td>
                  <td style={{ textAlign: "end" }}><button type="button" className="btn g sm" aria-label={t(t("حذف الشريحة"))} onClick={() => set({ targetBonus: { ...tb, brackets: tb.brackets.filter((_, j) => j !== i) } })}>×</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button type="button" className="btn g sm" data-testid="br-add" onClick={() => {
          const last = tb.brackets[tb.brackets.length - 1];
          const from = last?.toPercent ?? "0";
          set({ targetBonus: { ...tb, brackets: [...tb.brackets, { fromPercent: from, toPercent: null, kind: "FIXED", amount: "0", overridable: false }] } });
        }}>{t("+ شريحة مكافأة")}</button>
        <p className="cb-hint">{t("الحد الأدنى داخل الشريحة والأعلى خارجها: 99.99% في شريحة 80–100، و100% في التالية. «تقديري» يطلب قرار الإدارة (مبلغ أو صفر مع السبب) قبل اعتماد الشهر.")}</p>
      </Section>

      {/* ── C ───────────────────────────────────────────────────── */}
      <Section title={t(t("ج. الحافز الإضافي بعد تجاوز المستهدف (حدّي)"))} testId="sec-over" on={ot.enabled} onToggle={(v) => set({ overTarget: { ...ot, enabled: v } })}
        sub={explain("overTarget") ?? t("نسبة على المبلغ الزائد داخل كل شريحة فقط، لا على كامل المبيعات.")}>
        <div className="perf-scroll"><table className="t dense cb-tbl">
          <thead><tr><th scope="col">{t("من %")}</th><th scope="col">{t("إلى %")}</th><th scope="col" className="num">{t("النسبة على الزائد فقط")}</th><th scope="col"><span className="sr-only">{t("حذف")}</span></th></tr></thead>
          <tbody>
            {ot.bands.map((b, i) => (
              <tr key={i} data-testid={`band-${i}`}>
                <td><Num id={`bd-from-${i}`} value={b.fromPercent} width={70} onChange={(v) => setBand(i, { fromPercent: v })} /></td>
                <td><Num id={`bd-to-${i}`} value={b.toPercent ?? ""} width={70} placeholder={t(t("فأكثر"))} onChange={(v) => setBand(i, { toPercent: v === "" ? null : v })} /></td>
                <td className="num"><Num id={`bd-rate-${i}`} value={b.ratePercent} suffix="%" onChange={(v) => setBand(i, { ratePercent: v })} /></td>
                <td style={{ textAlign: "end" }}><button type="button" className="btn g sm" aria-label={t(t("حذف الشريحة"))} onClick={() => set({ overTarget: { ...ot, bands: ot.bands.filter((_, j) => j !== i) } })}>×</button></td>
              </tr>
            ))}
          </tbody>
        </table></div>
        <button type="button" className="btn g sm" data-testid="bd-add" onClick={() => {
          const last = ot.bands[ot.bands.length - 1];
          set({ overTarget: { ...ot, bands: [...ot.bands, { fromPercent: last?.toPercent ?? "100", toPercent: null, ratePercent: "0" }] } });
        }}>{t("+ شريحة حافز")}</button>
        <p className="cb-hint">{t("مثال: عند 130% من مستهدف 50,000: ‏10,000 × 0.5% + 5,000 × 1% = 100 ر.س — لا 65,000 × 1%.")}</p>
      </Section>

      <Simulation components={c} canSeePay={canSeePay} employees={employees} />

      <div className="cb-section-note">
        {[
          `${ar ? "أ" : "A"}: ${os.enabled ? os.rows.map((r, i) => `${i + 1}${i === os.rows.length - 1 ? "+" : ""} → ${r.ratePercent}%`).join(" · ") : t("متوقف")}`,
          `${ar ? "ب" : "B"}: ${tb.enabled ? tb.brackets.map((b) => `${pctLabel(ar, b.fromPercent, b.toPercent)} ${b.kind === "FIXED" ? formatMoney(b.amount ?? "0", 0) : b.kind === "DISCRETIONARY" ? t("تقديري") : t("لا شيء")}`).join(" · ") : t("متوقف")}`,
          `${ar ? "ج" : "C"}: ${ot.enabled ? ot.bands.map((b) => `${pctLabel(ar, b.fromPercent, b.toPercent)} ${b.ratePercent}%`).join(" · ") : t("متوقف")}`,
        ].map((t) => <div key={t}>{t}</div>)}
      </div>
    </div>
    </ArCtx.Provider>
  );
}

type SimFigures = { sales: string; achievementPercent: string; clientCommission: string; targetBonus: string; overTargetIncentive: string; totalVariable: string; totalMonthly: string | null };
/** Exact figures (as the workbook computes them) and `rounded`, half-up to two places, for display. */
type SimRow = SimFigures & { label: string; rounded: SimFigures };

/** «محاكاة» — the workbook's Simulation sheet, computed by the server's engine on the editor's components. */
function Simulation({ components, canSeePay, employees }: { components: Components; canSeePay: boolean; employees: { id: string; name: string }[] }) {
  const t = useT();
  const ar = useContext(ArCtx);
  const n = components.orderSequence.rows.length;
  const [target, setTarget] = useState("50000");
  const [mixMode, setMixMode] = useState<"AMOUNTS" | "PERCENT">("AMOUNTS");
  const [amounts, setAmounts] = useState<string[]>(["34672.3305", "1254.539", "0"]);
  const [percents, setPercents] = useState<string[]>(["70", "20", "10"]);
  const [scenarios, setScenarios] = useState(SCENARIOS.join(", "));
  const [custom, setCustom] = useState("250000, 300000");
  const [disc, setDisc] = useState("0");
  const [override, setOverride] = useState("");
  const [fixedPay, setFixedPay] = useState("");
  const [employeeId, setEmployeeId] = useState("");
  const [out, setOut] = useState<{ base: SimRow; rows: SimRow[]; fixedPaySource: string | null } | null>(null);
  const [err, setErr] = useState("");

  const pad = (xs: string[]) => Array.from({ length: n }, (_, i) => xs[i] ?? "0");
  const body = () => ({
    components, target,
    mix: mixMode === "AMOUNTS" ? { mode: "AMOUNTS", amounts: pad(amounts) } : { mode: "PERCENT", percents: pad(percents) },
    scenarios: [
      ...scenarios.split(/[,،\s]+/).filter(Boolean).map((p) => ({ label: ar ? `${p}% من المستهدف` : `${p}% of target`, percentOfTarget: p })),
      ...custom.split(/[,،\s]+/).filter(Boolean).map((a, i) => ({ label: ar ? `سيناريو مخصص ${i + 1}` : `Custom ${i + 1}`, amount: a })),
    ],
    discretionaryAmount: disc, overrideAmount: override,
    fixedPay: fixedPay || null, employeeId: employeeId || undefined,
  });
  async function run() {
    setErr("");
    const res = await api<{ base: SimRow; rows: SimRow[]; fixedPaySource: string | null }>("/api/commissions/simulate", { method: "POST", body: body() });
    if (res.ok) setOut(res.data);
    else { setOut(null); setErr(res.data.error ?? t("تعذّرت المحاكاة.")); }
  }
  // Recompute when the plan in the editor changes, so the table follows the edits.
  const key = JSON.stringify(components);
  useEffect(() => {
    const t = setTimeout(() => { void run(); }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-run on the plan's own edits only; inputs re-run with the button
  }, [key]);

  const m = (v: string | null) => (v === null ? "—" : <span className="n">{formatMoney(v)}</span>);
  const pct = (v: string) => <span className="n">{Number(v).toFixed(2)}%</span>;
  const row = (r: SimRow, i: number | "base") => {
    const x = r.rounded;
    return (
      <tr key={i} data-testid={`sim-row-${i}`} className={i === "base" ? "on" : undefined} title={`${r.clientCommission} · ${r.overTargetIncentive} · ${r.totalVariable}`}>
        <td>{i === "base" ? t("المدخلات (أرقام الشهر)") : r.label}</td>
        <td className="num">{m(x.sales)}</td>
        <td className="num">{pct(x.achievementPercent)}</td>
        <td className="num">{m(x.clientCommission)}</td>
        <td className="num">{m(x.targetBonus)}</td>
        <td className="num">{m(x.overTargetIncentive)}</td>
        <td className="num"><b>{m(x.totalVariable)}</b></td>
        <td className="num">{m(x.totalMonthly)}</td>
      </tr>
    );
  };


  return (
    <Section title={t(t("محاكاة"))} testId="sec-sim" sub={t(t("سيناريوهات بنسبة من المستهدف ومبالغ مخصصة، بتوزيع الطلبات الأول / الثاني / الثالث فأكثر — كجدول المحاكاة في ملف العمولات."))}>
      <div className="cb-grid">
        <div className="cb-f"><span>{t("المستهدف الشهري")}</span><Num id="sim-target" value={target} suffix={t(t("ر.س"))} width={130} onChange={setTarget} /></div>
        <div className="cb-f"><span>{t("توزيع الطلبات")}</span>
          <div className="seg">
            <button type="button" className={mixMode === "AMOUNTS" ? "on" : ""} onClick={() => setMixMode("AMOUNTS")} data-testid="sim-mix-amounts">{t("مبالغ")}</button>
            <button type="button" className={mixMode === "PERCENT" ? "on" : ""} onClick={() => setMixMode("PERCENT")} data-testid="sim-mix-percent">{t("نِسَب %")}</button>
          </div></div>
        {Array.from({ length: n }, (_, i) => (
          <div className="cb-f" key={i}><span>{ar ? (i === n - 1 ? `الطلب ${i + 1} وما بعده` : `الطلب ${i + 1}`) : i === n - 1 ? `Order ${i + 1} and after` : `Order ${i + 1}`}</span>
            {mixMode === "AMOUNTS"
              ? <Num id={`sim-amt-${i}`} value={amounts[i] ?? "0"} width={130} suffix={t(t("ر.س"))} onChange={(v) => setAmounts(pad(amounts).map((x, j) => (j === i ? v : x)))} />
              : <Num id={`sim-pct-${i}`} value={percents[i] ?? "0"} width={80} suffix="%" onChange={(v) => setPercents(pad(percents).map((x, j) => (j === i ? v : x)))} />}
          </div>
        ))}
      </div>
      <div className="cb-grid">
        <label className="cb-f"><span>{t("السيناريوهات (% من المستهدف)")}</span><input value={scenarios} dir="ltr" onChange={(e) => setScenarios(e.target.value)} data-testid="sim-scenarios" /></label>
        <label className="cb-f"><span>{t("مبالغ مخصصة")}</span><input value={custom} dir="ltr" onChange={(e) => setCustom(e.target.value)} data-testid="sim-custom" /></label>
        <div className="cb-f"><span>{t("مكافأة تقديرية (80–99%)")}</span><Num id="sim-disc" value={disc} suffix={t(t("ر.س"))} onChange={setDisc} /></div>
        <div className="cb-f"><span>{t("مبلغ بديل للشريحة العليا")}</span><Num id="sim-override" value={override} suffix={t(t("ر.س"))} placeholder={t(t("فارغ = مبلغ الخطة"))} onChange={setOverride} /></div>
        {canSeePay && employees.length > 0 && (
          <label className="cb-f"><span>{t("الراتب الثابت من الموارد البشرية لـ")}</span>
            <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} data-testid="sim-employee">
              <option value="">—</option>
              {employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select></label>
        )}
        <div className="cb-f"><span>{t("راتب ثابت للمحاكاة (اختياري)")}</span><Num id="sim-fixed" value={fixedPay} suffix={t(t("ر.س"))} placeholder="—" onChange={setFixedPay} /></div>
      </div>
      <div><button type="button" className="btn p sm" onClick={run} data-testid="sim-run">{t("احسب المحاكاة")}</button></div>
      {err && <p className="notice er" role="alert">{err}</p>}
      {out && (
        <div className="perf-scroll" style={{ marginTop: 12 }}>
          <table className="t dense" data-testid="sim-table">
            <thead><tr>
              <th scope="col">{t("السيناريو")}</th>
              <th scope="col" className="num">{t("المبيعات المحصّلة")}</th>
              <th scope="col" className="num">{t("نسبة التحقيق")}</th>
              <th scope="col" className="num">{t("عمولة العملاء")}</th>
              <th scope="col" className="num">{t("مكافأة المستهدف")}</th>
              <th scope="col" className="num">{t("الحافز فوق المستهدف")}</th>
              <th scope="col" className="num">{t("إجمالي المتغير")}</th>
              <th scope="col" className="num">{t("إجمالي التعويض الشهري")}</th>
            </tr></thead>
            <tbody>
              {row(out.base, "base")}
              {out.rows.map((r, i) => row(r, i))}
            </tbody>
          </table>
          <p className="cb-hint" style={{ marginTop: 6 }}>
            {mixMode === "AMOUNTS"
              ? t("بتوزيع «مبالغ» تبقى عمولة العملاء ثابتة في كل السيناريوهات كما في ملف المحاكاة؛ اختر «نِسَب %» لتتغير مع مبيعات السيناريو.")
              : t("عمولة العملاء = مبيعات السيناريو موزّعة على الطلبات بالنسب أعلاه.")}
            {" "}{out.fixedPaySource === "HR" ? t("الراتب الثابت من سجل الموارد البشرية.") : out.fixedPaySource === "INPUT" ? t("الراتب الثابت المُدخل للمحاكاة.") : t("لا راتب ثابت: عمود الإجمالي الشهري فارغ.")}
          </p>
        </div>
      )}
    </Section>
  );
}
