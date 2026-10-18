/**
 * Print profiles (A-3): the paper / label stock a job is laid out for, in millimetres. The ranges
 * here are the same as the CHECK constraints of migration 20261016150000_print_system; the API
 * validates with this module first and the database is the backstop.
 */
export const PROFILE_KINDS = ["A4_PLAIN", "A4_SHEET", "THERMAL_ROLL", "CUSTOM"] as const;
export type ProfileKind = (typeof PROFILE_KINDS)[number];
export const ORIENTATIONS = ["PORTRAIT", "LANDSCAPE"] as const;
export type Orientation = (typeof ORIENTATIONS)[number];

export type ProfileGeometry = {
  paperWidthMm: number;
  paperHeightMm: number;
  labelWidthMm: number;
  labelHeightMm: number;
  marginTopMm: number;
  marginLeftMm: number;
  /** Right / bottom margins (design §P2-3 T·R·B·L): part of the fit check; the grid itself starts at top / left. */
  marginRightMm: number;
  marginBottomMm: number;
  gapXMm: number;
  gapYMm: number;
  columns: number;
  rows: number;
  orientation: Orientation;
  scalePct: number;
  dpi: number;
  offsetXMm: number;
  offsetYMm: number;
};

export type ProfileInput = ProfileGeometry & {
  name: string;
  kind: ProfileKind;
  defaultStartSlot: number;
  defaultCopies: number;
};

export type PrintProfileData = ProfileInput & {
  id: string;
  isPreset: boolean;
  presetKey: string | null;
  ownerId: string | null;
  ownerName: string | null;
};

/** [min, max] inclusive. */
export const PROFILE_LIMITS = {
  nameMax: 80,
  paperMm: [20, 1000],
  labelMm: [10, 1000],
  marginMm: [0, 100],
  gapMm: [0, 50],
  columns: [1, 20],
  rows: [1, 50],
  scalePct: [50, 200],
  dpi: [72, 1200],
  offsetMm: [-20, 20],
  copies: [1, 100],
} as const;

/** Tolerance for decimal stock sizes (99.1 × 2 + 2.5 + 2 × 4.65 = 210.0000…01). */
export const FIT_TOLERANCE_MM = 0.01;

export type ProfileError = { field: keyof ProfileInput | "grid"; code: string };

/** The paper as it is fed: LANDSCAPE swaps width and height. */
export function orientedPaper(p: Pick<ProfileGeometry, "paperWidthMm" | "paperHeightMm" | "orientation">) {
  return p.orientation === "LANDSCAPE"
    ? { w: p.paperHeightMm, h: p.paperWidthMm }
    : { w: p.paperWidthMm, h: p.paperHeightMm };
}

export const capacity = (p: Pick<ProfileGeometry, "columns" | "rows">) => p.columns * p.rows;

/** A roll prints one label per page (the page is the label). */
export function isRoll(p: Pick<ProfileInput, "kind"> & Pick<ProfileGeometry, "columns" | "rows">): boolean {
  return p.kind === "THERMAL_ROLL" || (p.kind !== "A4_SHEET" && p.kind !== "A4_PLAIN" && capacity(p) === 1);
}

/** Start slot applies to sheets with more than one label (B-3). */
export const usesStartSlot = (p: Pick<ProfileInput, "kind"> & Pick<ProfileGeometry, "columns" | "rows">) => !isRoll(p) && capacity(p) > 1;

/** Compact = smaller than 70 × 45 mm (the 50 × 30 class, A-4). */
export const COMPACT_MAX = { w: 70, h: 45 };
export function isCompactLabel(widthMm: number, heightMm: number): boolean {
  return widthMm < COMPACT_MAX.w || heightMm < COMPACT_MAX.h;
}

/** Grid extent from the paper origin, before scale and offsets. */
export function gridExtent(p: ProfileGeometry) {
  return {
    w: p.marginLeftMm + p.columns * p.labelWidthMm + (p.columns - 1) * p.gapXMm,
    h: p.marginTopMm + p.rows * p.labelHeightMm + (p.rows - 1) * p.gapYMm,
  };
}

