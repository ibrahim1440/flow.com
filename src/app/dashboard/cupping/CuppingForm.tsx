"use client";

import { useState, useMemo } from "react";
import { Coffee, ChevronDown, ChevronUp } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";

type Lang = "ar" | "en";

// ─── SCA Constants ────────────────────────────────────────────────────────────

const SLIDER_ATTRS = [
  { key: "fragranceAroma", label: "Fragrance / Aroma", labelAr: "العطر / الرائحة" },
  { key: "flavor",         label: "Flavor",             labelAr: "الطعم" },
  { key: "aftertaste",     label: "Aftertaste",         labelAr: "النكهة الباقية" },
  { key: "acidity",        label: "Acidity",            labelAr: "الحموضة" },
  { key: "body",           label: "Body",               labelAr: "الثقل" },
  { key: "balance",        label: "Balance",            labelAr: "التوازن" },
  { key: "overall",        label: "Overall",            labelAr: "التقييم العام" },
] as const;

type SliderKey = (typeof SLIDER_ATTRS)[number]["key"];

const CUP_ATTRS = [
  { key: "uniformity", label: "Uniformity",  labelAr: "التجانس" },
  { key: "cleanCup",   label: "Clean Cup",   labelAr: "نقاء الكوب" },
  { key: "sweetness",  label: "Sweetness",   labelAr: "الحلاوة" },
] as const;

type CupKey = (typeof CUP_ATTRS)[number]["key"];

// The stored descriptor is the English word (existing scores keep matching); only the label
// shown follows the viewer's language (G-13).
const FLAVOR_TAGS = [
  "Fruity", "Citrus", "Lemon", "Orange", "Grapefruit",
  "Berry", "Blueberry", "Strawberry", "Raspberry",
  "Stone Fruit", "Peach", "Apricot", "Plum",
  "Tropical", "Mango", "Pineapple", "Passion Fruit",
  "Floral", "Jasmine", "Rose", "Lavender",
  "Chocolate", "Dark Chocolate", "Milk Chocolate", "Cocoa",
  "Nutty", "Almond", "Hazelnut", "Peanut",
  "Caramel", "Honey", "Toffee", "Vanilla", "Brown Sugar",
  "Spicy", "Cinnamon", "Clove",
  "Herbal", "Green Tea",
  "Earthy", "Tobacco", "Cedar",
  "Winey", "Fermented",
];

const FLAVOR_AR: Record<string, string> = {
  Fruity: "فاكهي", Citrus: "حمضيات", Lemon: "ليمون", Orange: "برتقال", Grapefruit: "جريب فروت",
  Berry: "توتي", Blueberry: "توت أزرق", Strawberry: "فراولة", Raspberry: "توت العليق",
  "Stone Fruit": "فاكهة ذات نواة", Peach: "خوخ", Apricot: "مشمش", Plum: "برقوق",
  Tropical: "استوائي", Mango: "مانجو", Pineapple: "أناناس", "Passion Fruit": "باشن فروت",
  Floral: "زهري", Jasmine: "ياسمين", Rose: "ورد", Lavender: "خزامى",
  Chocolate: "شوكولاتة", "Dark Chocolate": "شوكولاتة داكنة", "Milk Chocolate": "شوكولاتة بالحليب", Cocoa: "كاكاو",
  Nutty: "مكسرات", Almond: "لوز", Hazelnut: "بندق", Peanut: "فول سوداني",
  Caramel: "كراميل", Honey: "عسل", Toffee: "توفي", Vanilla: "فانيلا", "Brown Sugar": "سكر بني",
  Spicy: "توابل", Cinnamon: "قرفة", Clove: "قرنفل",
  Herbal: "عشبي", "Green Tea": "شاي أخضر",
  Earthy: "ترابي", Tobacco: "تبغ", Cedar: "أرز",
  Winey: "نبيذي", Fermented: "مخمّر",
};

/** A stored descriptor in the viewer's language; an unknown one is shown as stored. */
export function descriptorLabel(tag: string, lang: Lang): string {
  return lang === "ar" ? (FLAVOR_AR[tag] ?? tag) : tag;
}

