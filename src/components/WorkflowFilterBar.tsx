"use client";

import { Search, X } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";

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

  return (
    <div className="bg-white border border-border rounded-2xl p-3 flex flex-wrap gap-2 items-center">
      {/* Search */}
      <div className="relative flex-1 min-w-[180px]">
        <Search size={15} className="absolute ltr:left-3 rtl:right-3 top-1/2 -translate-y-1/2 text-brown/40 pointer-events-none" />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder={t("searchWorkflow")}
          className="w-full ltr:pl-8 rtl:pr-8 pr-3 py-2 text-sm border border-border rounded-xl bg-muted/30 focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors placeholder:text-brown/40"
        />
      </div>

      {/* Bean filter */}
      {beanOptions.length > 0 && (
        <select
          value={selectedBean}
          onChange={(e) => onBeanChange(e.target.value)}
          className="py-2 px-3 text-sm border border-border rounded-xl bg-white focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors text-charcoal min-w-[130px]"
        >
          <option value="">{t("allBeans")}</option>
          {beanOptions.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      )}

      {/* Order filter */}
      {orderOptions.length > 0 && (
        <select
          value={selectedOrder}
          onChange={(e) => onOrderChange(e.target.value)}
          className="py-2 px-3 text-sm border border-border rounded-xl bg-white focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors text-charcoal min-w-[130px]"
        >
          <option value="">{t("allOrders")}</option>
          {orderOptions.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      )}

      {/* Result count + clear */}
      <div className="flex items-center gap-2 ltr:ml-auto rtl:mr-auto">
        {hasFilter && resultCount !== totalCount && (
          <span className="text-xs text-brown/60 font-medium whitespace-nowrap">
            {resultCount} {t("filterResults")} {totalCount}
          </span>
        )}
        {hasFilter && (
          <button
            onClick={clearAll}
            className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-bold text-brown/60 hover:text-orange hover:bg-orange/10 rounded-lg transition-colors"
          >
            <X size={12} /> {t("clearFilters")}
          </button>
        )}
      </div>
    </div>
  );
}
