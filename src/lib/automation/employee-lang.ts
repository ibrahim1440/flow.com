/**
 * The language of automation WhatsApp messages to EMPLOYEES (owner language decision 3, 26 Oct 2026).
 *
 *   · An employee may choose the language they receive on «خدماتي» (Employee.whatsappLanguage):
 *     «حسب إعداد النظام» (NULL) / «العربية» / «English».
 *   · The automation settings hold the default for everyone who has not chosen
 *     (AutomationSettings.employeeMessageLang); NULL = Arabic.
 *   · At send time: the employee's choice, else the default, else Arabic (resolveMessageLang).
 *
 * A message to an employee has an Arabic and an English text: the rule step's `template` and
 * `templateEn`, the status notification's `template` and `templateEn`. When the English text is
 * missing, the built-in English of an untouched built-in Arabic text is used; when there is none,
 * the employee gets the text as it was always sent (the Arabic, in the rule's language). Customers,
 * typed phone numbers and marketing are never routed through here: their text is unchanged.
 *
 * Pure and client-safe: the rule editor offers these defaults, the dispatcher and the status-rule
 * planner choose with pickStaffTemplate, and tests/automation/employee-lang.test.ts asserts it.
 */
import type { Lang } from "./catalog";

export type MsgLang = Lang;

export const MESSAGE_LANGS: readonly MsgLang[] = ["ar", "en"];

export function asMsgLang(v: unknown): MsgLang | null {
  return v === "ar" || v === "en" ? v : null;
}

/** The employee's choice wins; otherwise the system default; otherwise Arabic. */
export function resolveMessageLang(employeeChoice: unknown, systemDefault: unknown): MsgLang {
  return asMsgLang(employeeChoice) ?? asMsgLang(systemDefault) ?? "ar";
}

/** A Person key of an employee login ("employee:<id>"), as context.ts builds them. */
export function staffIdOf(personKey: string): string | null {
  return personKey.startsWith("employee:") ? personKey.slice("employee:".length) || null : null;
}

/**
 * The built-in texts a new rule step starts with (the rule editor), per event, in both languages.
 * Internal wording: most rules message staff, not customers.
 */
export const DEFAULT_RULE_TEMPLATES: Record<string, { ar: string; en: string }> = {
  "order.created": {
    ar: "طلب جديد رقم {{order.number}} للعميل {{customer.name}}:\n{{order.items}}\nسجله: {{actor.name}}",
    en: "New order {{order.number}} for {{customer.name}}:\n{{order.items}}\nRecorded by: {{actor.name}}",
  },
  "order.status_changed": {
    ar: "الطلب {{order.number}} ({{customer.name}}) صار: {{status.to}}.",
    en: "Order {{order.number}} ({{customer.name}}) is now: {{status.to}}.",
  },
  "delivery.recorded": {
    ar: "تسليم للطلب {{order.number}} ({{customer.name}}): {{delivery.quantity}} من {{delivery.item}}.",
    en: "Delivery for order {{order.number}} ({{customer.name}}): {{delivery.quantity}} of {{delivery.item}}.",
  },
  "production.batch_roasted": {
    ar: "دفعة {{batch.number}} ({{batch.product}}) تحمصت: {{batch.greenKg}} كغ بن أخضر.",
    en: "Batch {{batch.number}} ({{batch.product}}) roasted: {{batch.greenKg}} kg of green coffee.",
  },
  "qc.batch_finalized": {
    ar: "نتيجة الجودة للدفعة {{batch.number}} ({{batch.product}}): {{qc.outcome}}.",
    en: "QC result for batch {{batch.number}} ({{batch.product}}): {{qc.outcome}}.",
  },
  "packaging.completed": {
    ar: "تغليف الدفعة {{batch.number}}: {{pack.units}} عبوة كاملة.",
    en: "Batch {{batch.number}} packed: {{pack.units}} full units.",
  },
  "production.order_created": {
    ar: "أمر إنتاج {{production.number}}: {{production.units}} وحدة من {{production.sku}} للطلب {{order.number}}.",
    en: "Production order {{production.number}}: {{production.units}} units of {{production.sku}} for order {{order.number}}.",
  },
  "sales.quote_status_changed": {
    ar: "عرض السعر {{quote.number}} لـ {{customer.name}}: {{quote.status}} ({{quote.total}}).",
    en: "Quotation {{quote.number}} for {{customer.name}}: {{quote.status}} ({{quote.total}}).",
  },
  "sales.task_due": {
    ar: "تذكير: {{task.subject}} — {{task.related}} (موعدها {{task.dueAt}}).",
    en: "Reminder: {{task.subject}} — {{task.related}} (due {{task.dueAt}}).",
  },
  "finance.approval_requested": {
    ar: "طلب اعتماد جديد ينتظرك: {{approval.summary}}\nمن: {{approval.requester}}",
    en: "A new approval request is waiting for you: {{approval.summary}}\nFrom: {{approval.requester}}",
  },
  "finance.approval_decided": {
    ar: "طلبك «{{approval.summary}}»: {{approval.decision}}.",
    en: "Your request “{{approval.summary}}”: {{approval.decision}}.",
  },
};

/** The built-in English of a rule step whose Arabic is still the built-in Arabic of its event. */
export function ruleEnglishDefault(eventKey: string, arabic: string): string | null {
  const d = DEFAULT_RULE_TEMPLATES[eventKey];
  return d && d.ar.trim() === arabic.trim() ? d.en : null;
}

export type TemplatePick = { template: string; lang: Lang };

/**
 * The text an employee receives, and the language its variables are written in.
 *
 *   want "en": the English text (stored, else the built-in English of an untouched built-in Arabic);
 *              none → the text as it was always sent (`template`, in `fallbackLang`).
 *   want "ar": `template`. Written in Arabic when the step is bilingual (it has an English text);
 *              otherwise exactly as before (`fallbackLang`, the rule's language).
 */
export function pickStaffTemplate(
  t: { template: string; templateEn?: string | null; englishDefault?: string | null; fallbackLang: Lang },
  want: MsgLang,
): TemplatePick {
  const stored = (t.templateEn ?? "").trim();
  if (want === "en") {
    const en = stored || (t.englishDefault ?? "").trim();
    return en ? { template: en, lang: "en" } : { template: t.template, lang: t.fallbackLang };
  }
  return { template: t.template, lang: stored ? "ar" : t.fallbackLang };
}
