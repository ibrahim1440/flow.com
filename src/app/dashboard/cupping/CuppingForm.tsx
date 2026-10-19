"use client";

import { useState, useMemo, type ReactNode } from "react";
import { useI18n } from "@/lib/i18n/context";
import { descriptorLabel } from "@/lib/cupping/descriptors";
import "./cupping-form.css";

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

export { descriptorLabel };

// The descriptors drawn first (G-06 1222:99148 / G-08 1352:18327); the rest open under «n أخرى».
// Display order only: the stored value is still the English word.
const FEATURED_TAGS = ["Fruity", "Citrus", "Chocolate", "Caramel", "Floral", "Berry", "Nutty", "Honey"];

// The quality band of a final score. The thresholds and words are unchanged; the band is now
// drawn as a StatusDot (a dot and a word, never colour alone) instead of a tinted banner.
type Tone = "success" | "info" | "warning" | "danger";
const SCORE_LABELS: { min: number; label: string; labelAr: string; tone: Tone }[] = [
  { min: 90, label: "Outstanding", labelAr: "استثنائي",      tone: "success" },
  { min: 85, label: "Excellent",   labelAr: "ممتاز",         tone: "success" },
  { min: 80, label: "Very Good",   labelAr: "جيد جدًا",      tone: "success" },
  { min: 75, label: "Good",        labelAr: "جيد",           tone: "info" },
  { min: 70, label: "Fair",        labelAr: "مقبول",         tone: "warning" },
  { min: 0,  label: "Below Spec",  labelAr: "دون المواصفة",  tone: "danger" },
];

function scoreLabel(s: number) {
  return SCORE_LABELS.find((l) => s >= l.min) ?? SCORE_LABELS[SCORE_LABELS.length - 1];
}

const SLIDER_MIN = 6;
const SLIDER_MAX = 10;
const SLIDER_STEP = 0.25;

// ─── Icons (Direction 2.1 stroke icons, 16 px in chips) ─────────────────────────

const IconClose = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
);
const IconFilter = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="M4 7h16M7 12h10M10 17h4" /></svg>
);

// ─── Sub-components ───────────────────────────────────────────────────────────

/** A labelled section: the title and caption column, then the controls (G-06 «fsec»). */
function Sec({ title, caption, htmlFor, children }: { title: string; caption?: ReactNode; htmlFor?: string; children: ReactNode }) {
  return (
    <section className="cf-sec">
      <div className="cf-head">
        {htmlFor ? <label htmlFor={htmlFor}>{title}</label> : <h3>{title}</h3>}
        {caption ? <p>{caption}</p> : null}
      </div>
      <div className="cf-body">{children}</div>
    </section>
  );
}

