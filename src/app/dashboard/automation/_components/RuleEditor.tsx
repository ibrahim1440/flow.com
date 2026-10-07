"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, Clock, MessageCircle, Plus, Save, Trash2 } from "lucide-react";
import {
  Alert, Button, Card, Field, Modal, PageHeader, Select, SectionTitle, TextInput, api, useLang,
} from "../../sales/_components/ui";
import {
  EVENT_GROUPS, EVENTS, RECIPIENT_LABELS, getEvent, recipientsFor, sampleContext, type EventDef, type RecipientKind,
} from "@/lib/automation/catalog";
import { CONDITION_OPS, CONDITION_OP_LABELS, OPS_WITHOUT_VALUE, type ConditionOp } from "@/lib/automation/conditions";
import { normalizePhoneForWhatsApp } from "@/lib/automation/phone";
import { MAX_STEPS, MAX_WAIT_MINUTES } from "@/lib/automation/rules";
import { renderTemplate, TEMPLATE_MAX_LENGTH, unknownPlaceholders } from "@/lib/automation/template";
import { Bubble, useAutomationAbilities } from "./shared";

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
  | { key: number; type: "whatsapp"; kind: RecipientKind; employeeId: string; phone: string; phoneName: string; template: string }
  | { key: number; type: "wait"; amount: string; unit: WaitUnit };

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
// customer replaces the text anyway.
const DEFAULT_TEMPLATE: Record<string, string> = {
  "order.created": "طلب جديد رقم {{order.number}} للعميل {{customer.name}}:\n{{order.items}}\nسجله: {{actor.name}}",
  "order.status_changed": "الطلب {{order.number}} ({{customer.name}}) صار: {{status.to}}.",
  "delivery.recorded": "تسليم للطلب {{order.number}} ({{customer.name}}): {{delivery.quantity}} من {{delivery.item}}.",
  "production.batch_roasted": "دفعة {{batch.number}} ({{batch.product}}) تحمصت: {{batch.greenKg}} كغ بن أخضر.",
  "qc.batch_finalized": "نتيجة الجودة للدفعة {{batch.number}} ({{batch.product}}): {{qc.outcome}}.",
  "packaging.completed": "تغليف الدفعة {{batch.number}}: {{pack.units}} عبوة كاملة.",
  "production.order_created": "أمر إنتاج {{production.number}}: {{production.units}} وحدة من {{production.sku}} للطلب {{order.number}}.",
  "sales.quote_status_changed": "عرض السعر {{quote.number}} لـ {{customer.name}}: {{quote.status}} ({{quote.total}}).",
  "sales.task_due": "تذكير: {{task.subject}} — {{task.related}} (موعدها {{task.dueAt}}).",
  "finance.approval_requested": "طلب اعتماد جديد ينتظرك: {{approval.summary}}\nمن: {{approval.requester}}",
  "finance.approval_decided": "طلبك «{{approval.summary}}»: {{approval.decision}}.",
};

function toDraftSteps(raw: unknown): StepDraft[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((s: Record<string, unknown>) => {
    if (s.type === "wait") {
      const m = Number(s.minutes) || 1;
      const unit: WaitUnit = m % 1440 === 0 ? "days" : m % 60 === 0 ? "hours" : "minutes";
      return { key: nextKey(), type: "wait", amount: String(m / UNIT_MINUTES[unit]), unit };
    }
    const to = (s.to ?? {}) as Record<string, string>;
    return {
      key: nextKey(),
      type: "whatsapp",
      kind: (to.kind as RecipientKind) ?? "customer",
      employeeId: to.employeeId ?? "",
      phone: to.phone ?? "",
      phoneName: to.name ?? "",
      template: String(s.template ?? ""),
    };
  });
}

function toDraftConditions(raw: unknown): ConditionDraft[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((c: Record<string, unknown>) => ({ field: String(c.field ?? ""), op: (c.op as ConditionOp) ?? "eq", value: String(c.value ?? "") }));
}

/** Staff first: the first recipient the event offers that is not the customer. */
function defaultRecipient(event: EventDef | undefined): RecipientKind {
  return event?.recipients.find((r) => r !== "customer") ?? "employee";
}

