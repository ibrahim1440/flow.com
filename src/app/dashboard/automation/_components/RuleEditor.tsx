"use client";

import { Select } from "@/components/ui/Select";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Btn, Field, Notice, OpsBanner, PageHeader } from "@/components/ops/ui";
import { Dialog } from "@/components/hr/ui";
import { useD21Phone } from "@/components/shell/page-context";
import { api, useLang } from "../../sales/_components/ui";
import {
  EVENT_GROUPS, EVENTS, RECIPIENT_LABELS, getEvent, recipientsFor, sampleContext, type EventDef, type RecipientKind,
} from "@/lib/automation/catalog";
import { CONDITION_OPS, CONDITION_OP_LABELS, OPS_WITHOUT_VALUE, type ConditionOp } from "@/lib/automation/conditions";
import { normalizePhoneForWhatsApp } from "@/lib/automation/phone";
import { EMAIL_LOCKED_EVENTS, MAX_STEPS, MAX_WAIT_MINUTES, QUOTE_ATTACH_EVENT, SUBJECT_MAX_LENGTH } from "@/lib/automation/rules";
import { parseEmailAddress } from "@/lib/automation/email-mode";
import { Lock } from "lucide-react";
import { renderTemplate, TEMPLATE_MAX_LENGTH, unknownPlaceholders } from "@/lib/automation/template";
import { DEFAULT_RULE_TEMPLATES, ruleEnglishDefault } from "@/lib/automation/employee-lang";
import { isStaffRecipient } from "@/lib/automation/rules";
import { PlusIco, Sec } from "../../_components/tools-ui";
import { Bubble, useAutomationAbilities } from "./shared";

// Direction 2.1 (UI batch 2; GX E-P02, Figma 1220:96575 at 1440, EN 1230:117812, 1024
// 1222:101068, phone 1228:124270): label-column sections «الأساسيات · 1. متى؟ · 2. بشرط ·
// 3. نفّذ الخطوات». Visual port only — the same catalogue, drafts, payload, requests (POST/PUT/
// DELETE) and read-only gate as before. The phone keeps the full editor (the frame's read-only
// phone summary is not adopted: it would remove editing on a phone).

/**
 * The rule editor: when <event>, if <conditions>, do <steps>.
 *
 * Everything it offers comes from the event catalogue — the same object the server validates
 * against and renders with — so a variable chip here is a variable the dispatcher fills, and
 * the preview is the message as it will be sent, with sample values.
 */

type ConditionDraft = { field: string; op: ConditionOp; value: string };
type WaitUnit = "minutes" | "hours" | "days";
type StepDraft =
  // templateEn: the English text of a staff step (owner language decision 3); unused for the customer / a typed number.
  | { key: number; type: "whatsapp"; kind: RecipientKind; employeeId: string; phone: string; phoneName: string; template: string; templateEn: string }
  | { key: number; type: "wait"; amount: string; unit: WaitUnit }
  // Batch 25: an e-mail to the event's customer, or to one address; attach = the event's own quotation PDF.
  | { key: number; type: "email"; toKind: "customer" | "email"; email: string; emailName: string; subject: string; template: string; attach: boolean };

export type StoredRule = {
  id: string;
  name: string;
  description: string | null;
  eventType: string;
  isActive: boolean;
  locale: string;
  conditions: unknown;
  steps: unknown;
};

type EmployeeOption = { id: string; name: string; hasPhone: boolean; phoneHint: string | null };

const UNIT_MINUTES: Record<WaitUnit, number> = { minutes: 1, hours: 60, days: 1440 };

let keySeq = 1;
const nextKey = () => keySeq++;

// Internal wording by default: most rules message staff, not customers. A rule written for a
// customer replaces the text anyway. Both languages (owner language decision 3): employees receive
// the Arabic or the English text (src/lib/automation/employee-lang.ts).
const DEFAULT_AR: Record<string, string> = Object.fromEntries(Object.entries(DEFAULT_RULE_TEMPLATES).map(([k, v]) => [k, v.ar]));

function toDraftSteps(raw: unknown, eventType: string): StepDraft[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((s: Record<string, unknown>) => {
    if (s.type === "wait") {
      const m = Number(s.minutes) || 1;
      const unit: WaitUnit = m % 1440 === 0 ? "days" : m % 60 === 0 ? "hours" : "minutes";
      return { key: nextKey(), type: "wait", amount: String(m / UNIT_MINUTES[unit]), unit };
    }
    const to = (s.to ?? {}) as Record<string, string>;
    const template = String(s.template ?? "");
    if (s.type === "email") {
      return { key: nextKey(), type: "email", toKind: to.kind === "email" ? "email" : "customer", email: to.email ?? "", emailName: to.name ?? "", subject: String(s.subject ?? ""), template, attach: s.attach === "quote_pdf" };
    }
    const stored = typeof s.templateEn === "string" ? s.templateEn : "";
    return {
      key: nextKey(),
      type: "whatsapp",
      kind: (to.kind as RecipientKind) ?? "customer",
      employeeId: to.employeeId ?? "",
      phone: to.phone ?? "",
      phoneName: to.name ?? "",
      template,
      // A step saved before the English text existed: an untouched built-in Arabic gets the built-in English.
      templateEn: stored || ruleEnglishDefault(eventType, template) || "",
    };
  });
}

