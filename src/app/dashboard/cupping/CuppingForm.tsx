"use client";

import { useState, useMemo } from "react";
import { Coffee, ChevronDown, ChevronUp } from "lucide-react";

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

const SCORE_LABELS: { min: number; label: string; color: string }[] = [
  { min: 90, label: "Outstanding",  color: "#16a34a" },
  { min: 85, label: "Excellent",    color: "#22c55e" },
  { min: 80, label: "Very Good",    color: "#84cc16" },
  { min: 75, label: "Good",         color: "#eab308" },
  { min: 70, label: "Fair",         color: "#f97316" },
  { min: 0,  label: "Below Spec",   color: "#ef4444" },
];

function scoreLabel(s: number) {
  return SCORE_LABELS.find((l) => s >= l.min) ?? SCORE_LABELS[SCORE_LABELS.length - 1];
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function ScoreSlider({
  label, labelAr, value, onChange,
}: {
  label: string; labelAr: string; value: number; onChange: (v: number) => void;
}) {
  const pct = ((value - 6) / 4) * 100;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <div>
          <span className="text-sm font-bold text-charcoal">{label}</span>
          <span className="text-xs text-brown/50 ltr:ml-1.5 rtl:mr-1.5">{labelAr}</span>
        </div>
        <span className="text-lg font-extrabold tabular-nums" style={{ color: scoreLabel(value + 60).color }}>
          {value.toFixed(2)}
        </span>
      </div>
      <div className="relative h-2 rounded-full bg-gray-100">
        <div
          className="absolute inset-y-0 left-0 rounded-full transition-all duration-75"
          style={{ width: `${pct}%`, backgroundColor: "#E25D2F" }}
        />
        <input
          type="range" min={6} max={10} step={0.25}
          value={value}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          className="absolute inset-0 w-full opacity-0 cursor-pointer h-2"
        />
        {/* Thumb */}
        <div
          className="absolute top-1/2 -translate-y-1/2 w-4 h-4 rounded-full bg-white border-2 shadow-md pointer-events-none transition-all duration-75"
          style={{ left: `calc(${pct}% - 8px)`, borderColor: "#E25D2F" }}
        />
      </div>
      <div className="flex justify-between text-[10px] text-brown/40 font-medium select-none">
        <span>6.00</span><span>7.00</span><span>8.00</span><span>9.00</span><span>10.00</span>
      </div>
    </div>
  );
}

