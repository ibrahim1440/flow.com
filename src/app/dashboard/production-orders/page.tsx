"use client";

import { useState, useEffect, useMemo } from "react";
import { ClipboardList, Loader2 } from "lucide-react";
import Link from "next/link";
import { useI18n } from "@/lib/i18n/context";
import { formatDate } from "@/lib/utils";
import { ProductionStatusBadge, ProgressBar, type ProductionOrderRow } from "./shared";

// The production work list. Everything shown here is derived on the server from the real
// roasting batches behind each order — this page never recomputes progress itself, so it
// cannot drift from what the production order detail and the API report.

const STATUS_FILTERS = ["PENDING", "IN_PRODUCTION", "COMPLETED", "CANCELLED"] as const;

export default function ProductionOrdersPage() {
  const { t } = useI18n();
  const [rows, setRows] = useState<ProductionOrderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>("open");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await fetch("/api/production-orders");
        if (!cancelled) setRows(res.ok ? await res.json() : []);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const visible = useMemo(() => {
    if (filter === "all") return rows;
    // "Open" is the default view because it is the only one that represents work: a
    // roaster arriving in the morning wants what is planned and what is running, not a
    // history of everything ever closed.
    if (filter === "open") return rows.filter((r) => r.status === "PENDING" || r.status === "IN_PRODUCTION");
    return rows.filter((r) => r.status === filter);
  }, [rows, filter]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: rows.length, open: 0 };
    for (const s of STATUS_FILTERS) c[s] = 0;
    for (const r of rows) {
      c[r.status] = (c[r.status] ?? 0) + 1;
      if (r.status === "PENDING" || r.status === "IN_PRODUCTION") c.open++;
    }
    return c;
  }, [rows]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-extrabold text-charcoal">{t("productionOrdersTitle")}</h1>
        <p className="text-brown text-sm font-medium">{t("productionOrdersSub")}</p>
      </div>

      <div className="flex flex-wrap gap-2">
        {(["open", "all", ...STATUS_FILTERS] as const).map((key) => (
          <button
            key={key}
            onClick={() => setFilter(key)}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold border-2 transition-colors ${
              filter === key
                ? "bg-orange text-white border-orange"
                : "bg-white text-brown border-border hover:border-orange/50"
            }`}
          >
            {key === "open" ? t("poFilterAll") + " · " + t("statusIN_PRODUCTION")
              : key === "all" ? t("poFilterAll")
              : t(`status${key}` as never)}
            <span className="ms-1.5 opacity-70">{counts[key] ?? 0}</span>
          </button>
        ))}
      </div>

      {loading ? (
        <div className="text-center py-12 text-muted-foreground">
          <Loader2 size={28} className="mx-auto mb-2 animate-spin" />
        </div>
      ) : visible.length === 0 ? (
        <div className="text-center py-12 bg-white rounded-2xl border border-border text-muted-foreground">
          <ClipboardList size={32} className="mx-auto mb-2" />
          <p>{t("poNone")}</p>
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-border overflow-x-auto">
          <table className="w-full text-sm min-w-[860px]">
            <thead className="bg-cream">
              <tr>
                <th className="text-start px-4 py-3 font-semibold">{t("poNumber")}</th>
                <th className="text-start px-4 py-3 font-semibold">{t("poProduct")}</th>
                <th className="text-start px-4 py-3 font-semibold">{t("poDemandSource")}</th>
                <th className="text-end px-4 py-3 font-semibold">{t("poRequired")}</th>
                <th className="text-end px-4 py-3 font-semibold">{t("poProduced")}</th>
                <th className="text-end px-4 py-3 font-semibold">{t("poRemaining")}</th>
                <th className="text-start px-4 py-3 font-semibold w-40">{t("poProgressLabel")}</th>
                <th className="text-start px-4 py-3 font-semibold">{t("poStatus")}</th>
                <th className="text-start px-4 py-3 font-semibold">{t("poCreatedAt")}</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr key={r.id} className="border-t border-border hover:bg-cream/40 transition-colors">
                  <td className="px-4 py-3">
                    <Link href={`/dashboard/production-orders/${r.id}`} className="font-bold text-orange hover:underline">
                      {r.productionNumber}
                    </Link>
                    <p className="text-xs text-brown/70">{r._count.roastingBatches} {t("poBatches")}</p>
                  </td>
                  <td className="px-4 py-3">
                    <p className="font-semibold">{r.productSku.skuCode}</p>
                    <p className="text-xs text-brown/70">{r.productSku.product.productNameEn}</p>
                  </td>
                  <td className="px-4 py-3">
                    {r.sourceOrderItem ? (
                      <>
                        <p className="font-medium">#{r.sourceOrderItem.order.orderNumber}</p>
                        <p className="text-xs text-brown/70">{r.sourceOrderItem.order.customer?.name}</p>
                      </>
                    ) : (
                      <span className="text-xs text-brown/50 italic">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-end tabular-nums font-semibold">{r.targetUnits}</td>
                  <td className="px-4 py-3 text-end tabular-nums">{r.progress?.producedUnits ?? 0}</td>
                  <td className="px-4 py-3 text-end tabular-nums">{r.progress?.remainingUnits ?? r.targetUnits}</td>
                  <td className="px-4 py-3">
                    <ProgressBar produced={r.progress?.producedUnits ?? 0} target={r.targetUnits} />
                  </td>
                  <td className="px-4 py-3"><ProductionStatusBadge status={r.status} /></td>
                  <td className="px-4 py-3 text-xs text-brown/70 whitespace-nowrap">{formatDate(r.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
