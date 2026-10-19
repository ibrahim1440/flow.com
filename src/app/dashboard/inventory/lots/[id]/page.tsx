"use client";
// Lot traceability — Figma 217:2 «سلسلة التتبع»: one finished-goods lot from the supplier to the order,
// read from GET /api/inventory/lots/:id/trace (src/lib/services/lot-trace.ts — existing relations
// only: PurchaseRecord → GreenBean → RoastingBatch → FinishedGoodsLot / PackagingSource →
// StockAllocation → Order / Delivery). Reached from «تتبع» on the finished stock tab.
import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Notice, OpsLoading, OpsRoot, PageHeader, StatusDot, Timeline, kg, opsDate, useL } from "@/components/ops/ui";
import "@/components/ops/stock.css";
import { useI18n } from "@/lib/i18n/context";
import { timeOf } from "../../_parts/shared";

type Trace = {
  lot: {
    id: string; batchNumber: string; status: string; createdAt: string; isUnitTracked: boolean;
    unitsProduced: number; unitsAvailable: number; unitsReserved: number; unitsFree: number;
    quantityKg: number; availableQty: number; reservedQty: number; actualContentGrams: number | null; nominalContentGrams: number | null;
    fromBatchKg: number; product: { productNameEn: string; productNameAr: string | null };
    sku: { skuCode: string; name: string | null; nameAr: string | null; weightGrams: number } | null; reservedFor: number[];
  };
  purchase: { date: string; supplier: string; quantity: number; costPerUnit: number; totalCost: number } | null;
  greenLot: { serialNumber: string; beanType: string; beanTypeAr: string | null; process: string | null; processAr: string | null; location: string | null; quantityKg: number; receivedDate: string } | null;
  batch: { batchNumber: string; date: string; status: string; greenKg: number; roastedKg: number; roastProfile: string | null; qc: { date: string; decision: string; by: string | null }[] } | null;
  gramsFlow: { roastedKg: number; packedKg: number; lossKg: number; blendedKg: number; unpackedKg: number; gapKg: number; roastLossPct: number | null; packedBySku: { skuCode: string; weightGrams: number; kg: number; partialKg: number; grams: number }[] } | null;
  orders: { id: string; status: string; units: number | null; kg: number; createdAt: string; order: { number: number; status: string; customer: string; customerAr: string | null }; deliveredUnits: number; deliveryStatus: string; lastDelivery: string | null }[];
  events: { at: string; kind: string; text: Record<string, string | number | null>; by: string | null }[];
};

const LOT_STATUS: Record<string, [string, "success" | "warning" | "neutral", string]> = {
  AVAILABLE: ["متاح", "success", "Available"], RESERVED: ["محجوز", "warning", "Reserved"], SHIPPED: ["مشحون", "neutral", "Shipped"], PARTIAL: ["عبوة جزئية", "warning", "Partial"],
};
const ALLOC: Record<string, [string, "warning" | "success" | "neutral", string]> = {
  RESERVED: ["محجوز", "warning", "Reserved"], CONSUMED: ["سُلِّم", "success", "Delivered"], RELEASED: ["أُلغي الحجز", "neutral", "Released"],
};

