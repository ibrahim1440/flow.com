"use client";

import { useI18n } from "@/lib/i18n/context";

// Shared presentation for the production-order screens. Both the list and the detail read
// the same server-computed figures, so the formatting lives in one place rather than being
// re-derived on each page.

export type ProductionProgress = {
  batchCount: number;
  greenConsumedKg: number;
  roastedOutputKg: number;
  producedUnits: number;
  remainingUnits: number;
  remainingKg: number;
};

export type ProductionOrderRow = {
  id: string;
  productionNumber: string;
  status: string;
  targetUnits: number;
  targetWeightKg: number;
  expectedGreenBeanKg: number;
  createdAt: string;
  productSku: {
    id: string; skuCode: string; name: string; weightGrams: number;
    product: { id: string; productNameEn: string; countryEn: string | null };
  };
  greenBean: { id: string; serialNumber: string; beanType: string } | null;
  sourceOrderItem: {
    id: string; quantityUnits: number | null; deliveredUnits: number;
    order: { id: string; orderNumber: number; status: string; customer: { name: string } | null };
  } | null;
  _count: { roastingBatches: number };
  progress: ProductionProgress | null;
};

// Direction 2.1 status dots. PLANNED reads as waiting, IN_PRODUCTION as in progress, and
// the two terminal states take the success and cancelled tones used on order rows.
const STATUS_TONE: Record<string, "warning" | "info" | "success" | "cancelled"> = {
  PENDING: "warning",
  IN_PRODUCTION: "info",
  COMPLETED: "success",
  CANCELLED: "cancelled",
};

export function ProductionStatusBadge({ status }: { status: string }) {
  const { t } = useI18n();
  return (
    <span className={`hr-dot tone-${STATUS_TONE[status] ?? "warning"}`} data-status={status}>
      <span>{t(`status${status}` as never)}</span>
    </span>
  );
}

export function ProgressBar({ produced, target }: { produced: number; target: number }) {
  // Clamped at 100 %: over-production is real and legitimate (a roaster load does not
  // divide evenly into an order), but a bar past its own track reads as a rendering bug.
  const pct = target > 0 ? Math.min(100, Math.round((produced / target) * 100)) : 0;
  const complete = produced >= target && target > 0;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <span className={`ops-bar${complete ? " tone-success" : ""}`} role="img" aria-label={`${pct}%`}>
        <span style={{ width: `${pct}%` }} />
      </span>
      <span className="hr-num hr-caption" style={{ margin: 0, minWidth: 36 }}>{pct}%</span>
    </span>
  );
}
