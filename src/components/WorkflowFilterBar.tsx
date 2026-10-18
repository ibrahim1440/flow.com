"use client";

import { useI18n } from "@/lib/i18n/context";
import { FilterChip } from "@/components/hr/ui";

export type FilterOption = { label: string; value: string };

type Props = {
  searchQuery: string;
  onSearchChange: (v: string) => void;
  beanOptions: FilterOption[];
  selectedBean: string;
  onBeanChange: (v: string) => void;
  orderOptions: FilterOption[];
  selectedOrder: string;
  onOrderChange: (v: string) => void;
  resultCount: number;
  totalCount: number;
};

export default function WorkflowFilterBar({
  searchQuery, onSearchChange,
  beanOptions, selectedBean, onBeanChange,
  orderOptions, selectedOrder, onOrderChange,
  resultCount, totalCount,
}: Props) {
  const { t } = useI18n();
  const hasFilter = searchQuery || selectedBean || selectedOrder;

  function clearAll() {
    onSearchChange("");
    onBeanChange("");
    onOrderChange("");
  }

  // Direction 2.1 filter bar (HR-01 / orders): a search field, then one FilterChip per
  // filter (native select laid over the chip; «×» clears it), then the result count.
  return (
    <div className="hr-filterbar" data-hr-root="">
      <input
        type="text"
        value={searchQuery}
        onChange={(e) => onSearchChange(e.target.value)}
        placeholder={t("searchWorkflow")}
        aria-label={t("searchWorkflow")}
        className="hr-input hr-search"
      />
      {beanOptions.length > 0 && (
        <FilterChip label={t("beanType")} value={selectedBean} onChange={onBeanChange} options={beanOptions} allLabel={t("allBeans")} clearLabel={`${t("clearFilters")}: ${t("beanType")}`} />
      )}
      {orderOptions.length > 0 && (
        <FilterChip label={t("opsOrderCol")} value={selectedOrder} onChange={onOrderChange} options={orderOptions} allLabel={t("allOrders")} clearLabel={`${t("clearFilters")}: ${t("opsOrderCol")}`} />
      )}
      {hasFilter && resultCount !== totalCount && (
        <span className="hr-caption" style={{ margin: 0, whiteSpace: "nowrap" }}>
          <span className="hr-num">{resultCount}</span> {t("filterResults")} <span className="hr-num">{totalCount}</span>
        </span>
      )}
      {hasFilter && (
        <button type="button" onClick={clearAll} className="hr-btn is-ghost is-sm">
          {t("clearFilters")}
        </button>
      )}
    </div>
  );
}
