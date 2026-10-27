"use client";
// A green-coffee lot's page (20261114090000_green_lot_labels): what the QR code on its sack label opens, and where a scan
// of its barcode leads. GET /api/inventory/green-lots/:code (src/lib/services/green-lot-page.ts): the lot, its sacks,
// the receipts it came in on (supplier, supplier invoice no., kg — no price), the roasts drawn from it, its counts and
// the label print history (reprints). «طباعة ملصق» opens the per-sack print dialog.
import { useEffect, useState } from "react";
import Link from "next/link";
import { localizeApiError } from "@/lib/i18n/api-errors";
import { Notice, OpsLoading, OpsRoot, PageHeader, StatusDot, kg, opsDate, useL } from "@/components/ops/ui";
import "@/components/ops/stock.css";
import { useI18n } from "@/lib/i18n/context";
import { PrintLabelButton } from "@/components/print/QuickPrint";
import { timeOf } from "../../_parts/shared";

type Page = {
  lot: {
    id: string; code: string; serialNumber: string; beanType: string; beanTypeAr: string | null; country: string; countryAr: string | null;
    region: string | null; regionAr: string | null; variety: string | null; process: string | null; processAr: string | null; altitude: string | null;
    location: string | null; quantityKg: number; isActive: boolean; receivedDate: string; sackCount: number | null; sackWeightKg: number | null;
  };
  supplier: string | null; invoiceRef: string | null; receivedKg: number | null;
  receipts: { date: string; supplier: string; quantityKg: number; invoiceId: string | null; invoiceNumber: string | null; invoiceRef: string | null }[];
  roasts: { id: string; batchNumber: string; date: string; greenKg: number; status: string; product: { productNameEn: string; productNameAr: string | null } | null }[];
  roastedKg: number;
  counts: { id: string; sessionId: string; number: number; status: string; at: string; systemQty: number; countedQty: number | null; variance: number | null }[];
  prints: { id: string; at: string; by: string | null; labels: number; profile: string | null; language: string | null; sacks: { from: number; to: number; n: number } | null }[];
};

const ACTIVE: Record<string, [string, "success" | "warning" | "neutral", string]> = { on: ["نشط", "success", "Active"], off: ["غير نشط", "neutral", "Inactive"] };
const COUNT: Record<string, [string, "success" | "warning" | "neutral", string]> = { OPEN: ["مفتوح", "warning", "Open"], POSTED: ["مُرحّل", "success", "Posted"], CANCELLED: ["ملغى", "neutral", "Cancelled"] };

