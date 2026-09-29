"use client";

// Asset classes and their depreciation policy versions (Figma ACC-64). The policy statement
// "fixed_assets.depreciation" gates every fixed-asset journal; each class's settings are a version
// prepared by one person and approved by another, never changed once approved.
import { useState } from "react";
import Link from "next/link";
import { Plus } from "lucide-react";
import { api, ApiError, Badge, Button, Card, CardTitle, Dialog, EmptyState, ErrorState, Field, INPUT, LoadingState, Notice, Table, Td, Th, useApi, useL } from "../../../finance/_components/ui";
import { useCan } from "../../_components/kit";
import { DISPOSAL_MONTH, METHOD, POLICY_STATUS, Pill, START } from "../_ui";

type Acc = { id: string; code: string; name: string; type: string; controlKind: string };
type Pol = { id: string; version: number; status: string; method: string; usefulLifeMonths: number; residualPercent: string; decliningFactor: string | null; startConvention: string; disposalConvention: string; capitalisationThreshold: string; note: string | null; preparedBy: string; preparedByName: string | null; approvedByName: string | null };
type Cls = { id: string; code: string; name: string; nameAr: string | null; cost?: { code: string; name: string }; accum?: { code: string; name: string }; expense?: { code: string; name: string }; policies: Pol[] };
type Policy = { key: string; versions: { id: string; version: number; status: string }[] };
const blankPol = { method: "STRAIGHT_LINE", usefulLifeMonths: "", residualPercent: "0", decliningFactor: "", startConvention: "IN_SERVICE_MONTH", disposalConvention: "NONE", capitalisationThreshold: "", note: "" };

