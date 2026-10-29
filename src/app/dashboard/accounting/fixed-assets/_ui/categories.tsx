"use client";

// «تصنيفات الأصول» — the categories (seeded by the migration), each with its default life, method, residual % and
// accounts (blank = the posting role's account, shown in grey). The editor is also opened inline from the asset form.
import { useState } from "react";
import { OpsLoading, Btn, Field } from "@/components/ops/ui";
import { Dialog } from "@/components/hr/ui";
import { Section } from "@/components/chrome";
import { Select } from "@/components/ui/Select";
import { Msg, useApi, useLang, useWrite } from "../../_ui/shell";
import { METHOD, nameOf, type Can } from "./fa";

type Acc = { code: string; name: string | null; fromRole: boolean } | null;
export type Category = {
  id: string; code: string; nameAr: string; nameEn: string | null; usefulLifeMonths: number; method: string; decliningRatePercent: string | null; residualPercent: string;
  zakatDeductible: boolean; isLeasehold: boolean; isActive: boolean; assets: number; costAccountId: string | null; accumAccountId: string | null; expenseAccountId: string | null; gainLossAccountId: string | null;
  accounts: { cost: Acc; accum: Acc; expense: Acc; gainLoss: Acc };
};
type Opt = { id: string; code: string; name: string | null };
type Options = { categoryAccounts: { asset: Opt[]; expense: Opt[]; gainLoss: Opt[] } };

const blank = { id: "", code: "", nameAr: "", nameEn: "", usefulLifeMonths: "60", method: "STRAIGHT_LINE", decliningRatePercent: "", residualPercent: "0", costAccountId: "", accumAccountId: "", expenseAccountId: "", gainLossAccountId: "", zakatDeductible: true, isLeasehold: false, isActive: true };
type Form = typeof blank;

/** The category editor dialog (create or edit); `onSaved` gets the saved category's id. */
export function CategoryDialog({ open, initial, onClose, onSaved }: { open: boolean; initial: Form | null; onClose: () => void; onSaved: (id: string) => void }) {
  const { L } = useLang();
  const opts = useApi<Options>(open ? "/api/accounting/fixed-assets/options" : null);
  const w = useWrite();
  const [f, setF] = useState<Form>(initial ?? blank);
  const [seen, setSeen] = useState(initial);
  if (initial !== seen) { setSeen(initial); setF(initial ?? blank); }
  const set = (k: keyof Form, v: string | boolean) => setF((x) => ({ ...x, [k]: v }));
  const acc = (k: "costAccountId" | "accumAccountId" | "expenseAccountId" | "gainLossAccountId", list: Opt[] | undefined, label: string) => (
    <Field label={label}><Select value={f[k]} onChange={(e) => set(k, e.target.value)} data-testid={`facat-${k}`}><option value="">{L("حساب الدور الافتراضي", "The role's default account")}</option>{(list ?? []).map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</Select></Field>
  );
  async function save() {
    const r = await w.run<{ id: string }>("save", "/api/accounting/fixed-assets/categories", "POST", { ...f, id: f.id || null, usefulLifeMonths: Number(f.usefulLifeMonths), decliningRatePercent: f.decliningRatePercent || null });
    if (r) onSaved(r.id);
  }
  return (
    <Dialog open={open} title={f.id ? L("تعديل التصنيف", "Edit category") : L("تصنيف جديد", "New category")} onClose={onClose} testId="facat-dialog"
      actions={<><Btn variant="primary" busy={w.busy === "save"} onClick={save} data-testid="facat-save">{L("حفظ التصنيف", "Save category")}</Btn><Btn onClick={onClose}>{L("إلغاء", "Cancel")}</Btn></>}>
      <Msg error={w.error} />
      <div className="fa-form">
        {!f.id ? <Field label={L("الرمز (لاتيني كبير)", "Code (capitals)")}><input className="hr-input" dir="ltr" value={f.code} onChange={(e) => set("code", e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ""))} data-testid="facat-code" /></Field> : null}
        <Field label={L("الاسم", "Name")}><input className="hr-input" value={f.nameAr} onChange={(e) => set("nameAr", e.target.value)} data-testid="facat-name" /></Field>
        <Field label={L("الاسم بالإنجليزية", "English name")}><input className="hr-input" dir="ltr" value={f.nameEn} onChange={(e) => set("nameEn", e.target.value)} /></Field>
        <Field label={L("العمر الإنتاجي (شهر)", "Useful life (months)")}><input className="hr-input" dir="ltr" inputMode="numeric" value={f.usefulLifeMonths} onChange={(e) => set("usefulLifeMonths", e.target.value.replace(/\D/g, ""))} data-testid="facat-life" /></Field>
        <Field label={L("طريقة الإهلاك", "Method")}><Select value={f.method} onChange={(e) => set("method", e.target.value)}>{Object.entries(METHOD).map(([k, v]) => <option key={k} value={k}>{L(v[0], v[1])}</option>)}</Select></Field>
        {f.method === "DECLINING_BALANCE" ? <Field label={L("النسبة السنوية ٪ (فارغ = ضعف القسط الثابت)", "Annual rate % (blank = double straight-line)")}><input className="hr-input" dir="ltr" value={f.decliningRatePercent} onChange={(e) => set("decliningRatePercent", e.target.value)} /></Field> : null}
        <Field label={L("القيمة المتبقية ٪ من التكلفة", "Residual value % of cost")}><input className="hr-input" dir="ltr" value={f.residualPercent} onChange={(e) => set("residualPercent", e.target.value)} data-testid="facat-residual" /></Field>
        {acc("costAccountId", opts.data?.categoryAccounts.asset, L("حساب التكلفة", "Cost account"))}
        {acc("accumAccountId", opts.data?.categoryAccounts.asset, L("حساب مجمع الإهلاك", "Accumulated depreciation account"))}
        {acc("expenseAccountId", opts.data?.categoryAccounts.expense, L("حساب مصروف الإهلاك", "Depreciation expense account"))}
        {acc("gainLossAccountId", opts.data?.categoryAccounts.gainLoss, L("حساب أرباح وخسائر الاستبعاد", "Disposal gain / loss account"))}
        <label className="hr-check is-wide"><input type="checkbox" checked={!f.zakatDeductible} onChange={(e) => set("zakatDeductible", !e.target.checked)} data-testid="facat-zakat" /> {L("غير مخصوم من وعاء الزكاة", "Not deducted from the Zakat base")} <span className="acct-hint">{L("(تحقق مع مستشار الزكاة / zatca.gov.sa)", "(check with your Zakat adviser / zatca.gov.sa)")}</span></label>
        <label className="hr-check is-wide"><input type="checkbox" checked={f.isLeasehold} onChange={(e) => set("isLeasehold", e.target.checked)} data-testid="facat-leasehold" /> {L("تحسينات مبانٍ مستأجرة: العمر الأقل من 5 سنوات ومدة العقد", "Leasehold improvements: the life is the shorter of 5 years and the lease term")}</label>
        {f.id ? <label className="hr-check is-wide"><input type="checkbox" checked={f.isActive} onChange={(e) => set("isActive", e.target.checked)} /> {L("نشط (يظهر في نموذج الأصل)", "Active (offered on the asset form)")}</label> : null}
      </div>
      <p className="acct-hint">{L("يغيّر التصنيف القيم الافتراضية للأصول الجديدة فقط؛ الأصل المسجّل يحتفظ بعمره وطريقته. حساب فارغ يعني حساب الدور في «ربط الحسابات».", "A category sets the defaults of new assets only; a recorded asset keeps its own life and method. A blank account means the role's account in «account mapping».")}</p>
    </Dialog>
  );
}

