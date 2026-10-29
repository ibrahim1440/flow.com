"use client";

// «أوامر التصنيع» for the accountant (Qoyod parity — QOYOD-REF §3.4 / §3.5; owner: production is created by Sales and
// roasted to stock by Production, so this is a READ-ONLY view): each roasting batch as a manufacturing order — date,
// description (green lot → product), state, cost and the posted journal entry — and, opened, Qoyod's «تحركات المخزون»
// (green consumed −, roasted produced +, unit cost, movement value) plus the entry link Qoyod does not show.
// One existing API: GET /api/accounting/inventory/batches (the cost-read gate: accounting, or inventory › valuation).
import Link from "next/link";
import { useMemo, useState } from "react";
import { OpsLoading, Notice } from "@/components/ops/ui";
import { D21Dialog } from "@/components/ui/Dialog";
import { DateRange, FilterCard, ListFooter, ListPageSize, Section, useFilters, usePaging } from "@/components/chrome";
import { AcctShell, money, todayRiyadh, useApi, useLang, type Setup } from "../_ui/shell";

type Row = { id: string; batchNumber: string; date: string; product: string | null; greenLot: string | null; greenKg: string; roastedKg: string; lossKg: string; lossPct: string | null; greenCost: string | null; abnormalCost: string | null; roastedCost: string | null; roastedUnitCost: string | null; greenUnitCost: string | null; posted: boolean; journalEntryId: string | null };
type Batches = { from: string; to: string; rows: Row[]; totals: { greenKg: string; roastedKg: string; greenCost: string; roastedCost: string; abnormalCost: string; lossPct: string | null; roastedUnitCost: string | null } };

