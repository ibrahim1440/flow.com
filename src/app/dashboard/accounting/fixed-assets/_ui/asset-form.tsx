"use client";

// The asset form («إضافة أصل» / edit). Three ways in: from a purchase invoice's EXPENSE line (picks the line: cost,
// date and supplier come from it), manual (against the account it was paid from) or existing at go-live (its
// accumulated depreciation carried in). A category can be created inline (Qoyod blocks: «يجب اضافه تصنيف للأصل اولا»).
// Blank life / residual / method take the category's. An asset in the books edits only its descriptive fields.
import { useRouter } from "next/navigation";
import { useState } from "react";
import { OpsLoading, Btn, Field } from "@/components/ops/ui";
import { Section } from "@/components/chrome";
import { Select } from "@/components/ui/Select";
import { Msg, money, todayRiyadh, useApi, useLang, useWrite } from "../../_ui/shell";
import { CategoryDialog } from "./categories";
import { KIND, METHOD, nameOf, type Asset } from "./fa";

type Opt = { id: string; code: string; name: string | null };
type Options = {
  categories: { id: string; code: string; nameAr: string; nameEn: string | null; usefulLifeMonths: number; method: string; residualPercent: string; zakatDeductible: boolean; isLeasehold: boolean }[];
  branches: { id: string; code: string; nameAr: string | null; nameEn: string }[]; suppliers: { id: string; name: string }[];
  employees: { id: string; fullNameAr: string; fullNameEn: string | null; employeeNo: string }[]; counterAccounts: Opt[];
  defaults: { bank: string | null; cash: string | null }; books: { active: boolean; goLiveDate: string | null; openingPosted: boolean };
  sod: { selfAllowed: boolean }; can: { write: boolean; post: boolean; reverse: boolean; opening: boolean };
};
type Line = { lineId: string; description: string; remaining: string; capacity?: string; usedIn?: { fixedAssets: string; deferrals: string }; invoice: { id: string; number: string; supplierRef: string; invoiceDate: string; inBooks: boolean; supplier: { id: string; name: string } } };

const empty = (today: string) => ({
  code: "", nameAr: "", nameEn: "", categoryId: "", branchId: "", location: "", supplierId: "", acquisitionKind: "MANUAL", supplierInvoiceLineId: "", counterAccountId: "",
  acquisitionDate: today, inServiceDate: today, cost: "", residualValue: "", usefulLifeMonths: "", method: "", openingAccumulated: "", serialNumber: "", custodianEmployeeId: "", notes: "",
  attachments: [] as { name: string; url: string }[],
  /** "" = the category's; "DEDUCTED" / "NOT_DEDUCTED" override it (council F4). */
  zakatDeductible: "" as "" | "DEDUCTED" | "NOT_DEDUCTED", leaseEndDate: "",
});
type F = ReturnType<typeof empty>;

export function fromAsset(a: Asset): F {
  return { code: a.code, nameAr: a.nameAr, nameEn: a.nameEn ?? "", categoryId: a.category.id, branchId: a.branch?.id ?? "", location: a.location ?? "", supplierId: a.supplier?.id ?? "", acquisitionKind: a.acquisitionKind,
    supplierInvoiceLineId: a.supplierInvoiceLineId ?? "", counterAccountId: a.counterAccount?.id ?? "", acquisitionDate: a.acquisitionDate, inServiceDate: a.inServiceDate ?? "", cost: a.cost, residualValue: a.residualValue,
    usefulLifeMonths: String(a.usefulLifeMonths), method: a.method, openingAccumulated: a.openingAccumulated ?? "", serialNumber: a.serialNumber ?? "", custodianEmployeeId: a.custodianEmployeeId ?? "", notes: a.notes ?? "", attachments: a.attachments,
    zakatDeductible: a.zakatDeductible === null ? "" : a.zakatDeductible ? "DEDUCTED" : "NOT_DEDUCTED", leaseEndDate: a.leaseEndDate ?? "" };
}

