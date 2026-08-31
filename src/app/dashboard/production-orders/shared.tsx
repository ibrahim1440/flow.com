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

// Reuses the Order Operations status palette rather than introducing a second one:
// PLANNED reads as waiting, IN_PRODUCTION as in-progress, and the two terminal states
// take the success and cancelled tones already used on order rows.
const STATUS_STYLE: Record<string, string> = {
  PENDING: "text-oo-status-waiting bg-oo-status-waiting-bg border-oo-status-waiting/30",
  IN_PRODUCTION: "text-oo-status-preparing bg-oo-status-preparing-bg border-oo-status-preparing/30",
  COMPLETED: "text-oo-status-success bg-oo-status-success-bg border-oo-status-success/30",
  CANCELLED: "text-oo-status-cancelled bg-oo-status-cancelled-bg border-oo-status-cancelled/30",
};

export function ProductionStatusBadge({ status }: { status: string }) {
  const { t } = useI18n();
  const style = STATUS_STYLE[status] ?? STATUS_STYLE.PENDING;
  return (
    <span className={`inline-block px-2.5 py-1 rounded-lg text-[11px] font-bold border whitespace-nowrap ${style}`}>
      {t(`status${status}` as never)}
    </span>
  );
}

export function ProgressBar({ produced, target }: { produced: number; target: number }) {
  // Clamped at 100 %: over-production is real and legitimate (a roaster load does not
  // divide evenly into an order), but a bar past its own track reads as a rendering bug.
  const pct = target > 0 ? Math.min(100, Math.round((produced / target) * 100)) : 0;
  const complete = produced >= target && target > 0;
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 bg-muted rounded-full h-1.5 min-w-[60px]">
        <div
          className={`h-1.5 rounded-full transition-all ${complete ? "bg-success" : "bg-orange"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-[11px] tabular-nums text-brown/70 w-9 text-end">{pct}%</span>
    </div>
  );
}
