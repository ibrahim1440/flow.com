"use client";

// The asset: its facts, the schedule ahead, its sub-ledger (every event with its GL state and entry), its depreciation
// lines, additions and disposals. Actions: activate / delete (a draft), edit, «إضافة رأسمالية» (or «تعديل تقدير»: a new
// life / residual value only, no entry), «استبعاد» (the dialog shows the gain / loss before posting — easier than Qoyod;
// a sale for value waits for the e-invoiced sales line, council F1) and the cancels of the latest addition / disposal.
import Link from "next/link";
import { useParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { OpsLoading, Btn, Field } from "@/components/ops/ui";
import { Dialog } from "@/components/hr/ui";
import { Section } from "@/components/chrome";
import { Select } from "@/components/ui/Select";
import { Msg, money, todayRiyadh, useApi, useLang, useWrite } from "../../_ui/shell";
import { FaShell, Crumb, Tag, Money, nameOf, FA_STATUS, GL_STATE, KIND, METHOD, type Asset, type Can } from "../_ui/fa";
import { AssetForm } from "../_ui/asset-form";

type Ev = { id: string; kind: string; eventDate: string; costDelta: string; accumDelta: string; sourceType: string; reversal: boolean; glState: string; journalEntryId: string | null };
type Doc = { id: string; number: string; status: string; glState: string; journalEntryId: string | null; createdAt: string };
type Full = Asset & { custodian: { fullNameAr: string; fullNameEn: string | null; employeeNo: string } | null; events: Ev[];
  additions: (Doc & { additionDate: string; amount: string; kind: string; description: string; newUsefulLifeMonths: number | null; newResidualValue: string | null })[];
  disposals: (Doc & { disposalDate: string; kind: string; proceedsNet: string; vat: string; netBookValue: string; gainLoss: string; catchUpDepreciation: string })[];
  depreciation: { id: string; run: string; runStatus: string; periodKey: string; fromDate: string; toDate: string; amount: string; voided: boolean }[];
  projection: { periodKey: string; charge: string; accumulated: string; nbv: string }[]; can: Can };
type Opt = { id: string; code: string; name: string | null };
type Options = { counterAccounts: Opt[]; proceedsAccounts: Opt[]; defaults: { bank: string | null } };
type Line = { lineId: string; description: string; remaining: string; capacity?: string; usedIn?: { fixedAssets: string; deferrals: string }; invoice: { number: string; invoiceDate: string; supplier: { name: string } } };
type Preview = { catchUpDepreciation: string; accumulated: string; netBookValue: string; proceedsNet: string; gainLoss: string; dateOk: boolean; recordedThrough: string };

const EV: Record<string, [string, string]> = { ACQUISITION: ["اقتناء", "Acquisition"], OPENING: ["رصيد افتتاحي", "Opening"], ADDITION: ["إضافة رأسمالية", "Addition"], DEPRECIATION: ["إهلاك", "Depreciation"], DISPOSAL: ["استبعاد", "Disposal"] };

function AssetPage() {
  const { L, ar } = useLang();
  const id = String(useParams()?.id ?? "");
  const a = useApi<Full>(`/api/accounting/fixed-assets/${id}`);
  const opts = useApi<Options>("/api/accounting/fixed-assets/options");
  const lines = useApi<{ rows: Line[] }>("/api/accounting/fixed-assets/invoice-lines");
  const w = useWrite();
  const [mode, setMode] = useState<null | "edit" | "add" | "dispose" | "cancelAdd" | "cancelDisp" | "delete">(null);
  const [target, setTarget] = useState<string>("");
  const [reason, setReason] = useState("");
  const today = todayRiyadh();
  const [add, setAdd] = useState({ additionDate: today, amount: "", kind: "MANUAL", counterAccountId: "", supplierInvoiceLineId: "", description: "", newUsefulLifeMonths: "", newResidualValue: "" });
  const [dis, setDis] = useState({ disposalDate: today, kind: "SCRAP", reason: "" });
  const [pv, setPv] = useState<Preview | null>(null);
  const d = a.data;
  useEffect(() => {
    if (mode !== "dispose") return;
    const q = new URLSearchParams({ disposalDate: dis.disposalDate, kind: dis.kind, proceedsNet: "0" });
    let off = false;
    fetch(`/api/accounting/fixed-assets/${id}/disposals?${q}`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then((x) => { if (!off) setPv(x); }).catch(() => { if (!off) setPv(null); });
    return () => { off = true; };
  }, [mode, dis.disposalDate, dis.kind, id]);
  if (!d) return <FaShell title={L("الأصل", "Asset")}><Msg error={a.error} /><OpsLoading /></FaShell>;
  const live = d.status === "ACTIVE" || d.status === "FULLY_DEPRECIATED";
  const done = () => { setMode(null); setReason(""); a.reload(); lines.reload(); };
  const latestAdd = d.additions.filter((x) => x.status === "POSTED").slice(-1)[0];
  const liveDisp = d.disposals.find((x) => x.status === "POSTED");
  async function act(kind: string) {
    if (kind === "activate") { if (await w.run("activate", `/api/accounting/fixed-assets/${id}/activate`, "POST", {}, L("فُعّل الأصل وسُجّل اقتناؤه.", "Activated; the acquisition is recorded."))) done(); }
    if (kind === "delete") { if (await w.run("delete", `/api/accounting/fixed-assets/${id}`, "DELETE", {})) window.location.href = "/dashboard/accounting/fixed-assets"; }
    if (kind === "add") {
      const rev = add.kind === "REVISION";
      if (await w.run("add", `/api/accounting/fixed-assets/${id}/additions`, "POST", { ...add, amount: rev ? null : add.amount, counterAccountId: rev ? null : add.counterAccountId || opts.data?.defaults.bank || null, supplierInvoiceLineId: rev ? null : add.supplierInvoiceLineId || null, newUsefulLifeMonths: add.newUsefulLifeMonths || null, newResidualValue: add.newResidualValue || null },
        rev ? L("سُجّل تعديل التقدير وأُعيد حساب الإهلاك من تاريخه.", "Change of estimate recorded; depreciation recomputed from its date.") : L("سُجّلت الإضافة الرأسمالية وأُعيد حساب الإهلاك.", "Addition recorded; depreciation recomputed."))) done();
    }
    if (kind === "dispose") { if (await w.run("dispose", `/api/accounting/fixed-assets/${id}/disposals`, "POST", { ...dis, proceedsNet: "0" }, L("استُبعد الأصل.", "The asset is disposed of."))) done(); }
    if (kind === "cancelAdd") { if (await w.run("c", `/api/accounting/fixed-assets/additions/${target}/cancel`, "POST", { reason }, L("أُلغيت الإضافة.", "Addition cancelled."))) done(); }
    if (kind === "cancelDisp") { if (await w.run("c", `/api/accounting/fixed-assets/disposals/${target}/cancel`, "POST", { reason }, L("أُلغي الاستبعاد وعاد الأصل.", "Disposal cancelled; the asset is back."))) done(); }
  }
  const je = (x: string | null) => (x ? <Link href={`/dashboard/accounting/journals/${x}`}>{L("القيد", "Entry")}</Link> : null);
  const dl = (k: string, v: React.ReactNode) => <div><dt>{k}</dt><dd>{v || "—"}</dd></div>;
  return (
    <FaShell title={`${d.code} · ${ar ? d.nameAr : d.nameEn || d.nameAr}`} actions={
      <span className="acct-actions">
        {d.status === "DRAFT" && d.can.post ? <Btn variant="primary" busy={w.busy === "activate"} onClick={() => act("activate")} data-testid="fa-activate">{L("تفعيل الأصل", "Activate")}</Btn> : null}
        {d.can.write && !d.can.post && d.status !== "DISPOSED" ? <span className="acct-hint" data-testid="fa-needs-post">{L("التفعيل والإضافة والاستبعاد: يتطلب صلاحية الترحيل (journal_post)", "Activate, add, dispose: needs the posting duty (journal_post)")}</span> : null}
        {d.can.write && d.status !== "DISPOSED" ? <Btn onClick={() => setMode(mode === "edit" ? null : "edit")} data-testid="fa-edit">{L("تعديل", "Edit")}</Btn> : null}
        {live && d.can.post ? <Btn onClick={() => { setAdd({ ...add, kind: "MANUAL" }); setMode("add"); }} data-testid="fa-add">{L("إضافة رأسمالية", "Capital addition")}</Btn> : null}
        {live && d.can.post ? <Btn onClick={() => { setAdd({ ...add, kind: "REVISION", amount: "" }); setMode("add"); }} data-testid="fa-revise">{L("تعديل التقدير", "Change of estimate")}</Btn> : null}
        {live && d.can.post ? <Btn variant="danger" onClick={() => { setPv(null); setMode("dispose"); }} data-testid="fa-dispose">{L("إبعاد الأصل", "Dispose of")}</Btn> : null}
        {d.status === "DRAFT" && d.can.write ? <Btn variant="ghost" onClick={() => setMode("delete")} data-testid="fa-delete">{L("حذف المسودة", "Delete draft")}</Btn> : null}
      </span>
    }>
      <Crumb items={[{ label: d.code }]} />
      <Msg error={w.error ?? a.error} done={w.done} onClose={() => { w.setError(null); w.setDone(null); }} />
      {mode === "edit" ? <AssetForm asset={d} onDone={() => { setMode(null); a.reload(); }} /> : (
        <>
          <div className="acct-metrics" data-testid="fa-figures">
            <div className="acct-metric"><span className="k">{L("التكلفة", "Cost")}</span><span className="v">{money(d.cost)}</span></div>
            <div className="acct-metric"><span className="k">{L("مجمع الإهلاك", "Accumulated depreciation")}</span><span className="v">{money(d.accumulatedDepreciation)}</span><span className="s">{d.depreciatedThrough ? L(`حتى ${d.depreciatedThrough}`, `to ${d.depreciatedThrough}`) : L("لم يُسجَّل إهلاك", "No depreciation yet")}</span></div>
            <div className="acct-metric"><span className="k">{L("صافي القيمة الدفترية", "Net book value")}</span><span className="v">{money(d.netBookValue)}</span><span className="s">{L("ر.س", "SAR")}</span></div>
            <div className="acct-metric"><span className="k">{L("الحالة", "Status")}</span><span><Tag map={FA_STATUS} value={d.status} /></span>{d.nextMonth ? <span className="s">{L(`إهلاك ${d.nextMonth.periodKey}: ${money(d.nextMonth.charge)}`, `${d.nextMonth.periodKey}: ${money(d.nextMonth.charge)}`)}</span> : null}</div>
          </div>
          <Section title={L("بيانات الأصل", "Asset details")} testId="fa-detail">
            <div className="fa-body"><dl className="acct-kv-grid">
              {dl(L("التصنيف", "Category"), nameOf(d.category, ar))}
              {dl(L("طريقة الاقتناء", "Acquired"), L(KIND[d.acquisitionKind]?.[0] ?? "", KIND[d.acquisitionKind]?.[1] ?? ""))}
              {dl(L("فاتورة المشتريات", "Purchase invoice"), d.supplierInvoice ? <Link href={`/dashboard/purchases/invoices/${d.supplierInvoice.id}`}><bdi>{d.supplierInvoice.number}</bdi></Link> : null)}
              {dl(L("دُفع من", "Paid from"), d.counterAccount ? `${d.counterAccount.code} · ${nameOf(d.counterAccount, ar)}` : null)}
              {dl(L("تاريخ الاقتناء", "Acquired on"), <bdi>{d.acquisitionDate}</bdi>)}
              {dl(L("بدء الاستخدام", "In service"), <bdi>{d.inServiceDate}</bdi>)}
              {dl(L("نهاية العمر الإنتاجي", "End of useful life"), <bdi>{d.lifeEnd}</bdi>)}
              {dl(L("العمر / الطريقة", "Life / method"), `${d.usefulLifeMonths} ${L("شهرًا", "months")} · ${L(METHOD[d.method]?.[0] ?? "", METHOD[d.method]?.[1] ?? "")}${d.decliningRatePercent ? ` ${Number(d.decliningRatePercent)}%` : ""}`)}
              {dl(L("القيمة المتبقية", "Residual value"), money(d.residualValue))}
              {d.leaseEndDate ? dl(L("نهاية عقد الإيجار", "Lease end"), <bdi>{d.leaseEndDate}</bdi>) : null}
              {dl(L("الزكاة", "Zakat"), <span data-testid="fa-zakat">{d.zakatDeductibleEffective ? L("مخصوم من وعاء الزكاة", "Deducted from the Zakat base") : L("غير مخصوم من وعاء الزكاة", "Not deducted from the Zakat base")}{d.zakatDeductible === null ? <span className="acct-hint"> {L("(حسب التصنيف)", "(the category's)")}</span> : null}<span className="acct-th-sub">{L("تحقق مع مستشار الزكاة / zatca.gov.sa", "Check with your Zakat adviser / zatca.gov.sa")}</span></span>)}
              {d.openingAccumulated ? dl(L("مجمع افتتاحي", "Opening accumulated"), money(d.openingAccumulated)) : null}
              {dl(L("الفرع / الموقع", "Branch / location"), [nameOf(d.branch, ar), d.location].filter(Boolean).join(" · "))}
              {dl(L("المورد", "Supplier"), d.supplier?.name)}
              {dl(L("الرقم التسلسلي", "Serial"), d.serialNumber ? <bdi>{d.serialNumber}</bdi> : null)}
              {dl(L("العهدة", "Custodian"), d.custodian ? `${ar ? d.custodian.fullNameAr : d.custodian.fullNameEn || d.custodian.fullNameAr} · ${d.custodian.employeeNo}` : null)}
              {dl(L("المرفقات", "Attachments"), d.attachments.length ? d.attachments.map((x, i) => <span key={i}>{i ? " · " : ""}<a href={x.url} target="_blank" rel="noreferrer">{x.name}</a></span>) : null)}
              {d.notes ? dl(L("ملاحظات", "Notes"), d.notes) : null}
            </dl></div>
          </Section>
          {d.projection.length ? (
            <Section title={L("الإهلاك القادم (متوقع)", "Depreciation ahead (projected)")} tone="mid" testId="fa-projection">
              <div className="fa-body"><div className="fa-proj">{d.projection.slice(0, 12).map((p) => <div key={p.periodKey}><bdi className="acct-code">{p.periodKey}</bdi><Money v={p.charge} strong /><span className="acct-hint">{L("صافي", "NBV")} {money(p.nbv)}</span></div>)}</div></div>
            </Section>
          ) : null}
          <Section title={L("سجل حركات الأصل", "Asset ledger")} className="is-flush" testId="fa-events">
            {d.events.length === 0 ? <p className="acct-hint fa-body">{L("لا حركات: المسودة لا تصل إلى الدفاتر حتى تُفعَّل.", "No events: a draft reaches the books only once activated.")}</p> : (
              <div className="hr-tablewrap"><table className="hr-table is-dense">
                <thead><tr><th>{L("التاريخ", "Date")}</th><th>{L("الحركة", "Event")}</th><th className="num">{L("التكلفة", "Cost")}</th><th className="num">{L("مجمع الإهلاك", "Accumulated")}</th><th>{L("الدفاتر", "Books")}</th><th /></tr></thead>
                <tbody>{d.events.map((e) => <tr key={e.id}><td><bdi>{e.eventDate}</bdi></td><td>{L(EV[e.kind]?.[0] ?? e.kind, EV[e.kind]?.[1] ?? e.kind)}{e.reversal ? <span className="acct-th-sub">{L("عكس", "Reversal")}</span> : null}</td>
                  <td className="num">{Number(e.costDelta) ? <Money v={e.costDelta} /> : ""}</td><td className="num">{Number(e.accumDelta) ? <Money v={e.accumDelta} /> : ""}</td><td><Tag map={GL_STATE} value={e.glState} /></td><td>{je(e.journalEntryId)}</td></tr>)}</tbody>
              </table></div>
            )}
          </Section>
          {d.additions.length ? (
            <Section title={L("الإضافات الرأسمالية", "Capital additions")} className="is-flush">
              <div className="hr-tablewrap"><table className="hr-table is-dense"><thead><tr><th>{L("المرجع", "Ref")}</th><th>{L("التاريخ", "Date")}</th><th>{L("الوصف", "Description")}</th><th className="num">{L("المبلغ", "Amount")}</th><th>{L("الحالة", "Status")}</th><th>{L("الخيارات", "Options")}</th></tr></thead>
                <tbody>{d.additions.map((x) => <tr key={x.id}><td className="acct-code">{x.number}</td><td><bdi>{x.additionDate}</bdi></td><td>{x.kind === "REVISION" ? <span className="acct-th-sub">{L("تعديل تقدير", "Change of estimate")}</span> : null}{x.description}{x.newUsefulLifeMonths ? <span className="acct-th-sub">{L(`عمر جديد ${x.newUsefulLifeMonths} شهرًا`, `new life ${x.newUsefulLifeMonths} months`)}</span> : null}{x.newResidualValue ? <span className="acct-th-sub">{L(`قيمة متبقية جديدة ${money(x.newResidualValue)}`, `new residual ${money(x.newResidualValue)}`)}</span> : null}</td><td className="num">{x.kind === "REVISION" ? "—" : <Money v={x.amount} />}</td><td><Tag map={FA_STATUS} value={x.status} /></td>
                  <td><span className="acct-actions">{je(x.journalEntryId)}{latestAdd?.id === x.id && d.can.reverse && d.status !== "DISPOSED" ? <button type="button" className="hr-btn is-sm" onClick={() => { setTarget(x.id); setMode("cancelAdd"); }}>{L("إلغاء", "Cancel")}</button> : null}</span></td></tr>)}</tbody></table></div>
            </Section>
          ) : null}
          {d.disposals.length ? (
            <Section title={L("الاستبعاد", "Disposal")} className="is-flush">
              <div className="hr-tablewrap"><table className="hr-table is-dense"><thead><tr><th>{L("المرجع", "Ref")}</th><th>{L("التاريخ", "Date")}</th><th>{L("النوع", "Kind")}</th><th className="num">{L("صافي القيمة", "NBV")}</th><th className="num">{L("المتحصلات", "Proceeds")}</th><th className="num">{L("ربح / (خسارة)", "Gain / (loss)")}</th><th>{L("الحالة", "Status")}</th><th>{L("الخيارات", "Options")}</th></tr></thead>
                <tbody>{d.disposals.map((x) => <tr key={x.id}><td className="acct-code">{x.number}</td><td><bdi>{x.disposalDate}</bdi></td><td>{x.kind === "SALE" ? L("بيع", "Sale") : L("إتلاف", "Scrap")}</td><td className="num"><Money v={x.netBookValue} /></td><td className="num"><Money v={x.proceedsNet} /></td><td className={`num ${Number(x.gainLoss) < 0 ? "acct-bad" : "acct-good"}`}><Money v={x.gainLoss} strong /></td><td><Tag map={FA_STATUS} value={x.status} /></td>
                  <td><span className="acct-actions">{je(x.journalEntryId)}{liveDisp?.id === x.id && d.can.reverse ? <button type="button" className="hr-btn is-sm" onClick={() => { setTarget(x.id); setMode("cancelDisp"); }}>{L("إلغاء الاستبعاد", "Cancel disposal")}</button> : null}</span></td></tr>)}</tbody></table></div>
            </Section>
          ) : null}
          {d.depreciation.length ? (
            <Section title={L("قيود الإهلاك", "Depreciation runs")} className="is-flush">
              <div className="hr-tablewrap"><table className="hr-table is-dense"><thead><tr><th>{L("الشهر", "Month")}</th><th>{L("القيد", "Run")}</th><th>{L("الفترة", "Span")}</th><th className="num">{L("المبلغ", "Amount")}</th><th>{L("الحالة", "Status")}</th></tr></thead>
                <tbody>{d.depreciation.map((x) => <tr key={x.id} className={x.voided ? "is-muted" : undefined}><td><bdi className="acct-code">{x.periodKey}</bdi></td><td className="acct-code">{x.run}</td><td><bdi>{x.fromDate} → {x.toDate}</bdi></td><td className="num"><Money v={x.amount} /></td><td><Tag map={FA_STATUS} value={x.voided ? "REVERSED" : x.runStatus} /></td></tr>)}</tbody></table></div>
            </Section>
          ) : null}
        </>
      )}

      <Dialog open={mode === "add"} title={add.kind === "REVISION" ? L("تعديل التقدير", "Change of estimate") : L("إضافة رأسمالية", "Capital addition")} sub={d.code} onClose={() => setMode(null)} testId="fa-add-dialog"
        actions={<><Btn variant="primary" busy={w.busy === "add"} onClick={() => act("add")} data-testid="fa-add-save">{add.kind === "REVISION" ? L("تسجيل التعديل", "Record the change") : L("تسجيل الإضافة", "Record the addition")}</Btn><Btn onClick={() => setMode(null)}>{L("إلغاء", "Cancel")}</Btn></>}>
        <div className="acct-seg" role="group">{(["MANUAL", "PURCHASE_INVOICE", "REVISION"] as const).map((k) => <button key={k} type="button" aria-pressed={add.kind === k} onClick={() => setAdd({ ...add, kind: k })} data-testid={`fa-add-kind-${k}`}>{k === "REVISION" ? L("تعديل تقدير فقط", "Estimate only") : L(KIND[k][0], KIND[k][1])}</button>)}</div>
        <div className="fa-form">
          {add.kind === "REVISION" ? null : add.kind === "PURCHASE_INVOICE" ? <Field label={L("سطر فاتورة المشتريات", "Purchase-invoice line")} wide><Select value={add.supplierInvoiceLineId} onChange={(e) => { const l = lines.data?.rows.find((x) => x.lineId === e.target.value); setAdd({ ...add, supplierInvoiceLineId: e.target.value, amount: l?.remaining ?? add.amount, description: add.description || l?.description || "", additionDate: l && l.invoice.invoiceDate > add.additionDate ? l.invoice.invoiceDate : add.additionDate }); }}><option value="">{L("اختر السطر", "Choose the line")}</option>{(lines.data?.rows ?? []).map((l) => <option key={l.lineId} value={l.lineId}>{`${l.invoice.number} · ${l.invoice.supplier.name} · ${l.description} · ${money(l.remaining)}${l.usedIn && (Number(l.usedIn.fixedAssets) || Number(l.usedIn.deferrals)) ? ` · ${L("مستخدم في", "used in")}: ${L("أصل ثابت", "fixed asset")} ${money(l.usedIn.fixedAssets)} / ${L("تأجيل", "deferral")} ${money(l.usedIn.deferrals)}` : ""}`}</option>)}</Select></Field>
            : <Field label={L("دُفعت من حساب", "Paid from account")}><Select value={add.counterAccountId || opts.data?.defaults.bank || ""} onChange={(e) => setAdd({ ...add, counterAccountId: e.target.value })}>{(opts.data?.counterAccounts ?? []).map((x) => <option key={x.id} value={x.id}>{x.code} · {x.name}</option>)}</Select></Field>}
          <Field label={L("التاريخ", "Date")} help={d.depreciatedThrough ? L(`بعد ${d.depreciatedThrough} (آخر إهلاك مسجّل)`, `after ${d.depreciatedThrough} (last depreciation recorded)`) : undefined}><input type="date" className="hr-input" value={add.additionDate} onChange={(e) => setAdd({ ...add, additionDate: e.target.value })} data-testid="fa-add-date" /></Field>
          {add.kind !== "REVISION" ? <Field label={L("المبلغ (ر.س)", "Amount (SAR)")}><input className="hr-input acct-amount" dir="ltr" value={add.amount} onChange={(e) => setAdd({ ...add, amount: e.target.value })} data-testid="fa-add-amount" /></Field> : null}
          <Field label={L("الوصف", "Description")} wide><input className="hr-input" value={add.description} onChange={(e) => setAdd({ ...add, description: e.target.value })} data-testid="fa-add-desc" /></Field>
          <Field label={L(`عمر إنتاجي جديد بالأشهر (${add.kind === "REVISION" ? "" : "اختياري، "}من بدء الاستخدام؛ الحالي ${d.usefulLifeMonths})`, `New useful life in months (${add.kind === "REVISION" ? "" : "optional, "}from in-service; now ${d.usefulLifeMonths})`)}
            help={d.category.isLeasehold ? L(`تحسينات مستأجرة: الأقل من 5 سنوات ومدة العقد (حتى ${d.leaseEndDate ?? "—"}).`, `Leasehold: the shorter of 5 years and the lease (to ${d.leaseEndDate ?? "—"}).`) : undefined}>
            <input className="hr-input" dir="ltr" value={add.newUsefulLifeMonths} onChange={(e) => setAdd({ ...add, newUsefulLifeMonths: e.target.value.replace(/\D/g, "") })} data-testid="fa-add-life" /></Field>
          <Field label={L(`قيمة متبقية جديدة (${add.kind === "REVISION" ? "" : "اختياري؛ "}الحالية ${money(d.residualValue)})`, `New residual value (${add.kind === "REVISION" ? "" : "optional; "}now ${money(d.residualValue)})`)}><input className="hr-input acct-amount" dir="ltr" value={add.newResidualValue} onChange={(e) => setAdd({ ...add, newResidualValue: e.target.value })} data-testid="fa-add-residual" /></Field>
        </div>
        <p className="acct-hint">{add.kind === "REVISION"
          ? L("تعديل تقدير بلا قيد: يُوزَّع المتبقي القابل للإهلاك على العمر الجديد من التاريخ (أثر مستقبلي، ولا يُعدَّل ما سبق). يُسجَّل في سجل التدقيق ويُلغى كالإضافة.", "A change of estimate, no entry: the remaining depreciable amount spreads over the new life from the date (prospectively; nothing before changes). Audited, and cancelled like an addition.")
          : L("تزيد التكلفة، ويُوزَّع المتبقي القابل للإهلاك على باقي العمر من تاريخ الإضافة (أثر مستقبلي).", "The cost rises; the remaining depreciable amount spreads over the remaining life from the addition's date (prospectively).")}</p>
      </Dialog>

      <Dialog open={mode === "dispose"} title={L("إبعاد أصل", "Dispose of an asset")} sub={d.code} onClose={() => setMode(null)} testId="fa-dispose-dialog"
        actions={<><Btn variant="danger" busy={w.busy === "dispose"} disabled={!!pv && !pv.dateOk} onClick={() => act("dispose")} data-testid="fa-dispose-save">{L("تسجيل الاستبعاد", "Record the disposal")}</Btn><Btn onClick={() => setMode(null)}>{L("إلغاء", "Cancel")}</Btn></>}>
        {pv ? (
          <div className="acct-metrics" data-testid="fa-dispose-preview">
            <div className="acct-metric"><span className="k">{Number(pv.gainLoss) >= 0 ? L("ربح الاستبعاد", "Gain on disposal") : L("خسارة الاستبعاد", "Loss on disposal")}</span><span className={`v ${Number(pv.gainLoss) < 0 ? "is-bad" : ""}`} data-testid="fa-dispose-gl">{money(Math.abs(Number(pv.gainLoss)).toFixed(2))}</span></div>
            <div className="acct-metric"><span className="k">{L("صافي القيمة الدفترية", "Net book value")}</span><span className="v">{money(pv.netBookValue)}</span><span className="s">{L(`بعد إهلاك حتى التاريخ ${money(pv.catchUpDepreciation)}`, `after depreciation to the day ${money(pv.catchUpDepreciation)}`)}</span></div>
            <div className="acct-metric"><span className="k">{L("المتحصلات", "Proceeds")}</span><span className="v">{money(pv.proceedsNet)}</span><span className="s">{L("بلا متحصلات (قريباً عبر فاتورة المبيعات)", "None (soon via the sales invoice)")}</span></div>
          </div>
        ) : null}
        {pv && !pv.dateOk ? <p className="acct-bad">{L(`التاريخ قبل آخر إهلاك مسجّل (${pv.recordedThrough}).`, `The date is before the last depreciation recorded (${pv.recordedThrough}).`)}</p> : null}
        <div className="acct-seg" role="group">{(["SCRAP", "SALE"] as const).map((k) => <button key={k} type="button" aria-pressed={dis.kind === k} onClick={() => setDis({ ...dis, kind: k })} data-testid={`fa-dispose-${k}`}>{k === "SALE" ? L("بيع", "Sale") : L("إتلاف / شطب", "Scrap / write-off")}</button>)}</div>
        <p className={`${dis.kind === "SALE" ? "acct-warn" : "acct-hint"} fa-note`} data-testid="fa-dispose-sale-note">{L("بيع الأصل يحتاج فاتورة مبيعات إلكترونية — قريباً. يُسجَّل هنا الاستبعاد بلا متحصلات فقط (إتلاف / شطب)؛ أي متحصلات — بيع أو خردة مُباعة — تمر بسطر «بيع أصل ثابت» في فاتورة المبيعات.", "Selling an asset needs an e-invoiced sales invoice — coming soon. Here only a disposal without proceeds is recorded (scrap / write-off); any proceeds — a sale or scrap sold — go through the «fixed-asset sale» sales-invoice line.")}</p>
        <div className="fa-form">
          <Field label={L("تاريخ الاستبعاد", "Disposal date")}><input type="date" className="hr-input" value={dis.disposalDate} onChange={(e) => setDis({ ...dis, disposalDate: e.target.value })} data-testid="fa-dispose-date" /></Field>
          <Field label={L("السبب / قرار الشركة", "Reason / company decision")} wide><input className="hr-input" value={dis.reason} onChange={(e) => setDis({ ...dis, reason: e.target.value })} /></Field>
        </div>
      </Dialog>

      <Dialog open={mode === "cancelAdd" || mode === "cancelDisp"} title={mode === "cancelAdd" ? L("إلغاء الإضافة", "Cancel the addition") : L("إلغاء الاستبعاد", "Cancel the disposal")} onClose={() => setMode(null)}
        actions={<><Btn variant="danger" disabled={reason.trim().length < 3} busy={w.busy === "c"} onClick={() => act(mode as string)} data-testid="fa-cancel-confirm">{L("تأكيد الإلغاء", "Confirm")}</Btn><Btn onClick={() => setMode(null)}>{L("رجوع", "Back")}</Btn></>}>
        <p>{L("يُعكس القيد بتاريخه (يجب أن تكون فترته مفتوحة) ويعود الأصل كما كان.", "Its entry is reversed on its own date (its period must be open) and the asset goes back as it was.")}</p>
        <Field label={L("السبب (يُسجَّل)", "Reason (recorded)")}><textarea className="hr-input hr-textarea" value={reason} onChange={(e) => setReason(e.target.value)} data-testid="fa-cancel-reason" /></Field>
      </Dialog>
      <Dialog open={mode === "delete"} title={L("حذف المسودة", "Delete the draft")} sub={d.code} onClose={() => setMode(null)}
        actions={<><Btn variant="danger" busy={w.busy === "delete"} onClick={() => act("delete")} data-testid="fa-delete-confirm">{L("حذف", "Delete")}</Btn><Btn onClick={() => setMode(null)}>{L("رجوع", "Back")}</Btn></>}>
        <p>{L("المسودة لم تصل إلى الدفاتر؛ تُحذف نهائيًا.", "The draft never reached the books; it is deleted for good.")}</p>
      </Dialog>
    </FaShell>
  );
}
export default function Page() { return <Suspense fallback={<OpsLoading />}><AssetPage /></Suspense>; }
