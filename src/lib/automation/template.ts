/**
 * Message templates: plain text with {{placeholders}} taken from the event catalogue.
 *
 * Pure and client-safe — the editor's live preview and the dispatcher render with this same
 * function, so what the user previews is what the customer receives.
 *
 * An enumerated variable stores its code (Ready for Shipping) and is written as its label in
 * the rule's language (جاهز للشحن). A placeholder with no value renders as nothing rather
 * than as "{{...}}": a customer should never see the template's plumbing.
 */
import { getVariable, type EventDef, type Lang } from "./catalog";

export const TEMPLATE_MAX_LENGTH = 4000;

const PLACEHOLDER = /\{\{\s*([A-Za-z][\w.]*)\s*\}\}/g;

export type RenderContext = Record<string, string | number | null | undefined>;

/** Every distinct placeholder key in a template, in order of first appearance. */
export function placeholders(template: string): string[] {
  const seen = new Set<string>();
  for (const m of template.matchAll(PLACEHOLDER)) seen.add(m[1]);
  return [...seen];
}

/** Placeholders this event cannot fill — a typo, or a variable from another event. */
export function unknownPlaceholders(event: EventDef, template: string): string[] {
  return placeholders(template).filter((k) => !getVariable(event, k));
}

/** The text a variable is written as in a message. */
export function displayValue(event: EventDef, key: string, raw: unknown, lang: Lang): string {
  if (raw === null || raw === undefined) return "";
  const value = String(raw);
  const def = getVariable(event, key);
  if (def?.kind === "enum" && def.options) {
    const opt = def.options.find((o) => o.value === value);
    if (opt) return lang === "ar" ? opt.ar : opt.en;
  }
  return value;
}

export function renderTemplate(event: EventDef, template: string, ctx: RenderContext, lang: Lang): string {
  return template
    .replace(PLACEHOLDER, (_whole, key: string) => displayValue(event, key, ctx[key], lang))
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}