export function AssetForm({ asset, onDone }: { asset?: Asset | null; onDone?: () => void }) {
  const { L, ar } = useLang();
  const router = useRouter();
  const opts = useApi<Options>("/api/accounting/fixed-assets/options");
  const lines = useApi<{ rows: Line[] }>("/api/accounting/fixed-assets/invoice-lines");
  const w = useWrite();
  const [f, setF] = useState<F>(asset ? fromAsset(asset) : empty(todayRiyadh()));
  const [catOpen, setCatOpen] = useState(false);
  const locked = !!asset && asset.status !== "DRAFT";
  const set = <K extends keyof F>(k: K, v: F[K]) => setF((x) => ({ ...x, [k]: v }));
  const o = opts.data;
  const cat = o?.categories.find((c) => c.id === f.categoryId);
  if (o && !f.counterAccountId && o.defaults.bank && f.acquisitionKind === "MANUAL" && !asset) set("counterAccountId", o.defaults.bank);
  if (o && !f.categoryId && o.categories[0] && !asset) set("categoryId", o.categories[0].id);

  function pickLine(id: string) {
    const l = lines.data?.rows.find((x) => x.lineId === id);
    setF((x) => ({ ...x, supplierInvoiceLineId: id, ...(l ? { cost: l.remaining, acquisitionDate: l.invoice.invoiceDate, inServiceDate: x.inServiceDate < l.invoice.invoiceDate ? l.invoice.invoiceDate : x.inServiceDate, supplierId: l.invoice.supplier.id, nameAr: x.nameAr || l.description } : {}) }));
  }
  const body = () => ({ ...f, usefulLifeMonths: f.usefulLifeMonths || null, residualValue: f.residualValue || null, method: f.method || null, openingAccumulated: f.acquisitionKind === "OPENING" ? f.openingAccumulated || "0" : null,
    supplierInvoiceLineId: f.supplierInvoiceLineId || null, counterAccountId: f.counterAccountId || null, attachments: f.attachments.filter((a) => a.name && a.url),
    zakatDeductible: f.zakatDeductible || null, leaseEndDate: cat?.isLeasehold ? f.leaseEndDate || null : null });
  async function save(activate: boolean) {
    const r = asset ? await w.run<Asset>("save", `/api/accounting/fixed-assets/${asset.id}`, "PATCH", body()) : await w.run<Asset>(activate ? "activate" : "save", "/api/accounting/fixed-assets", "POST", body());
    if (!r) return;
    if (activate && (!asset || asset.status === "DRAFT")) {
      const a = await w.run("activate", `/api/accounting/fixed-assets/${r.id}/activate`, "POST", {});
      if (!a) { router.replace(`/dashboard/accounting/fixed-assets/${r.id}`); return; }
    }
    if (onDone) onDone(); else router.push(`/dashboard/accounting/fixed-assets/${r.id}`);
  }
  if (!o) return <OpsLoading />;
  const dis = locked;
  // The lease term in whole months from the in-service date (a hint; the server checks the life ends by the lease end).
  const leaseMonths = cat?.isLeasehold && f.leaseEndDate && f.inServiceDate && f.leaseEndDate > f.inServiceDate
    ? (() => { const a = new Date(`${f.inServiceDate}T00:00:00Z`), b = new Date(`${f.leaseEndDate}T00:00:00Z`); b.setUTCDate(b.getUTCDate() + 1); return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + b.getUTCMonth() - a.getUTCMonth() - (b.getUTCDate() < a.getUTCDate() ? 1 : 0); })() : null;
  // Activation posts (journal_post); the preparer activating their own asset needs the segregation-of-duties setting.
  const canActivate = o.can.post && o.sod.selfAllowed;
  return (
    <>
      <Msg error={w.error ?? opts.error} />
      <Section title={L("بيانات الأصل", "Asset details")} testId="fa-form">
        <div className="fa-body">
          <div className="fa-form">
            <Field label={L("اسم الأصل", "Asset name")}><input className="hr-input" value={f.nameAr} onChange={(e) => set("nameAr", e.target.value)} data-testid="faf-name" /></Field>
            <Field label={L("الاسم بالإنجليزية", "English name")}><input className="hr-input" dir="ltr" value={f.nameEn} onChange={(e) => set("nameEn", e.target.value)} /></Field>
            <Field label={L("الرمز (فارغ = تلقائي)", "Code (blank = automatic)")}><input className="hr-input" dir="ltr" value={f.code} disabled={dis} onChange={(e) => set("code", e.target.value)} data-testid="faf-code" /></Field>
            <Field label={L("التصنيف", "Category")} help={cat ? L(`افتراضي: ${cat.usefulLifeMonths} شهرًا · متبقية ${cat.residualPercent}٪ · ${METHOD[cat.method]?.[0] ?? ""}`, `Default: ${cat.usefulLifeMonths} months · residual ${cat.residualPercent}% · ${METHOD[cat.method]?.[1] ?? ""}`) : undefined}>
              <span className="acct-actions"><Select value={f.categoryId} disabled={dis} onChange={(e) => set("categoryId", e.target.value)} data-testid="faf-category">{o.categories.map((c) => <option key={c.id} value={c.id}>{nameOf(c, ar)}</option>)}</Select>
                {!dis ? <button type="button" className="hr-btn is-sm" onClick={() => setCatOpen(true)} data-testid="faf-newcat">{L("+ تصنيف جديد", "+ New category")}</button> : null}</span>
            </Field>
          </div>
          <div className="acct-seg" role="group" aria-label={L("طريقة الاقتناء", "How it was acquired")}>
            {(["PURCHASE_INVOICE", "MANUAL", "OPENING"] as const).map((k) => <button key={k} type="button" disabled={dis} aria-pressed={f.acquisitionKind === k} onClick={() => set("acquisitionKind", k)} data-testid={`faf-kind-${k}`}>{L(KIND[k][0], KIND[k][1])}</button>)}
          </div>
          <div className="fa-form">
            {f.acquisitionKind === "PURCHASE_INVOICE" ? (
              <Field label={L("سطر فاتورة المشتريات (مصروف)", "Purchase-invoice line (expense)")} wide help={!lines.data?.rows.length ? L("لا أسطر مصروف مرحّلة متاحة للرسملة.", "No posted expense lines left to capitalise.") : L("تُعاد تصنيف قيمة السطر من حساب المصروف إلى الأصل.", "The line's amount is reclassified from the expense account to the asset.")}>
                <Select value={f.supplierInvoiceLineId} disabled={dis} onChange={(e) => pickLine(e.target.value)} data-testid="faf-line">
                  <option value="">{L("اختر السطر", "Choose the line")}</option>
                  {(lines.data?.rows ?? []).map((l) => <option key={l.lineId} value={l.lineId}>{`${l.invoice.number} · ${l.invoice.supplier.name} · ${l.description} · ${money(l.remaining)}${l.usedIn && (Number(l.usedIn.fixedAssets) || Number(l.usedIn.deferrals)) ? ` · ${L("مستخدم في", "used in")}: ${L("أصل ثابت", "fixed asset")} ${money(l.usedIn.fixedAssets)} / ${L("تأجيل", "deferral")} ${money(l.usedIn.deferrals)}` : ""}`}</option>)}
                </Select>
              </Field>
            ) : null}
            {f.acquisitionKind === "MANUAL" ? (
              <Field label={L("دُفع من حساب", "Paid from account")} help={o.books.active ? undefined : L("قبل بدء المحاسبة لا يُرحَّل قيد؛ يكفي تركه.", "Before go-live no entry posts; it may be left.")}>
                <Select value={f.counterAccountId} disabled={dis} onChange={(e) => set("counterAccountId", e.target.value)} data-testid="faf-counter"><option value="">{L("—", "—")}</option>{o.counterAccounts.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</Select>
              </Field>
            ) : null}
            {f.acquisitionKind === "OPENING" ? (
              <Field label={L("مجمع الإهلاك المرحّل من الدفاتر السابقة", "Accumulated depreciation carried in")} help={o.books.goLiveDate ? L(`كما في اليوم السابق لـ ${o.books.goLiveDate}`, `As at the day before ${o.books.goLiveDate}`) : L("حدّد تاريخ بدء المحاسبة أولًا.", "Set the go-live date first.")}>
                <input className="hr-input acct-amount" dir="ltr" value={f.openingAccumulated} disabled={dis} onChange={(e) => set("openingAccumulated", e.target.value)} data-testid="faf-opening" />
              </Field>
            ) : null}
            <Field label={L("تاريخ الاقتناء", "Acquisition date")}><input type="date" className="hr-input" value={f.acquisitionDate} disabled={dis} onChange={(e) => set("acquisitionDate", e.target.value)} data-testid="faf-acq" /></Field>
            <Field label={L("تاريخ بدء الاستخدام (يبدأ الإهلاك منه)", "In-service date (depreciation starts)")}><input type="date" className="hr-input" value={f.inServiceDate} disabled={dis} onChange={(e) => set("inServiceDate", e.target.value)} data-testid="faf-inservice" /></Field>
            <Field label={L("التكلفة (ر.س، دون ضريبة قابلة للاسترداد)", "Cost (SAR, excl. recoverable VAT)")}><input className="hr-input acct-amount" dir="ltr" inputMode="decimal" value={f.cost} disabled={dis} onChange={(e) => set("cost", e.target.value)} data-testid="faf-cost" /></Field>
            <Field label={L("القيمة المتبقية (فارغ = نسبة التصنيف)", "Residual value (blank = category %)")}><input className="hr-input acct-amount" dir="ltr" value={f.residualValue} disabled={dis} onChange={(e) => set("residualValue", e.target.value)} data-testid="faf-residual" /></Field>
            <Field label={L("العمر الإنتاجي بالأشهر (فارغ = التصنيف)", "Useful life in months (blank = category)")}><input className="hr-input" dir="ltr" inputMode="numeric" value={f.usefulLifeMonths} disabled={dis} onChange={(e) => set("usefulLifeMonths", e.target.value.replace(/\D/g, ""))} data-testid="faf-life" /></Field>
            <Field label={L("طريقة الإهلاك", "Method")}><Select value={f.method} disabled={dis} onChange={(e) => set("method", e.target.value)}><option value="">{L("طريقة التصنيف", "The category's")}</option>{Object.entries(METHOD).map(([k, v]) => <option key={k} value={k}>{L(v[0], v[1])}</option>)}</Select></Field>
            {cat?.isLeasehold ? (
              <Field label={L("تاريخ نهاية عقد الإيجار", "Lease end date")} help={L(`العمر الإنتاجي: الأقل من 5 سنوات ومدة العقد${leaseMonths !== null ? ` — مدة العقد من بدء الاستخدام ${leaseMonths} شهرًا` : ""}.`, `Useful life: the shorter of 5 years and the lease term${leaseMonths !== null ? ` — the lease runs ${leaseMonths} months from the in-service date` : ""}.`)}>
                <input type="date" className="hr-input" value={f.leaseEndDate} disabled={dis} onChange={(e) => set("leaseEndDate", e.target.value)} data-testid="faf-lease-end" />
              </Field>
            ) : null}
            <Field label={L("الزكاة", "Zakat")} help={L("تحقق مع مستشار الزكاة / zatca.gov.sa", "Check with your Zakat adviser / zatca.gov.sa")}>
              <Select value={f.zakatDeductible} onChange={(e) => set("zakatDeductible", e.target.value as F["zakatDeductible"])} data-testid="faf-zakat">
                <option value="">{L(`حسب التصنيف (${cat ? (cat.zakatDeductible ? "مخصوم" : "غير مخصوم") : "—"})`, `The category's (${cat ? (cat.zakatDeductible ? "deducted" : "not deducted") : "—"})`)}</option>
                <option value="DEDUCTED">{L("مخصوم من وعاء الزكاة", "Deducted from the Zakat base")}</option>
                <option value="NOT_DEDUCTED">{L("غير مخصوم من وعاء الزكاة", "Not deducted from the Zakat base")}</option>
              </Select>
            </Field>
          </div>
        </div>
      </Section>
      <Section title={L("الموقع والمسؤول", "Location and custodian")} tone="mid">
        <div className="fa-body"><div className="fa-form">
          <Field label={L("الفرع", "Branch")}><Select value={f.branchId} onChange={(e) => set("branchId", e.target.value)} data-testid="faf-branch"><option value="">{L("—", "—")}</option>{o.branches.map((b) => <option key={b.id} value={b.id}>{nameOf(b, ar)}</option>)}</Select></Field>
          <Field label={L("الموقع", "Location")}><input className="hr-input" value={f.location} onChange={(e) => set("location", e.target.value)} placeholder={L("مثال: صالة المحمصة", "e.g. roastery floor")} /></Field>
          <Field label={L("المورد", "Supplier")}><Select value={f.supplierId} disabled={dis || f.acquisitionKind === "PURCHASE_INVOICE"} onChange={(e) => set("supplierId", e.target.value)}><option value="">{L("—", "—")}</option>{o.suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
          <Field label={L("الرقم التسلسلي", "Serial number")}><input className="hr-input" dir="ltr" value={f.serialNumber} onChange={(e) => set("serialNumber", e.target.value)} data-testid="faf-serial" /></Field>
          <Field label={L("الموظف المسؤول (العهدة)", "Custodian (employee)")}><Select value={f.custodianEmployeeId} onChange={(e) => set("custodianEmployeeId", e.target.value)}><option value="">{L("—", "—")}</option>{o.employees.map((p) => <option key={p.id} value={p.id}>{(ar ? p.fullNameAr : p.fullNameEn || p.fullNameAr)} · {p.employeeNo}</option>)}</Select></Field>
          <Field label={L("ملاحظات", "Notes")} wide><textarea className="hr-input hr-textarea" value={f.notes} onChange={(e) => set("notes", e.target.value)} /></Field>
          <div className="is-wide">
            <span className="hr-label">{L("المرفقات (رابط https: فاتورة، ضمان، صورة)", "Attachments (https link: invoice, warranty, photo)")}</span>
            {f.attachments.map((a, i) => (
              <div className="acct-row" key={i}>
                <input className="hr-input" value={a.name} placeholder={L("الاسم", "Name")} onChange={(e) => set("attachments", f.attachments.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                <input className="hr-input acct-grow" dir="ltr" value={a.url} placeholder="https://" onChange={(e) => set("attachments", f.attachments.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))} />
                <button type="button" className="hr-btn is-sm" onClick={() => set("attachments", f.attachments.filter((_, j) => j !== i))}>{L("إزالة", "Remove")}</button>
              </div>
            ))}
            <button type="button" className="hr-btn is-sm" onClick={() => set("attachments", [...f.attachments, { name: "", url: "" }])}>{L("+ مرفق", "+ Attachment")}</button>
          </div>
        </div></div>
      </Section>
      <div className="acct-foot">
        <span className="acct-hint">{!locked && !canActivate ? L("يُحفظ الأصل مسودة؛ يفعّله شخص آخر لديه صلاحية ترحيل القيود (فصل المهام).", "The asset is saved as a draft; another person with the journal-posting duty activates it (segregation of duties).") : locked ? L("الأصل في السجل: تتغير بياناته الوصفية فقط؛ القيم تتغير بإضافة رأسمالية أو استبعاد.", "The asset is in the register: only its descriptive fields change; amounts change through an addition or a disposal.") : L("«حفظ وتفعيل» يسجّل الاقتناء (ويرحّل قيده إن كانت المحاسبة مفعّلة)؛ المسودة لا تصل إلى الدفاتر.", "«Save and activate» records the acquisition (and posts it when accounting is on); a draft never reaches the books.")}</span>
        <span className="acct-actions">
          <Btn busy={w.busy === "save"} onClick={() => save(false)} data-testid="faf-save">{locked ? L("حفظ التغييرات", "Save changes") : L("حفظ كمسودة", "Save as draft")}</Btn>
          {!locked && canActivate ? <Btn variant="primary" busy={w.busy === "activate"} onClick={() => save(true)} data-testid="faf-activate">{L("حفظ وتفعيل", "Save and activate")}</Btn> : null}
        </span>
      </div>
      <CategoryDialog open={catOpen} initial={null} onClose={() => setCatOpen(false)} onSaved={(id) => { setCatOpen(false); opts.reload(); set("categoryId", id); }} />
    </>
  );
}
