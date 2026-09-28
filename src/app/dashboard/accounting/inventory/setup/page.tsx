"use client";

// Figma: ACC-46. Decision D-1 settings (costing method, supplier price-difference treatment),
// normal-loss bands (approved by someone other than their author, never changed once approved),
// items with their units and operational links, locations, and conversion-cost pools (direct labour
// and production overhead absorbed at budget ÷ normal capacity) with their absorption report.
import { useState } from "react";
import { Plus } from "lucide-react";
import { api, ApiError, Badge, Button, Card, CardTitle, Dialog, ErrorState, Field, INPUT, LoadingState, Notice, Table, Td, Th, useApi, useL } from "../../../finance/_components/ui";
import { riyadhToday, useAmount, useCan } from "../../_components/kit";
import { KIND, KindBadge } from "../_ui";

type Masters = {
  settings: { costMethod: string | null; priceDifference: string | null; locked: boolean; policy: { status: string; version: number } | null };
  items: { id: string; code: string; name: string; nameEn: string; kind: string; account: string | null; baseUnit: string; yieldPerUnit: string; isActive: boolean; units: { unit: string; factor: string }[]; links: Record<"greenBeanId" | "coffeeProductId" | "materialItemId" | "productSkuId", string | null> }[];
  locations: { id: string; code: string; name: string; nameAr: string | null; isActive: boolean; isSalesDefault: boolean }[];
  bands: { id: string; code: string; name: string; nameAr: string | null; process: string; maxLossPercent: string; status: string; createdBy: string; createdByName: string; approvedByName: string | null }[];
};
const PROCESS: Record<string, [string, string]> = { ROASTING: ["تحميص", "Roasting"], PACKING: ["تعبئة", "Packing"], BAKING: ["خبز", "Baking"], OTHER: ["أخرى", "Other"] };
const POOL_PROCESS: Record<string, [string, string]> = { ROASTING: ["تحميص", "Roasting"], BLENDING: ["خلط", "Blending"], PACKING: ["تعبئة", "Packing"], BAKING: ["خبز", "Baking"], OTHER: ["أخرى", "Other"] };
const POOL_KIND: Record<string, [string, string]> = { DIRECT_LABOUR: ["عمالة مباشرة", "Direct labour"], PRODUCTION_OVERHEAD: ["تكاليف إنتاج غير مباشرة", "Production overhead"] };
const BASIS: Record<string, [string, string]> = {
  PER_KG_INPUT: ["لكل كغ مدخل", "per kg input"], PER_KG_OUTPUT: ["لكل كغ ناتج", "per kg output"], PER_UNIT_OUTPUT: ["لكل وحدة ناتجة", "per unit output"],
  PER_BATCH: ["لكل دفعة", "per batch"], PER_LABOUR_HOUR: ["لكل ساعة عمل", "per labour hour"], PER_MACHINE_HOUR: ["لكل ساعة آلة", "per machine hour"],
};
type Pool = { id: string; code: string; name: string; nameAr: string | null; kind: string; process: string; basis: string; budgetAmount: string; normalCapacity: string; rate: string; status: string;
  createdBy: string; createdByName: string; approvedByName: string | null; expenseAccount: { code: string; nameAr: string | null; nameEn: string } | null };
type Absorption = { pools: { id: string; code: string; name: string; kind: string; process: string; basis: string; rate: string; status: string; expenseAccount: { code: string; nameAr: string | null; nameEn: string } | null; actual: string; absorbed: string; unabsorbed: string; overAbsorbed: boolean }[] };
type Acc = { id: string; code: string; nameAr: string | null; nameEn: string; type: string; allowPosting: boolean; isActive: boolean };
const LINK: Record<string, string> = { greenBeanId: "GreenBean", coffeeProductId: "CoffeeProduct", materialItemId: "MaterialItem", productSkuId: "ProductSKU" };