const SCORE_LABELS: { min: number; label: string; labelAr: string; color: string }[] = [
  { min: 90, label: "Outstanding", labelAr: "استثنائي",      color: "#16a34a" },
  { min: 85, label: "Excellent",   labelAr: "ممتاز",         color: "#22c55e" },
  { min: 80, label: "Very Good",   labelAr: "جيد جدًا",      color: "#84cc16" },
  { min: 75, label: "Good",        labelAr: "جيد",           color: "#eab308" },
  { min: 70, label: "Fair",        labelAr: "مقبول",         color: "#f97316" },
  { min: 0,  label: "Below Spec",  labelAr: "دون المواصفة",  color: "#ef4444" },
];

function scoreLabel(s: number) {
  return SCORE_LABELS.find((l) => s >= l.min) ?? SCORE_LABELS[SCORE_LABELS.length - 1];
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function ScoreSlider({
  label, value, onChange,
}: {
  label: string; value: number; onChange: (v: number) => void;
}) {
  const pct = ((value - 6) / 4) * 100;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-sm font-bold text-charcoal">{label}</span>
        <span className="text-lg font-extrabold tabular-nums" style={{ color: scoreLabel(value + 60).color }}>
          {value.toFixed(2)}
        </span>
      </div>
      <div className="relative h-2 rounded-full bg-gray-100" dir="ltr">
        <div
          className="absolute inset-y-0 left-0 rounded-full transition-all duration-75"
          style={{ width: `${pct}%`, backgroundColor: "#7C3AED" }}
        />
        <input
          type="range" min={6} max={10} step={0.25}
          value={value}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          aria-label={label}
          className="absolute inset-0 w-full opacity-0 cursor-pointer h-2"
        />
        {/* Thumb */}
        <div
          className="absolute top-1/2 -translate-y-1/2 w-4 h-4 rounded-full bg-white border-2 shadow-md pointer-events-none transition-all duration-75"
          style={{ left: `calc(${pct}% - 8px)`, borderColor: "#7C3AED" }}
        />
      </div>
      <div className="flex justify-between text-[10px] text-brown/40 font-medium select-none" dir="ltr">
        <span>6.00</span><span>7.00</span><span>8.00</span><span>9.00</span><span>10.00</span>
      </div>
    </div>
  );
}

function CupRow({
  label, cups, onChange, cupLabel,
}: {
  label: string; cups: boolean[]; onChange: (i: number) => void; cupLabel: (i: number) => string;
}) {
  const score = cups.filter(Boolean).length * 2;
  return (
    <div className="flex items-center gap-3">
      <div className="flex-1 min-w-0">
        <span className="text-sm font-bold text-charcoal">{label}</span>
      </div>
      <div className="flex gap-2">
        {cups.map((checked, i) => (
          <button
            key={i} type="button"
            onClick={() => onChange(i)}
            aria-pressed={checked}
            aria-label={`${label} · ${cupLabel(i)}`}
            className={`w-8 h-8 rounded-lg border-2 flex items-center justify-center transition-all duration-150 text-xs font-bold ${
              checked
                ? "bg-orange border-orange text-white shadow-sm"
                : "bg-gray-50 border-gray-200 text-gray-300 hover:border-orange/40"
            }`}
          >
            <Coffee size={13} strokeWidth={checked ? 2.5 : 1.5} aria-hidden="true" />
          </button>
        ))}
      </div>
      <span className="w-8 text-right text-base font-extrabold tabular-nums text-charcoal">{score}</span>
    </div>
  );
}

// ─── Types ─────────────────────────────────────────────────────────────────────

export type CuppingFormData = {
  fragranceAroma: number; flavor: number; aftertaste: number;
  acidity: number; body: number; balance: number; overall: number;
  uniformity: number; cleanCup: number; sweetness: number;
  defectCups: number; defectType: "none" | "taint" | "fault";
  finalScore: number; notes: string; flavorDescriptors: string[];
};

type Props = {
  onSubmit: (data: CuppingFormData) => Promise<void>;
  submitting?: boolean;
  submitLabel?: string;
  /** The guest pages are English and have no language provider; they pass "en". */
  lang?: Lang;
};

// ─── Main Form ────────────────────────────────────────────────────────────────

