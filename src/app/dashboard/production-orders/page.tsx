"use client";

import { useState, useEffect, useMemo } from "react";
import Link from "next/link";
import { useI18n } from "@/lib/i18n/context";
import { ProductionStatusBadge, ProgressBar, type ProductionOrderRow } from "./shared";
import { OpsEmpty, OpsLoading, OpsRoot, PageHeader, Tabs, opsDate } from "@/components/ops/ui";

// The production work list. Everything shown here is derived on the server from the real
// roasting batches behind each order — this page never recomputes progress itself, so it
// cannot drift from what the production order detail and the API report.

const STATUS_FILTERS = ["PENDING", "IN_PRODUCTION", "COMPLETED", "CANCELLED"] as const;

export default function ProductionOrdersPage() {
  const { t, lang } = useI18n();
  const [rows, setRows] = useState<ProductionOrderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"open" | "all" | (typeof STATUS_FILTERS)[number]>("open");

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
    <OpsRoot>
      <div className="hr-page">
        <PageHeader title={t("productionOrdersTitle")}>
          <span>{t("productionOrdersSub")}</span>
        </PageHeader>

        <Tabs
          label={t("productionOrdersTitle")}
          value={filter}
          onChange={(k) => setFilter(k)}
          items={(["open", "all", ...STATUS_FILTERS] as const).map((key) => ({
            key,
            label: key === "open" ? t("opsOpenWork") : key === "all" ? t("poFilterAll") : t(`status${key}` as never),
            count: counts[key] ?? 0,
          }))}
        />

        {loading ? (
          <OpsLoading />
        ) : visible.length === 0 ? (
          <OpsEmpty title={t("poNone")} />
        ) : (
          <div className="hr-tablewrap">
            <table className="hr-table is-mrow ops-rows ops-pos" aria-label={t("productionOrdersTitle")}>
              <thead>
                <tr>
                  <th>{t("poNumber")}</th>
                  <th>{t("poProduct")}</th>
                  <th>{t("poDemandSource")}</th>
                  <th className="num">{t("poRequired")}</th>
                  <th className="num">{t("poProduced")}</th>
                  <th className="num">{t("poRemaining")}</th>
                  <th className="hr-hide-compact">{t("poProgressLabel")}</th>
                  <th>{t("poStatus")}</th>
                  <th className="hr-hide-compact">{t("poCreatedAt")}</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => (
                  <tr key={r.id} data-testid={`po-row-${r.productionNumber}`}>
                    <td>
                      <Link href={`/dashboard/production-orders/${r.id}`} className="ops-serial ops-link">{r.productionNumber}</Link>
                      <span className="ops-line"><span className="hr-num">{r._count.roastingBatches}</span> {t("poBatches")}</span>
                    </td>
                    <td className="m-title">
                      <span className="strong">{r.productSku.product.productNameEn}</span>
                      <span className="ops-line">
                        <span className="ops-serial">{r.productSku.skuCode}</span>
                        <span className="hr-mobile-only"> · <Link href={`/dashboard/production-orders/${r.id}`} className="ops-serial ops-link">{r.productionNumber}</Link> · <bdi dir="ltr"><span className="hr-num">{r.progress?.producedUnits ?? 0}</span> / <span className="hr-num">{r.targetUnits}</span></bdi></span>
                      </span>
                    </td>
                    <td>
                      {r.sourceOrderItem ? (
                        <>
                          <span className="hr-id">#{r.sourceOrderItem.order.orderNumber}</span>
                          <span className="ops-line">{r.sourceOrderItem.order.customer?.name}</span>
                        </>
                      ) : <span className="hr-muted">—</span>}
                    </td>
                    <td className="num"><span className="hr-num">{r.targetUnits}</span></td>
                    <td className="num"><span className="hr-num">{r.progress?.producedUnits ?? 0}</span></td>
                    <td className="num"><span className="hr-num">{r.progress?.remainingUnits ?? r.targetUnits}</span></td>
                    <td className="hr-hide-compact"><ProgressBar produced={r.progress?.producedUnits ?? 0} target={r.targetUnits} /></td>
                    <td className="m-end"><ProductionStatusBadge status={r.status} /></td>
                    <td className="hr-hide-compact" style={{ whiteSpace: "nowrap" }}>{/* N-08: FREEZE short operational date */}{opsDate(r.createdAt, lang)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </OpsRoot>
  );
}