const r3 = (v: number) => String(Math.round(v * 1000) / 1000);
/**
 * The dimension check of the design (§P2-3): all four margins, the labels and the gaps must add up
 * to no more than the paper, e.g. «4.65 + 99.1 + 2.5 + 99.1 + 4.65 = 210 mm» across an A4 sheet.
 * Returns each axis' terms as text, the sum and the paper size (oriented).
 */
export function fitSums(p: ProfileGeometry) {
  const paper = orientedPaper(p);
  // Design 1652:10127: «4.65 + 99.1 + 2.5 + 99.1 + 4.65 = 210.0 mm ✓» and, with no gap,
  // «13.1 + 4 × 67.7 + 13.1 = 297.0 mm ✓». A sum over the paper names the paper: «… > 210.0 mm».
  const axis = (start: number, n: number, size: number, gap: number, end: number) => {
    const parts: string[] = [r3(start)];
    if (n > 1 && gap === 0) parts.push(`${n} × ${r3(size)}`);
    else if (n <= 4) for (let i = 0; i < n; i++) { if (i) parts.push(r3(gap)); parts.push(r3(size)); }
    else { parts.push(`${n} × ${r3(size)}`); parts.push(`${n - 1} × ${r3(gap)}`); }
    parts.push(r3(end));
    return { terms: parts.join(" + "), sum: start + n * size + (n - 1) * gap + end };
  };
  const f1 = (v: number) => (Math.round(v * 10) / 10).toFixed(1);
  // Failed state (1661:14509): «4.65 + 101.0 + 2.5 + 101.0 + 4.65 = 213.8 mm ✗ (> 210.0)».
  const line = (a: { terms: string; sum: number }, paperMm: number) => {
    const ok = a.sum <= paperMm + FIT_TOLERANCE_MM;
    const text = `${a.terms} = ${f1(a.sum)} mm`;
    return { ok, text, display: ok ? `${text} ✓` : `${text} ✗ (> ${f1(paperMm)})` };
  };
  const w = axis(p.marginLeftMm, p.columns, p.labelWidthMm, p.gapXMm, p.marginRightMm);
  const h = axis(p.marginTopMm, p.rows, p.labelHeightMm, p.gapYMm, p.marginBottomMm);
  return {
    width: { ...w, paper: paper.w, ...line(w, paper.w) },
    height: { ...h, paper: paper.h, ...line(h, paper.h) },
  };
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : NaN);
const int = (v: unknown) => (typeof v === "number" && Number.isInteger(v) ? v : NaN);
const inRange = (v: number, [a, b]: readonly [number, number]) => Number.isFinite(v) && v >= a && v <= b;

/**
 * Validates an untrusted profile body. Returns the normalized value or every error found
 * (field + stable code), never a partial value.
 */
