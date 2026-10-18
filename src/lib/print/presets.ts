/** Saved label presets (template + field configuration + language), validated like profiles. */
import { PRINT_LANGS, type PrintLang } from "./bidi";
import { TEMPLATE_KEYS, normalizeFields, type FieldConfig, type TemplateKey } from "./templates";

export type PresetInput = {
  name: string;
  templateKey: TemplateKey;
  language: PrintLang;
  fields: FieldConfig;
  /** 1–6, or null = by label size (design §P2-2). */
  notesMaxLines: number | null;
  showLogo: boolean;
  profileId: string | null;
};

export function validatePreset(raw: unknown): { ok: true; value: PresetInput } | { ok: false; errors: { field: string; code: string }[] } {
  const b = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const errors: { field: string; code: string }[] = [];
  const name = typeof b.name === "string" ? b.name.trim() : "";
  if (name.length < 1 || name.length > 80) errors.push({ field: "name", code: "PRESET_NAME" });
  const templateKey = (TEMPLATE_KEYS as readonly string[]).includes(b.templateKey as string) ? (b.templateKey as TemplateKey) : null;
  if (!templateKey) errors.push({ field: "templateKey", code: "PRESET_TEMPLATE" });
  const language = (PRINT_LANGS as string[]).includes(b.language as string) ? (b.language as PrintLang) : null;
  if (!language) errors.push({ field: "language", code: "PRESET_LANGUAGE" });
  if (!Array.isArray(b.fields)) errors.push({ field: "fields", code: "PRESET_FIELDS" });
  const lines = b.notesMaxLines === undefined ? null : b.notesMaxLines;
  if (lines !== null && (typeof lines !== "number" || !Number.isInteger(lines) || lines < 1 || lines > 6)) errors.push({ field: "notesMaxLines", code: "PRESET_NOTES_LINES" });
  const profileId = typeof b.profileId === "string" && b.profileId ? b.profileId : null;
  if (errors.length || !templateKey || !language) return { ok: false, errors };
  return { ok: true, value: { name, templateKey, language, fields: normalizeFields(templateKey, b.fields), notesMaxLines: lines as number | null, showLogo: b.showLogo !== false, profileId } };
}
