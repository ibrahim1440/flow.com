// Marketing role presets (owner brief §19): Owner/Administrator, Marketing Manager, Content Creator,
// Analyst, Read Only — as sets of `marketing` keys. Pure. They are applied through the existing
// Employees screen (custom role); this file is the documented source of each preset, so a preset
// can never quietly grant more than it says. Privileged keys (ads_manage, integrations_manage,
// automation_manage) stay with the owner/administrator.

export const MARKETING_ROLE_PRESETS: { key: string; ar: string; en: string; access: "view" | "edit"; subs: string[] }[] = [
  { key: "owner", ar: "المالك / المسؤول", en: "Owner / Administrator", access: "edit", subs: ["content_manage", "campaigns_manage", "publish", "approve", "budget_manage", "revenue_view", "customers_data", "messaging_manage", "ads_manage", "integrations_manage", "automation_manage", "ai_use"] },
  { key: "manager", ar: "مدير التسويق", en: "Marketing Manager", access: "edit", subs: ["content_manage", "campaigns_manage", "publish", "approve", "budget_manage", "revenue_view", "customers_data", "messaging_manage", "ai_use"] },
  { key: "creator", ar: "صانع المحتوى", en: "Content Creator", access: "edit", subs: ["content_manage", "ai_use"] },
  { key: "analyst", ar: "المحلل", en: "Analyst", access: "view", subs: ["revenue_view"] },
  { key: "readonly", ar: "اطلاع فقط", en: "Read Only", access: "view", subs: [] },
];
