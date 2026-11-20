"use client";
// «مفوتر غير مسلّم / مسلّم غير مفوتر» — read-only. Revenue is posted when an invoice is issued and the cost of sales when
// goods are delivered; this lists the order lines where only one of the two has happened, as of a day, with the
// amount that IS in the books for the difference. It measures the difference; it does not correct it.
import Link from "next/link";
import { OpsLoading } from "@/components/ops/ui";
import { money, useApi, useLang } from "./shell";

type Row = { orderId: string; orderNumber: number; orderItemId: string; customerName: string; item: string; skuCode: string | null; unit: "UNIT" | "KG"; ordered: string; delivered: string; invoiced: string; creditedNet: string; deliveredBefore: string; invoicedBefore: string; gap: string; side: "DELIVERED_NOT_INVOICED" | "INVOICED_NOT_DELIVERED"; amount: string; lastDelivery: string | null; lastInvoice: string | null; straddlesGoLive: boolean; unitMismatch: boolean };
type QC = { orderId: string; orderNumber: number; orderItemId: string; customerName: string; item: string; skuCode: string | null; unit: "UNIT" | "KG"; notes: string[]; creditedQty: string; creditedNet: string; invoiced: string; delivered: string; costStillInBooks: string };
type Gaps = { asOf: string; goLive: string | null; beforeGoLive: number; straddling: number; quantityCredits: QC[]; rows: Row[]; totals: { deliveredNotInvoiced: { lines: number; costInBooks: string }; invoicedNotDelivered: { lines: number; revenueInBooks: string }; unitMismatch: number }; unlinkedInvoices: { lines: number; net: string } };

