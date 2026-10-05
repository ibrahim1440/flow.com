"use client";

// Figma: ACC-05. Chart of accounts as an indented tree with control-account and posting-role
// badges; create/edit in a dialog. The server refuses cycles, type changes on accounts with
// postings, and disabling a mapped account.
import { useMemo, useState } from "react";
import { Plus, Upload } from "lucide-react";
import { ApiError, Badge, Button, Card, Dialog, EmptyState, ErrorState, Field, INPUT, LoadingState, Notice, Segmented, Table, Td, Th, api, useApi, useL, useFinance } from "../../finance/_components/ui";
import { ROLE_LABELS, useCan } from "../_components/kit";

type Account = { id: string; code: string; nameEn: string; nameAr: string | null; type: string; parentId: string | null; allowPosting: boolean; isActive: boolean; controlKind: string; allowManualPosting: boolean; cashFlowClass: string | null; lineCount: number; roles: string[] };
const TYPE_LABEL: Record<string, [string, string]> = { ASSET: ["أصول", "Asset"], LIABILITY: ["التزامات", "Liability"], EQUITY: ["حقوق ملكية", "Equity"], REVENUE: ["إيرادات", "Revenue"], EXPENSE: ["مصروفات", "Expense"] };
const CONTROL_LABEL: Record<string, [string, string]> = {
  RECEIVABLE: ["مراقبة · ذمم مدينة", "Control · receivables"], PAYABLE: ["مراقبة · ذمم دائنة", "Control · payables"], INVENTORY: ["مراقبة · مخزون", "Control · inventory"],
  TAX: ["ضريبة", "Tax"], COMMISSION_PAYABLE: ["مراقبة · عمولات", "Control · commissions"], CUSTOMER_ADVANCES: ["مراقبة · دفعات مقدمة", "Control · customer advances"],
  CASH: ["نقدية", "Cash"], CLEARING: ["وسيط", "Clearing"],
};
type Filter = "ALL" | "POSTABLE" | "CONTROL" | "INACTIVE";
const CASH_FLOW_LABEL: Record<string, [string, string]> = { CASH: ["نقد", "Cash"], OPERATING: ["تشغيلية", "Operating"], INVESTING: ["استثمارية", "Investing"], FINANCING: ["تمويلية", "Financing"], EXCLUDED: ["مستبعد", "Excluded"] };
type Form = { id?: string; code: string; nameEn: string; nameAr: string; type: string; parentId: string; allowPosting: boolean; isActive: boolean; controlKind: string; allowManualPosting: boolean; cashFlowClass: string };

