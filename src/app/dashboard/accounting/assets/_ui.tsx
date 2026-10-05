"use client";

// Shared labels for the fixed-asset and year-end screens (Figma page 22, ACC-60..65).
import { Badge, useL, type Tone } from "../../finance/_components/ui";

export const ASSET_STATUS: Record<string, [string, string, Tone]> = {
  DRAFT: ["مسودة", "Draft", "info"], SUBMITTED: ["بانتظار الاعتماد", "Awaiting approval", "warn"], CAPITALISED: ["مُرسمل", "Capitalised", "ok"],
  DISPOSED: ["مُستبعد", "Disposed", "info"], CANCELLED: ["ملغى", "Cancelled", "bad"],
};
export const DOC_STATUS: Record<string, [string, string, Tone]> = {
  DRAFT: ["محسوب — بانتظار الاعتماد", "Computed — awaiting approval", "warn"], POSTED: ["مرحّل", "Posted", "ok"],
  REVERSAL_REQUESTED: ["طلب عكس بانتظار القرار", "Reversal awaiting decision", "warn"], REVERSED: ["معكوس", "Reversed", "info"], CANCELLED: ["ملغى", "Discarded", "info"],
};
export const POLICY_STATUS: Record<string, [string, string, Tone]> = { DRAFT: ["مسودة", "Draft", "warn"], APPROVED: ["معتمد", "Approved", "ok"], RETIRED: ["متقاعد", "Retired", "info"] };
export const METHOD: Record<string, [string, string]> = { STRAIGHT_LINE: ["قسط ثابت", "Straight line"], DECLINING_BALANCE: ["متناقص", "Declining balance"] };
export const START: Record<string, [string, string]> = { IN_SERVICE_MONTH: ["شهر الخدمة", "In-service month"], NEXT_MONTH: ["الشهر التالي", "Month after"] };
export const DISPOSAL_MONTH: Record<string, [string, string]> = { NONE: ["لا إهلاك", "No charge"], FULL_MONTH: ["شهر كامل", "Full month"] };
export const DISPOSAL_KIND: Record<string, [string, string]> = { SALE: ["بيع", "Sale"], SCRAP: ["إتلاف", "Scrap"], WRITE_OFF: ["شطب", "Write-off"] };
export const SOURCE_KIND: Record<string, [string, string]> = { BILL_LINE: ["بند فاتورة مورد", "Supplier-bill line"], ACCOUNT: ["حساب مقابل", "Counter account"], IN_LEDGER: ["قائم في الأستاذ", "Already in the ledger"] };
export const LEDGER: Record<string, [string, string, Tone]> = {
  TRANSLATED: ["في الحسابات", "In the accounts", "ok"], SKIPPED: ["لا قيد", "No entry needed", "info"], PENDING: ["بانتظار الترحيل", "Waiting to post", "warn"],
  BLOCKED: ["محجوب", "Blocked", "bad"], FAILED: ["تعذّر", "Failed", "bad"],
};
export const faNo = (n: number) => `FA-${String(n).padStart(4, "0")}`;

export function Pill({ map, v }: { map: Record<string, [string, string, Tone]>; v: string }) {
  const { L } = useL();
  const m = map[v] ?? [v, v, "info" as Tone];
  return <Badge tone={m[2]}>{L(m[0], m[1])}</Badge>;
}