export function validateProfile(raw: unknown): { ok: true; value: ProfileInput } | { ok: false; errors: ProfileError[] } {
  const b = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const errors: ProfileError[] = [];
  const name = typeof b.name === "string" ? b.name.trim() : "";
  if (name.length < 1 || name.length > PROFILE_LIMITS.nameMax) errors.push({ field: "name", code: "PROFILE_NAME" });
  const kind = (PROFILE_KINDS as readonly string[]).includes(b.kind as string) ? (b.kind as ProfileKind) : null;
  if (!kind) errors.push({ field: "kind", code: "PROFILE_KIND" });
  const orientation = b.orientation === undefined ? "PORTRAIT" : (ORIENTATIONS as readonly string[]).includes(b.orientation as string) ? (b.orientation as Orientation) : null;
  if (!orientation) errors.push({ field: "orientation", code: "PROFILE_ORIENTATION" });

  const v = {
    paperWidthMm: num(b.paperWidthMm), paperHeightMm: num(b.paperHeightMm),
    labelWidthMm: num(b.labelWidthMm), labelHeightMm: num(b.labelHeightMm),
    marginTopMm: b.marginTopMm === undefined ? 0 : num(b.marginTopMm),
    marginLeftMm: b.marginLeftMm === undefined ? 0 : num(b.marginLeftMm),
    marginRightMm: b.marginRightMm === undefined ? 0 : num(b.marginRightMm),
    marginBottomMm: b.marginBottomMm === undefined ? 0 : num(b.marginBottomMm),
    gapXMm: b.gapXMm === undefined ? 0 : num(b.gapXMm),
    gapYMm: b.gapYMm === undefined ? 0 : num(b.gapYMm),
    columns: b.columns === undefined ? 1 : int(b.columns),
    rows: b.rows === undefined ? 1 : int(b.rows),
    scalePct: b.scalePct === undefined ? 100 : int(b.scalePct),
    dpi: b.dpi === undefined ? 203 : int(b.dpi),
    offsetXMm: b.offsetXMm === undefined ? 0 : num(b.offsetXMm),
    offsetYMm: b.offsetYMm === undefined ? 0 : num(b.offsetYMm),
    defaultStartSlot: b.defaultStartSlot === undefined ? 1 : int(b.defaultStartSlot),
    defaultCopies: b.defaultCopies === undefined ? 1 : int(b.defaultCopies),
  };
  const L = PROFILE_LIMITS;
  const check = (field: keyof ProfileInput, ok: boolean, code: string) => { if (!ok) errors.push({ field, code }); };
  check("paperWidthMm", inRange(v.paperWidthMm, L.paperMm), "PROFILE_PAPER_RANGE");
  check("paperHeightMm", inRange(v.paperHeightMm, L.paperMm), "PROFILE_PAPER_RANGE");
  check("labelWidthMm", inRange(v.labelWidthMm, L.labelMm), "PROFILE_LABEL_RANGE");
  check("labelHeightMm", inRange(v.labelHeightMm, L.labelMm), "PROFILE_LABEL_RANGE");
  check("marginTopMm", inRange(v.marginTopMm, L.marginMm), "PROFILE_MARGIN_RANGE");
  check("marginLeftMm", inRange(v.marginLeftMm, L.marginMm), "PROFILE_MARGIN_RANGE");
  check("marginRightMm", inRange(v.marginRightMm, L.marginMm), "PROFILE_MARGIN_RANGE");
  check("marginBottomMm", inRange(v.marginBottomMm, L.marginMm), "PROFILE_MARGIN_RANGE");
  check("gapXMm", inRange(v.gapXMm, L.gapMm), "PROFILE_GAP_RANGE");
  check("gapYMm", inRange(v.gapYMm, L.gapMm), "PROFILE_GAP_RANGE");
  check("columns", inRange(v.columns, L.columns), "PROFILE_COLUMNS_RANGE");
  check("rows", inRange(v.rows, L.rows), "PROFILE_ROWS_RANGE");
  check("scalePct", inRange(v.scalePct, L.scalePct), "PROFILE_SCALE_RANGE");
  check("dpi", inRange(v.dpi, L.dpi), "PROFILE_DPI_RANGE");
  check("offsetXMm", inRange(v.offsetXMm, L.offsetMm), "PROFILE_OFFSET_RANGE");
  check("offsetYMm", inRange(v.offsetYMm, L.offsetMm), "PROFILE_OFFSET_RANGE");
  check("defaultCopies", inRange(v.defaultCopies, L.copies), "PROFILE_COPIES_RANGE");
  if (Number.isInteger(v.columns) && Number.isInteger(v.rows)) {
    check("defaultStartSlot", inRange(v.defaultStartSlot, [1, Math.max(1, v.columns * v.rows)]), "PROFILE_START_SLOT_RANGE");
  }
  if (errors.length === 0 && orientation) {
    const f = fitSums({ ...v, orientation });
    if (!f.width.ok) errors.push({ field: "grid", code: "PROFILE_GRID_TOO_WIDE" });
    if (!f.height.ok) errors.push({ field: "grid", code: "PROFILE_GRID_TOO_TALL" });
  }
  if (errors.length > 0 || !kind || !orientation) return { ok: false, errors };
  return { ok: true, value: { name, kind, orientation, ...v } };
}