export default function ManufacturingOrdersPage() {
  const { L, lang } = useLang();
  const setup = useApi<Setup>("/api/accounting/setup");
  const monthStart = `${todayRiyadh().slice(0, 7)}-01`;
  const f = useFilters({ from: monthStart, to: todayRiyadh(), q: "" });
  const b = useApi<Batches>(`/api/accounting/inventory/batches?from=${f.applied.from || monthStart}&to=${f.applied.to || todayRiyadh()}`);
  const rows = useMemo(() => {
    const q = f.applied.q.trim().toLowerCase();
    return (b.data?.rows ?? []).filter((r) => !q || `${r.batchNumber} ${r.product ?? ""} ${r.greenLot ?? ""}`.toLowerCase().includes(q));
  }, [b.data, f.applied.q]);
  const { pageRows, pager } = usePaging(rows);
  const [open, setOpen] = useState<Row | null>(null);
  const desc = (r: Row) => `${r.greenLot ?? L("بن أخضر", "Green coffee")} → ${r.product ?? L("بن محمص", "Roasted coffee")}`;
  return (
    <AcctShell setup={setup.data} title={L("أوامر التصنيع", "Manufacturing orders")}
      meta={<span className="acct-meta"><span>{L("للعرض فقط · دفعات التحميص المكتملة من الإنتاج", "Read-only · completed roasting batches from Production")}</span><span aria-hidden="true">·</span><span>{L("ريال سعودي", "SAR")}</span></span>}
      actions={<a className="hr-btn" href={`/api/accounting/inventory/batches?from=${f.applied.from || monthStart}&to=${f.applied.to || todayRiyadh()}&format=csv`} data-testid="mo-csv">{L("تصدير", "Export")}</a>}>
      <FilterCard onApply={f.apply} onReset={f.reset} busy={b.loading} testId="mo-filter">
        <DateRange from={f.draft.from} to={f.draft.to} onChange={(r) => f.setDraft({ ...f.draft, ...r })} />
        <div className="qc-field"><span className="qc-label">{L("الدفعة أو المنتج", "Batch or product")}</span>
          <input className="hr-input" value={f.draft.q} onChange={(e) => f.set("q", e.target.value)} data-testid="mo-search" /></div>
      </FilterCard>
      {b.error && !b.data ? <Notice tone="danger">{b.error}</Notice> : !b.data ? <OpsLoading /> : (
        <Section title={L("أوامر التصنيع", "Manufacturing orders")} testId="mo-section">
          <div className="acct-metrics">
            <div className="acct-metric"><span className="k">{L("تكلفة البن الأخضر", "Green cost")}</span><span className="v">{money(b.data.totals.greenCost)}</span><span className="s">{L(`${b.data.totals.greenKg} كغ`, `${b.data.totals.greenKg} kg`)}</span></div>
            <div className="acct-metric"><span className="k">{L("تكلفة المحمص", "Roasted cost")}</span><span className="v">{money(b.data.totals.roastedCost)}</span><span className="s">{L(`${b.data.totals.roastedKg} كغ`, `${b.data.totals.roastedKg} kg`)}</span></div>
            <div className="acct-metric"><span className="k">{L("فاقد غير طبيعي", "Abnormal loss")}</span><span className="v">{money(b.data.totals.abnormalCost)}</span><span className="s">{L(`متوسط الفاقد ${b.data.totals.lossPct ?? "—"}%`, `Average loss ${b.data.totals.lossPct ?? "—"}%`)}</span></div>
          </div>
          <ListPageSize {...pager} />
          <div className="hr-tablewrap">
            <table className="hr-table is-dense is-mrow" data-testid="mo-table">
              <thead><tr><th>{L("التاريخ", "Date")}</th><th>{L("المرجع", "Reference")}</th><th>{L("الوصف", "Description")}</th><th>{L("الحالة", "Status")}</th><th className="num">{L("التكلفة", "Cost")}</th><th className="acct-hide-m">{L("مرجع القيد", "Entry")}</th><th className="acct-hide-m">{L("الخيارات", "Options")}</th></tr></thead>
              <tbody>
                {pageRows.map((r) => (
                  <tr key={r.id} data-testid={`mo-row-${r.batchNumber}`}>
                    <td className="hr-num">{r.date}</td>
                    <td className="m-title"><span className="acct-code">{r.batchNumber}</span><span className="hr-msub">{desc(r)}</span></td>
                    <td><bdi>{desc(r)}</bdi></td>
                    <td><span className="hr-dot tone-success"><span>{L("تمت العملية", "Done")}</span></span></td>
                    <td className="num hr-num m-end">{r.roastedCost ? money(r.roastedCost) : <span className="acct-hint">{L("بلا تكلفة", "uncosted")}</span>}</td>
                    <td className="acct-hide-m">{r.journalEntryId ? <Link className="acct-code" href={`/dashboard/accounting/journals/${r.journalEntryId}`}>{L("القيد", "Entry")}</Link> : <span className="acct-hint">{L("لم يُرحَّل", "not posted")}</span>}</td>
                    <td className="acct-hide-m"><button type="button" className="hr-btn is-sm is-ghost" onClick={() => setOpen(r)} aria-label={L(`عرض ${r.batchNumber}`, `View ${r.batchNumber}`)} data-testid={`mo-open-${r.batchNumber}`}>👁</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ListFooter {...pager} noun={L("أمر تصنيع", "orders")} emptyText={L("لا توجد أي أوامر تصنيع في هذه الفترة", "No manufacturing orders in this range")} />
        </Section>
      )}
      {open ? (
        <D21Dialog lang={lang === "en" ? "en" : "ar"} title={L("تفاصيل أمر التصنيع", "Manufacturing order details")} sub={<><span className="acct-code">{open.batchNumber}</span> · <span className="hr-num">{open.date}</span></>} width={640} onClose={() => setOpen(null)} testId="mo-detail"
          actions={<button type="button" className="hr-btn" onClick={() => setOpen(null)}>{L("إغلاق", "Close")}</button>}>
          <p style={{ marginTop: 0 }}><bdi>{desc(open)}</bdi> · <span className="hr-dot tone-success"><span>{L("تمت العملية", "Done")}</span></span></p>
          <h3 style={{ margin: "8px 0" }}>{L("تحركات المخزون", "Stock movements")}</h3>
          <div className="hr-tablewrap">
            <table className="hr-table is-dense" data-testid="mo-moves">
              <thead><tr><th>{L("المنتج", "Item")}</th><th className="num">{L("الكمية", "Quantity")}</th><th className="num">{L("القيمة المتوسطة", "Unit cost")}</th><th className="num">{L("قيمة الحركة", "Movement value")}</th></tr></thead>
              <tbody>
                <tr><td>{open.greenLot ?? L("بن أخضر", "Green coffee")}</td><td className="num hr-num">−{open.greenKg} {L("كغ", "kg")}</td><td className="num hr-num">{open.greenUnitCost ? Number(open.greenUnitCost).toFixed(4) : "—"}</td><td className="num hr-num">{open.greenCost ? `−${money(open.greenCost)}` : "—"}</td></tr>
                <tr><td>{open.product ?? L("بن محمص", "Roasted coffee")}</td><td className="num hr-num">+{open.roastedKg} {L("كغ", "kg")}</td><td className="num hr-num">{open.roastedUnitCost ? Number(open.roastedUnitCost).toFixed(4) : "—"}</td><td className="num hr-num">{open.roastedCost ? money(open.roastedCost) : "—"}</td></tr>
                {open.abnormalCost && Number(open.abnormalCost) ? <tr><td>{L("فاقد تحميص غير طبيعي (مصروف)", "Abnormal roast loss (expense)")}</td><td className="num hr-num">{open.lossKg} {L("كغ", "kg")}</td><td /><td className="num hr-num acct-bad">{money(open.abnormalCost)}</td></tr> : null}
              </tbody>
            </table>
          </div>
          <p className="acct-hint">{L(`الفاقد ${open.lossKg} كغ (${open.lossPct ?? "—"}%) · تكلفة الكيلو المحمص = (تكلفة الأخضر − الفاقد غير الطبيعي) ÷ الكيلوات المحمصة.`, `Loss ${open.lossKg} kg (${open.lossPct ?? "—"}%) · cost per roasted kg = (green cost − abnormal loss) ÷ roasted kg.`)}</p>
          <p className="acct-hint">{open.journalEntryId ? <Link href={`/dashboard/accounting/journals/${open.journalEntryId}`} data-testid="mo-entry">{L("فتح القيد المرحّل", "Open the posted entry")}</Link> : L("لم يُرحَّل قيد: المحاسبة غير مفعّلة أو الدفعة قبل تاريخ البدء.", "No entry posted: accounting is not active or the batch precedes the go-live date.")}</p>
        </D21Dialog>
      ) : null}
    </AcctShell>
  );
}