export default function LotTracePage() {
  const { id } = useParams<{ id: string }>();
  const { lang } = useI18n();
  const L = useL();
  const [t, setT] = useState<Trace | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let off = false;
    fetch(`/api/inventory/lots/${encodeURIComponent(id)}/trace`).then(async (r) => {
      if (off) return;
      if (r.ok) setT(await r.json());
      else setError(((await r.json().catch(() => ({}))) as { error?: string }).error ?? L("تعذّر تحميل اللوت.", "Could not load the lot."));
    });
    return () => { off = true; };
  }, [id, L]);

  const ar = lang === "ar";
  const kgU = ar ? "كغ" : "kg";
  const sar = ar ? "ر.س" : "SAR";
  const disp = (en: string | null | undefined, a: string | null | undefined) => (ar && a ? a : en ?? "—");
  const size = (g: number) => (g >= 1000 ? `${g / 1000} ${kgU}` : `${g} ${ar ? "غ" : "g"}`);
  const when = (d: string) => `${opsDate(d, lang)} ${timeOf(d)}`;
  /** «#1042» kept left-to-right inside Arabic text (LRI … PDI), as the frames draw it. */
  const ord = (n: number | string | null | undefined) => `\u2066#${n ?? "—"}\u2069`;

  if (error) return <OpsRoot><div className="hr-page"><Notice tone="danger">{error}</Notice><Link className="ops-link" href="/dashboard/inventory?tab=finished">{L("المخزون التام", "Finished stock")}</Link></div></OpsRoot>;
  if (!t) return <OpsRoot><div className="hr-page"><OpsLoading /></div></OpsRoot>;

  const { lot, batch, gramsFlow: g } = t;
  const unit = lot.sku ? size(lot.sku.weightGrams) : null;
  const title = lot.sku ? disp(lot.sku.name, lot.sku.nameAr) : disp(lot.product.productNameEn, lot.product.productNameAr);
  const reservedOrders = lot.reservedFor.map((n) => ord(n)).join("، ");
  const delivered = t.orders.reduce((a, o) => a + (o.status === "CONSUMED" ? o.units ?? 0 : 0), 0);
  const firstOrder = t.orders.find((o) => o.status !== "RELEASED") ?? null;

  const evText = (e: Trace["events"][number]) => {
    const x = e.text;
    switch (e.kind) {
      case "RESERVED": return ar ? `حُجزت ${x.units ?? kg(x.kg as number)} ${x.units ? "وحدات" : kgU} للطلب ${ord(x.order)}` : `${x.units ?? kg(x.kg as number)} ${x.units ? "units" : kgU} reserved for order #${x.order}`;
      case "RELEASED": return ar ? `أُلغي حجز ${x.units ?? ""} للطلب ${ord(x.order)}` : `Reservation for order #${x.order} released`;
      case "DELIVERED": return ar ? `سُلِّم ${kg(x.kg as number)} ${kgU}${x.note ? ` · ${x.note}` : ""}` : `Delivered ${kg(x.kg as number)} ${kgU}${x.note ? ` · ${x.note}` : ""}`;
      case "PACKED": return ar ? `تعبئة ${x.units ?? "—"} × ${unit ?? ""}${x.sku ? ` · ${x.sku}` : ""}` : `Packed ${x.units ?? "—"} × ${unit ?? ""}${x.sku ? ` · ${x.sku}` : ""}`;
      case "QC": return ar ? `قرار الجودة للدفعة ${x.batch}: ${x.decision === "Accept" ? "قبول" : "رفض"}` : `QC decision for batch ${x.batch}: ${x.decision}`;
      case "ROASTED": return ar ? `دفعة تحميص ${x.batch} · صرف ${kg(x.greenKg as number)} ${kgU} من ${x.serial ?? "—"}` : `Roast ${x.batch} · ${kg(x.greenKg as number)} ${kgU} drawn from ${x.serial ?? "—"}`;
      case "PURCHASED": return ar ? `شراء ${kg(x.kg as number)} ${kgU} من ${x.supplier}` : `Bought ${kg(x.kg as number)} ${kgU} from ${x.supplier}`;
      default: return e.kind;
    }
  };

  const pct = (v: number) => (g && g.roastedKg > 0 ? `${Math.max(0, (v / g.roastedKg) * 100)}%` : "0%");

  return (
    <OpsRoot className="stk-lottrace">
      <div className="hr-page">
        <PageHeader title={unit && !title.includes(unit) ? `${title} · ${unit}` : title}>
          {lot.sku ? <span className="hr-caption hr-id">{lot.sku.skuCode}</span> : null}
          <span className="hr-caption">
            {L("لوت", "Lot")} <span className="hr-id">{lot.batchNumber}</span> · {L("عُبّئ", "packed")} {when(lot.createdAt)} · <StatusDot map={LOT_STATUS} value={lot.unitsReserved > 0 && lot.status === "AVAILABLE" ? "RESERVED" : LOT_STATUS[lot.status] ? lot.status : "AVAILABLE"} />
          </span>
        </PageHeader>

        <div className="stk-metrics">
          <div>
            <span className="stk-lbl">{lot.isUnitTracked ? L("وحدات منتجة", "Units produced") : L("الكمية · كغ", "Quantity · kg")}</span>
            <span className="stk-mid">{lot.isUnitTracked ? lot.unitsProduced : kg(lot.quantityKg)}</span>
            <span className="stk-d">{unit ? `${unit} ${L("للوحدة", "per unit")}` : "—"}</span>
          </div>
          <div>
            <span className="stk-lbl">{L("محجوزة", "Reserved")}</span>
            <span className="stk-mid">{lot.isUnitTracked ? lot.unitsReserved : kg(lot.reservedQty)}</span>
            <span className="stk-d">{reservedOrders ? `${L("للطلب", "for order")} ${reservedOrders}` : L("لا حجوزات", "No reservations")}</span>
          </div>
          <div>
            <span className="stk-lbl">{L("حرة", "Free")}</span>
            <span className="stk-mid">{lot.isUnitTracked ? lot.unitsFree : kg(Math.max(0, lot.availableQty - lot.reservedQty))}</span>
            <span className="stk-d">{delivered ? `${L("سُلِّم", "delivered")} ${delivered}` : L("لم يُسلَّم شيء بعد", "Nothing delivered yet")}</span>
          </div>
          <div>
            <span className="stk-lbl">{L("من الدفعة", "From the batch")}</span>
            <span className="stk-mid">{batch ? kg(lot.fromBatchKg) : "—"}{batch ? <span className="stk-unit">{kgU}</span> : null}</span>
            <span className="stk-d">{batch ? `${L("من", "of")} ${kg(batch.roastedKg)} ${kgU} ${L("محمص", "roasted")}` : L("لا دفعة مرتبطة", "No linked batch")}</span>
          </div>
        </div>

        <div className="ops-sechead" style={{ marginTop: 12 }}>
          <h2>{L("سلسلة التتبع", "Traceability chain")}</h2>
          <p className="hr-caption">{L("من المورد إلى الطلب", "From the supplier to the order")}</p>
        </div>
        <ol className="ops-stages stk-chain" aria-label={L("سلسلة التتبع", "Traceability chain")}>
          <li className={t.purchase ? "is-done" : "is-pending"}>
            <span className="ops-stage-title">{L("الشراء", "Purchase")}</span>
            {t.purchase ? <>
              <span className="ops-stage-a">{opsDate(t.purchase.date, lang)}</span>
              <span className="ops-stage-b">{t.purchase.supplier}</span>
              <span className="ops-stage-c"><bdi>{kg(t.purchase.quantity)} {kgU} × {kg(t.purchase.costPerUnit)} {sar}</bdi></span>
            </> : <span className="ops-stage-b">{t.greenLot ? L("رصيد افتتاحي · لا فاتورة شراء", "Opening balance · no purchase record") : "—"}</span>}
          </li>
          <li className={t.greenLot ? "is-done" : "is-pending"}>
            <span className="ops-stage-title">{L("اللوت الأخضر", "Green lot")}</span>
            {t.greenLot ? <>
              <span className="ops-stage-a hr-id">{t.greenLot.serialNumber}</span>
              <span className="ops-stage-b">{disp(t.greenLot.beanType, t.greenLot.beanTypeAr)}{t.greenLot.process ? ` · ${disp(t.greenLot.process, t.greenLot.processAr)}` : ""}</span>
              <span className="ops-stage-c">{L("المتبقي", "Remaining")} {kg(t.greenLot.quantityKg)} {kgU}{t.greenLot.location ? ` · ${L("رف", "shelf")} ${t.greenLot.location}` : ""}</span>
            </> : <span className="ops-stage-b">—</span>}
          </li>
          <li className={batch ? "is-done" : "is-pending"}>
            <span className="ops-stage-title">{L("دفعة التحميص", "Roasting batch")}</span>
            {batch ? <>
              <span className="ops-stage-a hr-id">{batch.batchNumber}</span>
              <span className="ops-stage-b">{ar ? `${kg(batch.greenKg)} ← ${kg(batch.roastedKg)} ${kgU}` : `${kg(batch.greenKg)} → ${kg(batch.roastedKg)} ${kgU}`}{g?.roastLossPct != null ? ` · ${L("فقد", "loss")} ${g.roastLossPct}%` : ""}</span>
              <span className="ops-stage-c">{batch.qc.length ? `${L("الجودة", "QC")}: ${batch.qc[batch.qc.length - 1].decision === "Accept" ? L("قبول", "accepted") : L("رفض", "rejected")}` : `${L("الجودة", "QC")}: —`}</span>
            </> : <span className="ops-stage-b">—</span>}
          </li>
          <li className="is-done">
            <span className="ops-stage-title">{L("لوت التعبئة", "Packaging lot")}</span>
            <span className="ops-stage-a hr-id">{lot.batchNumber}</span>
            <span className="ops-stage-b">{lot.isUnitTracked ? <bdi>{lot.unitsProduced} × {unit ?? ""}{lot.sku ? ` · ${lot.sku.skuCode}` : ""}</bdi> : `${kg(lot.quantityKg)} ${kgU}`}</span>
            <span className="ops-stage-c">{when(lot.createdAt)}</span>
          </li>
          <li className={firstOrder ? (firstOrder.status === "CONSUMED" ? "is-done" : "is-current") : "is-pending"}>
            <span className="ops-stage-title">{L("الطلب", "Order")}</span>
            {firstOrder ? <>
              <span className="ops-stage-a">#{firstOrder.order.number}</span>
              <span className="ops-stage-b">{disp(firstOrder.order.customer, firstOrder.order.customerAr)}</span>
              <span className="ops-stage-c">{firstOrder.units ?? kg(firstOrder.kg)} {firstOrder.units ? L("وحدات", "units") : kgU} {firstOrder.status === "CONSUMED" ? L("مسلّمة", "delivered") : L("محجوزة", "reserved")}</span>
            </> : <span className="ops-stage-b">{L("لم يُحجز بعد", "Not reserved yet")}</span>}
          </li>
        </ol>

        <div className="stk-trace-grid">
          <div className="hr-stack">
            {g && batch ? (
              <section aria-label={L("إلى أين ذهب كل غرام", "Where every gram went")}>
                <div className="ops-sechead">
                  <h2>{L("إلى أين ذهب كل غرام", "Where every gram went")}</h2>
                  <p className="hr-caption">{L("الدفعة", "Batch")} <span className="hr-id">{batch.batchNumber}</span></p>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
                  <span><span className="stk-big">{kg(g.roastedKg)}</span> <span className="hr-caption">{kgU} {L("محمص", "roasted")}</span></span>
                  <span className={`stk-match${Math.abs(g.gapKg) >= 0.001 ? " is-gap" : ""}`}>{Math.abs(g.gapKg) < 0.001 ? `✓ ${L("مطابقة كاملة", "Fully reconciled")}` : `${L("فرق غير مفسَّر", "Unexplained")} ${kg(g.gapKg, 3)} ${kgU}`}</span>
                </div>
                <div className="stk-grams" role="img" aria-label={L("توزيع الدفعة", "Batch breakdown")}>
                  <i className="stk-g-packed" style={{ width: pct(g.packedKg) }} />
                  <i className="stk-g-loss" style={{ width: pct(g.lossKg) }} />
                  <i className="stk-g-blend" style={{ width: pct(g.blendedKg) }} />
                  <i className="stk-g-unpacked" style={{ width: pct(g.unpackedKg) }} />
                </div>
                <ul className="stk-glegend">
                  <li>
                    <span><i className="stk-g-packed" /><span>{L("عبوات", "Packages")}<span className="stk-gsub">{g.packedBySku.length ? g.packedBySku.map((p, i) => (
                      <span key={p.skuCode} className="hr-nowrap">{i ? " · " : ""}{Math.round(p.grams / p.weightGrams)} × {size(p.weightGrams)}{p.partialKg ? ` (+${kg(p.partialKg)} ${kgU} ${L("جزئية", "partial")})` : ""}</span>
                    )) : "—"}</span></span></span>
                    <bdi className="hr-num">{kg(g.packedKg)} {kgU}</bdi>
                  </li>
                  <li><span><i className="stk-g-loss" /><span>{L("فاقد مُعلن", "Declared loss")}<span className="stk-gsub">{L("أثناء التفريغ", "while packing")}</span></span></span><bdi className="hr-num">{kg(g.lossKg)} {kgU}</bdi></li>
                  {g.blendedKg ? <li><span><i className="stk-g-blend" /><span>{L("إلى خلطة", "Into a blend")}</span></span><bdi className="hr-num">{kg(g.blendedKg)} {kgU}</bdi></li> : null}
                  <li><span><i className="stk-g-unpacked" /><span>{L("غير معبأ", "Not packed")}<span className="stk-gsub">{L("في الدفعة", "in the batch")}</span></span></span><bdi className="hr-num">{kg(g.unpackedKg)} {kgU}</bdi></li>
                </ul>
              </section>
            ) : null}

            <section aria-label={L("الحجوزات والتسليم", "Reservations and delivery")}>
              <div className="ops-sechead"><h2>{L("الحجوزات والتسليم", "Reservations and delivery")}</h2></div>
              {t.orders.length === 0 ? <p className="hr-caption">{L("لا حجوزات على هذا اللوت.", "No reservation on this lot.")}</p> : (
                <div className="hr-tablewrap">
                  <table className="hr-table is-mrow">
                    <thead><tr><th>{L("الطلب", "Order")}</th><th>{L("العميل", "Customer")}</th><th className="num">{L("وحدات", "Units")}</th><th>{L("الحالة", "Status")}</th><th>{L("التسليم", "Delivery")}</th></tr></thead>
                    <tbody>
                      {t.orders.map((o) => (
                        <tr key={o.id}>
                          <td><span className="hr-num">#{o.order.number}</span></td>
                          <td className="m-title"><span className="strong">{disp(o.order.customer, o.order.customerAr)}</span><span className="hr-msub">#{o.order.number} · {o.units ?? kg(o.kg)} {o.units ? L("وحدات", "units") : kgU}</span></td>
                          <td className="num"><span className="hr-num">{o.units ?? kg(o.kg)}</span></td>
                          <td className="m-end"><StatusDot map={ALLOC} value={ALLOC[o.status] ? o.status : "RESERVED"} /></td>
                          <td className="hr-caption">{o.lastDelivery ? opsDate(o.lastDelivery, lang) : L("لم يُسلَّم", "Not delivered")}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>

          <section aria-label={L("سجل اللوت", "Lot log")}>
            <div className="ops-sechead"><h2 style={{ fontSize: 14 }}>{L("سجل اللوت", "Lot log")}</h2></div>
            <Timeline items={t.events.map((e, i) => ({ key: `${e.kind}-${i}`, text: evText(e), when: `${when(e.at)}${e.by ? ` · ${e.by}` : ""}`, tone: e.kind === "DELIVERED" ? "success" as const : undefined }))} />
          </section>
        </div>
      </div>
    </OpsRoot>
  );
}