/** The four built-in presets — identical to the rows the migration inserts. */
export const PRESET_PROFILES: PrintProfileData[] = [
  { id: "print_preset_a4_plain", presetKey: "A4_PLAIN", name: "A4 plain", kind: "A4_PLAIN", paperWidthMm: 210, paperHeightMm: 297, labelWidthMm: 190, labelHeightMm: 277, marginTopMm: 10, marginLeftMm: 10, marginRightMm: 10, marginBottomMm: 10, gapXMm: 0, gapYMm: 0, columns: 1, rows: 1, orientation: "PORTRAIT", scalePct: 100, dpi: 300, offsetXMm: 0, offsetYMm: 0, defaultStartSlot: 1, defaultCopies: 1, isPreset: true, ownerId: null, ownerName: null },
  { id: "print_preset_a4_l7165", presetKey: "A4_L7165", name: "A4 label sheet · 8", kind: "A4_SHEET", paperWidthMm: 210, paperHeightMm: 297, labelWidthMm: 99.1, labelHeightMm: 67.7, marginTopMm: 13.1, marginLeftMm: 4.65, marginRightMm: 4.65, marginBottomMm: 13.1, gapXMm: 2.5, gapYMm: 0, columns: 2, rows: 4, orientation: "PORTRAIT", scalePct: 100, dpi: 300, offsetXMm: 0, offsetYMm: 0, defaultStartSlot: 1, defaultCopies: 1, isPreset: true, ownerId: null, ownerName: null },
  { id: "print_preset_thermal", presetKey: "THERMAL_100x70", name: "Thermal roll 100 × 70", kind: "THERMAL_ROLL", paperWidthMm: 100, paperHeightMm: 70, labelWidthMm: 100, labelHeightMm: 70, marginTopMm: 0, marginLeftMm: 0, marginRightMm: 0, marginBottomMm: 0, gapXMm: 0, gapYMm: 3, columns: 1, rows: 1, orientation: "PORTRAIT", scalePct: 100, dpi: 203, offsetXMm: 0, offsetYMm: 0, defaultStartSlot: 1, defaultCopies: 1, isPreset: true, ownerId: null, ownerName: null },
  { id: "print_preset_compact", presetKey: "COMPACT_50x30", name: "Thermal roll 50 × 30", kind: "THERMAL_ROLL", paperWidthMm: 50, paperHeightMm: 30, labelWidthMm: 50, labelHeightMm: 30, marginTopMm: 0, marginLeftMm: 0, marginRightMm: 0, marginBottomMm: 0, gapXMm: 0, gapYMm: 3, columns: 1, rows: 1, orientation: "PORTRAIT", scalePct: 100, dpi: 203, offsetXMm: 0, offsetYMm: 0, defaultStartSlot: 1, defaultCopies: 1, isPreset: true, ownerId: null, ownerName: null },
];

/**
 * Display names of the built-in presets in each UI language (design 1652:10127 / 1652:9690). A
 * custom profile shows the name its owner gave it.
 */
export const PRESET_NAMES: Record<string, { ar: string; en: string }> = {
  A4_L7165: { ar: "ورقة ملصقات A4 · 8", en: "A4 label sheet · 8" },
  A4_PLAIN: { ar: "ورق A4 عادي", en: "A4 plain" },
  THERMAL_100x70: { ar: "لفافة حرارية 100 × 70 mm", en: "Thermal roll 100 × 70" },
  COMPACT_50x30: { ar: "لفافة حرارية 50 × 30 mm", en: "Thermal roll 50 × 30" },
};
export function profileDisplayName(p: Pick<PrintProfileData, "name" | "presetKey" | "isPreset">, lang: "ar" | "en"): string {
  return p.isPreset && p.presetKey && PRESET_NAMES[p.presetKey] ? PRESET_NAMES[p.presetKey][lang] : p.name;
}

/** Columns of PrintProfile that make up its definition (for audit snapshots and duplication). */
export function profileDefinition(p: ProfileInput): ProfileInput {
  return {
    name: p.name, kind: p.kind, paperWidthMm: p.paperWidthMm, paperHeightMm: p.paperHeightMm,
    labelWidthMm: p.labelWidthMm, labelHeightMm: p.labelHeightMm, marginTopMm: p.marginTopMm, marginLeftMm: p.marginLeftMm, marginRightMm: p.marginRightMm, marginBottomMm: p.marginBottomMm,
    gapXMm: p.gapXMm, gapYMm: p.gapYMm, columns: p.columns, rows: p.rows, orientation: p.orientation,
    scalePct: p.scalePct, dpi: p.dpi, offsetXMm: p.offsetXMm, offsetYMm: p.offsetYMm,
    defaultStartSlot: p.defaultStartSlot, defaultCopies: p.defaultCopies,
  };
}