function toDraftConditions(raw: unknown): ConditionDraft[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((c: Record<string, unknown>) => ({ field: String(c.field ?? ""), op: (c.op as ConditionOp) ?? "eq", value: String(c.value ?? "") }));
}

/**
 * Batch 25 (council seat 5): a new step goes to the CUSTOMER when the event has one — the case people build rules
 * for — else to the event's first own recipient.
 */
function defaultRecipient(event: EventDef | undefined): RecipientKind {
  if (event?.recipients.includes("customer")) return "customer";
  return event?.recipients[0] ?? "employee";
}

function newEmailStep(event: EventDef | undefined): StepDraft {
  const quote = event?.key === QUOTE_ATTACH_EVENT;
  const d = event ? DEFAULT_RULE_TEMPLATES[event.key] : undefined;
  return {
    key: nextKey(), type: "email", toKind: event?.recipients.includes("customer") ? "customer" : "email", email: "", emailName: "",
    subject: quote ? "عرض سعر {{quote.number}}" : event ? event.ar : "", template: d?.ar ?? "", attach: quote,
  };
}

function newMessageStep(event: EventDef | undefined): StepDraft {
  const kind = defaultRecipient(event);
  const d = event ? DEFAULT_RULE_TEMPLATES[event.key] : undefined;
  return { key: nextKey(), type: "whatsapp", kind, employeeId: "", phone: "", phoneName: "", template: d?.ar ?? "", templateEn: d?.en ?? "" };
}