export function GreenLotPage({ code }: { code: string }) {
  const { lang } = useI18n();
  const L = useL();
  const [p, setP] = useState<Page | null>(null);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let off = false;
    fetch(`/api/inventory/green-lots/${encodeURIComponent(code)}`, { cache: "no-store" }).then(async (r) => {
      if (off) return;
      if (r.ok) setP(await r.json());
      else setError(localizeApiError(await r.json().catch(() => ({})), lang) ?? L("تعذّر تحميل اللوت.", "Could not load the lot."));
    });
    return () => { off = true; };
  }, [code, tick, lang, L]);

  const ar = lang === "ar";
  const kgU = ar ? "كغ" : "kg";
  const disp = (en: string | null | undefined, a: string | null | undefined) => (ar && a ? a : en ?? "—");
  const when = (d: string) => `${opsDate(d, lang)} ${timeOf(d)}`;

  if (error) return <OpsRoot><div className="hr-page"><Notice tone="danger">{error}</Notice><Link className="ops-link" href="/dashboard/inventory">{L("المخزون", "Inventory")}</Link></div></OpsRoot>;
  if (!p) return <OpsRoot><div className="hr-page"><OpsLoading /></div></OpsRoot>;
  const { lot } = p;
  const name = disp(lot.beanType, lot.beanTypeAr);
  const origin = [disp(lot.country, lot.countryAr), lot.region ? disp(lot.region, lot.regionAr) : null].filter(Boolean).join(ar ? "، " : ", ");
  const label = `${name} · ${lot.serialNumber}`;

  return (
    <OpsRoot className="stk-lottrace">
      <div className="hr-page" data-testid="green-lot-page">
        <PageHeader title={`${name}${lot.process ? ` · ${disp(lot.process, lot.processAr)}` : ""}`} actions={
          <PrintLabelButton template="GREEN_LOT" variant="primary" size="md" testId="green-lot-print" subtitle={label} onPrinted={() => setTick((t) => t + 1)}
            items={[{ kind: "green", greenBeanId: lot.id, label, sacks: { count: lot.sackCount, kg: lot.sackWeightKg }, receivedKg: p.receivedKg }]} />
        }>
          <span className="hr-caption"><bdi dir="ltr" className="hr-id" data-testid="green-lot-code">{lot.code}</bdi> · {L("لوت", "Lot")} <bdi dir="ltr" className="hr-id">{lot.serialNumber}</bdi></span>
          <span className="hr-caption">{origin}{lot.variety ? ` · ${lot.variety}` : ""}{lot.altitude ? <> · <bdi dir="ltr">{lot.altitude}</bdi></> : null}</span>
          <StatusDot map={ACTIVE} value={lot.isActive ? "on" : "off"} />
        </PageHeader>

        <div className="stk-metrics">
          <div>
            <span className="stk-lbl">{L("الرصيد الآن", "Balance now")}</span>
            <span className="stk-mid" data-testid="green-lot-balance">{kg(lot.quantityKg)}<span className="stk-unit">{kgU}</span></span>
            <span className="stk-d">{lot.location ? `${L("رف", "Shelf")} ${lot.location}` : L("بلا موقع مسجل", "No location recorded")}</span>
          </div>
          <div>
            <span className="stk-lbl">{L("المستلم", "Received")}</span>
            <span className="stk-mid">{p.receivedKg === null ? "—" : kg(p.receivedKg)}{p.receivedKg === null ? null : <span className="stk-unit">{kgU}</span>}</span>
            <span className="stk-d">{opsDate(lot.receivedDate, lang)}{p.supplier ? ` · ${p.supplier}` : ""}</span>
          </div>
          <div>
            <span className="stk-lbl">{L("الأكياس", "Sacks")}</span>
            <span className="stk-mid" data-testid="green-lot-sacks">{lot.sackCount ?? "—"}</span>
            <span className="stk-d">{lot.sackCount && lot.sackWeightKg ? <bdi>{lot.sackCount} × {kg(lot.sackWeightKg)} {kgU}</bdi> : L("لم يُسجّل عدد الأكياس", "Sacks not recorded")}</span>
          </div>
          <div>
            <span className="stk-lbl">{L("سُحب للتحميص", "Drawn for roasting")}</span>
            <span className="stk-mid">{kg(p.roastedKg)}<span className="stk-unit">{kgU}</span></span>
            <span className="stk-d">{ar ? `${p.roasts.length} دفعة` : `${p.roasts.length} batches`}</span>
          </div>
        </div>

        <div className="stk-trace-grid">
          <div className="hr-stack">
            <section aria-label={L("الاستلام", "Receipts")}>
              <div className="ops-sechead"><h2>{L("الاستلام", "Receipts")}</h2>{p.invoiceRef ? <p className="hr-caption">{L("فاتورة المورد", "Supplier invoice")} <bdi dir="ltr">{p.invoiceRef}</bdi></p> : null}</div>
              {p.receipts.length === 0 ? <p className="hr-caption">{L("لا استلام مسجل: رصيد افتتاحي.", "No receipt recorded: an opening balance.")}</p> : (
                <div className="hr-tablewrap">
                  <table className="hr-table is-mrow">
                    <thead><tr><th>{L("التاريخ", "Date")}</th><th>{L("المورد", "Supplier")}</th><th>{L("الفاتورة", "Invoice")}</th><th className="num">{L("الكمية · كغ", "Quantity · kg")}</th></tr></thead>
                    <tbody>{p.receipts.map((r, i) => (
                      <tr key={i}>
                        <td className="hr-caption">{opsDate(r.date, lang)}</td>
                        <td className="m-title"><span className="strong">{r.supplier}</span><span className="hr-msub">{opsDate(r.date, lang)}{r.invoiceRef ? <> · <bdi dir="ltr">{r.invoiceRef}</bdi></> : null}</span></td>
                        <td>{r.invoiceId ? <Link className="ops-link" href={`/dashboard/purchases/invoices/${r.invoiceId}`}><bdi dir="ltr">{r.invoiceNumber}</bdi></Link> : "—"}{r.invoiceRef ? <span className="hr-caption"> · <bdi dir="ltr">{r.invoiceRef}</bdi></span> : null}</td>
                        <td className="num m-end"><span className="hr-num">{kg(r.quantityKg)}</span></td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              )}
            </section>

            <section aria-label={L("دفعات التحميص من هذا اللوت", "Roasts drawn from this lot")}>
              <div className="ops-sechead"><h2>{L("دفعات التحميص من هذا اللوت", "Roasts drawn from this lot")}</h2></div>
              {p.roasts.length === 0 ? <p className="hr-caption">{L("لم يُسحب منه بعد.", "Nothing drawn from it yet.")}</p> : (
                <div className="hr-tablewrap">
                  <table className="hr-table is-mrow">
                    <thead><tr><th>{L("الدفعة", "Batch")}</th><th>{L("القهوة", "Coffee")}</th><th>{L("التاريخ", "Date")}</th><th className="num">{L("أخضر · كغ", "Green · kg")}</th></tr></thead>
                    <tbody>{p.roasts.map((b) => (
                      <tr key={b.id}>
                        <td><span className="ops-serial">{b.batchNumber}</span></td>
                        <td className="m-title"><span className="strong">{b.product ? disp(b.product.productNameEn, b.product.productNameAr) : "—"}</span><span className="hr-msub"><span className="ops-serial">{b.batchNumber}</span> · {opsDate(b.date, lang)}</span></td>
                        <td className="hr-caption">{when(b.date)}</td>
                        <td className="num m-end"><span className="hr-num">{kg(b.greenKg)}</span></td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              )}
            </section>

            <section aria-label={L("الجرد", "Counts")}>
              <div className="ops-sechead"><h2>{L("الجرد", "Counts")}</h2></div>
              {p.counts.length === 0 ? <p className="hr-caption">{L("لم يُعدّ في جرد بعد.", "Not in a count yet.")}</p> : (
                <ul className="stk-glegend">{p.counts.map((c) => (
                  <li key={c.id}>
                    <span><Link className="ops-link" href={`/dashboard/inventory?view=counts&count=${c.sessionId}`}>{L("جرد", "Count")} #{c.number}</Link> · <StatusDot map={COUNT} value={c.status} /> · {opsDate(c.at, lang)}</span>
                    <bdi className="hr-num">{c.countedQty === null ? "—" : `${kg(c.countedQty)} ${kgU}`}{c.variance ? ` (${c.variance > 0 ? "+" : ""}${kg(c.variance)})` : ""}</bdi>
                  </li>
                ))}</ul>
              )}
            </section>
          </div>

          <section aria-label={L("سجل الطباعة", "Print history")} data-testid="green-lot-prints">
            <div className="ops-sechead"><h2 style={{ fontSize: 14 }}>{L("سجل طباعة الملصقات", "Label print history")}</h2></div>
            {p.prints.length === 0 ? <p className="hr-caption">{L("لم يُطبع له ملصق بعد.", "No label printed yet.")}</p> : (
              <ul className="stk-glegend">{p.prints.map((j) => (
                <li key={j.id}>
                  <span>{when(j.at)}{j.by ? ` · ${j.by}` : ""}<span className="stk-gsub">{j.sacks ? (ar ? `الأكياس ${j.sacks.from}–${j.sacks.to}` : `sacks ${j.sacks.from}–${j.sacks.to}`) : L("ملصق اللوت", "lot label")}{j.profile ? ` · ${j.profile}` : ""}</span></span>
                  <bdi className="hr-num">{ar ? `${j.labels} ملصق` : `${j.labels} labels`}</bdi>
                </li>
              ))}</ul>
            )}
          </section>
        </div>
      </div>
    </OpsRoot>
  );
}
