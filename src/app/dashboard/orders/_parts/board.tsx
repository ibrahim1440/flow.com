"use client";
// The Orders page as the status board (production simplification, Phase B item 4).
//
// «تجهيز الطلبات» is retired: preparation runs by itself (on creation, and after every roast, QC
// decision, packing and delivery), so the Orders page only SHOWS where each order stands.
//
// fix/order-progress-ui (owner, 2026-10-22): where an order stands is ONE text status, by the
// shared rule of lib/order-stage (orderProgress / lineProgress) — the order's status first (hold,
// cancelled, rejected, completed), otherwise its production stage. The four-segment roast → QC →
// pack → delivery bar is no longer drawn anywhere: the board shows a chip, the pane its stepper
// with one line under the current step, and «بنود الطلب» one status per line.
import { useI18n } from "@/lib/i18n/context";
import { LocalizedName } from "@/components/LocalizedName";
import { countNoun, Kg, UNIT_FORMS } from "@/components/ops/ui";
import { lineProgress, progressText, type ProgressDisplay } from "@/lib/order-stage";

export type PipelineInfo = {
  stage: number;
  key: "roast" | "qc" | "pack" | "ready" | "restReady" | "partReady" | "done";
  partDelivered: boolean;
  lines: { orderItemId: string; stage: number; reservedUnits: number | null }[];
};

/** One text status (the shared helper's display), as a chip. */
export function ProgressChip({ d, testId }: { d: ProgressDisplay; testId?: string }) {
  const { t } = useI18n();
  return (
    <span className={`ops-dtag tone-${d.tone}${d.muted ? " is-muted" : ""}`} data-testid={testId} data-key={d.key}>
      {progressText(d, t)}
    </span>
  );
}

type Line = {
  id: string;
  beanTypeName: string;
  product?: { productNameEn: string; productNameAr: string | null } | null;
  quantityUnits: number | null;
  quantityKg: number;
  preparationDecision: string | null;
};

/**
 * «بنود الطلب»: per line its name, quantity and ONE text status.
 *
 * Blocking a line is intentionally not offered here (owner decision, 2026-10-22). The server side
 * is unchanged: POST /api/orders/[id]/preparation-review still accepts `decision: "Blocked"` (with
 * a note) and the unblock, behind orders › prepare_review, and a blocked line still refuses
 * delivery. To re-enable it, restore the block / unblock buttons and the reason form of
 * `LinePreparation` in this file as of 20642725 and pass it `canBlock` (that privilege) from the
 * Orders page. A line already blocked in data still reads «موقوف» (lineProgress), so nothing is
 * hidden.
 */
export function OrderLines({ orderStatus, items, pipeline }: {
  orderStatus: string;
  items: Line[];
  pipeline: PipelineInfo | null;
}) {
  const { t, lang } = useI18n();
  const byLine = new Map((pipeline?.lines ?? []).map((l) => [l.orderItemId, l]));
  return (
    <div className="hr-stack" style={{ gap: 8 }}>
      <p className="hr-caption" style={{ margin: 0 }}>{t("ordLinesAutoNote")}</p>
      <ul className="ops-dlines" style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {items.map((i) => {
          const d = lineProgress(orderStatus, { stage: byLine.get(i.id)?.stage, blocked: i.preparationDecision === "Blocked" });
          return (
            <li key={i.id} className="ops-dline" data-testid={`order-line-prep-${i.id}`}>
              <div className="ops-dline-t">
                <div className="ops-dline-name">
                  {i.product ? <LocalizedName lang={lang} en={i.product.productNameEn} ar={i.product.productNameAr} lastResort={i.beanTypeName} /> : <bdi>{i.beanTypeName}</bdi>}
                </div>
                <div className="ops-dline-sub">
                  {i.quantityUnits != null ? countNoun(i.quantityUnits, lang === "ar" ? "ar" : "en", UNIT_FORMS) : <Kg v={i.quantityKg} />}
                </div>
              </div>
              {d ? <ProgressChip d={d} testId={`order-line-status-${i.id}`} /> : <span className="hr-muted">—</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