export default function CuppingForm({ onSubmit, submitting = false, submitLabel, lang: langProp }: Props) {
  const ctx = useI18n();
  const lang: Lang = langProp ?? ctx.lang;
  const L = (ar: string, en: string) => (lang === "ar" ? ar : en);
  const attrLabel = (a: { label: string; labelAr: string }) => (lang === "ar" ? a.labelAr : a.label);
  const [sliders, setSliders] = useState<Record<SliderKey, number>>({
    fragranceAroma: 7, flavor: 7, aftertaste: 7,
    acidity: 7, body: 7, balance: 7, overall: 7,
  });

  const [cups, setCups] = useState<Record<CupKey, boolean[]>>({
    uniformity: [true, true, true, true, true],
    cleanCup:   [true, true, true, true, true],
    sweetness:  [true, true, true, true, true],
  });

  const [defectCups, setDefectCups]   = useState(0);
  const [defectType, setDefectType]   = useState<"none" | "taint" | "fault">("none");
  const [notes, setNotes]             = useState("");
  const [tags, setTags]               = useState<string[]>([]);
  const [showAllTags, setShowAllTags] = useState(false);

  // ── Live score math ────────────────────────────────────────────────────────
  const cupScores = useMemo(() => ({
    uniformity: cups.uniformity.filter(Boolean).length * 2,
    cleanCup:   cups.cleanCup.filter(Boolean).length * 2,
    sweetness:  cups.sweetness.filter(Boolean).length * 2,
  }), [cups]);

  const subtotal = useMemo(() =>
    Object.values(sliders).reduce((a, b) => a + b, 0) +
    cupScores.uniformity + cupScores.cleanCup + cupScores.sweetness,
    [sliders, cupScores]);

  const defectPenalty = defectCups * (defectType === "fault" ? 4 : defectType === "taint" ? 2 : 0);
  const finalScore    = Math.max(0, subtotal - defectPenalty);
  const quality = scoreLabel(finalScore);
  const qualityLabel = lang === "ar" ? quality.labelAr : quality.label;
  const qualityColor = quality.color;

  function setSlider(key: SliderKey, val: number) {
    setSliders((p) => ({ ...p, [key]: val }));
  }

  function toggleCup(key: CupKey, i: number) {
    setCups((p) => {
      const next = [...p[key]];
      next[i] = !next[i];
      return { ...p, [key]: next };
    });
  }

  function toggleTag(tag: string) {
    setTags((p) => p.includes(tag) ? p.filter((t) => t !== tag) : [...p, tag]);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    await onSubmit({
      ...sliders,
      uniformity: cupScores.uniformity,
      cleanCup: cupScores.cleanCup,
      sweetness: cupScores.sweetness,
      defectCups, defectType, finalScore,
      notes, flavorDescriptors: tags,
    });
  }

  const visibleTags = showAllTags ? FLAVOR_TAGS : FLAVOR_TAGS.slice(0, 18);

  return (
    <form onSubmit={handleSubmit} className="space-y-6">

      {/* ── Live Score Banner ─────────────────────────────────────── */}
      <div className="rounded-2xl p-5 text-center shadow-sm" style={{ backgroundColor: qualityColor + "18", border: `2px solid ${qualityColor}40` }}>
        <p className="text-xs font-bold uppercase tracking-widest mb-1" style={{ color: qualityColor }}>
          {L("النتيجة النهائية · SCA", "SCA final score")}
        </p>
        <p className="text-6xl font-black tabular-nums leading-none" style={{ color: qualityColor }}>
          {finalScore.toFixed(2)}
        </p>
        <p className="text-sm font-bold mt-2" style={{ color: qualityColor }}>{qualityLabel}</p>
        <div className="flex justify-center gap-4 mt-3 text-xs text-charcoal/50 font-medium">
          <span>{L("المجموع الجزئي", "Subtotal")}: <strong className="text-charcoal d21-bold">{subtotal.toFixed(2)}</strong></span>
          {defectPenalty > 0 && (
            <span className="text-red-500">{L("العيوب", "Defects")}: <strong dir="ltr">−{defectPenalty}</strong></span>
          )}
        </div>
      </div>

      {/* ── Slider Attributes ─────────────────────────────────────── */}
      <section className="bg-white rounded-2xl border border-border p-5 space-y-5">
        <h3 className="text-sm font-extrabold text-charcoal uppercase tracking-wide">
          {L("الصفات الحسية (6 – 10)", "Sensory attributes (6 – 10)")}
        </h3>
        {SLIDER_ATTRS.map((attr) => (
          <ScoreSlider
            key={attr.key}
            label={attrLabel(attr)}
            value={sliders[attr.key]}
            onChange={(v) => setSlider(attr.key, v)}
          />
        ))}
      </section>

      {/* ── Cup Attributes ────────────────────────────────────────── */}
      <section className="bg-white rounded-2xl border border-border p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-extrabold text-charcoal uppercase tracking-wide">
            {L("درجات الأكواب (5 أكواب × نقطتان)", "Cup scores (5 cups × 2 pts)")}
          </h3>
          <span className="text-xs text-brown/50">{L("اضغط لتعليم كوب غير مطابق", "Tap to mark a failed cup")}</span>
        </div>
        {CUP_ATTRS.map((attr) => (
          <CupRow
            key={attr.key}
            label={attrLabel(attr)}
            cupLabel={(i) => L(`كوب ${i + 1}`, `Cup ${i + 1}`)}
            cups={cups[attr.key]}
            onChange={(i) => toggleCup(attr.key, i)}
          />
        ))}
      </section>

      {/* ── Defects ───────────────────────────────────────────────── */}
      <section className="bg-white rounded-2xl border border-border p-5 space-y-4">
        <h3 className="text-sm font-extrabold text-charcoal uppercase tracking-wide">{L("العيوب", "Defects")}</h3>
        <div className="flex gap-3 flex-wrap">
          {(["none", "taint", "fault"] as const).map((type) => (
            <button key={type} type="button"
              onClick={() => { setDefectType(type); if (type === "none") setDefectCups(0); }}
              className={`px-4 py-2 rounded-xl text-sm font-bold border-2 transition-all ${
                defectType === type
                  ? type === "none"
                    ? "bg-green-500 border-green-500 text-white"
                    : type === "taint"
                    ? "bg-amber-500 border-amber-500 text-white"
                    : "bg-red-500 border-red-500 text-white"
                  : "bg-white border-border text-brown hover:border-charcoal/30"
              }`}>
              {type === "none" ? L("لا عيب", "No defect") : type === "taint" ? L("شائبة (−2 لكل كوب)", "Taint (−2/cup)") : L("عيب (−4 لكل كوب)", "Fault (−4/cup)")}
            </button>
          ))}
        </div>
        {defectType !== "none" && (
          <div className="space-y-2">
            <label className="text-xs font-bold text-brown uppercase tracking-wide">
              {L("عدد الأكواب المعيبة", "Number of defect cups")}
            </label>
            <div className="flex gap-2">
              {[0, 1, 2, 3, 4, 5].map((n) => (
                <button key={n} type="button"
                  onClick={() => setDefectCups(n)}
                  className={`w-10 h-10 rounded-xl text-sm font-bold border-2 transition-all ${
                    defectCups === n
                      ? "bg-red-500 border-red-500 text-white"
                      : "bg-white border-border text-charcoal hover:border-red-300"
                  }`}>
                  {n}
                </button>
              ))}
            </div>
            {defectCups > 0 && (
              <p className="text-xs font-bold text-red-500">
                {L(`الخصم: −${defectCups * (defectType === "fault" ? 4 : 2)} نقاط`, `Penalty: −${defectCups * (defectType === "fault" ? 4 : 2)} points`)}
              </p>
            )}
          </div>
        )}
      </section>

      {/* ── Flavor Tags ───────────────────────────────────────────── */}
      <section className="bg-white rounded-2xl border border-border p-5 space-y-3">
        <h3 className="text-sm font-extrabold text-charcoal uppercase tracking-wide">
          {L("واصفات النكهة", "Flavor descriptors")}
        </h3>
        <div className="flex flex-wrap gap-2">
          {visibleTags.map((tag) => (
            <button key={tag} type="button"
              onClick={() => toggleTag(tag)}
              aria-pressed={tags.includes(tag)}
              className={`px-3 py-1.5 rounded-full text-xs font-bold border transition-all duration-150 ${
                tags.includes(tag)
                  ? "bg-orange border-orange text-white shadow-sm"
                  : "bg-cream border-border text-brown hover:border-orange/40 hover:text-orange"
              }`}>
              {descriptorLabel(tag, lang)}
            </button>
          ))}
          <button type="button"
            onClick={() => setShowAllTags((p) => !p)}
            className="px-3 py-1.5 rounded-full text-xs font-bold border border-dashed border-border text-brown/50 hover:text-orange hover:border-orange/40 flex items-center gap-1 transition-all">
            {showAllTags ? <><ChevronUp size={11} aria-hidden="true" /> {L("أقل", "Less")}</> : <><ChevronDown size={11} aria-hidden="true" /> {L(`+${FLAVOR_TAGS.length - 18} أخرى`, `+${FLAVOR_TAGS.length - 18} more`)}</>}
          </button>
        </div>
        {tags.length > 0 && (
          <p className="text-xs text-brown/50">
            {L("المختارة", "Selected")}: <strong className="text-charcoal">{tags.map((t) => descriptorLabel(t, lang)).join(L("، ", ", "))}</strong>
          </p>
        )}
      </section>

      {/* ── Notes ─────────────────────────────────────────────────── */}
      <section className="bg-white rounded-2xl border border-border p-5">
        <label htmlFor="cupper-notes" className="block text-sm font-extrabold text-charcoal uppercase tracking-wide mb-2">
          {L("ملاحظات المقيّم", "Cupper notes")}
        </label>
        <textarea
          id="cupper-notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          placeholder={L("صف ما تتذوقه وتشمّه وتشعر به في الكوب…", "Describe what you taste, smell, and feel in the cup…")}
          className="w-full px-4 py-3 rounded-xl border-2 border-border bg-cream text-charcoal text-sm focus:outline-none focus:border-orange focus:ring-2 focus:ring-orange/20 resize-none transition-colors"
        />
      </section>

      {/* ── Score Summary + Submit ─────────────────────────────────── */}
      <div className="bg-white rounded-2xl border border-border p-5 space-y-4">
        <h3 className="text-sm font-extrabold text-charcoal uppercase tracking-wide">{L("تفصيل الدرجة", "Score breakdown")}</h3>
        <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
          {SLIDER_ATTRS.map((a) => (
            <div key={a.key} className="flex justify-between">
              <span className="text-brown/70">{attrLabel(a)}</span>
              <span className="font-bold text-charcoal tabular-nums">{sliders[a.key].toFixed(2)}</span>
            </div>
          ))}
          {CUP_ATTRS.map((a) => (
            <div key={a.key} className="flex justify-between">
              <span className="text-brown/70">{attrLabel(a)}</span>
              <span className="font-bold text-charcoal tabular-nums">{cupScores[a.key]}.00</span>
            </div>
          ))}
        </div>
        <div className="border-t border-border pt-3 space-y-1">
          <div className="flex justify-between text-sm">
            <span className="text-brown/70">{L("المجموع الجزئي", "Subtotal")}</span>
            <span className="font-bold">{subtotal.toFixed(2)}</span>
          </div>
          {defectPenalty > 0 && (
            <div className="flex justify-between text-sm text-red-500">
              <span>{L("خصم العيوب", "Defect penalty")}</span>
              <span className="font-bold" dir="ltr">−{defectPenalty}.00</span>
            </div>
          )}
          <div className="flex justify-between text-base font-extrabold pt-1" style={{ color: qualityColor }}>
            <span>{L("النتيجة النهائية", "Final score")}</span>
            <span>{finalScore.toFixed(2)}</span>
          </div>
        </div>

        <button
          type="submit"
          disabled={submitting}
          className="w-full py-3.5 rounded-xl font-extrabold text-white text-sm tracking-wide transition-all duration-200 active:scale-[0.98] disabled:opacity-50"
          style={{ backgroundColor: qualityColor }}>
          {submitting ? L("جارٍ الإرسال…", "Submitting…") : (submitLabel ?? L("إرسال التقييم", "Submit score"))}
        </button>
      </div>
    </form>
  );
}