export default function InventorySetupPage() {
  const { L } = useL();
  const { can, user } = useCan();
  const amt = useAmount();
  const { data: m, error, reload } = useApi<Masters>("/api/accounting/inventory/items");
  const pools = useApi<Pool[]>("/api/accounting/inventory/cost-pools");
  const [absFrom, setAbsFrom] = useState(() => `${riyadhToday().slice(0, 4)}-01-01`);
  const [absTo, setAbsTo] = useState(riyadhToday);
  const abs = useApi<Absorption>(`/api/accounting/inventory/reports/absorption?from=${absFrom}&to=${absTo}`);
  const accs = useApi<Acc[]>(can("inv_master_manage") ? "/api/accounting/coa" : null);
  const [method, setMethod] = useState<string | undefined>();
  const [diff, setDiff] = useState<string | undefined>();
  const [busy, setBusy] = useState(""); const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [dlg, setDlg] = useState<"" | "band" | "item" | "location" | "unit" | "pool">("");
  const [f, setF] = useState<Record<string, string>>({});
  const set = (k: string) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!m) return <LoadingState />;
  const cm = method ?? m.settings.costMethod ?? "", pd = diff ?? m.settings.priceDifference ?? "";
  const run = async (key: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(key); setMsg(null);
    try { await fn(); setDlg(""); setF({}); setMethod(undefined); setDiff(undefined); reload(); pools.reload(); abs.reload(); if (done) setMsg({ tone: "ok", text: done }); }
    catch (e) { setMsg({ tone: "bad", text: e instanceof ApiError ? e.message : String(e) }); }
    setBusy("");
  };
  const open = (k: typeof dlg, init: Record<string, string> = {}) => { setF(init); setMsg(null); setDlg(k); };
  const policy = m.settings.policy;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardTitle title={L("قرار D-1 – تقييم المخزون وتكاليف الإنتاج", "Decision D-1 – inventory valuation and production costing")}
          sub={L("إعدادات يعتمدها المحاسب: لا يُرحّل مستند مخزون قبل حسمها (إلا مؤقتاً في قاعدة اختبار معزولة)", "Settings the accountant approves: no inventory document posts before they are decided (except provisionally in an isolated test database)")}
          right={<Badge tone={policy?.status === "APPROVED" ? "ok" : "warn"}>{policy ? L(`سياسة inventory.costing: ${policy.status === "APPROVED" ? "معتمدة" : "بانتظار الاعتماد"}`, `Policy inventory.costing: ${policy.status.toLowerCase()}`) : L("سياسة inventory.costing غير موجودة", "No inventory.costing policy")}</Badge>} />
        {msg && !dlg && <Notice tone={msg.tone}>{msg.text}</Notice>}
        <div className="flex items-end gap-3 flex-wrap">
          <Field label={L("طريقة تكلفة المخزون", "Inventory costing method")} hint={L("المتوسط المرجح (موصى به) أو الوارد أولاً", "Weighted average (recommended) or FIFO")}>
            <select className={`${INPUT} min-w-[260px]`} value={cm} disabled={!can("settings_manage") || m.settings.locked} onChange={(e) => setMethod(e.target.value)}>
              <option value="">{L("لم يُقرَّر بعد", "Not decided")}</option><option value="WEIGHTED_AVERAGE">{L("المتوسط المرجح", "Weighted average")}</option><option value="FIFO">{L("الوارد أولاً صادر أولاً", "FIFO")}</option>
            </select>
          </Field>
          <Field label={L("فرق سعر فاتورة المورد عن الاستلام", "Supplier bill price difference")} hint={L("الرسملة على المتبقي أو التحميل على الفروقات", "Capitalise on stock held, or expense to variance")}>
            <select className={`${INPUT} min-w-[260px]`} value={pd} disabled={!can("settings_manage") || (m.settings.locked && !!m.settings.priceDifference)} onChange={(e) => setDiff(e.target.value)}>
              <option value="">{L("لم يُقرَّر بعد", "Not decided")}</option><option value="CAPITALISE">{L("رسملة على المتبقي", "Capitalise")}</option><option value="EXPENSE">{L("تحميل على فروقات المخزون", "Expense to variance")}</option>
            </select>
          </Field>
          {can("settings_manage") && <Button busy={busy === "settings"} disabled={method === undefined && diff === undefined} onClick={() => run("settings", () => api("/api/accounting/inventory/settings", { method: "PATCH", json: { ...(method !== undefined ? { inventoryCostMethod: method || null } : {}), ...(diff !== undefined ? { inventoryPriceDifference: diff || null } : {}) } }), L("حُفظت الإعدادات.", "Settings saved."))}>{L("حفظ", "Save")}</Button>}
        </div>
        <Notice tone="info">{m.settings.locked ? (m.settings.costMethod
          ? L("رُحّلت مستندات مخزون: طريقة التكلفة لا تتغيّر بعد الآن.", "Inventory documents have posted: the costing method can no longer change.")
          : L("القرار لم يُحسم، ومع ذلك رُحّلت مستندات مؤقتاً في قاعدة الاختبار المعزولة بالمتوسط المرجح كقيمة احتياطية؛ لذلك لا يُضبط هنا. في قاعدة حقيقية لا يُرحّل شيء قبل الحسم.", "Undecided, yet documents posted provisionally in this isolated test database with the weighted-average fallback, so it cannot be set here. In a real database nothing posts before the decision.")) : L("لا يتغيّر أي منهما بعد ترحيل أول مستند مخزون. القيم المستخدمة في الاختبارات والشاشات التجريبية افتراضات اختبار وليست سياسة معتمدة.", "Neither changes after the first inventory document posts. Values used in tests and synthetic screens are test assumptions, not an approved policy.")}</Notice>
      </Card>

      <Card>
        <CardTitle title={L("نطاقات الفاقد الطبيعي", "Normal-loss bands")} sub={L("لكل عملية: تُعتمد من غير مُعدّها ولا تتغير بعد الاعتماد (تُسحب ويُعتمد غيرها)", "Per process: approved by someone other than the author and never changed after approval (retire and approve another)")}
          right={can("inv_master_manage") ? <Button kind="primary" icon={Plus} onClick={() => open("band", { process: "ROASTING" })}>{L("نطاق", "Band")}</Button> : undefined} />
        <Table>
          <thead><tr><Th>{L("الرمز", "Code")}</Th><Th>{L("الاسم", "Name")}</Th><Th>{L("العملية", "Process")}</Th><Th num>{L("الحد الأقصى للفاقد", "Max loss")}</Th><Th>{L("الحالة", "Status")}</Th><Th /></tr></thead>
          <tbody>{m.bands.map((b) => (
            <tr key={b.id}>
              <Td>{b.code}</Td><Td>{L(b.nameAr ?? b.name, b.name)}</Td><Td>{L(PROCESS[b.process]?.[0] ?? b.process, PROCESS[b.process]?.[1] ?? b.process)}</Td><Td num>{b.maxLossPercent}%</Td>
              <Td>{b.status === "APPROVED" ? <Badge tone="ok">{L(`معتمد · ${b.approvedByName}`, `Approved · ${b.approvedByName}`)}</Badge> : b.status === "DRAFT" ? <Badge tone="warn">{L("مسودة – بانتظار الاعتماد", "Draft – awaiting approval")}</Badge> : <Badge tone="info">{L("مسحوب", "Retired")}</Badge>}</Td>
              <Td>
                {b.status === "DRAFT" && can("inv_doc_approve") && b.createdBy !== user?.id && <button className="font-bold text-orange hover:underline" disabled={!!busy} onClick={() => run(b.id, () => api(`/api/accounting/inventory/loss-bands/${b.id}/approve`, { method: "POST", json: {} }))}>{L("اعتماد", "Approve")}</button>}
                {b.status === "APPROVED" && can("inv_master_manage") && <button className="font-bold text-red-700 hover:underline" disabled={!!busy} onClick={() => { if (confirm(L("سحب النطاق؟ لا يمكن إعادته.", "Retire the band? This cannot be undone."))) run(b.id, () => api(`/api/accounting/inventory/loss-bands/${b.id}/retire`, { method: "POST", json: {} })); }}>{L("سحب", "Retire")}</button>}
              </Td>
            </tr>
          ))}</tbody>
        </Table>
      </Card>

      <Card>
        <CardTitle title={L("الأصناف ووحداتها", "Items and units")} sub={L("الحساب يُحدَّد بنوع الصنف · الربط بسجلات التشغيل اختياري (صنف محاسبي واحد لكل سجل)", "The account follows the item kind · linking to an operational record is optional (one accounting item per record)")}
          right={can("inv_master_manage") ? <><Button onClick={() => open("location")}>{L("موقع", "Location")}</Button><Button kind="primary" icon={Plus} onClick={() => open("item", { kind: "GREEN_COFFEE" })}>{L("صنف", "Item")}</Button></> : undefined} />
        <Table>
          <thead><tr><Th>{L("الرمز", "Code")}</Th><Th>{L("الاسم", "Name")}</Th><Th>{L("النوع", "Kind")}</Th><Th>{L("الحساب", "Account")}</Th><Th>{L("الوحدة الأساسية", "Base unit")}</Th><Th>{L("تحويلات الوحدة", "Unit conversions")}</Th><Th>{L("الربط بالتشغيل", "Operational link")}</Th></tr></thead>
          <tbody>{m.items.map((i) => {
            const link = Object.entries(i.links).find(([, v]) => v);
            return (
              <tr key={i.id} className={i.isActive ? "" : "opacity-60"}>
                <Td>{i.code}</Td><Td>{L(i.name, i.nameEn)}</Td><Td><KindBadge kind={i.kind} /></Td><Td>{i.account ?? <Badge tone="bad">{L("غير مربوط", "Not mapped")}</Badge>}</Td><Td>{i.baseUnit}</Td>
                <Td>{[...i.units.map((u) => `${u.unit} = ${Number(u.factor)} ${i.baseUnit}`), ...(Number(i.yieldPerUnit) !== 1 ? [L(`وزن العائد ${Number(i.yieldPerUnit)} كغ`, `yield ${Number(i.yieldPerUnit)} kg`)] : [])].join(" · ") || "—"}
                  {can("inv_master_manage") && <button className="ms-2 text-[12px] font-bold text-orange hover:underline" onClick={() => open("unit", { itemId: i.id })}>{L("+ وحدة", "+ unit")}</button>}</Td>
                <Td><span dir="ltr" className="text-[12px]">{link ? `${LINK[link[0]]} · ${link[1]!.slice(0, 10)}` : "—"}</span></Td>
              </tr>
            );
          })}</tbody>
        </Table>
        <p className="text-xs text-brown">{L("المواقع: ", "Locations: ")}{m.locations.map((l) => `${l.code} · ${L(l.nameAr ?? l.name, l.name)}${l.isSalesDefault ? L(" (موقع المبيعات)", " (sales location)") : ""}`).join("، ")}</p>
      </Card>

      <Card>
        <CardTitle title={L("مجمّعات تكاليف التحويل", "Conversion-cost pools")} sub={L("العمالة المباشرة وتكاليف الإنتاج غير المباشرة لكل عملية، تُحمَّل على الإنتاج بمعدل معتمد", "Direct labour and production overhead per process, absorbed into production at an approved rate")}
          right={can("inv_master_manage") ? <Button kind="primary" icon={Plus} onClick={() => open("pool", { kind: "DIRECT_LABOUR", process: "ROASTING", basis: "PER_KG_OUTPUT" })}>{L("مجمّع", "Pool")}</Button> : undefined} />
        <Notice tone="info">{L("المعدل = الموازنة ÷ الطاقة العادية (معيار المحاسبة الدولي 2): فترة إنتاج منخفض تحمّل أقل، ويبقى غير المحمَّل مصروفاً في الفترة. يُعتمد المجمّع من غير مُعدّه ولا يتغير بعد الاعتماد. لا يُعد أي معدل سياسة للشركة قبل اعتماده؛ المعدلات في الاختبارات تجريبية (رموزها تنتهي بـ ‎-SYN).",
          "Rate = budget ÷ normal capacity (IAS 2 normal capacity): a low-output period absorbs less and the unabsorbed cost stays in the period's expense. A pool is approved by someone other than its author and never changes once approved. No rate is company policy until approved; rates used in tests are synthetic (codes end in -SYN).")}</Notice>
        {pools.error ? <ErrorState error={pools.error} onRetry={pools.reload} /> : !pools.data ? <LoadingState /> : pools.data.length === 0 ? <p className="text-[13px] text-brown">{L("لا مجمّعات بعد: لا تُحمَّل تكاليف تحويل على الإنتاج.", "No pools yet: no conversion cost is absorbed into production.")}</p> : (
          <Table>
            <thead><tr><Th>{L("الرمز", "Code")}</Th><Th>{L("الاسم", "Name")}</Th><Th>{L("النوع", "Kind")}</Th><Th>{L("العملية", "Process")}</Th><Th num>{L("الموازنة", "Budget")}</Th><Th num>{L("الطاقة العادية", "Normal capacity")}</Th><Th num>{L("المعدل", "Rate")}</Th><Th>{L("حساب المصروف", "Expense account")}</Th><Th>{L("الحالة", "Status")}</Th><Th /></tr></thead>
            <tbody>{pools.data.map((p) => (
              <tr key={p.id} className={p.status === "RETIRED" ? "opacity-60" : ""}>
                <Td><span dir="ltr">{p.code}</span>{p.code.endsWith("-SYN") && <span className="ms-1"><Badge tone="warn">{L("تجريبي", "Synthetic")}</Badge></span>}</Td>
                <Td>{L(p.nameAr ?? p.name, p.name)}</Td><Td>{L(POOL_KIND[p.kind]?.[0] ?? p.kind, POOL_KIND[p.kind]?.[1] ?? p.kind)}</Td><Td>{L(POOL_PROCESS[p.process]?.[0] ?? p.process, POOL_PROCESS[p.process]?.[1] ?? p.process)}</Td>
                <Td num>{amt(p.budgetAmount)}</Td><Td num>{Number(p.normalCapacity).toLocaleString("en-US")}</Td>
                <Td num>{Number(p.rate).toLocaleString("en-US", { maximumFractionDigits: 4 })} <span className="text-[11px] text-brown">{L(BASIS[p.basis]?.[0] ?? p.basis, BASIS[p.basis]?.[1] ?? p.basis)}</span></Td>
                <Td>{p.expenseAccount ? `${p.expenseAccount.code} · ${L(p.expenseAccount.nameAr ?? p.expenseAccount.nameEn, p.expenseAccount.nameEn)}` : "—"}</Td>
                <Td>{p.status === "APPROVED" ? <Badge tone="ok">{L(`معتمد · ${p.approvedByName}`, `Approved · ${p.approvedByName}`)}</Badge> : p.status === "DRAFT" ? <Badge tone="warn">{L(`مسودة (${p.createdByName}) – بانتظار الاعتماد`, `Draft (${p.createdByName}) – awaiting approval`)}</Badge> : <Badge tone="info">{L("مسحوب", "Retired")}</Badge>}</Td>
                <Td>
                  {p.status === "DRAFT" && can("inv_doc_approve") && p.createdBy !== user?.id && <button className="font-bold text-orange hover:underline" disabled={!!busy} onClick={() => run(p.id, () => api(`/api/accounting/inventory/cost-pools/${p.id}/approve`, { method: "POST", json: {} }))}>{L("اعتماد", "Approve")}</button>}
                  {p.status === "APPROVED" && can("inv_doc_approve") && <button className="font-bold text-red-700 hover:underline" disabled={!!busy} onClick={() => { if (confirm(L("سحب المجمّع؟ لا يمكن إعادته.", "Retire the pool? This cannot be undone."))) run(p.id, () => api(`/api/accounting/inventory/cost-pools/${p.id}/retire`, { method: "POST", json: {} })); }}>{L("سحب", "Retire")}</button>}
                </Td>
              </tr>
            ))}</tbody>
          </Table>
        )}
      </Card>

      <Card>
        <CardTitle title={L("تقرير التحميل", "Absorption report")} sub={L("لكل مجمّع: التكلفة الفعلية في حساب المصروف مقابل ما حُمِّل على الإنتاج المرحّل في الفترة", "Per pool: actual cost booked on its expense account against what posted productions absorbed in the period")} />
        <div className="flex items-end gap-3 flex-wrap">
          <Field label={L("من", "From")}><input type="date" className={`${INPUT} max-w-[180px]`} value={absFrom} onChange={(e) => setAbsFrom(e.target.value)} /></Field>
          <Field label={L("إلى", "To")}><input type="date" className={`${INPUT} max-w-[180px]`} value={absTo} onChange={(e) => setAbsTo(e.target.value)} /></Field>
        </div>
        {abs.error ? <ErrorState error={abs.error} onRetry={abs.reload} /> : !abs.data ? <LoadingState /> : abs.data.pools.length === 0 ? <p className="text-[13px] text-brown">{L("لا مجمّعات معتمدة.", "No approved pools.")}</p> : (<>
          <Table>
            <thead><tr><Th>{L("المجمّع", "Pool")}</Th><Th>{L("العملية", "Process")}</Th><Th num>{L("المعدل", "Rate")}</Th><Th>{L("حساب المصروف", "Expense account")}</Th><Th num>{L("الفعلي", "Actual")}</Th><Th num>{L("المحمَّل", "Absorbed")}</Th><Th num>{L("غير المحمَّل", "Unabsorbed")}</Th><Th /></tr></thead>
            <tbody>{abs.data.pools.map((p) => (
              <tr key={p.id} className={p.overAbsorbed ? "bg-red-50" : ""}>
                <Td><span dir="ltr">{p.code}</span> · {p.name}<span className="block text-[11px] text-brown">{L(POOL_KIND[p.kind]?.[0] ?? p.kind, POOL_KIND[p.kind]?.[1] ?? p.kind)}{p.status === "RETIRED" ? L(" · مسحوب", " · retired") : ""}</span></Td>
                <Td>{L(POOL_PROCESS[p.process]?.[0] ?? p.process, POOL_PROCESS[p.process]?.[1] ?? p.process)}</Td>
                <Td num>{Number(p.rate).toLocaleString("en-US", { maximumFractionDigits: 4 })} <span className="text-[11px] text-brown">{L(BASIS[p.basis]?.[0] ?? p.basis, BASIS[p.basis]?.[1] ?? p.basis)}</span></Td>
                <Td>{p.expenseAccount ? `${p.expenseAccount.code} · ${L(p.expenseAccount.nameAr ?? p.expenseAccount.nameEn, p.expenseAccount.nameEn)}` : "—"}</Td>
                <Td num>{amt(p.actual)}</Td><Td num>{amt(p.absorbed)}</Td><Td num className={p.overAbsorbed ? "text-red-700 font-bold" : ""}>{amt(p.unabsorbed)}</Td>
                <Td>{p.overAbsorbed ? <Badge tone="bad">{L("تحميل زائد", "Over-absorbed")}</Badge> : Number(p.unabsorbed) > 0 ? <Badge tone="info">{L("مصروف الفترة", "Period expense")}</Badge> : null}</Td>
              </tr>
            ))}</tbody>
          </Table>
          {abs.data.pools.some((p) => p.overAbsorbed) && <Notice tone="bad">{L("مجمّع حمّل أكثر مما أُنفق فعلاً: قد يحمل المخزون أكثر من تكلفته (معيار المحاسبة الدولي 2). راجع المعدل والطاقة العادية؛ قرار التسوية للمحاسب.", "A pool absorbed more than was actually spent: inventory could carry more than cost (IAS 2). Review the rate and normal capacity; the accountant decides the adjustment.")}</Notice>}
          <p className="text-xs text-brown">{L("التحميل يُقيَّد دائناً على حساب مقابل (عمالة / تكاليف محمَّلة) وتبقى التكاليف الفعلية في حساباتها، فلا يُحتسب شيء مرتين: الفعلي ناقص المحمَّل تتحمله الفترة، والمحمَّل يبقى في المخزون حتى البيع.", "Absorption credits a contra account (labour / overhead absorbed) and actual costs stay where they are booked, so nothing counts twice: actual less absorbed is borne by the period; the absorbed part sits in inventory until sold.")}</p>
        </>)}
      </Card>

      <Dialog open={dlg === "pool"} onClose={() => setDlg("")} title={L("مجمّع تكاليف تحويل جديد", "New conversion-cost pool")} sub={L("يُحفظ مسودة ويعتمده شخص آخر؛ المعدل = الموازنة ÷ الطاقة العادية", "Saved as a draft; someone else approves it. Rate = budget ÷ normal capacity")}>
        {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
        <Field label={L("الرمز", "Code")}><input className={INPUT} value={f.code ?? ""} onChange={set("code")} /></Field>
        <Field label={L("الاسم", "Name")}><input className={INPUT} value={f.name ?? ""} onChange={set("name")} /></Field>
        <Field label={L("النوع", "Kind")}><select className={INPUT} value={f.kind} onChange={set("kind")}>{Object.entries(POOL_KIND).map(([k, v]) => <option key={k} value={k}>{L(v[0], v[1])}</option>)}</select></Field>
        <Field label={L("العملية", "Process")}><select className={INPUT} value={f.process} onChange={set("process")}>{Object.entries(POOL_PROCESS).map(([k, v]) => <option key={k} value={k}>{L(v[0], v[1])}</option>)}</select></Field>
        <Field label={L("أساس التحميل", "Allocation basis")}><select className={INPUT} value={f.basis} onChange={set("basis")}>{Object.entries(BASIS).map(([k, v]) => <option key={k} value={k}>{L(v[0], v[1])}</option>)}</select></Field>
        <Field label={L("موازنة المجمّع للفترة (ر.س)", "Budgeted pool for the period (SAR)")}><input className={INPUT} inputMode="decimal" value={f.budgetAmount ?? ""} onChange={set("budgetAmount")} /></Field>
        <Field label={L("الطاقة العادية بوحدة الأساس", "Normal capacity in the basis unit")} hint={L("الطاقة المتوقعة في الظروف العادية، لا الفعلية", "Expected output under normal conditions, not actual")}><input className={INPUT} inputMode="decimal" value={f.normalCapacity ?? ""} onChange={set("normalCapacity")} /></Field>
        {Number(f.budgetAmount) >= 0 && Number(f.normalCapacity) > 0 && <p className="text-xs text-brown">{L(`المعدل المقترح: ${(Number(f.budgetAmount) / Number(f.normalCapacity)).toFixed(4)} ${BASIS[f.basis]?.[0] ?? ""}`, `Proposed rate: ${(Number(f.budgetAmount) / Number(f.normalCapacity)).toFixed(4)} ${BASIS[f.basis]?.[1] ?? ""}`)}</p>}
        <Field label={L("حساب المصروف الفعلي", "Expense account of the actual costs")}>
          <select className={INPUT} value={f.expenseAccountId ?? ""} onChange={set("expenseAccountId")}>
            <option value="">{accs.data ? L("— اختر —", "— choose —") : L("جارٍ التحميل…", "Loading…")}</option>
            {(accs.data ?? []).filter((a) => a.type === "EXPENSE" && a.allowPosting && a.isActive).map((a) => <option key={a.id} value={a.id}>{a.code} · {L(a.nameAr ?? a.nameEn, a.nameEn)}</option>)}
          </select>
        </Field>
        <Button kind="primary" busy={busy === "pool"} onClick={() => run("pool", () => api("/api/accounting/inventory/cost-pools", { method: "POST", json: { ...f, nameAr: f.name } }))}>{L("حفظ كمسودة", "Save as draft")}</Button>
      </Dialog>

      <Dialog open={dlg === "band"} onClose={() => setDlg("")} title={L("نطاق فاقد جديد", "New loss band")} sub={L("يُحفظ مسودة ويعتمده شخص آخر", "Saved as a draft; someone else approves it")}>
        {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
        <Field label={L("الرمز", "Code")}><input className={INPUT} value={f.code ?? ""} onChange={set("code")} /></Field>
        <Field label={L("الاسم", "Name")}><input className={INPUT} value={f.name ?? ""} onChange={set("name")} /></Field>
        <Field label={L("العملية", "Process")}><select className={INPUT} value={f.process} onChange={set("process")}>{Object.entries(PROCESS).map(([k, v]) => <option key={k} value={k}>{L(v[0], v[1])}</option>)}</select></Field>
        <Field label={L("الحد الأقصى للفاقد الطبيعي %", "Maximum normal loss %")}><input className={INPUT} inputMode="decimal" value={f.maxLossPercent ?? ""} onChange={set("maxLossPercent")} /></Field>
        <Button kind="primary" busy={busy === "band"} onClick={() => run("band", () => api("/api/accounting/inventory/loss-bands", { method: "POST", json: { ...f, nameAr: f.name } }))}>{L("حفظ كمسودة", "Save as draft")}</Button>
      </Dialog>

      <Dialog open={dlg === "item"} onClose={() => setDlg("")} title={L("صنف جديد", "New item")}>
        {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
        <Field label={L("الرمز", "Code")}><input className={INPUT} value={f.code ?? ""} onChange={set("code")} /></Field>
        <Field label={L("الاسم", "Name")}><input className={INPUT} value={f.name ?? ""} onChange={set("name")} /></Field>
        <Field label={L("النوع", "Kind")}><select className={INPUT} value={f.kind} onChange={set("kind")}>{Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{L(v[0], v[1])}</option>)}</select></Field>
        <Field label={L("الوحدة الأساسية", "Base unit")}><input className={INPUT} value={f.baseUnit ?? ""} onChange={set("baseUnit")} placeholder="kg" /></Field>
        <Field label={L("وزن العائد لكل وحدة (كغ)", "Yield weight per unit (kg)")} hint={L("1 للأصناف بالكيلو", "1 for items kept in kg")}><input className={INPUT} inputMode="decimal" value={f.yieldPerUnit ?? ""} onChange={set("yieldPerUnit")} /></Field>
        <Button kind="primary" busy={busy === "item"} onClick={() => run("item", () => api("/api/accounting/inventory/items", { method: "POST", json: { ...f, nameAr: f.name } }))}>{L("حفظ", "Save")}</Button>
      </Dialog>

      <Dialog open={dlg === "unit"} onClose={() => setDlg("")} title={L("تحويل وحدة", "Unit conversion")}>
        {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
        <Field label={L("الوحدة", "Unit")}><input className={INPUT} value={f.unit ?? ""} onChange={set("unit")} placeholder="sack60" /></Field>
        <Field label={L("تساوي كم من الوحدة الأساسية", "Equals how many base units")}><input className={INPUT} inputMode="decimal" value={f.factor ?? ""} onChange={set("factor")} /></Field>
        <Button kind="primary" busy={busy === "unit"} onClick={() => run("unit", () => api(`/api/accounting/inventory/items/${f.itemId}/units`, { method: "PUT", json: { unit: f.unit, factor: f.factor } }))}>{L("حفظ", "Save")}</Button>
      </Dialog>

      <Dialog open={dlg === "location"} onClose={() => setDlg("")} title={L("موقع جديد", "New location")}>
        {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
        <Field label={L("الرمز", "Code")}><input className={INPUT} value={f.code ?? ""} onChange={set("code")} /></Field>
        <Field label={L("الاسم", "Name")}><input className={INPUT} value={f.name ?? ""} onChange={set("name")} /></Field>
        <Button kind="primary" busy={busy === "location"} onClick={() => run("location", () => api("/api/accounting/inventory/locations", { method: "POST", json: { ...f, nameAr: f.name } }))}>{L("حفظ", "Save")}</Button>
      </Dialog>
    </div>
  );
}
