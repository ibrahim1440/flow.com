"use client";
// The Orders page as the status board (production simplification, Phase B item 4).
//
// «تجهيز الطلبات» is retired: preparation runs by itself (on creation, and after every roast, QC
// decision, packing and delivery), so the Orders page only SHOWS where each order stands — the
// four-step bar roast → QC → pack → delivery from the prototype's «الطلبات» tab — and keeps one
// manual act: a supervisor (orders › prepare_review) may block a line, and unblock it. Both go
// through the existing POST /api/orders/[id]/preparation-review, which stays the authority.
import { useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import type { TranslationKey } from "@/lib/i18n/translations";
import { LocalizedName } from "@/components/LocalizedName";
import { Btn } from "@/components/ops/ui";

export type PipelineInfo = {
  stage: number;
  key: "roast" | "qc" | "pack" | "ready" | "restReady" | "partReady" | "done";
  partDelivered: boolean;
  lines: { orderItemId: string; stage: number; reservedUnits: number | null }[];
};

const STAGE_LABEL: Record<PipelineInfo["key"], TranslationKey> = {
  roast: "ordStageRoast", qc: "ordStageQc", pack: "ordStagePack", ready: "ordStageReady",
  restReady: "ordStageRestReady", partReady: "ordStagePartReady", done: "ordStageDone",
};
const STEPS: TranslationKey[] = ["ordPipeRoast", "ordPipeQc", "ordPipePack", "ordPipeDeliver"];

export function pipelineLabel(p: PipelineInfo, t: (k: TranslationKey) => string): string {
  const base = t(STAGE_LABEL[p.key]);
  return p.partDelivered ? `${t("ordStagePartDelivered")} · ${base}` : base;
}

/** The four-segment bar; `compact` drops the step captions (table rows). */
export function PipelineBar({ p, compact, testId }: { p: PipelineInfo; compact?: boolean; testId?: string }) {
  const { t } = useI18n();
  const tone = p.key === "done" || p.key === "ready" || p.key === "restReady" ? "ok" : p.stage === 0 ? "warn" : "info";
  return (
    <span className={`ops-pipe${compact ? " is-compact" : ""}`} data-testid={testId} data-stage={p.stage} data-key={p.key}
      role="img" aria-label={`${pipelineLabel(p, t)} — ${STEPS.map((k) => t(k)).join(" · ")}`}>
      <span className={`ops-pipe-label tone-${tone}`}>{pipelineLabel(p, t)}</span>
      <span className="ops-pipe-bar" aria-hidden="true">
        {[0, 1, 2, 3].map((i) => <i key={i} className={p.stage > i ? "is-done" : p.stage === i ? "is-now" : ""} />)}
      </span>
      {compact ? null : (
        <span className="ops-pipe-steps" aria-hidden="true">{STEPS.map((k) => <span key={k}>{t(k)}</span>)}</span>
      )}
    </span>
  );
}

type Line = {
  id: string;
  beanTypeName: string;
  product?: { productNameEn: string; productNameAr: string | null } | null;
  quantityUnits: number | null;
  quantityKg: number;
  deliveredQty: number;
  preparationDecision: string | null;
};

/** Per line: its place on the bar, and — for a supervisor — block / unblock. */
export function LinePreparation({ orderId, items, pipeline, canBlock, open, onChanged }: {
  orderId: string;
  items: Line[];
  pipeline: PipelineInfo | null;
  canBlock: boolean;
  open: boolean;
  onChanged: () => void;
}) {
  const { t, lang } = useI18n();
  const [blocking, setBlocking] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function send(itemId: string, block: boolean) {
    setBusy(true); setError("");
    try {
      const res = await fetch(`/api/orders/${orderId}/preparation-review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(block
          ? { items: [{ orderItemId: itemId, decision: "Blocked" }], note: reason.trim() }
          : { items: [{ orderItemId: itemId }] }),
      });
      if (!res.ok) { setError((await res.json().catch(() => ({})))?.error ?? "Failed."); return; }
      setBlocking(null); setReason("");
      onChanged();
    } finally { setBusy(false); }
  }

  const byLine = new Map((pipeline?.lines ?? []).map((l) => [l.orderItemId, l]));
  return (
    <div className="hr-stack" style={{ gap: 8 }}>
      <p className="hr-caption" style={{ margin: 0 }}>{t("ordAutoPrepNote")}</p>
      <ul className="ops-dlines" style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {items.map((i) => {
          const l = byLine.get(i.id);
          const blocked = i.preparationDecision === "Blocked";
          const lp: PipelineInfo | null = l ? { stage: l.stage, key: (["roast", "qc", "pack", "ready", "done"] as const)[l.stage] as PipelineInfo["key"], partDelivered: false, lines: [] } : null;
          return (
            <li key={i.id} className="ops-dline" data-testid={`order-line-prep-${i.id}`}>
              <div className="ops-dline-t">
                <div className="ops-dline-name">
                  {i.product ? <LocalizedName lang={lang} en={i.product.productNameEn} ar={i.product.productNameAr} lastResort={i.beanTypeName} /> : <bdi>{i.beanTypeName}</bdi>}
                  {blocked ? <span className="ops-dtag tone-danger">{t("ordBlockedTag")}</span> : null}
                </div>
                {lp && !blocked ? <PipelineBar p={lp} compact /> : null}
              </div>
              {canBlock && open ? (
                blocked
                  ? <Btn size="sm" disabled={busy} onClick={() => send(i.id, false)} data-testid={`unblock-${i.id}`}>{t("ordUnblockLine")}</Btn>
                  : <Btn size="sm" variant="ghost" disabled={busy} onClick={() => { setBlocking(i.id); setReason(""); }} data-testid={`block-${i.id}`}>{t("ordBlockLine")}</Btn>
              ) : null}
            </li>
          );
        })}
      </ul>
      {blocking ? (
        <div className="hr-stack" style={{ gap: 8 }}>
          <label className="hr-label" htmlFor="block-reason">{t("ordBlockReason")}</label>
          <input id="block-reason" className="hr-input" style={{ minHeight: 44 }} value={reason} onChange={(e) => setReason(e.target.value)} />
          <div style={{ display: "flex", gap: 8 }}>
            <Btn variant="danger" disabled={busy || !reason.trim()} onClick={() => send(blocking, true)} data-testid="block-confirm">{t("ordBlockLine")}</Btn>
            <Btn variant="ghost" disabled={busy} onClick={() => setBlocking(null)}>{t("cancel")}</Btn>
          </div>
        </div>
      ) : null}
      {error ? <p className="hr-notice tone-danger" role="alert" style={{ margin: 0 }}>{error}</p> : null}
    </div>
  );
}