/** A sensory attribute, 6–10 in 0.25 steps: a track on the desk, a − value + stepper on the phone. */
function ScoreSlider({
  label, value, onChange, decLabel, incLabel,
}: {
  label: string; value: number; onChange: (v: number) => void; decLabel: string; incLabel: string;
}) {
  const pct = ((value - SLIDER_MIN) / (SLIDER_MAX - SLIDER_MIN)) * 100;
  const step = (d: number) => onChange(Math.min(SLIDER_MAX, Math.max(SLIDER_MIN, value + d)));
  return (
    <div className="cf-row">
      <span className="cf-label">{label}</span>
      <span className="cf-track">
        <i style={{ width: `${pct}%` }} />
        <b style={{ insetInlineStart: `calc(${pct}% - 8px)` }} />
        <input
          type="range" min={SLIDER_MIN} max={SLIDER_MAX} step={SLIDER_STEP}
          value={value}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          aria-label={label}
        />
      </span>
      <span className="cf-val">{value.toFixed(2)}</span>
      <span className="cf-step" dir="ltr">
        <button type="button" onClick={() => step(-SLIDER_STEP)} disabled={value <= SLIDER_MIN} aria-label={`${decLabel} · ${label}`}>−</button>
        <span aria-hidden="true">{value.toFixed(2)}</span>
        <button type="button" onClick={() => step(SLIDER_STEP)} disabled={value >= SLIDER_MAX} aria-label={`${incLabel} · ${label}`}>+</button>
      </span>
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
    <div className="cf-row is-cups">
      <span className="cf-label">{label}</span>
      <span className="cf-cups">
        {cups.map((checked, i) => (
          <button
            key={i} type="button"
            className="cf-cup"
            onClick={() => onChange(i)}
            aria-pressed={checked}
            aria-label={`${label} · ${cupLabel(i)}`}
          >
            {i + 1}
          </button>
        ))}
      </span>
      <span className="cf-val">{score}</span>
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
  /** The guest pages have no language provider; they pass the language the guest chose. */
  lang?: Lang;
  /**
   * "staff" (default): G-06 — the label column beside the controls and the score card at the
   * inline end. "guest": G-08 — sections stacked inside the open cup, the score under them.
   */
  variant?: "staff" | "guest";
};

// ─── Main Form ────────────────────────────────────────────────────────────────

export default function CuppingForm({ onSubmit, submitting = false, submitLabel, lang: langProp, variant = "staff" }: Props) {
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

  // ── Live score math (unchanged) ────────────────────────────────────────────
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
  // Display split of the same subtotal (G-06 score card): sensory sum, cup sum.
  const sensoryTotal = Object.values(sliders).reduce((a, b) => a + b, 0);
  const cupTotal = cupScores.uniformity + cupScores.cleanCup + cupScores.sweetness;

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

  const moreCount = FLAVOR_TAGS.length - FEATURED_TAGS.length;
  const visibleTags = showAllTags
    ? [...FEATURED_TAGS, ...FLAVOR_TAGS.filter((t) => !FEATURED_TAGS.includes(t))]
    : [...FEATURED_TAGS, ...tags.filter((t) => !FEATURED_TAGS.includes(t))];

  const guest = variant === "guest";
  const qualityDot = <span className={`hr-dot tone-${quality.tone}`} data-testid="cupping-quality"><span>{qualityLabel}</span></span>;
  const label = submitting ? L("جارٍ الإرسال…", "Submitting…") : (submitLabel ?? L("إرسال التقييم", "Submit score"));
  const submit = (cls?: string) => (
    <button type="submit" disabled={submitting} aria-busy={submitting || undefined} className={`hr-btn is-primary${cls ? ` ${cls}` : ""}`}>{label}</button>
  );
  // The score with the submit, inline: the guest footer (G-08) and the phone's sticky bar (G-06m).
  const scoreInline = (
    <div className="cf-score">
      <span>{L("النتيجة النهائية", "Final score")}</span>
      <div><span className="cf-final cf-num" data-testid="cupping-final-score">{finalScore.toFixed(2)}</span>{qualityDot}</div>
    </div>
  );

  return (
    <form onSubmit={handleSubmit} className={`cf ${guest ? "is-stack" : "is-sheet"}`} lang={lang} data-testid="cupping-form">
      <div className="cf-main">

        {/* ── Sensory attributes (6 – 10) ─────────────────────────── */}
        <Sec title={L("الصفات الحسية", "Sensory attributes")}
          caption={<>{L("من", "From")} <span className="cf-num">6</span> {L("إلى", "to")} <span className="cf-num">10</span> · {L("خطوة", "step")} <span className="cf-num">0.25</span></>}>
          {SLIDER_ATTRS.map((attr) => (
            <ScoreSlider
              key={attr.key}
              label={attrLabel(attr)}
              value={sliders[attr.key]}
              onChange={(v) => setSlider(attr.key, v)}
              decLabel={L("إنقاص", "Decrease")}
              incLabel={L("زيادة", "Increase")}
            />
          ))}
        </Sec>

        {/* ── Cup attributes (5 cups × 2 points) ──────────────────── */}
        <Sec title={L("الأكواب", "Cups")}
          caption={<><span className="cf-num">5</span> {L("أكواب × نقطتان · اضغط لتعليم كوب فاشل", "cups × 2 points · tap to mark a failed cup")}</>}>
          {CUP_ATTRS.map((attr) => (
            <CupRow
              key={attr.key}
              label={attrLabel(attr)}
              cupLabel={(i) => L(`كوب ${i + 1}`, `Cup ${i + 1}`)}
              cups={cups[attr.key]}
              onChange={(i) => toggleCup(attr.key, i)}
            />
          ))}
        </Sec>

        {/* ── Defects ─────────────────────────────────────────────── */}
        <Sec title={L("العيوب", "Defects")}
          caption={<>{L("شائبة", "Taint")} <span className="cf-num">−2</span> {L("أو عيب", "or fault")} <span className="cf-num">−4</span> {L("لكل كوب", "per cup")}</>}>
          <div className="cf-seg" role="group" aria-label={L("العيوب", "Defects")}>
            {(["none", "taint", "fault"] as const).map((type) => (
              <button key={type} type="button" aria-pressed={defectType === type}
                onClick={() => { setDefectType(type); if (type === "none") setDefectCups(0); }}>
                {type === "none" ? L("لا عيب", "No defect") : type === "taint" ? L("شائبة", "Taint") : L("عيب", "Fault")}
              </button>
            ))}
          </div>
          {defectType !== "none" && (
            <div className="cf-sub">
              <span className="cf-sublabel" id="cf-defect-cups">{L("عدد الأكواب المعيبة", "Number of defect cups")}</span>
              <div className="cf-seg" role="group" aria-labelledby="cf-defect-cups">
                {[0, 1, 2, 3, 4, 5].map((n) => (
                  <button key={n} type="button" aria-pressed={defectCups === n} onClick={() => setDefectCups(n)}>
                    <span className="cf-num">{n}</span>
                  </button>
                ))}
              </div>
              {defectCups > 0 && (
                <span className="cf-penalty">
                  {L("الخصم", "Penalty")}: <span className="cf-num">−{defectCups * (defectType === "fault" ? 4 : 2)}</span> {L("نقاط", "points")}
                </span>
              )}
            </div>
          )}
        </Sec>

        {/* ── Flavor descriptors ──────────────────────────────────── */}
        <Sec title={L("واصفات النكهة", "Flavor descriptors")} caption={L("اختر ما ينطبق", "Pick all that apply")}>
          <div className="cf-chips">
            {visibleTags.map((tag) => {
              const on = tags.includes(tag);
              return (
                <button key={tag} type="button" className="cf-chip" onClick={() => toggleTag(tag)} aria-pressed={on}>
                  {descriptorLabel(tag, lang)}
                  {on ? <IconClose /> : null}
                </button>
              );
            })}
            <button type="button" className="cf-chip is-more" onClick={() => setShowAllTags((p) => !p)} aria-expanded={showAllTags}>
              <IconFilter />
              {showAllTags ? L("أقل", "Less") : <><span className="cf-num">{moreCount}</span> {L("أخرى", "more")}</>}
            </button>
          </div>
        </Sec>

        {/* ── Notes ───────────────────────────────────────────────── */}
        <Sec title={guest ? L("ملاحظاتك", "Your notes") : L("ملاحظات المقيّم", "Cupper notes")} caption={L("اختياري", "Optional")} htmlFor="cupper-notes">
          <textarea
            id="cupper-notes"
            className="cf-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            placeholder={L("صف ما تتذوقه وتشمّه وتشعر به في الكوب…", "Describe what you taste, smell, and feel in the cup…")}
          />
        </Sec>

        {guest ? <div className="cf-foot">{scoreInline}{submit()}</div> : null}
        {/* Phone: the score and the submit stay reachable at the bottom (G-06m). */}
        <div className="cf-bar">{scoreInline}{submit()}</div>
      </div>

      {/* ── Score card (G-06, staff, desk) ────────────────────────── */}
      {!guest ? (
        <aside className="cf-card" aria-label={L("نتيجة SCA النهائية", "SCA final score")}>
          <p className="cf-card-cap">{lang === "ar" ? <>نتيجة <span className="cf-num">SCA</span> النهائية</> : <><span className="cf-num">SCA</span> final score</>}</p>
          <p className="cf-big cf-num">{finalScore.toFixed(2)}</p>
          <div>{qualityDot}</div>
          <dl className="cf-props">
            <dt>{L("الحسّي", "Sensory")}</dt><dd>{sensoryTotal.toFixed(2)}</dd>
            <dt>{L("الأكواب", "Cups")}</dt><dd>{cupTotal.toFixed(2)}</dd>
            <dt>{L("العيوب", "Defects")}</dt><dd>{defectPenalty > 0 ? `−${defectPenalty.toFixed(2)}` : "0.00"}</dd>
            <dt>{L("النهائية", "Final")}</dt><dd className="is-final">{finalScore.toFixed(2)}</dd>
          </dl>
          {submit()}
          <p className="cf-hint">{L("لا يُعدَّل التقييم بعد الإرسال", "A score cannot be changed once submitted")}</p>
        </aside>
      ) : null}
    </form>
  );
}