export function DeliveryInvoiceGaps({ asOf }: { asOf: string }) {
  const { L } = useLang();
  const g = useApi<Gaps>(`/api/accounting/delivery-invoice-gaps?to=${asOf}`);
  if (g.error) return <p role="alert" className="hr-err">{g.error}</p>;
  if (!g.data) return <OpsLoading />;
  const d = g.data;
  const unit = (r: { unit: "UNIT" | "KG" }) => (r.unit === "UNIT" ? L("حبة", "unit") : L("كجم", "kg"));
  const table = (side: Row["side"], amountHead: string, testId: string) => {
    const rows = d.rows.filter((r) => r.side === side && !r.unitMismatch);
    return rows.length === 0 ? <p className="acct-hint" data-testid={`${testId}-empty`}>{L("لا يوجد.", "None.")}</p> : (
      <div className="hr-tablewrap">
        <table className="hr-table is-dense" data-testid={testId}>
          <thead><tr><th>{L("الطلب", "Order")}</th><th>{L("العميل", "Customer")}</th><th>{L("الصنف", "Item")}</th><th className="num">{L("المطلوب", "Ordered")}</th><th className="num">{L("المسلَّم", "Delivered")}</th><th className="num">{L("المفوتر", "Invoiced")}</th><th className="num acct-hide-m">{L("إشعارات دائنة (مبلغ)", "Credit notes (amount)")}</th><th className="num">{L("الفرق", "Difference")}</th><th className="num">{amountHead}</th><th className="acct-hide-m">{L("آخر تسليم", "Last delivery")}</th><th className="acct-hide-m">{L("آخر فاتورة", "Last invoice")}</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.orderItemId}>
                <td><Link href={`/dashboard/orders?focus=${encodeURIComponent(r.orderId)}`}>{r.orderNumber}</Link></td>
                <td>{r.customerName}</td>
                <td>{r.item}{r.skuCode ? <span className="acct-code"> {r.skuCode}</span> : null}{r.straddlesGoLive ? <div className="acct-hint" data-testid="gaps-straddle">{L(`قبل بدء المحاسبة: مسلَّم ${r.deliveredBefore}، مفوتر ${r.invoicedBefore} — داخلة في الكميات، وليست في المبلغ`, `Before go-live: delivered ${r.deliveredBefore}, invoiced ${r.invoicedBefore} — counted in the quantities, not in the amount`)}</div> : null}</td>
                <td className="num hr-num">{r.ordered}</td><td className="num hr-num">{r.delivered}</td><td className="num hr-num">{r.invoiced}</td><td className="num hr-num acct-hide-m">{money(r.creditedNet, true)}</td>
                <td className="num hr-num">{r.gap.replace("-", "")} {unit(r)}</td><td className="num hr-num">{money(r.amount)}</td>
                <td className="hr-num acct-hide-m">{r.lastDelivery ?? "—"}</td><td className="hr-num acct-hide-m">{r.lastInvoice ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };
  return (
    <>
      <p className="acct-hint">{L(`كما في ${d.asOf}. الإيراد يُثبت عند إصدار الفاتورة، وتكلفة المبيعات عند التسليم. هذا التقرير يعرض بنود الطلبات التي حدث فيها أحد الحدثين دون الآخر، بالكمية والمبلغ المثبت في الدفاتر. يقيس الفرق ولا يعالجه.`, `As of ${d.asOf}. Revenue is posted when the invoice is issued, the cost of sales when goods are delivered. This lists the order lines where only one of the two has happened, with the quantity and the amount in the books. It measures the difference; it does not correct it.`)}</p>
      <h3 className="acct-h3">{L(`مسلَّم غير مفوتر · ${d.totals.deliveredNotInvoiced.lines} بندًا · تكلفة مثبتة بلا إيراد ${money(d.totals.deliveredNotInvoiced.costInBooks)}`, `Delivered, not invoiced · ${d.totals.deliveredNotInvoiced.lines} lines · cost in the books with no revenue ${money(d.totals.deliveredNotInvoiced.costInBooks)}`)}</h3>
      {table("DELIVERED_NOT_INVOICED", L("تكلفة مثبتة", "Cost in the books"), "gaps-delivered")}
      <h3 className="acct-h3">{L(`مفوتر غير مسلَّم · ${d.totals.invoicedNotDelivered.lines} بندًا · إيراد مثبت بلا تكلفة ${money(d.totals.invoicedNotDelivered.revenueInBooks)}`, `Invoiced, not delivered · ${d.totals.invoicedNotDelivered.lines} lines · revenue in the books with no cost ${money(d.totals.invoicedNotDelivered.revenueInBooks)}`)}</h3>
      {table("INVOICED_NOT_DELIVERED", L("إيراد مثبت (قبل الضريبة)", "Revenue in the books (net)"), "gaps-invoiced")}
      {d.totals.unitMismatch ? <p className="acct-hint" data-testid="gaps-mismatch">{L(`${d.totals.unitMismatch} بندًا فُوتر بوحدة غير وحدة الطلب (حبة مقابل كجم): لا تُقارن كمياته هنا.`, `${d.totals.unitMismatch} lines were invoiced in another unit than the order's (unit vs kg): their quantities are not compared here.`)}</p> : null}
      <h3 className="acct-h3">{L(`إشعارات دائنة مرتبطة بكميات · ${d.quantityCredits.length} بندًا`, `Credit notes about quantities · ${d.quantityCredits.length} lines`)}</h3>
      <p className="acct-hint">{L("إشعار دائن سببه «إرجاع بضاعة» أو «إلغاء التوريد». يخفّض مبلغ الإيراد فقط: لم يُسجَّل استلام مرتجع ولم تُعكس تكلفة، فالكميات في الجدولين أعلاه لا تتغير به، وتكلفة ما سُلّم من هذه الكمية باقية في تكلفة المبيعات. إشعارات تعديل السعر والخصم تظهر مبلغًا فقط في عمود «إشعارات دائنة».", "A credit note whose reason is «goods returned» or «supply cancelled». It reduces the revenue amount only: no return receipt was recorded and no cost was reversed, so the quantities in the two tables above do not change, and the cost of what was delivered of this quantity stays in cost of sales. Price-adjustment and discount notes show as an amount only, in the «credit notes» column.")}</p>
      {d.quantityCredits.length === 0 ? <p className="acct-hint" data-testid="gaps-qc-empty">{L("لا يوجد.", "None.")}</p> : (
        <div className="hr-tablewrap">
          <table className="hr-table is-dense" data-testid="gaps-qc">
            <thead><tr><th>{L("الطلب", "Order")}</th><th>{L("العميل", "Customer")}</th><th>{L("الصنف", "Item")}</th><th>{L("الإشعار", "Note")}</th><th className="num">{L("كمية الإشعار", "Credited quantity")}</th><th className="num">{L("مبلغ الإشعار (قبل الضريبة)", "Credited amount (net)")}</th><th className="num">{L("المفوتر", "Invoiced")}</th><th className="num">{L("المسلَّم", "Delivered")}</th><th className="num">{L("تكلفة باقية في الدفاتر", "Cost still in the books")}</th></tr></thead>
            <tbody>{d.quantityCredits.map((c) => (
              <tr key={c.orderItemId}><td><Link href={`/dashboard/orders?focus=${encodeURIComponent(c.orderId)}`}>{c.orderNumber}</Link></td><td>{c.customerName}</td><td>{c.item}{c.skuCode ? <span className="acct-code"> {c.skuCode}</span> : null}</td><td className="acct-code">{c.notes.join("، ")}</td>
                <td className="num hr-num">{c.creditedQty} {unit(c)}</td><td className="num hr-num">{money(c.creditedNet)}</td><td className="num hr-num">{c.invoiced}</td><td className="num hr-num">{c.delivered}</td><td className="num hr-num">{money(c.costStillInBooks)}</td></tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {d.goLive ? (
        <div role="note" className="acct-card" data-testid="gaps-golive">
          <strong>{L(`تنبيه: ${d.beforeGoLive} بندًا مستبعدًا لأن كل حركته قبل بدء المحاسبة (${d.goLive}).`, `Note: ${d.beforeGoLive} lines are left out because all their activity is older than the accounting go-live (${d.goLive}).`)}</strong>
          <p className="acct-hint">{L(`قبل ذلك التاريخ لم يُرحَّل إيراد ولا تكلفة، فلا يوجد في الدفاتر ما يُقارَن. ${d.straddling} بندًا له حركة قبل التاريخ وبعده: يبقى في الجدولين بكامل كمياته، ويُكتب تحته ما كان قبل التاريخ، والمبلغ يغطي الجزء المرحَّل فقط.`, `Before that date no revenue and no cost were posted, so the books hold nothing to compare. ${d.straddling} lines have activity on both sides of the date: they stay in the tables with all their quantities, what was before the date is written under them, and the amount covers the posted part only.`)}</p>
        </div>
      ) : null}
      <p className="acct-hint" data-testid="gaps-unlinked">{L(`فواتير صادرة غير مرتبطة ببند طلب: ${d.unlinkedInvoices.lines} بندًا بصافي ${money(d.unlinkedInvoices.net)}. لا يمكن مطابقتها بتسليم، فلا تدخل الجدولين.`, `Issued invoice lines that name no order line: ${d.unlinkedInvoices.lines} lines, net ${money(d.unlinkedInvoices.net)}. They cannot be matched to a delivery and are in neither table.`)}</p>
    </>
  );
}
