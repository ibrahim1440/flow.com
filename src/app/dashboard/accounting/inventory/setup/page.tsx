"use client";

// Figma: ACC-46. Decision D-1 settings (costing method, supplier price-difference treatment),
// normal-loss bands (approved by someone other than their author, never changed once approved),
// items with their units and operational links, and locations.
import { useState } from "react";
import { Plus } from "lucide-react";
import { api, ApiError, Badge, Button, Card, CardTitle, Dialog, ErrorState, Field, INPUT, LoadingState, Notice, Table, Td, Th, useApi, useL } from "../../../finance/_components/ui";
import { useCan } from "../../_components/kit";
import { KIND, KindBadge } from "../_ui";

type Masters = {
  settings: { costMethod: string | null; priceDifference: string | null; locked: boolean; policy: { status: string; version: number } | null };
  items: { id: string; code: string; name: string; nameEn: string; kind: string; account: string | null; baseUnit: string; yieldPerUnit: string; isActive: boolean; units: { unit: string; factor: string }[]; links: Record<"greenBeanId" | "coffeeProductId" | "materialItemId" | "productSkuId", string | null> }[];
  locations: { id: string; code: string; name: string; nameAr: string | null; isActive: boolean; isSalesDefault: boolean }[];
  bands: { id: string; code: string; name: string; nameAr: string | null; process: string; maxLossPercent: string; status: string; createdBy: string; createdByName: string; approvedByName: string | null }[];
};
const PROCESS: Record<string, [string, string]> = { ROASTING: ["تحميص", "Roasting"], PACKING: ["تعبئة", "Packing"], BAKING: ["خبز", "Baking"], OTHER: ["أخرى", "Other"] };
const LINK: Record<string, string> = { greenBeanId: "GreenBean", coffeeProductId: "CoffeeProduct", materialItemId: "MaterialItem", productSkuId: "ProductSKU" };

export default function InventorySetupPage() {
  const { L } = useL();
  const { can, user } = useCan();
  const { data: m, error, reload } = useApi<Masters>("/api/accounting/inventory/items");
  const [method, setMethod] = useState<string | undefined>();
  const [diff, setDiff] = useState<string | undefined>();
  const [busy, setBusy] = useState(""); const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [dlg, setDlg] = useState<"" | "band" | "item" | "location" | "unit">("");
  const [f, setF] = useState<Record<string, string>>({});
  const set = (k: string) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!m) return <LoadingState />;
  const cm = method ?? m.settings.costMethod ?? "", pd = diff ?? m.settings.priceDifference ?? "";
  const run = async (key: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(key); setMsg(null);
    try { await fn(); setDlg(""); setF({}); setMethod(undefined); setDiff(undefined); reload(); if (done) setMsg({ tone: "ok", text: done }); }
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
        <Notice tone="info">{m.settings.locked ? L("رُحّلت مستندات مخزون: طريقة التكلفة لا تتغيّر بعد الآن.", "Inventory documents have posted: the costing method can no longer change.") : L("لا يتغيّر أي منهما بعد ترحيل أول مستند مخزون. القيم المستخدمة في الاختبارات والشاشات التجريبية افتراضات اختبار وليست سياسة معتمدة.", "Neither changes after the first inventory document posts. Values used in tests and synthetic screens are test assumptions, not an approved policy.")}</Notice>
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