export default function AccountsPage() {
  const { L, name } = useL();
  const { can } = useCan();
  const { refresh } = useFinance();
  const { data, error, reload } = useApi<Account[]>("/api/accounting/coa");
  const [filter, setFilter] = useState<Filter>("ALL");
  const [q, setQ] = useState("");
  const [form, setForm] = useState<Form | null>(null);
  const [formErr, setFormErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const tree = useMemo(() => {
    if (!data) return [];
    const kids = new Map<string | null, Account[]>();
    for (const a of data) kids.set(a.parentId, [...(kids.get(a.parentId) ?? []), a]);
    const out: { a: Account; depth: number; isParent: boolean }[] = [];
    const walk = (pid: string | null, depth: number) => { for (const a of (kids.get(pid) ?? []).sort((x, y) => x.code.localeCompare(y.code))) { out.push({ a, depth, isParent: kids.has(a.id) }); walk(a.id, depth + 1); } };
    walk(null, 0);
    return out;
  }, [data]);
  const shown = tree.filter(({ a, isParent }) => {
    if (filter === "POSTABLE" && (isParent || !a.allowPosting || !a.isActive)) return false;
    if (filter === "CONTROL" && a.controlKind === "NONE") return false;
    if (filter === "INACTIVE" && a.isActive) return false;
    if (q && !`${a.code} ${a.nameEn} ${a.nameAr ?? ""}`.toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  });

  const save = async () => {
    if (!form) return;
    setBusy(true); setFormErr(null);
    try {
      const body = { ...form, parentId: form.parentId || null, nameAr: form.nameAr || null };
      if (form.id) await api(`/api/accounting/coa/${form.id}`, { method: "PATCH", json: body });
      else await api("/api/accounting/coa", { method: "POST", json: body });
      setForm(null); reload(); refresh();
    } catch (e) { setFormErr(e instanceof ApiError ? e.message : String(e)); } finally { setBusy(false); }
  };
  const loadTemplate = async () => {
    setBusy(true);
    try { await api("/api/accounting/setup/template", { method: "POST", json: {} }); reload(); refresh(); } catch (e) { alert(e instanceof ApiError ? e.message : String(e)); } finally { setBusy(false); }
  };

  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return <LoadingState />;
  if (data.length === 0) return (
    <EmptyState title={L("دليل الحسابات فارغ", "The chart of accounts is empty")} body={L("حمّل القالب المبدئي (بانتظار مراجعة المحاسب) أو أنشئ الحسابات يدوياً.", "Load the starting template (pending the accountant's review) or create accounts by hand.")}>
      {can("coa_manage") && <><Button kind="primary" icon={Upload} busy={busy} onClick={loadTemplate}>{L("تحميل القالب", "Load template")}</Button>
        <Button icon={Plus} onClick={() => setForm({ code: "", nameEn: "", nameAr: "", type: "EXPENSE", parentId: "", allowPosting: true, isActive: true, controlKind: "NONE", allowManualPosting: true, cashFlowClass: "" })}>{L("حساب جديد", "New account")}</Button></>}
    </EmptyState>
  );

  return (
    <Card>
      <div className="flex items-end gap-3 flex-wrap justify-between">
        <div className="flex items-end gap-3 flex-wrap">
          <Segmented<Filter> value={filter} onChange={setFilter} options={[{ value: "ALL", label: L("الكل", "All") }, { value: "POSTABLE", label: L("قابلة للترحيل", "Postable") }, { value: "CONTROL", label: L("مراقبة", "Control") }, { value: "INACTIVE", label: L("غير نشطة", "Inactive") }]} />
          <Field label={L("بحث", "Search")}><input className={INPUT} placeholder={L("رمز أو اسم الحساب…", "Account code or name…")} value={q} onChange={(e) => setQ(e.target.value)} /></Field>
        </div>
        {can("coa_manage") && <Button kind="primary" icon={Plus} onClick={() => setForm({ code: "", nameEn: "", nameAr: "", type: "EXPENSE", parentId: "", allowPosting: true, isActive: true, controlKind: "NONE", allowManualPosting: true, cashFlowClass: "" })}>{L("حساب جديد", "New account")}</Button>}
      </div>
      <Table>
        <thead><tr><Th>{L("الرمز", "Code")}</Th><Th>{L("الحساب", "Account")}</Th><Th>{L("النوع", "Type")}</Th><Th>{L("الخصائص", "Properties")}</Th><Th>{L("دور الترحيل", "Posting role")}</Th><Th></Th></tr></thead>
        <tbody>
          {shown.map(({ a, depth, isParent }) => (
            <tr key={a.id} className={isParent ? "bg-[#fafafa]" : "hover:bg-cream/40"}>
              <Td className={`tabular-nums ${isParent ? "font-bold" : ""}`}>{a.code}</Td>
              <Td className={isParent ? "font-bold" : ""}><span style={{ paddingInlineStart: depth * 18 }}>{name(a)}</span></Td>
              <Td className={isParent ? "font-bold" : ""}>{L(...TYPE_LABEL[a.type])}</Td>
              <Td>
                <span className="flex gap-1.5 flex-wrap">
                  {isParent && <Badge tone="info">{L("رئيسي · لا يُرحّل عليه", "Parent · no postings")}</Badge>}
                  {a.controlKind !== "NONE" && <Badge tone={a.controlKind === "CASH" ? "info" : "warn"}>{L(...(CONTROL_LABEL[a.controlKind] ?? [a.controlKind, a.controlKind]))}</Badge>}
                  {a.controlKind !== "NONE" && !a.allowManualPosting && <Badge tone="bad">{L("لا قيد يدوي", "No manual entries")}</Badge>}
                  {!a.isActive && <Badge tone="bad">{L("غير نشط", "Inactive")}</Badge>}
                  {a.lineCount > 0 && <Badge tone="info">{L(`حركات: ${a.lineCount}`, `Lines: ${a.lineCount}`)}</Badge>}
                </span>
              </Td>
              <Td><span className="flex gap-1 flex-wrap">{a.roles.map((r) => <Badge key={r} tone="brand">{L(...(ROLE_LABELS[r] ?? [r, r]))}</Badge>)}</span></Td>
              <Td>{can("coa_manage") && <button type="button" className="text-[13px] font-bold text-orange hover:underline" onClick={() => setForm({ id: a.id, code: a.code, nameEn: a.nameEn, nameAr: a.nameAr ?? "", type: a.type, parentId: a.parentId ?? "", allowPosting: a.allowPosting, isActive: a.isActive, controlKind: a.controlKind, allowManualPosting: a.allowManualPosting, cashFlowClass: a.cashFlowClass ?? "" })}>{L("تعديل", "Edit")}</button>}</Td>
            </tr>
          ))}
        </tbody>
      </Table>
      <Notice tone="warn">{L("حساب عليه حركات لا يتغير نوعه ولا رمزه ولا يصبح حساباً رئيسياً — تمنع قاعدة البيانات ذلك. الحساب المرتبط بدور ترحيل لا يُعطَّل قبل ربط الدور بحساب آخر.", "An account with postings keeps its type and code and cannot become a parent — the database refuses it. An account mapped to a posting role cannot be disabled until the role is mapped elsewhere.")}</Notice>

      <Dialog open={!!form} onClose={() => setForm(null)} title={form?.id ? L("تعديل حساب", "Edit account") : L("حساب جديد", "New account")}>
        {form && (
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label={L("الرمز", "Code")}><input className={INPUT} dir="ltr" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} /></Field>
              <Field label={L("النوع", "Type")}><select className={INPUT} value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>{Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{L(...v)}</option>)}</select></Field>
              <Field label={L("الاسم بالعربية", "Arabic name")}><input className={INPUT} dir="rtl" value={form.nameAr} onChange={(e) => setForm({ ...form, nameAr: e.target.value })} /></Field>
              <Field label={L("الاسم بالإنجليزية", "English name")}><input className={INPUT} dir="ltr" value={form.nameEn} onChange={(e) => setForm({ ...form, nameEn: e.target.value })} /></Field>
              <Field label={L("الحساب الرئيسي", "Parent account")}>
                <select className={INPUT} value={form.parentId} onChange={(e) => setForm({ ...form, parentId: e.target.value })}>
                  <option value="">{L("— بدون —", "— none —")}</option>
                  {data.filter((a) => a.type === form.type && a.id !== form.id && a.lineCount === 0).map((a) => <option key={a.id} value={a.id}>{a.code} · {name(a)}</option>)}
                </select>
              </Field>
              <Field label={L("نوع المراقبة", "Control type")}>
                <select className={INPUT} value={form.controlKind} onChange={(e) => setForm({ ...form, controlKind: e.target.value })}>
                  <option value="NONE">{L("بدون", "None")}</option>{Object.entries(CONTROL_LABEL).map(([k, v]) => <option key={k} value={k}>{L(...v)}</option>)}
                </select>
              </Field>
              {!["REVENUE", "EXPENSE"].includes(form.type) && <Field label={L("تصنيف التدفقات النقدية", "Cash-flow class")}>
                <select className={INPUT} value={form.cashFlowClass} onChange={(e) => setForm({ ...form, cashFlowClass: e.target.value })}>
                  <option value="">{L("افتراضي القالب", "Template default")}</option>{Object.entries(CASH_FLOW_LABEL).map(([k, v]) => <option key={k} value={k}>{L(...v)}</option>)}
                </select>
              </Field>}
            </div>
            <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={form.allowPosting} onChange={(e) => setForm({ ...form, allowPosting: e.target.checked })} />{L("يقبل الترحيل", "Accepts postings")}</label>
            <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} />{L("نشط", "Active")}</label>
            {form.controlKind !== "NONE" && <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={form.allowManualPosting} onChange={(e) => setForm({ ...form, allowManualPosting: e.target.checked })} />{L("يسمح بالقيود اليدوية", "Allows manual entries")}</label>}
            {formErr && <Notice tone="bad">{formErr}</Notice>}
            <div className="flex gap-2 justify-end"><Button kind="ghost" onClick={() => setForm(null)}>{L("إلغاء", "Cancel")}</Button><Button kind="primary" busy={busy} onClick={save}>{L("حفظ", "Save")}</Button></div>
          </div>
        )}
      </Dialog>
    </Card>
  );
}
