"use client";

import { useState, useEffect, useCallback } from "react";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import { useUser } from "@/app/dashboard/user-context";
import { hasSubPrivilege } from "@/lib/auth-shared";
import { useI18n } from "@/lib/i18n/context";
import type { TranslationKey } from "@/lib/i18n/translations";
import { LocalizedName } from "@/components/LocalizedName";

// E7: a requirement line is labelled from master data in the interface language — the
// Arabic name (CoffeeProduct.productNameAr / MaterialItem.nameAr) in Arabic, the English
// name in English, with the fallback of pickLocalizedName (English isolated in <bdi dir=ltr>,
// no marker). The kind is composed here («بن محمّص …» / «Roasted …»); the material code stays
// beside the name as its stable identifier. `label` (English, built by the server) is only
// used if a response predates the name fields.
function ComponentLabel({ c, lang }: { c: BomLine; lang: "ar" | "en" }) {
  if (c.nameEn === undefined) {
    const roasted = /^Roasted (.+)$/.exec(c.label);
    if (roasted) return <>{lang === "ar" ? "بن محمّص " : "Roasted "}<bdi>{roasted[1]}</bdi></>;
    return <bdi>{c.label}</bdi>;
  }
  if (c.type === "ROASTED_COFFEE")
    return <>{lang === "ar" ? "بن محمّص " : "Roasted "}<LocalizedName lang={lang} en={c.nameEn} ar={c.nameAr} lastResort={lang === "ar" ? "قهوة" : "coffee"} /></>;
  return (
    <>
      <LocalizedName lang={lang} en={c.nameEn} ar={c.nameAr} lastResort={c.code ?? undefined} />
      {c.code ? <> (<bdi dir="ltr">{c.code}</bdi>)</> : null}
    </>
  );
}

// A production order's status in the viewer's language (the raw enum read «IN PRODUCTION»).
const PO_STATUS_KEY: Record<string, TranslationKey> = {
  PENDING: "statusPENDING",
  IN_PRODUCTION: "statusIN_PRODUCTION",
  COMPLETED: "statusCOMPLETED",
  CANCELLED: "statusCANCELLED",
};

// Step 9 of the flow: turn the part of an order line the shelf could not cover into a
// production order — and only that part. The arithmetic lives on the server
// (GET/POST /api/order-items/[id]/production-requirement); this panel shows it and
// offers the button.

type BomLine = {
  type?: "ROASTED_COFFEE" | "MATERIAL";
  label: string;
  // E7 (additive in the response): master-data names and the material code.
  nameEn?: string | null;
  nameAr?: string | null;
  code?: string | null;
  unitOfMeasure: string;
  quantityRequired: number;
  quantityAvailable: number;
  shortfall: number;
};

type Requirement = {
  orderItemId: string;
  skuCode: string;
  productId?: string;
  productNameEn?: string | null;
  productNameAr?: string | null;
  orderedUnits: number;
  deliveredUnits: number;
  reservedUnits: number;
  scheduledUnits: number;
  shortfallUnits: number;
  shortfallKg: number;
  components: BomLine[];
  hasBom: boolean;
  blockedBy: string[];
  existingProductionOrders: { id: string; productionNumber: string; status: string; targetUnits: number; producedUnits: number }[];
};

export function ProductionRequirementPanel({ itemIds }: { itemIds: string[] }) {
  const { t, lang } = useI18n();
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
        return (
          <div key={row.orderItemId} className="ops-panel" style={{ marginTop: 0 }}>
            <div className="flex items-center justify-between gap-2 flex-wrap">
              {/* E7: the product's name in the interface language is the line's primary
                  label; the SKU code beside it is the stable identifier. */}
              <span className="flex items-baseline gap-2 flex-wrap" data-testid={`prodreq-product-${row.orderItemId}`}>
                {row.productNameEn !== undefined ? (
                  <b className="text-sm text-oo-text-primary">
                    <LocalizedName lang={lang} en={row.productNameEn} ar={row.productNameAr} lastResort={row.skuCode} />
                  </b>
                ) : null}
                <span className="ops-serial">{row.skuCode}</span>
              </span>
              <span className="text-xs text-oo-text-secondary">
                {t("orderedLabel")}: <b>{row.orderedUnits}</b> · {t("reservedLabel")}:{" "}
                <b className="text-oo-status-success">{row.reservedUnits}</b> ·{" "}
                {t("scheduledLabel")}:{" "}
                <b className={row.scheduledUnits > 0 ? "text-oo-status-preparing" : "text-oo-text-muted"}>
                  {row.scheduledUnits}
                </b>{" "}
                · {t("productionReqShortfall")}:{" "}
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
                    <li key={i} data-testid="prodreq-component" className="text-xs text-oo-text-secondary flex items-center gap-1.5 flex-wrap">
                      <span>
                        <ComponentLabel c={c} lang={lang} />: <b>{c.quantityRequired}</b>{" "}
                        {c.unitOfMeasure === "KG" ? (lang === "ar" ? "كغ" : "kg") : (lang === "ar" ? "قطعة" : "pcs")}
                      </span>
                      {c.shortfall > 0 && (
                        <span className="text-oo-status-blocked font-semibold">
                          ({t("productionReqShort")} — {c.quantityAvailable})
                        </span>
                      )}
                    </li>
                  ))}
                </ul>

                {/* An existing production order no longer suppresses the button. What it
                    already owes this line is subtracted from the shortfall by the server,
                    so a shortfall shown here is genuinely additional work — which is what
                    lets an increased order quantity be scheduled instead of refused. */}
                {canCreate ? (
                  <button
                    type="button"
                    disabled={busy === row.orderItemId}
                    onClick={() => create(row)}
                    className="hr-btn is-primary is-sm"
                    style={{ marginTop: 8 }}
                    aria-busy={busy === row.orderItemId || undefined}
                  >
                    {busy === row.orderItemId ? "…" : null}
                    {t("productionReqCreate")} ({row.shortfallUnits})
                  </button>
                ) : null}
              </>
            )}

            {/* Shown whether or not there is a shortfall: when a line looks short but the
                button offers nothing, these are the orders explaining why. */}
            {row.existingProductionOrders.length > 0 && (
              <ul className="mt-2 space-y-0.5 border-t border-oo-border-default pt-2">
                {row.existingProductionOrders.map((p) => (
                  <li key={p.id} className="text-[11px] text-oo-text-secondary flex items-center gap-1.5 flex-wrap">
                    <a
                      href={`/dashboard/production-orders/${p.id}`}
                      className="font-mono font-bold text-oo-action-primary hover:underline"
                    >
                      {p.productionNumber}
                    </a>
                    <span className="text-oo-text-muted">
                      {p.producedUnits}/{p.targetUnits}
                    </span>
                    <span className="font-semibold text-oo-text-muted">
                      {PO_STATUS_KEY[p.status] ? t(PO_STATUS_KEY[p.status]) : p.status.replace("_", " ")}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}
