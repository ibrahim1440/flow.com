/**
 * Shared request handling for /api/print/label-data (preview, no audit) and /api/print/jobs
 * (authorized job, audited).
 */
import { NextResponse } from "@/lib/api-response";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { PRINT_LANGS, type PrintLang } from "../bidi";
import { BLOCKING_CODES, contentWarnings, WARNING_CODES, type LabelData, type WarningCode } from "../content";
import { jobTotals, validateJob, type LayoutProfile } from "../layout";
import { profileDefinition, type PrintProfileData } from "../profiles";
import { TEMPLATE_KEYS, defaultFields, isShown, normalizeFields, type FieldConfig, type TemplateKey } from "../templates";
import { badRequest, canNameScorers, readJson, requirePrint, requireTemplateAccess } from "./auth";
import { PrintRefusal, getPrintSettings, itemRef, parseItems, resolveItems, type ItemIn } from "./data";

export type ParsedJob = {
  template: TemplateKey;
  language: PrintLang;
  items: ItemIn[];
  profile: PrintProfileData;
  startSlot: number;
  fields: FieldConfig;
  notesLines: number | null;
  clientWarnings: WarningCode[];
  /**
   * Notes mode recorded in the audit, derived on the server (QA P2-1): the effective mode from the
   * normalized fields, the default from the applied preset (or the template defaults). What the
   * client claimed is kept apart and never decides «overridden».
   */
  options: { notesMode: NotesMode | null; notesModeDefault: NotesMode | null; notesModeOverridden: boolean; clientClaim: { notesMode: string | null; notesModeDefault: string | null } | null };
  /** Decision 2.1: true only with the permission AND a privacy-confirmed preset asking for names. */
  named: boolean;
  /** Names were asked for (fields) but not authorized: printed anonymously. */
  namedIgnored: boolean;
  presetId: string | null;
};

export type NotesMode = "shared" | "scorer" | "both" | "none";
/** The notes mode a field configuration prints. */
export function notesModeOf(f: FieldConfig): NotesMode {
  const shared = isShown(f, "sharedNotes"), scorer = isShown(f, "scorerNotes");
  return shared && scorer ? "both" : scorer ? "scorer" : shared ? "shared" : "none";
}

export function toProfileData(p: Prisma.PrintProfileGetPayload<object>): PrintProfileData {
  return {
    id: p.id, name: p.name, kind: p.kind as PrintProfileData["kind"], paperWidthMm: p.paperWidthMm, paperHeightMm: p.paperHeightMm,
    labelWidthMm: p.labelWidthMm, labelHeightMm: p.labelHeightMm, marginTopMm: p.marginTopMm, marginLeftMm: p.marginLeftMm, marginRightMm: p.marginRightMm, marginBottomMm: p.marginBottomMm,
    gapXMm: p.gapXMm, gapYMm: p.gapYMm, columns: p.columns, rows: p.rows, orientation: p.orientation as PrintProfileData["orientation"],
    scalePct: p.scalePct, dpi: p.dpi, offsetXMm: p.offsetXMm, offsetYMm: p.offsetYMm, defaultStartSlot: p.defaultStartSlot,
    defaultCopies: p.defaultCopies, isPreset: p.isPreset, presetKey: p.presetKey, ownerId: p.ownerId, ownerName: p.ownerName,
  };
}

/**
 * Authenticates, authorizes and parses a job body. Returns the response to send on failure.
 * Order (review F1): authentication (401) → labels.print (403) → certification gate (409) → body
 * parse (400) → cupping module access for Cupping Results (403) → validation. Nothing is read from
 * the request before the caller is authorized and printing is enabled, so an unauthorized caller or
 * a gate-off server never reveals validation detail, whatever the body is.
 */