export function Categories() {
  const { L, ar } = useLang();
  const list = useApi<{ rows: Category[]; can: Can }>("/api/accounting/fixed-assets/categories?all=1");
  const [edit, setEdit] = useState<Form | null>(null);
  const [open, setOpen] = useState(false);
  const accText = (a: Acc) => (a ? <span className={a.fromRole ? "acct-hint" : undefined}><span className="acct-code">{a.code}</span> {a.name}</span> : <span className="acct-warn">{L("غير مربوط", "Not mapped")}</span>);
  return (
    <Section title={L("تصنيفات الأصول", "Asset categories")} testId="facat-list" className="is-flush"
      actions={list.data?.can.write ? <button type="button" className="hr-btn is-sm" onClick={() => { setEdit(null); setOpen(true); }} data-testid="facat-new">{L("+ إضافة تصنيف للأصل", "+ Add a category")}</button> : undefined}>
      <Msg error={list.error} />
      {!list.data ? <OpsLoading /> : (
        <div className="hr-tablewrap">
          <table className="hr-table is-dense">
            <thead><tr><th>{L("التصنيف", "Category")}</th><th className="num">{L("العمر (شهر)", "Life (months)")}</th><th>{L("الطريقة", "Method")}</th><th className="num">{L("المتبقية ٪", "Residual %")}</th>
              <th className="acct-hide-m">{L("التكلفة", "Cost")}</th><th className="acct-hide-m">{L("مجمع الإهلاك", "Accumulated")}</th><th className="acct-hide-m">{L("مصروف الإهلاك", "Expense")}</th><th className="acct-hide-m">{L("الربح / الخسارة", "Gain / loss")}</th>
              <th className="num">{L("الأصول", "Assets")}</th><th>{L("الخيارات", "Options")}</th></tr></thead>
            <tbody>
              {list.data.rows.map((c) => (
                <tr key={c.id} className={c.isActive ? undefined : "is-muted"} data-testid="facat-row">
                  <td>{nameOf(c, ar)}{!c.isActive ? <span className="acct-th-sub">{L("غير نشط", "Inactive")}</span> : null}{!c.zakatDeductible ? <span className="acct-th-sub">{L("غير مخصوم من وعاء الزكاة", "Not deducted from the Zakat base")}</span> : null}{c.isLeasehold ? <span className="acct-th-sub">{L("حتى نهاية العقد (5 سنوات كحد أقصى)", "To the lease end (5 years at most)")}</span> : null}</td>
                  <td className="num">{c.usefulLifeMonths}</td><td>{L(METHOD[c.method]?.[0] ?? c.method, METHOD[c.method]?.[1] ?? c.method)}</td><td className="num">{c.residualPercent}</td>
                  <td className="acct-hide-m">{accText(c.accounts.cost)}</td><td className="acct-hide-m">{accText(c.accounts.accum)}</td><td className="acct-hide-m">{accText(c.accounts.expense)}</td><td className="acct-hide-m">{accText(c.accounts.gainLoss)}</td>
                  <td className="num">{c.assets}</td>
                  <td>{list.data!.can.write ? <button type="button" className="hr-btn is-sm" onClick={() => { setEdit({ ...blank, ...c, nameEn: c.nameEn ?? "", usefulLifeMonths: String(c.usefulLifeMonths), decliningRatePercent: c.decliningRatePercent ?? "", costAccountId: c.costAccountId ?? "", accumAccountId: c.accumAccountId ?? "", expenseAccountId: c.expenseAccountId ?? "", gainLossAccountId: c.gainLossAccountId ?? "" }); setOpen(true); }}>{L("تعديل", "Edit")}</button> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <CategoryDialog open={open} initial={edit} onClose={() => setOpen(false)} onSaved={() => { setOpen(false); list.reload(); }} />
    </Section>
  );
}
