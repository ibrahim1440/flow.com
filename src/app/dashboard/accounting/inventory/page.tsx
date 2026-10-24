"use client";

// «المخزون والتكلفة» (Figma ACC-100 / 100s): the inventory cost ledger against the books. Sections:
//   قيمة المخزون — the per-account reconciliation (cost ledger · GL · difference · status) and the costed items;
//   تكلفة الإنتاج — production cost per roast (green cost, loss, cost per roasted kg);
//   بضاعة لم تصل فاتورتها — the GRNI open items (costed receipts not yet invoiced);
//   المخزون الافتتاحي — the go-live valuation (on hand × owner-entered or last-known cost → the opening grid);
//   السياسة والرواتب — the abnormal-loss threshold and the payroll accounts' alignment.
import Link from "next/link";
import { Suspense, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { OpsLoading, Btn } from "@/components/ops/ui";
import { Dialog } from "@/components/hr/ui";
import { AcctShell, Msg, money, todayRiyadh, useApi, useLang, useWrite, type Setup } from "../_ui/shell";

type RoleKey = "INVENTORY_GREEN" | "INVENTORY_PACKAGING" | "INVENTORY_CAFE" | "INVENTORY_ROASTED" | "INVENTORY_PACKED";
const ROLE_AR: Record<string, [string, string]> = {
  INVENTORY_GREEN: ["البن الأخضر", "Green coffee"], INVENTORY_PACKAGING: ["مواد التغليف", "Packaging"], INVENTORY_CAFE: ["مواد المقهى", "Café consumables"],
  INVENTORY_ROASTED: ["البن المحمص", "Roasted coffee"], INVENTORY_PACKED: ["المنتجات المعبأة", "Packed goods"],
};
const KIND_AR: Record<string, [string, string]> = { GREEN_BEAN: ["لوط أخضر", "Green lot"], MATERIAL: ["مادة", "Material"], ROASTED_BATCH: ["دفعة محمصة", "Roast"], FG_LOT: ["لوط معبأ", "Packed lot"] };
const SOURCE_AR: Record<string, [string, string]> = { OWNER: ["أدخلها المالك", "Owner"], MOVING_AVG: ["المتوسط المرجّح", "Moving average"], LAST_RECEIPT: ["آخر استلام", "Last receipt"], LAST_PURCHASE: ["آخر شراء", "Last purchase"], NONE: ["لا تكلفة معروفة", "No known cost"] };

type Rec = {
  asOf: string; active: boolean; goLiveDate: string | null; openingPosted: boolean; openingAppliedAt: string | null;
  inventory: { role: RoleKey; account: { id: string; code: string; name: string } | null; subLedger: string; gl: string; difference: string; skipped: string; openingPending: string; unexplained: string; status: "MATCHED" | "EXPLAINED" | "UNEXPLAINED" }[];
  totals: { subLedger: string; gl: string; difference: string };
  wip: { account: { code: string; name: string } | null; gl: string };
  grni: { account: { code: string; name: string } | null; openReceipts: string; gl: string; difference: string; count: number };
  ap: { account: { code: string; name: string } | null; openItems: string; gl: string; difference: string };
};
type Val = { asOf: string; total: string; rows: { id: string; kind: string; role: string; label: string; sub: string | null; unit: string; qty: string; opsQty: string | null; avgCost: string; value: string; drift: string | null; uncosted: boolean; exists: boolean }[] };
type Batches = { from: string; to: string; rows: { id: string; batchNumber: string; date: string; product: string | null; greenLot: string | null; greenKg: string; roastedKg: string; lossKg: string; lossPct: string | null; greenCost: string | null; abnormalCost: string | null; roastedCost: string | null; roastedUnitCost: string | null; greenUnitCost: string | null; posted: boolean; journalEntryId: string | null }[]; totals: { greenKg: string; roastedKg: string; greenCost: string; roastedCost: string; abnormalCost: string; lossPct: string | null; roastedUnitCost: string | null } };
type Receipt = { purchaseRecordId: string; supplierName: string; type: string; date: string; quantity: string; value: string; glState: string; notes: string | null };
type Opening = { goLiveDate: string | null; openingPosted: boolean; appliedAt: string | null; total: string; missing: number; byRole: { role: string; value: string; count: number }[]; grni: { count: number; value: string }; rows: { kind: string; entityId: string; label: string; sub: string | null; role: string; unit: string; qty: string; unitCost: string | null; source: string; value: string }[] };
type Policy = { abnormalRoastLossPct: string | null; abnormalUseProductLimit: boolean; updatedAt: string | null };
type Align = { aligned: boolean; hrAccountingEnabled: boolean; rows: { key: string; role: string | null; why: string; hrAccount: { code: string; name: string } | null; roleAccount: { code: string; name: string } | null; status: string }[] };

const VIEWS = [["value", "قيمة المخزون", "Inventory value"], ["batches", "تكلفة الإنتاج", "Production cost"], ["grni", "بضاعة لم تصل فاتورتها", "Received, not invoiced"], ["opening", "المخزون الافتتاحي", "Opening inventory"], ["policy", "السياسة والرواتب", "Policy & payroll"]] as const;

function Inventory() {
  const { L } = useLang();
  const router = useRouter();
  const path = usePathname();
  const sp = useSearchParams();
  const view = (VIEWS.find((v) => v[0] === sp.get("view"))?.[0] ?? "value") as (typeof VIEWS)[number][0];
  const go = (patch: Record<string, string | null>) => {
    const p = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(patch)) { if (v === null || v === "") p.delete(k); else p.set(k, v); }
    router.replace(`${path}?${p}`);
  };
  const setup = useApi<Setup>("/api/accounting/setup");
  const role = (r: string) => L(ROLE_AR[r]?.[0] ?? r, ROLE_AR[r]?.[1] ?? r);
  return (
    <AcctShell setup={setup.data} actions={view === "value" ? <a className="hr-btn" href="/api/accounting/inventory/valuation?format=csv" data-testid="valuation-csv">{L("تصدير CSV", "Export CSV")}</a> : view === "batches" ? <a className="hr-btn" href={`/api/accounting/inventory/batches?format=csv&from=${sp.get("from") ?? ""}&to=${sp.get("to") ?? ""}`}>{L("تصدير CSV", "Export CSV")}</a> : undefined}>
      <div className="acct-row">
        <div className="acct-seg" role="group" aria-label={L("القسم", "Section")}>
          {VIEWS.map(([k, ar, en]) => <button key={k} type="button" aria-pressed={view === k} onClick={() => go({ view: k === "value" ? null : k })} data-testid={`inv-view-${k}`}>{L(ar, en)}</button>)}
        </div>
      </div>
      {view === "value" ? <ValueView role={role} /> : view === "batches" ? <BatchView from={sp.get("from")} to={sp.get("to")} go={go} /> : view === "grni" ? <GrniView /> : view === "opening" ? <OpeningView role={role} canEdit={!!setup.data?.can.opening} /> : <PolicyView canEdit={!!setup.data?.can.settings} />}
    </AcctShell>
  );
}