export async function parseJobRequest(req: Request) {
  const { user, error } = await requirePrint();
  if (error) return { error } as const;
  const { body, error: bodyErr } = await readJson(req);
  if (bodyErr) return { error: bodyErr } as const;
  const b = body!;
  const template = (TEMPLATE_KEYS as readonly string[]).includes(b.template as string) ? (b.template as TemplateKey) : null;
  if (!template) return { error: badRequest("TEMPLATE_INVALID", "template must be COFFEE_ORIGIN or CUPPING_RESULTS.") } as const;
  const denied = requireTemplateAccess(user, template);
  if (denied) return { error: denied } as const;
  const language = (PRINT_LANGS as string[]).includes(b.language as string) ? (b.language as PrintLang) : null;
  if (!language) return { error: badRequest("LANGUAGE_INVALID", "language must be AR, EN or BI.") } as const;
  if (typeof b.profileId !== "string") return { error: badRequest("PROFILE_REQUIRED", "profileId is required.") } as const;
  const row = await prisma.printProfile.findUnique({ where: { id: b.profileId } });
  if (!row) return { error: NextResponse.json({ error: "Profile not found.", code: "PROFILE_NOT_FOUND" }, { status: 404 }) } as const;
  const profile = toProfileData(row);
  let items: ItemIn[];
  try { items = parseItems(b.items, template); } catch (e) {
    if (e instanceof PrintRefusal) return { error: NextResponse.json({ error: e.message, code: e.code, ...e.extra }, { status: e.status }) } as const;
    throw e;
  }
  const startSlot = b.startSlot === undefined ? 1 : (b.startSlot as number);
  const notesLines = Number.isInteger(b.notesLines) && (b.notesLines as number) >= 1 && (b.notesLines as number) <= 6 ? (b.notesLines as number) : null;
  const clientWarnings = Array.isArray(b.warnings) ? (b.warnings as unknown[]).filter((w): w is WarningCode => WARNING_CODES.includes(w as WarningCode)) : [];
  const o = (b.options && typeof b.options === "object" ? b.options : {}) as Record<string, unknown>;
  const mode = (v: unknown) => (typeof v === "string" && ["shared", "scorer", "both", "none"].includes(v) ? v : null);
  let fields = normalizeFields(template, b.fields);
  // Owner decision 2.1 — enforced here, whatever the client sends: scorer names print only for a
  // user holding labels.cupping_named_scorers, through a saved Cupping Results preset whose privacy
  // confirmation is recorded and which itself shows names. Anything else is printed anonymously.
  // Only a preset that exists and belongs to this template counts (for names and for the notes default).
  const askedPreset = typeof b.presetId === "string" && b.presetId ? b.presetId : null;
  const presetRow = askedPreset ? await prisma.printTemplatePreset.findUnique({ where: { id: askedPreset } }) : null;
  const preset = presetRow && presetRow.templateKey === template ? presetRow : null;
  const presetId = preset?.id ?? null;
  const wantsNames = isShown(fields, "scorerNames");
  let named = false;
  if (wantsNames && template === "CUPPING_RESULTS" && canNameScorers(user) && preset) {
    named = preset.namedScorersConfirmedAt !== null && isShown(normalizeFields("CUPPING_RESULTS", preset.fields), "scorerNames");
  }
  if (!named) fields = fields.map((f) => (f.key === "scorerNames" ? { ...f, show: false } : f));
  const cupping = template === "CUPPING_RESULTS";
  const notesMode = cupping ? notesModeOf(fields) : null;
  const notesModeDefault = cupping ? notesModeOf(preset ? normalizeFields(template, preset.fields) : defaultFields(template)) : null;
  const claim = { notesMode: mode(o.notesMode), notesModeDefault: mode(o.notesModeDefault) };
  const options = {
    notesMode, notesModeDefault, notesModeOverridden: cupping && notesMode !== notesModeDefault,
    clientClaim: claim.notesMode !== null || claim.notesModeDefault !== null ? claim : null,
  };
  const parsed: ParsedJob = { template, language, items, profile, startSlot, fields, notesLines, clientWarnings, options, named, namedIgnored: wantsNames && !named, presetId };
  return { user, parsed } as const;
}

/** Layout validation against the administrator's job cap, then data resolution. */
export async function buildJob(parsed: ParsedJob) {
  const settings = await getPrintSettings();
  const jobItems = parsed.items.map((it) => ({ ref: itemRef(it), copies: it.copies }));
  const layoutProfile: LayoutProfile = parsed.profile;
  const errors = validateJob(layoutProfile, jobItems, parsed.startSlot, settings.maxLabelsPerJob);
  const totals = jobTotals(layoutProfile, jobItems.map((i) => ({ ...i, copies: Number.isInteger(i.copies) ? i.copies : 0 })), Number.isInteger(parsed.startSlot) ? parsed.startSlot : 1);
  if (errors.length) {
    const tooLarge = errors.some((e) => e.code === "TOO_MANY_LABELS" || e.code === "TOO_MANY_PAGES" || e.code === "TOO_MANY_ITEMS");
    return {
      error: NextResponse.json({
        error: tooLarge ? `This job is larger than allowed (${totals.labels} labels, ${totals.pages} pages; at most ${settings.maxLabelsPerJob} labels per job).` : "Invalid print job.",
        code: tooLarge ? "PRINT_JOB_TOO_LARGE" : errors[0].code,
        errors, totals, maxLabelsPerJob: settings.maxLabelsPerJob,
      }, { status: 400 }),
    } as const;
  }
  let data: LabelData[];
  try { data = await resolveItems(parsed.template, parsed.items, parsed.named); } catch (e) {
    if (e instanceof PrintRefusal) return { error: NextResponse.json({ error: e.message, code: e.code, ...e.extra }, { status: e.status }) } as const;
    throw e;
  }
  // Data minimization (QA P3-7): individual notes leave the server only when the job prints them.
  if (parsed.template === "CUPPING_RESULTS" && !isShown(parsed.fields, "scorerNotes")) {
    data = data.map((d) => (d.kind === "cup" ? { ...d, result: { ...d.result, scorerNotes: null } } : d));
  }
  const s = layoutProfile.scalePct / 100;
  const warnings = contentWarnings(data, parsed.template, parsed.fields, parsed.language, { wMm: layoutProfile.labelWidthMm * s, hMm: layoutProfile.labelHeightMm * s }, { notesLines: parsed.notesLines });
  if (parsed.namedIgnored) warnings.push({ code: "NAMED_SCORERS_IGNORED" });
  return { data, totals, warnings, maxLabelsPerJob: settings.maxLabelsPerJob, blocked: warnings.filter((w) => BLOCKING_CODES.includes(w.code)) } as const;
}

/** The audit snapshot of a profile: geometry only. */
export const profileSnapshot = (p: PrintProfileData) => ({ ...profileDefinition(p), isPreset: p.isPreset, presetKey: p.presetKey }) as unknown as Prisma.InputJsonValue;
