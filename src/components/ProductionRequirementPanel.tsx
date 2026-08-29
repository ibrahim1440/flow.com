"use client";

import { useState, useEffect, useCallback } from "react";
import { Hammer, AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import { useUser } from "@/app/dashboard/user-context";
import { hasSubPrivilege } from "@/lib/auth-shared";
import { useI18n } from "@/lib/i18n/context";

// Step 9 of the flow: turn the part of an order line the shelf could not cover into a
// production order — and only that part. The arithmetic lives on the server
// (GET/POST /api/order-items/[id]/production-requirement); this panel shows it and
// offers the button.

type BomLine = {
  label: string;
  unitOfMeasure: string;
  quantityRequired: number;
  quantityAvailable: number;
  shortfall: number;
};

type Requirement = {
  orderItemId: string;
  skuCode: string;
  orderedUnits: number;
  deliveredUnits: number;
  reservedUnits: number;
  shortfallUnits: number;
  shortfallKg: number;
  components: BomLine[];
  hasBom: boolean;
  blockedBy: string[];
  existingProductionOrders: { id: string; productionNumber: string; status: string; targetUnits: number }[];
};

export function ProductionRequirementPanel({ itemIds }: { itemIds: string[] }) {
  const { t } = useI18n();
  const user = useUser();
  const canCreate = hasSubPrivilege(user?.permissions ?? {}, "production", "start_batch");

  const [rows, setRows] = useState<Requirement[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const key = itemIds.join(",");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const ids = key ? key.split(",") : [];
      const results = await Promise.all(
        ids.map(async (id) => {
          const res = await fetch(`/api/order-items/${id}/production-requirement`);
          // 409 = legacy kilogram line. Not an error worth shouting about: those lines
          // simply have no SKU production requirement, so they are left out.
          if (!res.ok) return null;
          return (await res.json()) as Requirement;
        })
      );
      if (cancelled) return;
      setRows(results.filter((r): r is Requirement => r !== null));
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [key, reloadKey]);

  const refresh = useCallback(() => setReloadKey((k) => k + 1), []);

  async function create(row: Requirement) {
    setBusy(row.orderItemId);
    setError(null);
    setDone(null);
    try {
      const res = await fetch(`/api/order-items/${row.orderItemId}/production-requirement`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to create production order.");
        return;
      }
      setDone(`${t("productionReqCreated")}: ${data.productionOrder?.productionNumber ?? ""}`);
      // Refresh THIS panel only. Calling the parent's reload here would put the whole
      // workstation back into its loading state, unmounting this panel and taking the
      // confirmation with it — the user would click and see the message vanish. Creating
      // a production order changes nothing the parent renders (the order keeps its status
      // and its items), so there is nothing for it to reload.
      refresh();
    } finally {
      setBusy(null);
    }
  }

  if (loading)
    return (
      <p className="text-xs text-oo-text-muted flex items-center gap-1.5 py-1">
        <Loader2 size={13} className="animate-spin" /> {t("loading")}
      </p>
    );

  // Every line on this order is a legacy kilogram line — nothing to show.
  if (rows.length === 0)
    return <p className="text-xs text-oo-text-muted">{t("productionReqLegacy")}</p>;

  return (
    <div className="space-y-2">
      {error && (
        <p className="text-xs font-semibold text-oo-status-blocked flex items-start gap-1.5">
          <AlertTriangle size={13} className="flex-shrink-0 mt-0.5" /> {error}
        </p>
      )}
      {done && (
        <p className="text-xs font-semibold text-oo-status-success flex items-center gap-1.5">
          <CheckCircle2 size={13} /> {done}
        </p>
      )}

      {rows.map((row) => {
        const open = row.existingProductionOrders.find(
          (p) => p.status === "PENDING" || p.status === "IN_PRODUCTION"
        );
        return (
          <div key={row.orderItemId} className="rounded-xl border border-oo-border-default p-2.5">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <span className="font-mono text-xs font-bold text-oo-text-primary">{row.skuCode}</span>
              <span className="text-xs text-oo-text-secondary">
                {t("orderedLabel")}: <b>{row.orderedUnits}</b> · {t("reservedLabel")}:{" "}
                <b className="text-oo-status-success">{row.reservedUnits}</b> ·{" "}
                {t("productionReqShortfall")}:{" "}
                <b className={row.shortfallUnits > 0 ? "text-oo-status-waiting" : "text-oo-text-muted"}>
                  {row.shortfallUnits}
                </b>
              </span>
            </div>

            {row.shortfallUnits === 0 ? (
              <p className="mt-1.5 text-xs text-oo-status-success">{t("productionReqCovered")}</p>
            ) : !row.hasBom ? (
              <p className="mt-1.5 text-xs font-semibold text-oo-status-blocked">{t("productionReqNoBom")}</p>
            ) : (
              <>
                <p className="mt-1.5 text-[11px] font-bold text-oo-text-muted uppercase">
                  {t("productionReqConsumes")}
                </p>
                <ul className="mt-0.5 space-y-0.5">
                  {row.components.map((c, i) => (
                    <li key={i} className="text-xs text-oo-text-secondary flex items-center gap-1.5 flex-wrap">
                      <span>
                        {c.label}: <b>{c.quantityRequired}</b>{" "}
                        {c.unitOfMeasure === "KG" ? "kg" : "pcs"}
                      </span>
                      {c.shortfall > 0 && (
                        <span className="text-oo-status-blocked font-semibold">
                          ({t("productionReqShort")} — {c.quantityAvailable})
                        </span>
                      )}
                    </li>
                  ))}
                </ul>

                {open ? (
                  <p className="mt-2 text-xs font-semibold text-oo-status-preparing">
                    {t("productionReqOpen")}: {open.productionNumber} ({open.targetUnits})
                  </p>
                ) : canCreate ? (
                  <button
                    type="button"
                    disabled={busy === row.orderItemId}
                    onClick={() => create(row)}
                    className="mt-2 w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-oo-action-primary text-white text-xs font-bold hover:bg-oo-action-primary-hover disabled:opacity-50 transition-colors"
                  >
                    {busy === row.orderItemId ? (
                      <Loader2 size={13} className="animate-spin" />
                    ) : (
                      <Hammer size={13} />
                    )}
                    {t("productionReqCreate")} ({row.shortfallUnits})
                  </button>
                ) : null}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