function newMessageStep(event: EventDef | undefined): StepDraft {
  const kind = defaultRecipient(event);
  return { key: nextKey(), type: "whatsapp", kind, employeeId: "", phone: "", phoneName: "", template: event ? DEFAULT_TEMPLATE[event.key] ?? "" : "" };
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
    rule ? toDraftSteps(rule.steps) : [newMessageStep(getEvent("order.status_changed"))],
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
        if (s.type !== "whatsapp") return s;
        const kind = allowed.includes(s.kind) ? s.kind : defaultRecipient(next);
        const untouched = Object.values(DEFAULT_TEMPLATE).includes(s.template) || !s.template.trim();
        return { ...s, kind, template: untouched ? DEFAULT_TEMPLATE[key] ?? "" : s.template };
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
          : {
              type: "whatsapp",
              template: s.template,
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

  const messageCount = steps.filter((s) => s.type === "whatsapp").length;

  return (
    <div className="space-y-[18px]" data-testid="rule-editor">
      <PageHeader
        title={rule ? (ar ? "تعديل قاعدة" : "Edit rule") : ar ? "قاعدة جديدة" : "New rule"}
        subtitle={ar ? "عند حدث في النظام، وإذا تحققت الشروط، تنفذ الخطوات بالترتيب." : "When something happens, if the conditions hold, run the steps in order."}
        actions={
          <>
            <Button variant="secondary" onClick={() => router.push("/dashboard/automation")}>
              {ar ? "رجوع" : "Back"}
            </Button>
            {rule && !readOnly && (
              <Button variant="danger" onClick={() => setConfirmDelete(true)} testId="rule-delete">
                <Trash2 size={15} aria-hidden /> {ar ? "حذف" : "Delete"}
              </Button>
            )}
            {!readOnly && (
              <Button onClick={save} disabled={saving} testId="rule-save">
                <Save size={15} aria-hidden /> {saving ? (ar ? "يحفظ..." : "Saving...") : ar ? "حفظ" : "Save"}
              </Button>
            )}
          </>
        }
      />

      {readOnly && <Alert kind="info">{ar ? "تعرض القاعدة للقراءة فقط: لا تملك صلاحية تعديل القواعد." : "Read only: you cannot edit rules."}</Alert>}
      {errors.length > 0 && (
        <Alert kind="error" onDismiss={() => setErrors([])}>
          <ul className="list-disc ps-5 space-y-0.5">
            {errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </Alert>
      )}

      {/* ── Basics ── */}
      <Card>
        <SectionTitle>{ar ? "الأساسيات" : "Basics"}</SectionTitle>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="rule-name" label={ar ? "اسم القاعدة" : "Rule name"} required>
            <TextInput id="rule-name" value={name} onChange={setName} disabled={readOnly} placeholder={ar ? "مثال: إشعار العميل بجاهزية الطلب" : "e.g. Tell the customer the order is ready"} />
          </Field>
          <Field id="rule-locale" label={ar ? "لغة القيم في الرسالة" : "Language for values"} hint={ar ? "مثل اسم الحالة: «جاهز للشحن» أو «Ready for Shipping»." : "How statuses and outcomes are written into the message."}>
            <Select id="rule-locale" value={locale} onChange={(v) => setLocale(v === "en" ? "en" : "ar")} disabled={readOnly}>
              <option value="ar">{ar ? "العربية" : "Arabic"}</option>
              <option value="en">{ar ? "الإنجليزية" : "English"}</option>
            </Select>
          </Field>
          <div className="sm:col-span-2">
            <Field id="rule-desc" label={ar ? "وصف (اختياري)" : "Description (optional)"}>
              <TextInput id="rule-desc" value={description} onChange={setDescription} disabled={readOnly} />
            </Field>
          </div>
          <label className="flex items-center gap-3 text-[14px] text-oo-text-primary sm:col-span-2 cursor-pointer">
            <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} disabled={readOnly} className="h-4 w-4 accent-oo-action-primary" data-testid="rule-active" />
            {ar ? "القاعدة مفعلة" : "Rule is active"}
            <span className="text-[12px] text-oo-text-muted">
              {ar ? "القاعدة غير المفعلة لا تنشئ رسائل." : "An inactive rule creates no messages."}
            </span>
          </label>
        </div>
      </Card>

      {/* ── When ── */}
      <Card>
        <SectionTitle>{ar ? "1. متى؟" : "1. When"}</SectionTitle>
        <Field id="rule-event" label={ar ? "الحدث" : "Event"} required>
          <Select id="rule-event" value={eventType} onChange={changeEvent} disabled={readOnly}>
            {EVENT_GROUPS.map((g) => (
              <optgroup key={g.key} label={ar ? g.ar : g.en}>
                {EVENTS.filter((e) => e.group === g.key).map((e) => (
                  <option key={e.key} value={e.key}>
                    {ar ? e.ar : e.en}
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
        </Field>
        {event && <p className="mt-2 text-[13px] leading-[20px] text-oo-text-secondary">{ar ? event.description.ar : event.description.en}</p>}
      </Card>

      {/* ── If ── */}
      {event && (
        <Card>
          <SectionTitle
            right={
              !readOnly && conditions.length < 10 ? (
                <Button variant="secondary" onClick={() => setConditions((cs) => [...cs, { field: event.variables[0].key, op: "eq", value: "" }])} testId="add-condition">
                  <Plus size={15} aria-hidden /> {ar ? "إضافة شرط" : "Add condition"}
                </Button>
              ) : undefined
            }
          >
            {ar ? "2. بشرط (اختياري)" : "2. Only if (optional)"}
          </SectionTitle>
          {conditions.length === 0 ? (
            <p className="text-[13px] text-oo-text-muted">{ar ? "بلا شروط: تنفذ القاعدة كلما وقع الحدث." : "No conditions: the rule runs every time."}</p>
          ) : (
            <div className="space-y-3">
              <p className="text-[12px] text-oo-text-muted">{ar ? "كل الشروط لازم تتحقق." : "Every condition must hold."}</p>
              {conditions.map((c, i) => {
                const def = event.variables.find((v) => v.key === c.field);
                return (
                  <div key={i} className="grid gap-2 sm:grid-cols-[1fr_180px_1fr_auto] items-end" data-testid={`condition-${i}`}>
                    <Select id={`cond-field-${i}`} value={c.field} disabled={readOnly} onChange={(v) => setConditions((cs) => cs.map((x, j) => (j === i ? { ...x, field: v, value: "" } : x)))}>
                      {event.variables.map((v) => (
                        <option key={v.key} value={v.key}>
                          {ar ? v.ar : v.en}
                        </option>
                      ))}
                    </Select>
                    <Select id={`cond-op-${i}`} value={c.op} disabled={readOnly} onChange={(v) => setConditions((cs) => cs.map((x, j) => (j === i ? { ...x, op: v as ConditionOp } : x)))}>
                      {CONDITION_OPS.filter((op) => (def?.kind === "number" ? true : !["gt", "gte", "lt", "lte"].includes(op))).map((op) => (
                        <option key={op} value={op}>
                          {ar ? CONDITION_OP_LABELS[op].ar : CONDITION_OP_LABELS[op].en}
                        </option>
                      ))}
                    </Select>
                    {OPS_WITHOUT_VALUE.has(c.op) ? (
                      <div />
                    ) : def?.kind === "enum" && def.options ? (
                      <Select id={`cond-value-${i}`} value={c.value} disabled={readOnly} onChange={(v) => setConditions((cs) => cs.map((x, j) => (j === i ? { ...x, value: v } : x)))}>
                        <option value="">{ar ? "اختر..." : "Choose..."}</option>
                        {def.options.map((o) => (
                          <option key={o.value} value={o.value}>
                            {ar ? o.ar : o.en}
                          </option>
                        ))}
                      </Select>
                    ) : (
                      <TextInput id={`cond-value-${i}`} value={c.value} disabled={readOnly} inputMode={def?.kind === "number" ? "decimal" : "text"} onChange={(v) => setConditions((cs) => cs.map((x, j) => (j === i ? { ...x, value: v } : x)))} />
                    )}
                    {!readOnly && (
                      <Button variant="ghost" onClick={() => setConditions((cs) => cs.filter((_, j) => j !== i))} title={ar ? "حذف الشرط" : "Remove"}>
                        <Trash2 size={15} aria-hidden />
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      )}

      {/* ── Do ── */}
      {event && (
        <Card>
          <SectionTitle>{ar ? "3. نفذ الخطوات" : "3. Do"}</SectionTitle>
          <div className="space-y-4">
            {steps.map((s, i) => (
              <div key={s.key} className="rounded-xl border border-oo-border-default p-4 space-y-3" data-testid={`step-${i}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-2 text-[14px] font-semibold text-oo-text-primary">
                    {s.type === "whatsapp" ? <MessageCircle size={16} aria-hidden /> : <Clock size={16} aria-hidden />}
                    {ar ? `الخطوة ${i + 1}: ` : `Step ${i + 1}: `}
                    {s.type === "whatsapp" ? (ar ? "رسالة واتساب" : "WhatsApp message") : ar ? "انتظار" : "Wait"}
                  </span>
                  {!readOnly && (
                    <span className="flex items-center gap-1">
                      <Button variant="ghost" onClick={() => moveStep(i, -1)} disabled={i === 0} title={ar ? "لأعلى" : "Move up"}>
                        <ArrowUp size={15} aria-hidden />
                      </Button>
                      <Button variant="ghost" onClick={() => moveStep(i, 1)} disabled={i === steps.length - 1} title={ar ? "لأسفل" : "Move down"}>
                        <ArrowDown size={15} aria-hidden />
                      </Button>
                      <Button variant="ghost" onClick={() => setSteps((ss) => ss.filter((x) => x.key !== s.key))} title={ar ? "حذف الخطوة" : "Remove step"}>
                        <Trash2 size={15} aria-hidden />
                      </Button>
                    </span>
                  )}
                </div>
                {s.type === "wait" ? (
                  <WaitStepFields step={s} readOnly={readOnly} lang={lang} onChange={(p) => updateStep(s.key, p)} />
                ) : (
                  <MessageStepFields step={s} event={event} employees={employees} locale={locale} readOnly={readOnly} lang={lang} index={i} onChange={(p) => updateStep(s.key, p)} />
                )}
              </div>
            ))}
            {!readOnly && steps.length < MAX_STEPS && (
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" onClick={() => setSteps((ss) => [...ss, newMessageStep(event)])} testId="add-message-step">
                  <MessageCircle size={15} aria-hidden /> {ar ? "إضافة رسالة واتساب" : "Add a WhatsApp message"}
                </Button>
                <Button variant="secondary" onClick={() => setSteps((ss) => [...ss, { key: nextKey(), type: "wait", amount: "1", unit: "hours" }])} testId="add-wait-step">
                  <Clock size={15} aria-hidden /> {ar ? "إضافة انتظار" : "Add a wait"}
                </Button>
              </div>
            )}
            {messageCount === 0 && <p className="text-[13px] text-oo-status-blocked">{ar ? "أضف رسالة واحدة على الأقل." : "Add at least one message."}</p>}
          </div>
        </Card>
      )}

      {confirmDelete && (
        <Modal
          title={ar ? "حذف القاعدة؟" : "Delete this rule?"}
          onClose={() => setConfirmDelete(false)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setConfirmDelete(false)}>
                {ar ? "إلغاء" : "Cancel"}
              </Button>
              <Button variant="danger" onClick={remove} testId="rule-delete-confirm">
                {ar ? "حذف" : "Delete"}
              </Button>
            </>
          }
        >
          <p className="text-[14px] leading-[22px] text-oo-text-secondary">
            {ar
              ? "تبقى الرسائل المرسلة في السجل باسم القاعدة. الرسائل التي لم ترسل بعد تلغى."
              : "Messages already sent stay in the log. Messages not yet sent are cancelled."}
          </p>
        </Modal>
      )}
    </div>
  );
}

function WaitStepFields({ step, readOnly, lang, onChange }: { step: Extract<StepDraft, { type: "wait" }>; readOnly: boolean; lang: "ar" | "en"; onChange: (p: Partial<StepDraft>) => void }) {
  const ar = lang === "ar";
  const minutes = Math.round(Number(step.amount) * UNIT_MINUTES[step.unit]);
  const bad = !Number.isFinite(minutes) || minutes < 1 || minutes > MAX_WAIT_MINUTES;
  return (
    <div className="grid gap-2 sm:grid-cols-[160px_160px_1fr] items-center">
      <TextInput id={`wait-${step.key}`} value={step.amount} onChange={(v) => onChange({ amount: v })} inputMode="decimal" disabled={readOnly} invalid={bad} />
      <Select id={`wait-unit-${step.key}`} value={step.unit} onChange={(v) => onChange({ unit: v as WaitUnit })} disabled={readOnly}>
        <option value="minutes">{ar ? "دقيقة" : "minutes"}</option>
        <option value="hours">{ar ? "ساعة" : "hours"}</option>
        <option value="days">{ar ? "يوم" : "days"}</option>
      </Select>
      <span className={`text-[12px] ${bad ? "text-oo-status-blocked" : "text-oo-text-muted"}`}>
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
  const preview = useMemo(() => renderTemplate(event, step.template, sampleContext(event), locale), [event, step.template, locale]);
  const unknown = unknownPlaceholders(event, step.template);
  const phoneCheck = step.kind === "phone" && step.phone ? normalizePhoneForWhatsApp(step.phone) : null;
  const chosenEmployee = employees.find((e) => e.id === step.employeeId);

  function insert(key: string) {
    const token = `{{${key}}}`;
    const el = ref.current;
    if (!el) return onChange({ template: step.template + token });
    const start = el.selectionStart ?? step.template.length;
    const end = el.selectionEnd ?? start;
    const next = step.template.slice(0, start) + token + step.template.slice(end);
    onChange({ template: next });
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id={`to-${step.key}`} label={ar ? "إلى" : "To"}>
          <Select id={`to-${step.key}`} value={step.kind} onChange={(v) => onChange({ kind: v as RecipientKind })} disabled={readOnly}>
            {recipientsFor(event).map((k) => (
              <option key={k} value={k}>
                {ar ? RECIPIENT_LABELS[k].ar : RECIPIENT_LABELS[k].en}
              </option>
            ))}
          </Select>
        </Field>
        {step.kind === "employee" && (
          <Field
            id={`emp-${step.key}`}
            label={ar ? "الموظف" : "Employee"}
            error={chosenEmployee && !chosenEmployee.hasPhone ? (ar ? "لا يوجد رقم جوال صالح لهذا الموظف." : "This employee has no usable phone number.") : undefined}
          >
            <Select id={`emp-${step.key}`} value={step.employeeId} onChange={(v) => onChange({ employeeId: v })} disabled={readOnly}>
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
            <Field id={`phone-${step.key}`} label={ar ? "رقم الجوال" : "Phone number"} error={phoneCheck && !phoneCheck.ok ? phoneCheck.reason : undefined} hint={ar ? "مثل 05XXXXXXXX أو +9665XXXXXXXX" : "e.g. 05XXXXXXXX or +9665XXXXXXXX"}>
              <TextInput id={`phone-${step.key}`} value={step.phone} onChange={(v) => onChange({ phone: v })} inputMode="tel" disabled={readOnly} invalid={!!phoneCheck && !phoneCheck.ok} />
            </Field>
            <Field id={`phone-name-${step.key}`} label={ar ? "اسم المستلم (اختياري)" : "Recipient name (optional)"}>
              <TextInput id={`phone-name-${step.key}`} value={step.phoneName} onChange={(v) => onChange({ phoneName: v })} disabled={readOnly} />
            </Field>
          </>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-2">
          <label htmlFor={`tpl-${step.key}`} className="block text-xs font-bold text-oo-text-secondary">
            {ar ? "نص الرسالة" : "Message"}
          </label>
          <textarea
            ref={ref}
            id={`tpl-${step.key}`}
            data-testid={`template-${index}`}
            rows={6}
            dir="auto"
            value={step.template}
            disabled={readOnly}
            maxLength={TEMPLATE_MAX_LENGTH}
            onChange={(e) => onChange({ template: e.target.value })}
            className="w-full rounded-[10px] border border-oo-border-strong bg-oo-bg-default px-[14px] py-[10px] text-[14px] leading-[22px] text-oo-text-primary outline-none focus:border-oo-action-primary focus:ring-2 focus:ring-oo-action-primary/20 disabled:bg-oo-bg-subtle"
          />
          {unknown.length > 0 && (
            <p className="text-[12px] font-bold text-oo-status-blocked" role="alert">
              {ar ? "متغيرات غير معروفة لهذا الحدث: " : "Unknown variables for this event: "}
              <bdi dir="ltr">{unknown.map((k) => `{{${k}}}`).join(" ")}</bdi>
            </p>
          )}
          {!readOnly && (
            <div>
              <p className="mb-1.5 text-[12px] text-oo-text-muted">{ar ? "اضغط متغيرا لإدراجه في مكان المؤشر:" : "Click a variable to insert it:"}</p>
              <div className="flex flex-wrap gap-1.5">
                {event.variables.map((v) => (
                  <button
                    key={v.key}
                    type="button"
                    onClick={() => insert(v.key)}
                    title={`{{${v.key}}}`}
                    className="rounded-lg border border-oo-border-default bg-oo-bg-subtle px-2 py-1 text-[12px] text-oo-text-secondary hover:border-oo-action-primary hover:text-oo-text-primary"
                  >
                    {ar ? v.ar : v.en}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="space-y-2">
          <span className="block text-xs font-bold text-oo-text-secondary">{ar ? "معاينة ببيانات مثال" : "Preview with sample data"}</span>
          <Bubble text={preview} lang={lang} testId={`preview-${index}`} />
          <p className="text-[11px] text-oo-text-muted">{step.template.length} / {TEMPLATE_MAX_LENGTH}</p>
        </div>
      </div>
    </div>
  );
}