export default function AssetSetupPage() {
  const { L } = useL();
  const { can, user } = useCan();
  const classes = useApi<Cls[]>("/api/accounting/fixed-assets/classes");
  const accounts = useApi<Acc[]>("/api/accounting/fixed-assets/pickers?what=accounts");
  const policies = useApi<Policy[]>("/api/accounting/policies");
  const [newCls, setNewCls] = useState<null | { code: string; name: string; nameAr: string; costAccountId: string; accumAccountId: string; expenseAccountId: string }>(null);
  const [newPol, setNewPol] = useState<null | { cls: Cls; f: typeof blankPol }>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const me = user?.id;
  const statement = (policies.data ?? []).find((p) => p.key === "fixed_assets.depreciation");
  const approved = statement?.versions.some((v) => v.status === "APPROVED");
  const byType = (t: string) => (accounts.data ?? []).filter((a) => a.type === t && !["RECEIVABLE", "PAYABLE", "CASH", "COMMISSION_PAYABLE", "CUSTOMER_ADVANCES"].includes(a.controlKind));

  const send = async (path: string, json: unknown, done: string, close: () => void) => {
    setBusy(true); setMsg(null);
    try { await api(path, { method: "POST", json }); close(); classes.reload(); setMsg({ tone: "ok", text: done }); }
    catch (e) { setMsg({ tone: "bad", text: e instanceof ApiError ? e.message : String(e) }); }
    setBusy(false);
  };

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardTitle title={L("سياسة الأصول الثابتة والإهلاك", "Fixed-asset and depreciation policy")}
          sub={L("بيان يعدّه المحاسب ويعتمده شخص آخر؛ قبل اعتماده لا يُرحَّل أي قيد رسملة أو إهلاك أو استبعاد", "A statement prepared by the accountant and approved by someone else; until it is approved no capitalisation, depreciation or disposal journal posts")}
          right={<>{approved ? <Badge tone="ok">{L("معتمدة", "Approved")}</Badge> : <Badge tone="bad">{L("غير معتمدة — القيود محجوبة", "Not approved — journals blocked")}</Badge>}
            <Link href="/dashboard/accounting/automation"><Button>{L("عرض النص والاعتماد", "Statement and approval")}</Button></Link></>} />
      </Card>
      <Card>
        <CardTitle title={L("فئات الأصول وإعدادات الإهلاك", "Asset classes and depreciation settings")}
          sub={L("كل تغيير إصدار جديد يعتمده شخص آخر · القيم في البيئة المحلية افتراضات تجريبية وليست سياسة الشركة", "Every change is a new version approved by someone else · values in the local environment are synthetic assumptions, not company policy")}
          right={<>{can("fa_setup") && <Button kind="primary" icon={Plus} onClick={() => { setMsg(null); setNewCls({ code: "", name: "", nameAr: "", costAccountId: "", accumAccountId: "", expenseAccountId: "" }); }}>{L("فئة جديدة", "New class")}</Button>}
            <Link href="/dashboard/accounting/assets"><Button>{L("السجل", "Register")}</Button></Link></>} />
        {msg && !newCls && !newPol && <Notice tone={msg.tone}>{msg.text}</Notice>}
        {classes.error ? <ErrorState error={classes.error} onRetry={classes.reload} /> : !classes.data ? <LoadingState /> : classes.data.length === 0 ? <EmptyState title={L("لا فئات بعد", "No classes yet")} /> : (
          <Table>
            <thead><tr><Th>{L("الفئة", "Class")}</Th><Th>{L("حساب الأصل", "Cost")}</Th><Th>{L("المجمع", "Accumulated")}</Th><Th>{L("المصروف", "Expense")}</Th><Th>{L("الطريقة", "Method")}</Th><Th num>{L("العمر", "Life")}</Th><Th num>{L("المتبقية", "Residual")}</Th><Th>{L("بداية الإهلاك", "Start")}</Th><Th>{L("شهر الاستبعاد", "Disposal month")}</Th><Th>{L("الإصدار", "Version")}</Th><Th>{L("إجراء", "Action")}</Th></tr></thead>
            <tbody>{classes.data.flatMap((c) => {
              const shown = c.policies.filter((p) => p.status !== "RETIRED");
              const rows = shown.length ? shown : [null];
              return rows.map((p, i) => (
                <tr key={c.id + (p?.id ?? "none")} className="border-t border-border" data-testid={`class-${c.code}-${p?.status ?? "NONE"}`}>
                  <Td>{i === 0 ? <><b>{c.code}</b> · {L(c.nameAr ?? c.name, c.name)}</> : ""}</Td>
                  <Td>{i === 0 ? c.cost?.code : ""}</Td><Td>{i === 0 ? c.accum?.code : ""}</Td><Td>{i === 0 ? c.expense?.code : ""}</Td>
                  {p ? <>
                    <Td>{L(METHOD[p.method][0], METHOD[p.method][1])}{p.decliningFactor ? ` (×${Number(p.decliningFactor)})` : ""}</Td><Td num>{p.usefulLifeMonths}</Td><Td num>{Number(p.residualPercent)}%</Td>
                    <Td>{L(START[p.startConvention][0], START[p.startConvention][1])}</Td><Td>{L(DISPOSAL_MONTH[p.disposalConvention][0], DISPOSAL_MONTH[p.disposalConvention][1])}</Td>
                    <Td><Pill map={POLICY_STATUS} v={p.status} /> v{p.version}<span className="block text-[11px] text-brown">{p.preparedByName}{p.approvedByName ? ` / ${p.approvedByName}` : ""}</span></Td>
                  </> : <Td className="text-brown" >{L("لا سياسة بعد", "No policy yet")}</Td>}
                  {!p && <><Td /><Td /><Td /><Td /><Td /></>}
                  <Td><div className="flex gap-1 flex-wrap">
                    {p?.status === "DRAFT" && can("fa_approve") && p.preparedBy !== me && <Button kind="primary" onClick={() => send(`/api/accounting/fixed-assets/policies/${p.id}/approve`, {}, L(`اعتُمد الإصدار v${p.version} لفئة ${c.code}.`, `Version ${p.version} of ${c.code} approved.`), () => {})}>{L("اعتماد", "Approve")}</Button>}
                    {p?.status === "DRAFT" && p.preparedBy === me && <span className="text-[12px] text-brown">{L("يعتمدها شخص آخر", "Someone else approves")}</span>}
                    {i === rows.length - 1 && can("fa_setup") && !c.policies.some((q) => q.status === "DRAFT") && <Button onClick={() => { setMsg(null); const cur = c.policies.find((q) => q.status === "APPROVED"); setNewPol({ cls: c, f: cur ? { ...blankPol, method: cur.method, usefulLifeMonths: String(cur.usefulLifeMonths), residualPercent: String(Number(cur.residualPercent)), decliningFactor: cur.decliningFactor ?? "", startConvention: cur.startConvention, disposalConvention: cur.disposalConvention, capitalisationThreshold: cur.capitalisationThreshold } : { ...blankPol } }); }}>{L("إصدار جديد", "New version")}</Button>}
                  </div></Td>
                </tr>));
            })}</tbody>
          </Table>)}
        {(classes.data ?? []).some((c) => c.policies.some((p) => p.status === "DRAFT")) && <Notice tone="warn">{L("الإصدارات المسودة لا يعتمدها إلا غير من أعدّها؛ حتى اعتمادها لا يُسجَّل أصل من الفئة إن لم يكن لها إصدار معتمد.", "Draft versions are approved only by someone other than their preparer; until then an asset cannot be registered in a class with no approved version.")}</Notice>}
      </Card>

      <Dialog open={!!newCls} onClose={() => setNewCls(null)} title={L("فئة أصول جديدة", "New asset class")}>
        {newCls && <div className="grid gap-3">
          <Field label={L("الرمز", "Code")}><input aria-label={L("رمز الفئة", "Class code")} className={INPUT} value={newCls.code} onChange={(e) => setNewCls({ ...newCls, code: e.target.value })} /></Field>
          <Field label={L("الاسم", "Name")}><input aria-label={L("اسم الفئة", "Class name")} className={INPUT} value={newCls.name} onChange={(e) => setNewCls({ ...newCls, name: e.target.value })} /></Field>
          <Field label={L("الاسم بالعربية", "Arabic name")}><input aria-label={L("اسم الفئة بالعربية", "Arabic class name")} className={INPUT} value={newCls.nameAr} onChange={(e) => setNewCls({ ...newCls, nameAr: e.target.value })} /></Field>
          <Field label={L("حساب الأصل", "Cost account")}><select aria-label={L("حساب الأصل", "Cost account")} className={INPUT} value={newCls.costAccountId} onChange={(e) => setNewCls({ ...newCls, costAccountId: e.target.value })}><option value="">—</option>{byType("ASSET").map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</select></Field>
          <Field label={L("حساب مجمع الإهلاك", "Accumulated depreciation account")}><select aria-label={L("حساب مجمع الإهلاك", "Accumulated depreciation account")} className={INPUT} value={newCls.accumAccountId} onChange={(e) => setNewCls({ ...newCls, accumAccountId: e.target.value })}><option value="">—</option>{byType("ASSET").map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</select></Field>
          <Field label={L("حساب مصروف الإهلاك", "Depreciation expense account")}><select aria-label={L("حساب مصروف الإهلاك", "Depreciation expense account")} className={INPUT} value={newCls.expenseAccountId} onChange={(e) => setNewCls({ ...newCls, expenseAccountId: e.target.value })}><option value="">—</option>{byType("EXPENSE").map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</select></Field>
          {msg?.tone === "bad" && <Notice tone="bad">{msg.text}</Notice>}
          <div className="flex gap-2 justify-end"><Button onClick={() => setNewCls(null)}>{L("إغلاق", "Close")}</Button><Button kind="primary" busy={busy} onClick={() => send("/api/accounting/fixed-assets/classes", newCls, L("أُنشئت الفئة؛ أعدّ سياستها ليعتمدها شخص آخر.", "Class created; prepare its policy for someone else to approve."), () => setNewCls(null))}>{L("إنشاء", "Create")}</Button></div>
        </div>}
      </Dialog>

      <Dialog open={!!newPol} onClose={() => setNewPol(null)} title={L(`إصدار سياسة جديد — ${newPol?.cls.code ?? ""}`, `New policy version — ${newPol?.cls.code ?? ""}`)} sub={L("يعتمده شخص آخر؛ لا يتغير بعد اعتماده", "Approved by someone else; never changes once approved")}>
        {newPol && <div className="grid gap-3">
          <Field label={L("الطريقة", "Method")}><select aria-label={L("الطريقة", "Method")} className={INPUT} value={newPol.f.method} onChange={(e) => setNewPol({ ...newPol, f: { ...newPol.f, method: e.target.value } })}>{Object.entries(METHOD).map(([k, v]) => <option key={k} value={k}>{L(v[0], v[1])}</option>)}</select></Field>
          <Field label={L("العمر الإنتاجي (شهر)", "Useful life (months)")}><input aria-label={L("العمر الإنتاجي (شهر)", "Useful life (months)")} inputMode="numeric" className={INPUT} value={newPol.f.usefulLifeMonths} onChange={(e) => setNewPol({ ...newPol, f: { ...newPol.f, usefulLifeMonths: e.target.value } })} /></Field>
          <Field label={L("القيمة المتبقية %", "Residual value %")}><input aria-label={L("القيمة المتبقية %", "Residual value %")} inputMode="decimal" className={INPUT} value={newPol.f.residualPercent} onChange={(e) => setNewPol({ ...newPol, f: { ...newPol.f, residualPercent: e.target.value } })} /></Field>
          {newPol.f.method === "DECLINING_BALANCE" && <Field label={L("معامل التناقص", "Declining factor")}><input aria-label={L("معامل التناقص", "Declining factor")} inputMode="decimal" className={INPUT} value={newPol.f.decliningFactor} onChange={(e) => setNewPol({ ...newPol, f: { ...newPol.f, decliningFactor: e.target.value } })} /></Field>}
          <Field label={L("بداية الإهلاك", "Start")}><select aria-label={L("بداية الإهلاك", "Start")} className={INPUT} value={newPol.f.startConvention} onChange={(e) => setNewPol({ ...newPol, f: { ...newPol.f, startConvention: e.target.value } })}>{Object.entries(START).map(([k, v]) => <option key={k} value={k}>{L(v[0], v[1])}</option>)}</select></Field>
          <Field label={L("شهر الاستبعاد", "Disposal month")}><select aria-label={L("شهر الاستبعاد", "Disposal month")} className={INPUT} value={newPol.f.disposalConvention} onChange={(e) => setNewPol({ ...newPol, f: { ...newPol.f, disposalConvention: e.target.value } })}>{Object.entries(DISPOSAL_MONTH).map(([k, v]) => <option key={k} value={k}>{L(v[0], v[1])}</option>)}</select></Field>
          <Field label={L("حد الرسملة", "Capitalisation threshold")}><input aria-label={L("حد الرسملة", "Capitalisation threshold")} inputMode="decimal" className={INPUT} value={newPol.f.capitalisationThreshold} onChange={(e) => setNewPol({ ...newPol, f: { ...newPol.f, capitalisationThreshold: e.target.value } })} /></Field>
          <Field label={L("ملاحظة", "Note")}><input aria-label={L("ملاحظة", "Note")} className={INPUT} value={newPol.f.note} onChange={(e) => setNewPol({ ...newPol, f: { ...newPol.f, note: e.target.value } })} /></Field>
          {msg?.tone === "bad" && <Notice tone="bad">{msg.text}</Notice>}
          <div className="flex gap-2 justify-end"><Button onClick={() => setNewPol(null)}>{L("إغلاق", "Close")}</Button><Button kind="primary" busy={busy} onClick={() => send(`/api/accounting/fixed-assets/classes/${newPol.cls.id}/policies`, newPol.f, L("أُعدّ الإصدار؛ بانتظار اعتماد شخص آخر.", "Version prepared; waiting for someone else to approve it."), () => setNewPol(null))}>{L("إعداد الإصدار", "Prepare version")}</Button></div>
        </div>}
      </Dialog>
    </div>
  );
}
