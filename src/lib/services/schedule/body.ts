// The plan body shared by «تخطيط الدفعات» preview and «اعتماد الخطة» (POST …/plans/preview, POST …/plans).
import { NextResponse } from "@/lib/api-response";
import { normaliseNumberText } from "@/lib/services/settings/sections";
import type { PlanRequest } from "./schedule-db";

const bad = (ar: string, en: string) => NextResponse.json({ error: ar, errorEn: en, code: "INVALID_BODY" }, { status: 400 });

export function parsePlanBody(b: Record<string, unknown>): PlanRequest | NextResponse {
  if (typeof b.productId !== "string" || !b.productId) return bad("اختر القهوة.", "Give productId.");
  const opt = (v: unknown) => (typeof v === "string" && v ? v : null);
  let overrideGreenKg: number | null = null;
  if (b.overrideGreenKg !== undefined && b.overrideGreenKg !== null && b.overrideGreenKg !== "") {
    const t = typeof b.overrideGreenKg === "number" ? String(b.overrideGreenKg) : typeof b.overrideGreenKg === "string" ? normaliseNumberText(b.overrideGreenKg) : "";
    if (!/^\d+(\.\d{1,2})?$/.test(t) || Number(t) <= 0 || Number(t) > 5000) return bad("أدخل كمية أخضر أكبر من صفر بخانتين عشريتين على الأكثر.", "Enter a green quantity above 0 with at most two decimals.");
    overrideGreenKg = Number(t);
  }
  let slots: PlanRequest["slots"] = null;
  if (Array.isArray(b.slots)) {
    if (b.slots.length > 500) return bad("خانات كثيرة.", "Too many slots.");
    slots = [];
    for (const s of b.slots as unknown[]) {
      const o = (s ?? {}) as Record<string, unknown>;
      if (typeof o.startsAt !== "string" || typeof o.operatorId !== "string") return bad("كل خانة تحتاج وقتًا ومشغّلًا.", "Each slot needs startsAt and operatorId.");
      slots.push({ startsAt: o.startsAt, operatorId: o.operatorId });
    }
  }
  const split = b.split === "ALTERNATIVE" ? "ALTERNATIVE" : "PROPOSED";
  return { productId: b.productId, roasterId: opt(b.roasterId), operatorId: opt(b.operatorId), split, overrideGreenKg, slots };
}