function Metric({ k, v, s, bad, testId }: { k: string; v: string; s?: string; bad?: boolean; testId?: string }) {
  const { L } = useLang();
  return <div className="acct-metric"><span className="k">{k}</span><span className={`v${bad ? " is-bad" : ""}`} data-testid={testId}>{money(v)} <small className="acct-hint">{L("ر.س", "SAR")}</small></span>{s ? <span className="s">{s}</span> : null}</div>;
}

function ValueView({ role }: { role: (r: string) => string }) {
  const { L } = useLang();
  const rec = useApi<Rec>("/api/accounting/inventory/reconciliation");
  const val = useApi<Val>("/api/accounting/inventory/valuation");
  if (rec.error) return <p role="alert" className="hr-err">{rec.error}</p>;
  if (!rec.data || !val.data) return <OpsLoading />;
  const r = rec.data;
  const st = (s: string) => s === "MATCHED" ? <span className="hr-dot tone-success"><span>{L("مطابق", "Matched")}</span></span> : s === "EXPLAINED" ? <span className="hr-dot tone-info"><span>{L("فرق مفسَّر", "Explained")}</span></span> : <span className="hr-dot tone-warning"><span>{L("غير مسوّى", "Unreconciled")}</span></span>;
  const unexplained = r.inventory.reduce((s, x) => s + Number(x.unexplained), 0);
  return (
    <>
      <div className="acct-metrics" data-testid="inv-metrics">
        <Metric k={L("سجل المخزون · طبقات التكلفة", "Cost ledger")} v={r.totals.subLedger} s={L(`${val.data.rows.length} صنفًا بتكلفة`, `${val.data.rows.length} costed items`)} testId="inv-subledger" />
        <Metric k={L("الدفتر · حسابات المخزون", "General ledger · inventory accounts")} v={r.totals.gl} s={L("أرصدة الحسابات المرحّلة", "Posted account balances")} testId="inv-gl" />
        <Metric k={L("الفرق", "Difference")} v={r.totals.difference} bad={Math.abs(unexplained) > 0.004} s={Math.abs(unexplained) > 0.004 ? L("فيه جزء غير مفسَّر", "Partly unexplained") : L("مفسَّر بالكامل", "Fully explained")} testId="inv-diff" />
        <Metric k={L("إنتاج تحت التشغيل", "WIP – roasting")} v={r.wip.gl} s={L("يجب أن يكون صفرًا", "Should be zero")} bad={Number(r.wip.gl) !== 0} />
      </div>
      <section className="acct-card">
        <h2>{L("الحسابات", "Accounts")} <span className="acct-hint">{L("السجل مقابل الدفتر لكل حساب مخزون، في", "Cost ledger against the books, per inventory account, as of")} <span className="hr-num">{r.asOf}</span></span></h2>
        <div className="hr-tablewrap">
          <table className="hr-table is-dense" data-testid="inv-recon">
            <thead><tr><th>{L("الحساب", "Account")}</th><th className="num">{L("السجل", "Ledger")}</th><th className="num">{L("الدفتر", "Books")}</th><th className="num">{L("الفرق", "Difference")}</th><th className="num acct-hide-m">{L("حركات قبل التفعيل", "Not posted (pre go-live)")}</th><th className="num acct-hide-m">{L("افتتاحي لم يُرحَّل", "Opening not posted")}</th><th>{L("الحالة", "Status")}</th></tr></thead>
            <tbody>
              {r.inventory.map((x) => (
                <tr key={x.role}>
                  <td>{x.account ? <><span className="acct-code">{x.account.code}</span> {x.account.name}</> : <span className="acct-warn">{role(x.role)} · {L("الدور غير مربوط", "role not mapped")}</span>}</td>
                  <td className="num hr-num">{money(x.subLedger)}</td><td className="num hr-num">{money(x.gl)}</td>
                  <td className={`num hr-num${Number(x.difference) ? " acct-bad" : ""}`}>{money(x.difference)}</td>
                  <td className="num hr-num acct-hide-m">{money(x.skipped, true)}</td><td className="num hr-num acct-hide-m">{money(x.openingPending, true)}</td>
                  <td>{st(x.status)}</td>
                </tr>
              ))}
              <tr className="is-total"><td>{L("المجموع", "Total")}</td><td className="num hr-num">{money(r.totals.subLedger)}</td><td className="num hr-num">{money(r.totals.gl)}</td><td className="num hr-num">{money(r.totals.difference)}</td><td className="acct-hide-m" /><td className="acct-hide-m" /><td /></tr>
            </tbody>
          </table>
        </div>
        <div className="acct-cards">
          <div className="acct-card"><h3>{L("بضاعة لم تصل فاتورتها", "Goods received not invoiced")}{r.grni.account ? <span className="acct-code"> {r.grni.account.code}</span> : null}</h3><p className="hr-num">{L("الاستلامات المفتوحة", "Open receipts")} {money(r.grni.openReceipts)} · {L("الدفتر", "Books")} {money(r.grni.gl)} · <b className={Number(r.grni.difference) ? "acct-bad" : "acct-good"}>{L("الفرق", "Difference")} {money(r.grni.difference)}</b></p></div>
          <div className="acct-card"><h3>{L("الذمم الدائنة", "Accounts payable")}{r.ap.account ? <span className="acct-code"> {r.ap.account.code}</span> : null}</h3><p className="hr-num">{L("الفواتير المفتوحة", "Open invoices")} {money(r.ap.openItems)} · {L("الدفتر", "Books")} {money(r.ap.gl)} · <b className={Number(r.ap.difference) ? "acct-bad" : "acct-good"}>{L("الفرق", "Difference")} {money(r.ap.difference)}</b></p></div>
        </div>
        <p className="acct-hint">{L("الحركات قبل تاريخ البدء أو قبل التفعيل تُحدّث سجل التكلفة ولا تُرحَّل؛ يدخل رصيدها الدفتر من خلال المخزون الافتتاحي. الفرق غير المفسَّر يُبحث قبل إقفال الفترة.", "Movements before go-live or activation update the cost ledger without posting; their balance enters the books through the opening inventory. An unexplained difference is investigated before the period is closed.")}</p>
      </section>
      <section className="acct-card">
        <h2>{L("الأصناف", "Items")} <span className="acct-hint">{L("المتوسط المرجّح المتحرك لكل صنف · الكمية التشغيلية مقابل كمية السجل", "Moving weighted average per holder · operational quantity against the ledger's")}</span></h2>
        <div className="hr-tablewrap">
          <table className="hr-table is-dense" data-testid="inv-items">
            <thead><tr><th>{L("الصنف", "Item")}</th><th className="acct-hide-m">{L("النوع", "Kind")}</th><th className="num">{L("السجل", "Ledger qty")}</th><th className="num acct-hide-m">{L("تشغيلي", "Operations")}</th><th className="num">{L("تكلفة الوحدة", "Unit cost")}</th><th className="num">{L("القيمة", "Value")}</th></tr></thead>
            <tbody>
              {val.data.rows.map((x) => (
                <tr key={x.id} className={!x.exists ? "is-muted" : undefined}>
                  <td>{x.label}{x.sub ? <span className="acct-code"> {x.sub}</span> : null}{x.uncosted ? <span className="acct-warn"> · {L("بلا تكلفة", "uncosted")}</span> : null}{x.drift ? <span className="acct-warn"> · {L("فرق كمية", "qty drift")} {x.drift}</span> : null}</td>
                  <td className="acct-hide-m">{L(KIND_AR[x.kind]?.[0] ?? x.kind, KIND_AR[x.kind]?.[1] ?? x.kind)}</td>
                  <td className="num hr-num">{x.qty} {x.unit}</td><td className="num hr-num acct-hide-m">{x.opsQty ?? "—"}</td>
                  <td className="num hr-num">{Number(x.avgCost).toFixed(2)}</td><td className="num hr-num">{money(x.value)}</td>
                </tr>
              ))}
              {!val.data.rows.length ? <tr><td colSpan={6} className="acct-hint">{L("لا أصناف بتكلفة بعد.", "No costed items yet.")}</td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function BatchView({ from, to, go }: { from: string | null; to: string | null; go: (p: Record<string, string | null>) => void }) {
  const { L } = useLang();
  const f = from ?? `${todayRiyadh().slice(0, 7)}-01`;
  const t = to ?? todayRiyadh();
  const b = useApi<Batches>(`/api/accounting/inventory/batches?from=${f}&to=${t}`);
  return (
    <>
      <div className="acct-row">
        <label className="hr-field"><span className="hr-label">{L("من", "From")}</span><input type="date" className="hr-input" value={f} onChange={(e) => e.target.value && go({ from: e.target.value })} /></label>
        <label className="hr-field"><span className="hr-label">{L("إلى", "To")}</span><input type="date" className="hr-input" value={t} onChange={(e) => e.target.value && go({ to: e.target.value })} /></label>
      </div>
      {b.error ? <p role="alert" className="hr-err">{b.error}</p> : !b.data ? <OpsLoading /> : (
        <>
          <div className="acct-metrics">
            <Metric k={L("تكلفة البن الأخضر", "Green cost")} v={b.data.totals.greenCost} s={L(`${b.data.totals.greenKg} كغ أخضر`, `${b.data.totals.greenKg} kg green`)} />
            <Metric k={L("تكلفة المحمص", "Roasted cost")} v={b.data.totals.roastedCost} s={L(`${b.data.totals.roastedKg} كغ محمص`, `${b.data.totals.roastedKg} kg roasted`)} />
            <Metric k={L("فاقد غير طبيعي", "Abnormal loss")} v={b.data.totals.abnormalCost} s={L(`متوسط الفاقد ${b.data.totals.lossPct ?? "—"}%`, `Average loss ${b.data.totals.lossPct ?? "—"}%`)} />
            <div className="acct-metric"><span className="k">{L("تكلفة الكيلو المحمص", "Cost per roasted kg")}</span><span className="v" data-testid="roast-unit-cost">{b.data.totals.roastedUnitCost ? Number(b.data.totals.roastedUnitCost).toFixed(2) : "—"}</span><span className="s">{L("الفاقد الطبيعي محمَّل على التكلفة", "Normal loss absorbed")}</span></div>
          </div>
          <div className="hr-tablewrap">
            <table className="hr-table is-dense" data-testid="batch-costs">
              <thead><tr><th>{L("الدفعة", "Roast")}</th><th className="acct-hide-m">{L("المنتج", "Product")}</th><th className="num">{L("أخضر كغ", "Green kg")}</th><th className="num">{L("محمص كغ", "Roasted kg")}</th><th className="num">{L("الفاقد", "Loss")}</th><th className="num">{L("تكلفة الأخضر", "Green cost")}</th><th className="num acct-hide-m">{L("فاقد غير طبيعي", "Abnormal")}</th><th className="num">{L("تكلفة الكيلو المحمص", "Cost / roasted kg")}</th></tr></thead>
              <tbody>
                {b.data.rows.map((x) => (
                  <tr key={x.id}>
                    <td><span className="acct-code">{x.batchNumber}</span> <span className="acct-hint hr-num">{x.date}</span>{x.journalEntryId ? <> · <Link href={`/dashboard/accounting/journals/${x.journalEntryId}`}>{L("القيد", "Entry")}</Link></> : null}</td>
                    <td className="acct-hide-m">{x.product ?? "—"}</td>
                    <td className="num hr-num">{x.greenKg}</td><td className="num hr-num">{x.roastedKg}</td><td className="num hr-num">{x.lossPct ? `${x.lossPct}%` : "—"}</td>
                    <td className="num hr-num">{x.greenCost ? money(x.greenCost) : <span className="acct-hint">{L("بلا تكلفة", "uncosted")}</span>}</td>
                    <td className="num hr-num acct-hide-m">{x.abnormalCost && Number(x.abnormalCost) ? <span className="acct-bad">{money(x.abnormalCost)}</span> : "—"}</td>
                    <td className="num hr-num">{x.roastedUnitCost ? Number(x.roastedUnitCost).toFixed(2) : "—"}</td>
                  </tr>
                ))}
                {!b.data.rows.length ? <tr><td colSpan={8} className="acct-hint">{L("لا دفعات في هذه الفترة.", "No roasts in this range.")}</td></tr> : null}
              </tbody>
            </table>
          </div>
          <p className="acct-hint">{L("تكلفة الكيلو المحمص = (تكلفة الأخضر − الفاقد غير الطبيعي) ÷ الكيلوات المحمصة. الفاقد فوق الحد الذي يحدده المالك يُحمَّل على مصروف فاقد التحميص.", "Cost per roasted kg = (green cost − abnormal loss) ÷ roasted kg. Loss above the owner's threshold is expensed to abnormal roast loss.")}</p>
        </>
      )}
    </>
  );
}

function GrniView() {
  const { L } = useLang();
  const r = useApi<Receipt[]>("/api/accounting/ap/receipts");
  if (r.error) return <p role="alert" className="hr-err">{r.error}</p>;
  if (!r.data) return <OpsLoading />;
  const total = r.data.reduce((s, x) => s + Number(x.value), 0);
  return (
    <section className="acct-card">
      <h2>{L("بضاعة مستلمة لم تصل فاتورتها", "Goods received, not invoiced")} <span className="acct-hint hr-num">{r.data.length} · {money(total)} {L("ر.س", "SAR")}</span></h2>
      <div className="hr-tablewrap">
        <table className="hr-table is-dense" data-testid="grni-table">
          <thead><tr><th>{L("التاريخ", "Date")}</th><th>{L("المورد", "Supplier")}</th><th className="acct-hide-m">{L("النوع", "Type")}</th><th className="num">{L("الكمية", "Qty")}</th><th className="num">{L("القيمة", "Value")}</th><th>{L("الدفتر", "Books")}</th></tr></thead>
          <tbody>
            {r.data.map((x) => (
              <tr key={x.purchaseRecordId}>
                <td className="hr-num">{x.date}</td><td>{x.supplierName}</td><td className="acct-hide-m">{x.type === "GREEN_BEAN" ? L("بن أخضر", "Green coffee") : L("مواد", "Materials")}</td>
                <td className="num hr-num">{x.quantity}</td><td className="num hr-num">{money(x.value)}</td>
                <td>{x.glState === "POSTED" ? <span className="hr-dot tone-success"><span>{L("مرحّل", "Posted")}</span></span> : <span className="hr-dot tone-neutral"><span>{L("قبل التفعيل", "Pre go-live")}</span></span>}</td>
              </tr>
            ))}
            {!r.data.length ? <tr><td colSpan={6} className="acct-hint">{L("كل الاستلامات مطابقة لفواتير.", "Every receipt is matched to an invoice.")}</td></tr> : null}
          </tbody>
        </table>
      </div>
      <p className="acct-hint">{L("تُطابق على فاتورة المورد كسطر «استلام»؛ الفرق بين قيمة الاستلام والفاتورة فرق سعر يُحمَّل على المخزون ما دام في المخزن.", "Matched on the supplier invoice as a receipt line; the difference between the receipt and the invoice is a price variance capitalised while the stock is on hand.")}</p>
    </section>
  );
}

function OpeningView({ role, canEdit }: { role: (r: string) => string; canEdit: boolean }) {
  const { L } = useLang();
  const op = useApi<Opening>("/api/accounting/inventory/opening");
  const w = useWrite();
  const [costs, setCosts] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState(false);
  if (op.error) return <p role="alert" className="hr-err">{op.error}</p>;
  if (!op.data) return <OpsLoading />;
  const o = op.data;
  const locked = o.openingPosted || !canEdit;
  async function save() {
    const list = Object.entries(costs).map(([k, v]) => { const [kind, entityId] = k.split("|"); return { kind, entityId, unitCost: v.trim() === "" ? null : v.trim() }; });
    if (await w.run("save", "/api/accounting/inventory/opening", "PUT", { costs: list }, L("حُفظت التكاليف.", "Costs saved."))) { setCosts({}); op.reload(); }
  }
  async function apply() {
    if (await w.run("apply", "/api/accounting/inventory/opening/apply", "POST", {}, L("طُبّق التقييم على سجل التكلفة وجدول الأرصدة الافتتاحية.", "Applied to the cost ledger and the opening grid."))) { setConfirm(false); op.reload(); }
  }
  return (
    <>
      <Msg error={w.error} done={w.done} onClose={() => { w.setError(null); w.setDone(null); }} />
      <div className="acct-metrics">
        <Metric k={L("قيمة المخزون الافتتاحي", "Opening inventory value")} v={o.total} s={L(`${o.rows.length} صنفًا على الرف`, `${o.rows.length} items on hand`)} testId="opening-inv-total" />
        {o.byRole.filter((b) => Number(b.value)).map((b) => <Metric key={b.role} k={role(b.role)} v={b.value} s={L(`${b.count} صنفًا`, `${b.count} items`)} />)}
        <div className="acct-metric"><span className="k">{L("بلا تكلفة", "Without a cost")}</span><span className={`v${o.missing ? " is-bad" : ""}`}>{o.missing}</span><span className="s">{L("أدخل تكلفتها قبل التطبيق", "Enter their cost before applying")}</span></div>
      </div>
      <p className="acct-hint">
        {L("الكمية الموجودة الآن × تكلفة يدخلها المالك، وإلا آخر تكلفة معروفة (المتوسط، آخر استلام، آخر شراء). التطبيق يضبط سجل التكلفة ويضيف سطر مخزون لكل حساب في جدول الأرصدة الافتتاحية (وسطر «بضاعة لم تصل فاتورتها» لكل مورد) — دون ترحيل أي حركة سابقة. يُعاد التطبيق حتى تُرحَّل الأرصدة الافتتاحية.", "On hand now × the owner's cost, else the last known cost (moving average, last receipt, last purchase). Applying sets the cost ledger and adds one inventory line per account to the opening grid (and a GRNI line per supplier) — no past movement is posted. Repeatable until the opening is posted.")}
        {" "}{L("تاريخ البدء", "Go-live")}: <span className="hr-num">{o.goLiveDate ?? "—"}</span>{o.appliedAt ? <> · {L("آخر تطبيق", "Last applied")} <span className="hr-num">{o.appliedAt.slice(0, 16).replace("T", " ")}</span></> : null}
        {o.grni.count ? <> · {L("بضاعة لم تصل فاتورتها قبل التفعيل", "Pre go-live GRNI")} {o.grni.count} ({money(o.grni.value)})</> : null}
      </p>
      <div className="hr-tablewrap">
        <table className="hr-table is-dense acct-lines" data-testid="opening-inv-table">
          <thead><tr><th>{L("الصنف", "Item")}</th><th className="acct-hide-m">{L("الحساب", "Account")}</th><th className="num">{L("الكمية", "Qty")}</th><th className="num">{L("تكلفة الوحدة", "Unit cost")}</th><th className="acct-hide-m">{L("المصدر", "Source")}</th><th className="num">{L("القيمة", "Value")}</th></tr></thead>
          <tbody>
            {o.rows.map((x) => {
              const k = `${x.kind}|${x.entityId}`;
              return (
                <tr key={k}>
                  <td>{x.label}{x.sub ? <span className="acct-code"> {x.sub}</span> : null}</td>
                  <td className="acct-hide-m">{role(x.role)}</td>
                  <td className="num hr-num">{x.qty} {x.unit}</td>
                  <td className="num">{locked ? <span className="hr-num">{x.unitCost ? Number(x.unitCost).toFixed(4) : "—"}</span> : <input className="hr-input acct-amount" inputMode="decimal" style={{ width: 110 }} value={costs[k] ?? (x.source === "OWNER" ? x.unitCost ?? "" : "")} placeholder={x.unitCost ? Number(x.unitCost).toFixed(4) : L("أدخل", "Enter")} onChange={(e) => setCosts({ ...costs, [k]: e.target.value })} aria-label={L("تكلفة الوحدة", "Unit cost")} />}</td>
                  <td className="acct-hide-m">{x.source === "NONE" ? <span className="acct-warn">{L(SOURCE_AR.NONE[0], SOURCE_AR.NONE[1])}</span> : L(SOURCE_AR[x.source]?.[0] ?? x.source, SOURCE_AR[x.source]?.[1] ?? x.source)}</td>
                  <td className="num hr-num">{money(x.value)}</td>
                </tr>
              );
            })}
            {!o.rows.length ? <tr><td colSpan={6} className="acct-hint">{L("لا مخزون على الرف.", "Nothing on hand.")}</td></tr> : null}
          </tbody>
        </table>
      </div>
      {locked ? (o.openingPosted ? <p className="acct-hint">{L("رُحّلت الأرصدة الافتتاحية؛ التقييم الافتتاحي نهائي.", "The opening balances are posted; the opening valuation is final.")}</p> : null) : (
        <div className="acct-actions">
          <Btn onClick={save} busy={w.busy === "save"} disabled={!Object.keys(costs).length} data-testid="opening-inv-save">{L("حفظ التكاليف", "Save costs")}</Btn>
          <Btn variant="primary" onClick={() => setConfirm(true)} data-testid="opening-inv-apply">{L("تطبيق على الأرصدة الافتتاحية", "Apply to the opening balances")}</Btn>
          <Link className="hr-btn is-ghost" href="/dashboard/accounting/opening">{L("فتح جدول الأرصدة الافتتاحية", "Open the opening grid")}</Link>
        </div>
      )}
      <Dialog open={confirm} title={L("تطبيق المخزون الافتتاحي", "Apply the opening inventory")} onClose={() => setConfirm(false)}
        actions={<><Btn onClick={() => setConfirm(false)}>{L("إلغاء", "Cancel")}</Btn><Btn variant="primary" busy={w.busy === "apply"} onClick={apply} data-testid="opening-inv-confirm">{L("تطبيق", "Apply")}</Btn></>}>
        <p>{L(`يضبط سجل التكلفة على ${money(o.total)} ر.س، ويستبدل أسطر المخزون في جدول الأرصدة الافتتاحية. أسطر الجدول الأخرى تبقى كما هي.`, `Sets the cost ledger to SAR ${money(o.total)} and replaces the inventory lines of the opening grid. The other lines stay as they are.`)}</p>
        {o.missing ? <p className="acct-warn">{L(`${o.missing} صنفًا بلا تكلفة سيُقيَّم بصفر.`, `${o.missing} items without a cost will be valued at zero.`)}</p> : null}
      </Dialog>
    </>
  );
}

function PolicyView({ canEdit }: { canEdit: boolean }) {
  const { L } = useLang();
  const pol = useApi<Policy>("/api/accounting/inventory/settings");
  const al = useApi<Align>("/api/accounting/payroll-alignment");
  const w = useWrite();
  const [pct, setPct] = useState<string | null>(null);
  const [useProduct, setUseProduct] = useState<boolean | null>(null);
  const status = (s: string) => s === "ALIGNED" ? <span className="hr-dot tone-success"><span>{L("مطابق", "Aligned")}</span></span> : s === "NO_ROLE" ? <span className="hr-dot tone-neutral"><span>{L("يحدده المحاسب", "Accountant's choice")}</span></span> : s === "MISALIGNED" ? <span className="hr-dot tone-danger"><span>{L("حساب مختلف", "Different account")}</span></span> : <span className="hr-dot tone-warning"><span>{s === "HR_UNMAPPED" ? L("غير مربوط في الموارد البشرية", "Not mapped in HR") : L("الدور غير مربوط", "Role not mapped")}</span></span>;
  return (
    <>
      <Msg error={w.error ?? pol.error} done={w.done} onClose={() => { w.setError(null); w.setDone(null); }} />
      <section className="acct-card">
        <h2>{L("فاقد التحميص", "Roast loss")}</h2>
        <p className="acct-hint">{L("الفاقد الطبيعي (فقد الوزن بالتحميص) يُحمَّل على تكلفة البن المحمص. الفاقد فوق هذه النسبة من وزن الأخضر غير طبيعي ويُحمَّل على مصروف «فاقد التحميص غير الطبيعي». فارغ = كل الفاقد طبيعي.", "Normal loss (moisture and chaff) is absorbed into roasted cost. Loss above this share of the green weight is abnormal and expensed to «abnormal roast loss». Empty = every loss is normal.")}</p>
        {!pol.data ? <OpsLoading rows={2} /> : (
          <div className="acct-row">
            <label className="hr-field"><span className="hr-label">{L("حد الفاقد الطبيعي %", "Normal loss limit %")}</span>
              <input className="hr-input acct-amount" inputMode="decimal" disabled={!canEdit} value={pct ?? pol.data.abnormalRoastLossPct ?? ""} placeholder={L("كل الفاقد طبيعي", "All loss normal")} onChange={(e) => setPct(e.target.value)} data-testid="loss-threshold" /></label>
            <label className="hr-field"><span className="hr-label"><input type="checkbox" disabled={!canEdit} checked={useProduct ?? pol.data.abnormalUseProductLimit} onChange={(e) => setUseProduct(e.target.checked)} data-testid="loss-use-product" /> {L("حد كل منتج: الفاقد المتوقع + 5 نقاط (حد المحطة «فوق الحد»)", "Per product: expected loss + 5 points (the station's «above» boundary)")}</span></label>
            {canEdit ? <Btn variant="primary" busy={w.busy === "pct"} disabled={pct === null && useProduct === null} onClick={async () => { if (await w.run("pct", "/api/accounting/inventory/settings", "PUT", { abnormalRoastLossPct: (pct ?? pol.data!.abnormalRoastLossPct ?? "") === "" ? null : pct ?? pol.data!.abnormalRoastLossPct, abnormalUseProductLimit: useProduct ?? pol.data!.abnormalUseProductLimit }, L("حُفظت السياسة.", "Policy saved."))) { setPct(null); setUseProduct(null); pol.reload(); } }}>{L("حفظ", "Save")}</Btn> : null}
          </div>
        )}
      </section>
      <section className="acct-card">
        <h2>{L("الرواتب في الدفتر", "Payroll in the ledger")} {al.data ? (al.data.aligned ? <span className="hr-dot tone-success"><span>{L("مطابقة", "Aligned")}</span></span> : <span className="hr-dot tone-warning"><span>{L("تحتاج مراجعة", "Needs review")}</span></span>) : null}</h2>
        <p className="acct-hint">{L("قيود الرواتب تُرحّلها الموارد البشرية بضوابطها (قفل الرواتب، موافقة شخصين). المطلوب أن يكون كل مفتاح ترحيل في الموارد البشرية على حساب دوره هنا؛ يُغيَّر ربطه من إعدادات الموارد البشرية لا من هنا.", "Payroll journals are posted by HR under its own controls (the payroll lock, two-person approvals). Each HR posting key must sit on its role's account; a change is made in HR's account map, not here.")}</p>
        {al.error ? <p role="alert" className="hr-err">{al.error}</p> : !al.data ? <OpsLoading rows={4} /> : (
          <div className="hr-tablewrap">
            <table className="hr-table is-dense" data-testid="payroll-align">
              <thead><tr><th>{L("مفتاح الموارد البشرية", "HR key")}</th><th className="acct-hide-m">{L("الغرض", "Purpose")}</th><th>{L("حساب الموارد البشرية", "HR account")}</th><th>{L("حساب الدور", "Role account")}</th><th>{L("الحالة", "Status")}</th></tr></thead>
              <tbody>
                {al.data.rows.map((x) => (
                  <tr key={x.key}><td className="acct-code">{x.key}</td><td className="acct-hide-m">{x.why}</td><td>{x.hrAccount ? <><span className="acct-code">{x.hrAccount.code}</span> {x.hrAccount.name}</> : "—"}</td><td>{x.roleAccount ? <><span className="acct-code">{x.roleAccount.code}</span> {x.roleAccount.name}</> : "—"}</td><td>{status(x.status)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

export default function InventoryCostPage() {
  return <Suspense fallback={<OpsLoading />}><Inventory /></Suspense>;
}