export function RuleEditor({ rule }: { rule: StoredRule | null }) {
  const lang = useLang();
  const ar = lang === "ar";
  const router = useRouter();
  const { canManageRules } = useAutomationAbilities();
  const readOnly = !canManageRules;

  const [name, setName] = useState(rule?.name ?? "");
  const [description, setDescription] = useState(rule?.description ?? "");
  const [eventType, setEventType] = useState(rule?.eventType ?? "order.status_changed");
  const [locale, setLocale] = useState<"ar" | "en">(rule?.locale === "en" ? "en" : "ar");
  const [isActive, setIsActive] = useState(rule?.isActive ?? false);
  const [conditions, setConditions] = useState<ConditionDraft[]>(() =>
    rule ? toDraftConditions(rule.conditions) : [{ field: "status.to", op: "eq", value: "Ready for Shipping" }],
  );
  const [steps, setSteps] = useState<StepDraft[]>(() =>
    rule ? toDraftSteps(rule.steps, rule.eventType) : [newMessageStep(getEvent("order.status_changed"))],
  );
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const event = getEvent(eventType);

  useEffect(() => {
    let cancelled = false;
    api<{ employees: EmployeeOption[] }>("/api/automation/recipients").then((r) => {
      if (!cancelled && r.ok) setEmployees(r.data.employees);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  function changeEvent(key: string) {
    const next = getEvent(key);
    setEventType(key);
    if (!next) return;
    // Conditions on fields the new event does not have would only be refused on save.
    setConditions((cs) => cs.filter((c) => next.variables.some((v) => v.key === c.field)));
    // Recipients the new event cannot resolve fall back to its first own recipient.
    const allowed = recipientsFor(next);
    setSteps((ss) =>
      ss.map((s) => {
        if (s.type === "email") {
          return { ...s, toKind: next.recipients.includes("customer") ? s.toKind : "email", attach: s.attach && key === QUOTE_ATTACH_EVENT };
        }
        if (s.type !== "whatsapp") return s;
        const kind = allowed.includes(s.kind) ? s.kind : defaultRecipient(next);
        const untouched = Object.values(DEFAULT_AR).includes(s.template) || !s.template.trim();
        const untouchedEn = Object.values(DEFAULT_RULE_TEMPLATES).some((d) => d.en === s.templateEn) || !s.templateEn.trim();
        const d = DEFAULT_RULE_TEMPLATES[key];
        return { ...s, kind, template: untouched ? d?.ar ?? "" : s.template, templateEn: untouchedEn ? d?.en ?? "" : s.templateEn };
      }),
    );
  }

  const updateStep = (key: number, patch: Partial<StepDraft>) =>
    setSteps((ss) => ss.map((s) => (s.key === key ? ({ ...s, ...patch } as StepDraft) : s)));
  const moveStep = (i: number, d: -1 | 1) =>
    setSteps((ss) => {
      const j = i + d;
      if (j < 0 || j >= ss.length) return ss;
      const copy = [...ss];
      [copy[i], copy[j]] = [copy[j], copy[i]];
      return copy;
    });

  function payload() {
    return {
      name,
      description,
      eventType,
      locale,
      isActive,
      conditions: conditions.map((c) => (OPS_WITHOUT_VALUE.has(c.op) ? { field: c.field, op: c.op } : c)),
      steps: steps.map((s) =>
        s.type === "wait"
          ? { type: "wait", minutes: Math.round(Number(s.amount) * UNIT_MINUTES[s.unit]) }
          : s.type === "email"
            ? {
                type: "email", subject: s.subject, template: s.template,
                to: s.toKind === "customer" ? { kind: "customer" } : { kind: "email", email: s.email, ...(s.emailName.trim() ? { name: s.emailName } : {}) },
                ...(s.attach && s.toKind === "customer" ? { attach: "quote_pdf" } : {}),
              }
            : {
              type: "whatsapp",
              template: s.template,
              ...(isStaffRecipient(s.kind) && s.templateEn.trim() ? { templateEn: s.templateEn } : {}),
              to:
                s.kind === "employee"
                  ? { kind: "employee", employeeId: s.employeeId }
                  : s.kind === "phone"
                    ? { kind: "phone", phone: s.phone, name: s.phoneName }
                    : { kind: s.kind },
            },
      ),
    };
  }

  async function save() {
    setSaving(true);
    setErrors([]);
    const res = await api<{ rule: { id: string }; details?: string[] }>(rule ? `/api/automation/rules/${rule.id}` : "/api/automation/rules", {
      method: rule ? "PUT" : "POST",
      body: payload(),
    });
    setSaving(false);
    if (!res.ok) {
      setErrors(res.data.details ?? [res.data.error ?? (ar ? "تعذر الحفظ." : "Could not save.")]);
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    router.push("/dashboard/automation");
  }

  async function remove() {
    if (!rule) return;
    const res = await api(`/api/automation/rules/${rule.id}`, { method: "DELETE" });
    if (!res.ok) {
      setConfirmDelete(false);
      setErrors([res.data.error ?? (ar ? "تعذر الحذف." : "Could not delete.")]);
      return;
    }
    router.push("/dashboard/automation");
  }

  const messageCount = steps.filter((s) => s.type === "whatsapp" || s.type === "email").length;
  const emailLocked = EMAIL_LOCKED_EVENTS.includes(eventType);
  // «تنبيه التكرار» (batch 25): a status notification on this event that also reaches the customer.
  const [dupStatuses, setDupStatuses] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    api<{ statuses: { labelAr: string; labelEn: string; toCustomer: boolean }[] }>(`/api/automation/duplicates?eventType=${encodeURIComponent(eventType)}`).then((r) => {
      if (!cancelled && r.ok) setDupStatuses(r.data.statuses.filter((x) => x.toCustomer).map((x) => (ar ? x.labelAr : x.labelEn)));
    });
    return () => { cancelled = true; };
  }, [eventType, ar]);
  const stepsToCustomer = steps.some((s) => (s.type === "whatsapp" && s.kind === "customer") || (s.type === "email" && s.toKind === "customer"));

  const L = (a: string, e: string) => (ar ? a : e);

  useD21Phone({
    title: rule ? rule.name : L("قاعدة جديدة", "New rule"),
    sub: L("قاعدة · رسائل العملاء التلقائية", "Rule · Automated customer messages"),
    back: "/dashboard/automation",
  });

  return (
    <div className="hr-stack" style={{ gap: 16 }} data-testid="rule-editor">
      <PageHeader
        title={rule ? L("تعديل قاعدة", "Edit rule") : L("قاعدة جديدة", "New rule")}
        actions={
          <>
            <Btn variant="ghost" onClick={() => router.push("/dashboard/automation")}>{L("رجوع", "Back")}</Btn>
            {rule && !readOnly && (
              <Btn variant="danger" onClick={() => setConfirmDelete(true)} data-testid="rule-delete">{L("حذف", "Delete")}</Btn>
            )}
            {!readOnly && (
              <Btn variant="primary" onClick={save} disabled={saving} data-testid="rule-save">
                {saving ? L("يحفظ...", "Saving...") : L("حفظ", "Save")}
              </Btn>
            )}
          </>
        }
      />
      <p className="tl-sub">{L("عند حدث في النظام، وإذا تحققت الشروط، تُنفَّذ الخطوات بالترتيب.", "When something happens, if the conditions hold, run the steps in order.")}</p>

      {readOnly && <Notice tone="info">{L("تعرض القاعدة للقراءة فقط: لا تملك صلاحية تعديل القواعد.", "Read only: you cannot edit rules.")}</Notice>}
      {errors.length > 0 && (
        <OpsBanner tone="danger" onClose={() => setErrors([])}>
          <ul style={{ margin: 0, paddingInlineStart: 18 }}>
            {errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </OpsBanner>
      )}

      <div>
        {/* ── Basics ── */}
        <Sec title={L("الأساسيات", "Basics")} caption={L("الاسم والوصف وتفعيل القاعدة", "Name, description and whether the rule is on")}>
          <div className="hr-form">
            <Field label={`${L("اسم القاعدة", "Rule name")} *`} help={L("حتى 120 حرفًا", "Up to 120 characters")}>
              <input id="rule-name" className="hr-input" value={name} onChange={(e) => setName(e.target.value)} disabled={readOnly} placeholder={L("مثال: إشعار العميل بجاهزية الطلب", "e.g. Tell the customer the order is ready")} />
            </Field>
            <Field label={L("لغة القيم في الرسالة", "Language for values")} help={L("مثل اسم الحالة: «جاهز للشحن» أو «Ready for Shipping».", "How statuses and outcomes are written into the message.")}>
              <Select id="rule-locale" className="hr-select" value={locale} onChange={(e) => setLocale(e.target.value === "en" ? "en" : "ar")} disabled={readOnly}>
                <option value="ar">{L("العربية", "Arabic")}</option>
                <option value="en">{L("الإنجليزية", "English")}</option>
              </Select>
            </Field>
            <Field label={L("وصف (اختياري)", "Description (optional)")}>
              <input id="rule-desc" className="hr-input" value={description} onChange={(e) => setDescription(e.target.value)} disabled={readOnly} />
            </Field>
            <div className="hr-field">
              <span className="hr-label">{L("الحالة", "Status")}</span>
              <label className="tl-check" style={{ minHeight: 34 }}>
                <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} disabled={readOnly} data-testid="rule-active" />
                {L("القاعدة مفعّلة", "Rule is active")}
              </label>
              <span className="hr-help" style={{ fontSize: 12.5, color: "var(--text-muted)" }}>{L("القاعدة غير المفعّلة لا تنشئ رسائل", "An inactive rule creates no messages.")}</span>
            </div>
          </div>
        </Sec>

        {/* ── When ── */}
        <Sec title={L("1. متى؟", "1. When")} caption={L("حدث واحد يطلق القاعدة", "One event starts the rule")}>
          <Field label={`${L("الحدث", "Event")} *`} help={event ? (ar ? event.description.ar : event.description.en) : undefined}>
            <Select id="rule-event" className="hr-select" value={eventType} onChange={(e) => changeEvent(e.target.value)} disabled={readOnly}>
              {EVENT_GROUPS.map((g) => (
                <optgroup key={g.key} label={ar ? g.ar : g.en}>
                  {EVENTS.filter((e) => e.group === g.key).map((e) => (
                    <option key={e.key} value={e.key}>
                      {(ar ? e.ar : e.en) + " · " + (ar ? g.ar : g.en)}
                    </option>
                  ))}
                </optgroup>
              ))}
            </Select>
          </Field>
        </Sec>

        {/* ── If ── */}
        {event && (
          <Sec title={L("2. بشرط", "2. Only if")} caption={L("اختياري · كل الشروط معًا", "Optional · all conditions together")}>
            {conditions.length === 0 ? (
              <p className="hr-caption" style={{ margin: 0 }}>{L("بلا شروط: تنفذ القاعدة كلما وقع الحدث.", "No conditions: the rule runs every time.")}</p>
            ) : (
              <div className="hr-stack" style={{ gap: 10 }}>
                {conditions.map((c, i) => {
                  const def = event.variables.find((v) => v.key === c.field);
                  return (
                    <div key={i} className="tl-cond" data-testid={`condition-${i}`}>
                      <Select id={`cond-field-${i}`} className="hr-select" aria-label={L("الحقل", "Field")} value={c.field} disabled={readOnly} onChange={(e) => { const v = e.target.value; setConditions((cs) => cs.map((x, j) => (j === i ? { ...x, field: v, value: "" } : x))); }}>
                        {event.variables.map((v) => (
                          <option key={v.key} value={v.key}>
                            {ar ? v.ar : v.en}
                          </option>
                        ))}
                      </Select>
                      <Select id={`cond-op-${i}`} className="hr-select" aria-label={L("المقارنة", "Comparison")} value={c.op} disabled={readOnly} onChange={(e) => { const v = e.target.value; setConditions((cs) => cs.map((x, j) => (j === i ? { ...x, op: v as ConditionOp } : x))); }}>
                        {CONDITION_OPS.filter((op) => (def?.kind === "number" ? true : !["gt", "gte", "lt", "lte"].includes(op))).map((op) => (
                          <option key={op} value={op}>
                            {ar ? CONDITION_OP_LABELS[op].ar : CONDITION_OP_LABELS[op].en}
                          </option>
                        ))}
                      </Select>
                      {OPS_WITHOUT_VALUE.has(c.op) ? (
                        <div />
                      ) : def?.kind === "enum" && def.options ? (
                        <Select id={`cond-value-${i}`} className="hr-select" aria-label={L("القيمة", "Value")} value={c.value} disabled={readOnly} onChange={(e) => { const v = e.target.value; setConditions((cs) => cs.map((x, j) => (j === i ? { ...x, value: v } : x))); }}>
                          <option value="">{L("اختر...", "Choose...")}</option>
                          {def.options.map((o) => (
                            <option key={o.value} value={o.value}>
                              {ar ? o.ar : o.en}
                            </option>
                          ))}
                        </Select>
                      ) : (
                        <input id={`cond-value-${i}`} className="hr-input" aria-label={L("القيمة", "Value")} value={c.value} disabled={readOnly} inputMode={def?.kind === "number" ? "decimal" : "text"} onChange={(e) => { const v = e.target.value; setConditions((cs) => cs.map((x, j) => (j === i ? { ...x, value: v } : x))); }} />
                      )}
                      {!readOnly ? (
                        <Btn variant="ghost" className="hr-iconbtn" onClick={() => setConditions((cs) => cs.filter((_, j) => j !== i))} title={L("حذف الشرط", "Remove")} aria-label={L("حذف الشرط", "Remove")}>×</Btn>
                      ) : <span />}
                    </div>
                  );
                })}
              </div>
            )}
            {!readOnly && conditions.length < 10 ? (
              <div className="tl-acts">
                <Btn size="sm" onClick={() => setConditions((cs) => [...cs, { field: event.variables[0].key, op: "eq", value: "" }])} data-testid="add-condition">
                  <PlusIco /> {L("إضافة شرط", "Add condition")}
                </Btn>
                <span className="hr-caption">{L("كل الشروط لازم تتحقق · حتى 10 شروط", "Every condition must hold · up to 10")}</span>
              </div>
            ) : null}
          </Sec>
        )}

        {/* ── Do ── */}
        {event && (
          <Sec title={L("3. نفّذ الخطوات", "3. Do")} caption={L(`بالترتيب · حتى ${MAX_STEPS} خطوات · رسالة واحدة على الأقل`, `In order · up to ${MAX_STEPS} steps · at least one message`)}>
            {steps.map((s, i) => (
              <div key={s.key} className="tl-step" data-testid={`step-${i}`}>
                <div className="tl-step-head">
                  <strong>
                    {L(`الخطوة ${i + 1}: `, `Step ${i + 1}: `)}
                    {s.type === "whatsapp" ? L("رسالة واتساب", "WhatsApp message") : s.type === "email" ? L("إيميل", "E-mail") : L("انتظار", "Wait")}
                  </strong>
                  {!readOnly && (
                    <span className="tl-acts" style={{ gap: 4 }}>
                      <Btn variant="ghost" size="sm" onClick={() => moveStep(i, -1)} disabled={i === 0}>{L("لأعلى", "Move up")}</Btn>
                      <Btn variant="ghost" size="sm" onClick={() => moveStep(i, 1)} disabled={i === steps.length - 1}>{L("لأسفل", "Move down")}</Btn>
                      <Btn variant="ghost" size="sm" onClick={() => setSteps((ss) => ss.filter((x) => x.key !== s.key))}>{L("حذف الخطوة", "Remove step")}</Btn>
                    </span>
                  )}
                </div>
                {s.type === "wait" ? (
                  <WaitStepFields step={s} readOnly={readOnly} lang={lang} onChange={(p) => updateStep(s.key, p)} />
                ) : s.type === "email" ? (
                  <EmailStepFields step={s} event={event} readOnly={readOnly} locked={emailLocked} lang={lang} index={i} onChange={(p) => updateStep(s.key, p)} />
                ) : (
                  <MessageStepFields step={s} event={event} employees={employees} locale={locale} readOnly={readOnly} lang={lang} index={i} onChange={(p) => updateStep(s.key, p)} />
                )}
              </div>
            ))}
            {!readOnly && steps.length < MAX_STEPS && (
              <div className="tl-acts">
                <Btn size="sm" onClick={() => setSteps((ss) => [...ss, newMessageStep(event)])} data-testid="add-message-step">
                  <PlusIco /> {L("إضافة رسالة واتساب", "Add a WhatsApp message")}
                </Btn>
                <Btn size="sm" onClick={() => setSteps((ss) => [...ss, newEmailStep(event)])} disabled={emailLocked} data-testid="add-email-step" title={emailLocked ? L("إيميل الفواتير مقفل لين تشتغل الفوترة الإلكترونية", "Invoice e-mail is locked until e-invoicing is live") : undefined}>
                  {emailLocked ? <Lock size={14} strokeWidth={1.6} aria-hidden /> : <PlusIco />} {L("إضافة إيميل", "Add an e-mail")}
                </Btn>
                <Btn size="sm" onClick={() => setSteps((ss) => [...ss, { key: nextKey(), type: "wait", amount: "1", unit: "hours" }])} data-testid="add-wait-step">
                  <PlusIco /> {L("إضافة انتظار", "Add a wait")}
                </Btn>
              </div>
            )}
            {messageCount === 0 && <p className="hr-caption" style={{ margin: 0, color: "var(--status-danger)" }}>{L("أضف رسالة واحدة على الأقل.", "Add at least one message.")}</p>}
            {emailLocked ? <p className="hr-caption" style={{ margin: 0 }} data-testid="email-locked-note">{L("إيميل الفواتير مقفل لين تشتغل الفوترة الإلكترونية (زاتكا). الواتساب متاح.", "Invoice e-mail is locked until e-invoicing (ZATCA) is live. WhatsApp is available.")}</p> : null}
            {dupStatuses.length && stepsToCustomer ? (
              <Notice tone="warning"><span data-testid="rule-duplicate-warning">{L(`تنبيه: «إشعارات الحالات» ترسل للعميل عند نفس الحدث (${dupStatuses.join("، ")}). العميل ممكن يوصله رسالتين.`, `Heads up: «Status notifications» already message the customer on this event (${dupStatuses.join(", ")}). The customer may get two messages.`)}</span></Notice>
            ) : null}
          </Sec>
        )}
      </div>

      <Dialog
        open={confirmDelete}
        title={L("حذف القاعدة؟", "Delete this rule?")}
        onClose={() => setConfirmDelete(false)}
        actions={
          <>
            <Btn onClick={() => setConfirmDelete(false)}>{L("إلغاء", "Cancel")}</Btn>
            <Btn variant="danger" onClick={remove} data-testid="rule-delete-confirm">{L("حذف", "Delete")}</Btn>
          </>
        }
      >
        <p style={{ margin: 0, fontSize: 14, lineHeight: "22px", color: "var(--text-secondary)" }}>
          {L(
            "تبقى الرسائل المرسلة في السجل باسم القاعدة. الرسائل التي لم ترسل بعد تلغى.",
            "Messages already sent stay in the log. Messages not yet sent are cancelled.",
          )}
        </p>
      </Dialog>
    </div>
  );
}

function WaitStepFields({ step, readOnly, lang, onChange }: { step: Extract<StepDraft, { type: "wait" }>; readOnly: boolean; lang: "ar" | "en"; onChange: (p: Partial<StepDraft>) => void }) {
  const ar = lang === "ar";
  const minutes = Math.round(Number(step.amount) * UNIT_MINUTES[step.unit]);
  const bad = !Number.isFinite(minutes) || minutes < 1 || minutes > MAX_WAIT_MINUTES;
  return (
    <div className="tl-wait">
      <input id={`wait-${step.key}`} className="hr-input" aria-label={ar ? "المدة" : "Amount"} value={step.amount} onChange={(e) => onChange({ amount: e.target.value })} inputMode="decimal" disabled={readOnly} aria-invalid={bad || undefined} />
      <Select id={`wait-unit-${step.key}`} className="hr-select" aria-label={ar ? "الوحدة" : "Unit"} value={step.unit} onChange={(e) => onChange({ unit: e.target.value as WaitUnit })} disabled={readOnly}>
        <option value="minutes">{ar ? "دقيقة" : "minutes"}</option>
        <option value="hours">{ar ? "ساعة" : "hours"}</option>
        <option value="days">{ar ? "يوم" : "days"}</option>
      </Select>
      <span className="hr-caption" style={bad ? { color: "var(--status-danger)" } : undefined}>
        {bad ? (ar ? "الانتظار من دقيقة إلى 7 أيام." : "Between 1 minute and 7 days.") : ar ? "الخطوات التي بعدها تتأخر بهذه المدة." : "Every later step is delayed by this much."}
      </span>
    </div>
  );
}

function MessageStepFields({
  step, event, employees, locale, readOnly, lang, index, onChange,
}: {
  step: Extract<StepDraft, { type: "whatsapp" }>;
  event: EventDef;
  employees: EmployeeOption[];
  locale: "ar" | "en";
  readOnly: boolean;
  lang: "ar" | "en";
  index: number;
  onChange: (p: Partial<StepDraft>) => void;
}) {
  const ar = lang === "ar";
  const ref = useRef<HTMLTextAreaElement>(null);
  const refEn = useRef<HTMLTextAreaElement>(null);
  // Owner language decision 3: a staff step has an Arabic and an English text; each employee gets the
  // one of their language («خدماتي», else the automation default, else Arabic).
  const staff = isStaffRecipient(step.kind);
  const [focus, setFocus] = useState<"template" | "templateEn">("template");
  const bilingual = staff && !!step.templateEn.trim();
  const preview = useMemo(() => renderTemplate(event, step.template, sampleContext(event), bilingual ? "ar" : locale), [event, step.template, locale, bilingual]);
  const previewEn = useMemo(() => renderTemplate(event, step.templateEn, sampleContext(event), "en"), [event, step.templateEn]);
  const unknown = unknownPlaceholders(event, step.template);
  const unknownEn = staff ? unknownPlaceholders(event, step.templateEn) : [];
  const phoneCheck = step.kind === "phone" && step.phone ? normalizePhoneForWhatsApp(step.phone) : null;
  const chosenEmployee = employees.find((e) => e.id === step.employeeId);

  function insert(key: string) {
    const token = `{{${key}}}`;
    const field = staff ? focus : "template";
    const el = field === "templateEn" ? refEn.current : ref.current;
    const text = step[field];
    if (!el) return onChange({ [field]: text + token });
    const start = el.selectionStart ?? text.length;
    const end = el.selectionEnd ?? start;
    const next = text.slice(0, start) + token + text.slice(end);
    onChange({ [field]: next });
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  }

  return (
    <div className="hr-stack" style={{ gap: 14 }}>
      <div className="tl-cols" style={{ gap: 24 }}>
        <div className="hr-stack" style={{ gap: 12 }}>
          <Field label={ar ? "إلى" : "To"}>
            <Select id={`to-${step.key}`} className="hr-select" value={step.kind} onChange={(e) => onChange({ kind: e.target.value as RecipientKind })} disabled={readOnly}>
              {recipientsFor(event).map((k) => (
                <option key={k} value={k}>
                  {ar ? RECIPIENT_LABELS[k].ar : RECIPIENT_LABELS[k].en}
                </option>
              ))}
            </Select>
          </Field>
          {step.kind === "employee" && (
            <Field
              label={ar ? "الموظف" : "Employee"}
              error={chosenEmployee && !chosenEmployee.hasPhone ? (ar ? "لا يوجد رقم جوال صالح لهذا الموظف." : "This employee has no usable phone number.") : undefined}
            >
              <Select id={`emp-${step.key}`} className="hr-select" value={step.employeeId} onChange={(e) => onChange({ employeeId: e.target.value })} disabled={readOnly}>
                <option value="">{ar ? "اختر موظفا..." : "Choose an employee..."}</option>
                {employees.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                    {e.hasPhone ? "" : ar ? " (بلا رقم)" : " (no phone)"}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {step.kind === "phone" && (
            <>
              <Field label={ar ? "رقم الجوال" : "Phone number"} error={phoneCheck && !phoneCheck.ok ? phoneCheck.reason : undefined} help={ar ? "مثل 05XXXXXXXX أو +9665XXXXXXXX" : "e.g. 05XXXXXXXX or +9665XXXXXXXX"}>
                <input id={`phone-${step.key}`} className="hr-input" dir="ltr" value={step.phone} onChange={(e) => onChange({ phone: e.target.value })} inputMode="tel" disabled={readOnly} aria-invalid={!!phoneCheck && !phoneCheck.ok ? true : undefined} />
              </Field>
              <Field label={ar ? "اسم المستلم (اختياري)" : "Recipient name (optional)"}>
                <input id={`phone-name-${step.key}`} className="hr-input" value={step.phoneName} onChange={(e) => onChange({ phoneName: e.target.value })} disabled={readOnly} />
              </Field>
            </>
          )}
        </div>
        <div className="hr-stack" style={{ gap: 6 }}>
          <span className="hr-label">{ar ? "معاينة ببيانات مثال" : "Preview with sample data"}</span>
          <Bubble text={preview} lang={lang} testId={`preview-${index}`} />
          {staff && step.templateEn.trim() ? <Bubble text={previewEn} lang={lang} testId={`preview-en-${index}`} /> : null}
        </div>
      </div>

      <div className="hr-stack" style={{ gap: 6 }}>
        <label htmlFor={`tpl-${step.key}`} className="hr-label">
          {staff ? (ar ? "النص العربي" : "Arabic text") : ar ? "نص الرسالة" : "Message"} <span style={{ color: "var(--status-danger)" }}>*</span>
        </label>
        <textarea
          ref={ref}
          id={`tpl-${step.key}`}
          data-testid={`template-${index}`}
          rows={4}
          dir="auto"
          value={step.template}
          disabled={readOnly}
          maxLength={TEMPLATE_MAX_LENGTH}
          onChange={(e) => onChange({ template: e.target.value })}
          onFocus={() => setFocus("template")}
          className="hr-textarea"
          style={{ lineHeight: "22px" }}
        />
        <span className="hr-caption">
          <span className="hr-num">{step.template.length} / {TEMPLATE_MAX_LENGTH}</span>
          {!readOnly ? (ar ? " · اضغط متغيرًا لإدراجه في مكان المؤشر" : " · click a variable to insert it at the cursor") : null}
        </span>
        {unknown.length > 0 && (
          <p className="hr-caption" style={{ margin: 0, color: "var(--status-danger)", fontWeight: 600 }} role="alert">
            {ar ? "متغيرات غير معروفة لهذا الحدث: " : "Unknown variables for this event: "}
            <bdi dir="ltr">{unknown.map((k) => `{{${k}}}`).join(" ")}</bdi>
          </p>
        )}
        {staff ? (
          <>
            <label htmlFor={`tpl-en-${step.key}`} className="hr-label" style={{ marginTop: 8 }}>
              {ar ? "النص الإنجليزي" : "English text"}
            </label>
            <textarea
              ref={refEn}
              id={`tpl-en-${step.key}`}
              data-testid={`template-en-${index}`}
              rows={4}
              dir="ltr"
              lang="en"
              value={step.templateEn}
              disabled={readOnly}
              maxLength={TEMPLATE_MAX_LENGTH}
              onChange={(e) => onChange({ templateEn: e.target.value })}
              onFocus={() => setFocus("templateEn")}
              className="hr-textarea"
              style={{ lineHeight: "22px" }}
            />
            <span className="hr-caption">
              <span className="hr-num">{step.templateEn.length} / {TEMPLATE_MAX_LENGTH}</span>
              {ar
                ? " · يستقبل كل موظف النص بلغته في «خدماتي»، أو بلغة رسائل الموظفين في إعدادات الأتمتة · فارغ = النص العربي"
                : " · each employee receives the text in the language set on «My services», else the employee message language in the automation settings · empty = the Arabic text"}
            </span>
            {unknownEn.length > 0 && (
              <p className="hr-caption" style={{ margin: 0, color: "var(--status-danger)", fontWeight: 600 }} role="alert">
                {ar ? "متغيرات غير معروفة في النص الإنجليزي: " : "Unknown variables in the English text: "}
                <bdi dir="ltr">{unknownEn.map((k) => `{{${k}}}`).join(" ")}</bdi>
              </p>
            )}
          </>
        ) : null}
        {!readOnly && (
          <div className="tl-vars">
            {event.variables.map((v) => (
              <button key={v.key} type="button" className="tl-var" onClick={() => insert(v.key)} title={`{{${v.key}}}`}>
                <span>{ar ? v.ar : v.en}</span>
                <code dir="ltr">{v.key}</code>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function EmailStepFields({ step, event, readOnly, locked, lang, index, onChange }: {
  step: Extract<StepDraft, { type: "email" }>;
  event: EventDef;
  readOnly: boolean;
  locked: boolean;
  lang: "ar" | "en";
  index: number;
  onChange: (p: Partial<StepDraft>) => void;
}) {
  const ar = lang === "ar";
  const L = (a: string, e: string) => (ar ? a : e);
  const preview = useMemo(() => renderTemplate(event, step.template, sampleContext(event), "ar"), [event, step.template]);
  const subjectPreview = useMemo(() => renderTemplate(event, step.subject, sampleContext(event), "ar"), [event, step.subject]);
  const unknown = [...unknownPlaceholders(event, step.subject), ...unknownPlaceholders(event, step.template)];
  const hasCustomer = event.recipients.includes("customer");
  const emailBad = step.toKind === "email" && step.email.trim() !== "" && !parseEmailAddress(step.email);
  const canAttach = event.key === QUOTE_ATTACH_EVENT && step.toKind === "customer";
  return (
    <div className="hr-stack" style={{ gap: 12 }} data-testid={`email-step-${index}`}>
      {locked ? <Notice tone="warning">{L("إيميل الفواتير مقفل لين تشتغل الفوترة الإلكترونية (زاتكا). احذف هذه الخطوة أو غيّر الحدث.", "Invoice e-mail is locked until e-invoicing (ZATCA) is live. Remove this step or change the event.")}</Notice> : null}
      <div className="tl-cols" style={{ gap: 24 }}>
        <div className="hr-stack" style={{ gap: 12 }}>
          <Field label={L("إلى", "To")}>
            <Select id={`email-to-${step.key}`} className="hr-select" value={step.toKind} onChange={(e) => onChange({ toKind: e.target.value as "customer" | "email" })} disabled={readOnly} data-testid={`email-to-${index}`}>
              {hasCustomer ? <option value="customer">{L("العميل (إيميله المسجّل)", "The customer (their e-mail on record)")}</option> : null}
              <option value="email">{L("إيميل محدد", "A fixed address")}</option>
            </Select>
          </Field>
          {step.toKind === "email" ? (
            <>
              <Field label={L("الإيميل", "E-mail")} error={emailBad ? L("اكتب إيميل واحد صحيح.", "Enter one valid address.") : undefined} help={L("عنوان ثابت خارج النظام: يضيفه المدير فقط (يطلب تأكيد الهوية).", "A fixed outside address: only an administrator adds one (identity check).")}>
                <input id={`email-addr-${step.key}`} className="hr-input" dir="ltr" type="email" value={step.email} onChange={(e) => onChange({ email: e.target.value })} disabled={readOnly} data-testid={`email-addr-${index}`} />
              </Field>
              <Field label={L("اسم المستلم (اختياري)", "Recipient name (optional)")}>
                <input id={`email-name-${step.key}`} className="hr-input" value={step.emailName} onChange={(e) => onChange({ emailName: e.target.value })} disabled={readOnly} />
              </Field>
            </>
          ) : null}
          <Field label={L("موضوع الإيميل", "Subject")} help={L("سطر واحد · يقبل المتغيرات", "One line · variables allowed")}>
            <input id={`email-subject-${step.key}`} className="hr-input" maxLength={SUBJECT_MAX_LENGTH} value={step.subject} onChange={(e) => onChange({ subject: e.target.value.replace(/[\r\n]+/g, " ") })} disabled={readOnly} data-testid={`email-subject-${index}`} />
          </Field>
          {canAttach ? (
            <label className="tl-check">
              <input type="checkbox" checked={step.attach} onChange={(e) => onChange({ attach: e.target.checked })} disabled={readOnly} data-testid={`email-attach-${index}`} />
              {L("أرفق عرض السعر (PDF) تلقائيًا", "Attach the quotation (PDF) automatically")}
            </label>
          ) : null}
        </div>
        <div className="hr-stack" style={{ gap: 6 }}>
          <span className="hr-label">{L("معاينة ببيانات مثال", "Preview with sample data")}</span>
          <strong style={{ fontSize: 13.5 }} data-testid={`email-subject-preview-${index}`}>{subjectPreview}</strong>
          <Bubble text={preview} lang={lang} testId={`preview-${index}`} />
          {step.attach && canAttach ? <span className="hr-caption">{L("+ ملف عرض السعر PDF", "+ the quotation PDF")}</span> : null}
          <span className="hr-caption">{L("في آخر كل إيميل رابط «إيقاف الإيميلات» للعميل.", "Every e-mail ends with a «stop e-mails» link for the customer.")}</span>
        </div>
      </div>
      <Field label={L("نص الإيميل", "Message")}>
        <textarea id={`email-tpl-${step.key}`} data-testid={`template-${index}`} rows={4} dir="auto" value={step.template} disabled={readOnly} maxLength={TEMPLATE_MAX_LENGTH} onChange={(e) => onChange({ template: e.target.value })} className="hr-textarea" style={{ lineHeight: "22px" }} />
      </Field>
      {unknown.length > 0 && (
        <p className="hr-caption" style={{ margin: 0, color: "var(--status-danger)", fontWeight: 600 }} role="alert">
          {L("متغيرات غير معروفة لهذا الحدث: ", "Unknown variables for this event: ")}<bdi dir="ltr">{[...new Set(unknown)].map((k) => `{{${k}}}`).join(" ")}</bdi>
        </p>
      )}
      {!readOnly && (
        <div className="tl-vars">
          {event.variables.map((v) => (
            <button key={v.key} type="button" className="tl-var" onClick={() => onChange({ template: step.template + `{{${v.key}}}` })} title={`{{${v.key}}}`}>
              <span>{ar ? v.ar : v.en}</span>
              <code dir="ltr">{v.key}</code>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