function CupRow({
  label, labelAr, cups, onChange,
}: {
  label: string; labelAr: string; cups: boolean[]; onChange: (i: number) => void;
}) {
  const score = cups.filter(Boolean).length * 2;
  return (
    <div className="flex items-center gap-3">
      <div className="flex-1 min-w-0">
        <span className="text-sm font-bold text-charcoal">{label}</span>
        <span className="text-xs text-brown/50 ltr:ml-1.5 rtl:mr-1.5">{labelAr}</span>
      </div>
      <div className="flex gap-2">
        {cups.map((checked, i) => (
          <button
            key={i} type="button"
            onClick={() => onChange(i)}
            className={`w-8 h-8 rounded-lg border-2 flex items-center justify-center transition-all duration-150 text-xs font-bold ${
              checked
                ? "bg-orange border-orange text-white shadow-sm"
                : "bg-gray-50 border-gray-200 text-gray-300 hover:border-orange/40"
            }`}
          >
            <Coffee size={13} strokeWidth={checked ? 2.5 : 1.5} />
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
};

// ─── Main Form ────────────────────────────────────────────────────────────────

export default function CuppingForm({ onSubmit, submitting = false, submitLabel = "Submit Score" }: Props) {
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
  const { label: qualityLabel, color: qualityColor } = scoreLabel(finalScore);

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
          SCA Final Score
        </p>
        <p className="text-6xl font-black tabular-nums leading-none" style={{ color: qualityColor }}>
          {finalScore.toFixed(2)}
        </p>
        <p className="text-sm font-bold mt-2" style={{ color: qualityColor }}>{qualityLabel}</p>
        <div className="flex justify-center gap-4 mt-3 text-xs text-charcoal/50 font-medium">
          <span>Subtotal: <strong className="text-charcoal">{subtotal.toFixed(2)}</strong></span>
          {defectPenalty > 0 && (
            <span className="text-red-500">Defects: <strong>-{defectPenalty}</strong></span>
          )}
        </div>
      </div>

      {/* ── Slider Attributes ─────────────────────────────────────── */}
      <section className="bg-white rounded-2xl border border-border p-5 space-y-5">
        <h3 className="text-sm font-extrabold text-charcoal uppercase tracking-wide">
          Sensory Attributes (6 – 10)
        </h3>
        {SLIDER_ATTRS.map((attr) => (
          <ScoreSlider
            key={attr.key}
            label={attr.label}
            labelAr={attr.labelAr}
            value={sliders[attr.key]}
            onChange={(v) => setSlider(attr.key, v)}
          />
        ))}
      </section>

      {/* ── Cup Attributes ────────────────────────────────────────── */}
      <section className="bg-white rounded-2xl border border-border p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-extrabold text-charcoal uppercase tracking-wide">
            Cup Scores (5 cups × 2 pts)
          </h3>
          <span className="text-xs text-brown/50">Tap to mark a failed cup</span>
        </div>
        {CUP_ATTRS.map((attr) => (
          <CupRow
            key={attr.key}
            label={attr.label}
            labelAr={attr.labelAr}
            cups={cups[attr.key]}
            onChange={(i) => toggleCup(attr.key, i)}
          />
        ))}
      </section>

      {/* ── Defects ───────────────────────────────────────────────── */}
      <section className="bg-white rounded-2xl border border-border p-5 space-y-4">
        <h3 className="text-sm font-extrabold text-charcoal uppercase tracking-wide">Defects</h3>
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
              {type === "none" ? "No Defect" : type === "taint" ? "Taint (−2/cup)" : "Fault (−4/cup)"}
            </button>
          ))}
        </div>
        {defectType !== "none" && (
          <div className="space-y-2">
            <label className="text-xs font-bold text-brown uppercase tracking-wide">
              Number of defect cups
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
                Penalty: −{defectCups * (defectType === "fault" ? 4 : 2)} points
              </p>
            )}
          </div>
        )}
      </section>

      {/* ── Flavor Tags ───────────────────────────────────────────── */}
      <section className="bg-white rounded-2xl border border-border p-5 space-y-3">
        <h3 className="text-sm font-extrabold text-charcoal uppercase tracking-wide">
          Flavor Descriptors
        </h3>
        <div className="flex flex-wrap gap-2">
          {visibleTags.map((tag) => (
            <button key={tag} type="button"
              onClick={() => toggleTag(tag)}
              className={`px-3 py-1.5 rounded-full text-xs font-bold border transition-all duration-150 ${
                tags.includes(tag)
                  ? "bg-orange border-orange text-white shadow-sm"
                  : "bg-cream border-border text-brown hover:border-orange/40 hover:text-orange"
              }`}>
              {tag}
            </button>
          ))}
          <button type="button"
            onClick={() => setShowAllTags((p) => !p)}
            className="px-3 py-1.5 rounded-full text-xs font-bold border border-dashed border-border text-brown/50 hover:text-orange hover:border-orange/40 flex items-center gap-1 transition-all">
            {showAllTags ? <><ChevronUp size={11} /> Less</> : <><ChevronDown size={11} /> +{FLAVOR_TAGS.length - 18} more</>}
          </button>
        </div>
        {tags.length > 0 && (
          <p className="text-xs text-brown/50">
            Selected: <strong className="text-charcoal">{tags.join(", ")}</strong>
          </p>
        )}
      </section>

      {/* ── Notes ─────────────────────────────────────────────────── */}
      <section className="bg-white rounded-2xl border border-border p-5">
        <label className="block text-sm font-extrabold text-charcoal uppercase tracking-wide mb-2">
          Cupper Notes
        </label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          placeholder="Describe what you taste, smell, and feel in the cup..."
          className="w-full px-4 py-3 rounded-xl border-2 border-border bg-cream text-charcoal text-sm focus:outline-none focus:border-orange focus:ring-2 focus:ring-orange/20 resize-none transition-colors"
        />
      </section>

      {/* ── Score Summary + Submit ─────────────────────────────────── */}
      <div className="bg-white rounded-2xl border border-border p-5 space-y-4">
        <h3 className="text-sm font-extrabold text-charcoal uppercase tracking-wide">Score Breakdown</h3>
        <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
          {SLIDER_ATTRS.map((a) => (
            <div key={a.key} className="flex justify-between">
              <span className="text-brown/70">{a.label}</span>
              <span className="font-bold text-charcoal tabular-nums">{sliders[a.key].toFixed(2)}</span>
            </div>
          ))}
          {CUP_ATTRS.map((a) => (
            <div key={a.key} className="flex justify-between">
              <span className="text-brown/70">{a.label}</span>
              <span className="font-bold text-charcoal tabular-nums">{cupScores[a.key]}.00</span>
            </div>
          ))}
        </div>
        <div className="border-t border-border pt-3 space-y-1">
          <div className="flex justify-between text-sm">
            <span className="text-brown/70">Subtotal</span>
            <span className="font-bold">{subtotal.toFixed(2)}</span>
          </div>
          {defectPenalty > 0 && (
            <div className="flex justify-between text-sm text-red-500">
              <span>Defect Penalty</span>
              <span className="font-bold">−{defectPenalty}.00</span>
            </div>
          )}
          <div className="flex justify-between text-base font-extrabold pt-1" style={{ color: qualityColor }}>
            <span>Final Score</span>
            <span>{finalScore.toFixed(2)}</span>
          </div>
        </div>

        <button
          type="submit"
          disabled={submitting}
          className="w-full py-3.5 rounded-xl font-extrabold text-white text-sm tracking-wide transition-all duration-200 active:scale-[0.98] disabled:opacity-50"
          style={{ backgroundColor: qualityColor }}>
          {submitting ? "Submitting…" : submitLabel}
        </button>
      </div>
    </form>
  );
}
