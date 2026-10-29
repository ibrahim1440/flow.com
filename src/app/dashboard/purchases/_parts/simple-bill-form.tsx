"use client";
// «فاتورة بسيطة» (BATCH22 WP-H) — the simple expense invoice form: up to 5 expense lines entered GROSS (the receipt's
// price; the server splits net / VAT, ±0.01 to match the paper), the supplier or «مورد نقدي متنوع» with the vendor's
// name and VAT number, «الموقع», the receipt image (mandatory), and «مدفوعة من» (a cash / bank account) to pay it in the same act.
// Actions (council Q-F2): «حفظ وموافقة» (accounting › ap and the SoD setting allows the preparer) or «حفظ وتقديم
// للاعتماد» («يحتاج اعتماد شخص آخر»), and «حفظ كمسودة». The preview below the lines is display only — the server
// computes and checks every figure (POST /api/purchases/simple).
import Link from "next/link";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Btn, Notice, OpsLoading } from "@/components/ops/ui";
import { Select } from "@/components/ui/Select";
import { localizeApiError } from "@/lib/i18n/api-errors";
import { money, todayRiyadh, useApi, useLang } from "../../accounting/_ui/shell";
import { useLocations } from "../../accounting/_ui/locations";
import type { PurchaseCan } from "./invoices";

type Meta = { can: PurchaseCan; sodSelfAllowed: boolean; simpleMode: boolean };
type Supplier = { id: string; name: string; vatNumber: string | null };
type Expense = { id: string; code: string; nameAr: string; nameEn: string | null; isActive: boolean };
type Consts = { miscSupplierId: string; maxLines: number; maxLineGross: string; taxCodes: string[]; maxAttachmentMb: number };
type Line = { key: number; expenseCategoryId: string; description: string; gross: string; taxCode: string; vat: string };
export type SimpleDraft = {
  id: string; supplierId: string; vendorName: string | null; vendorVatNumber: string | null; supplierRef: string; invoiceDate: string; notes: string | null; branchId?: string | null;
  lines: { expenseCategoryId: string | null; description: string; gross: string; vat: string; taxCode: string | null }[];
};

const TAX: Record<string, [string, string, number]> = {
  "P-S15": ["15% قابلة للاسترداد", "15% recoverable", 15],
  "P-S15-NR": ["15% غير قابلة للاسترداد", "15% not recoverable", 15],
  "P-Z0": ["صفرية", "Zero-rated", 0],
  "P-E0": ["معفاة", "Exempt", 0],
  "P-O": ["خارج النطاق (رسوم حكومية، مخالفات)", "Out of scope (fees, fines)", 0],
};
const VAT_RE = /^3\d{13}3$/;
let seq = 0;
const blank = (taxCode = "P-S15"): Line => ({ key: ++seq, expenseCategoryId: "", description: "", gross: "", taxCode, vat: "" });
/** Display only: net = round(G ÷ (1 + r), 2), VAT = G − net (the server's rule). */
const split = (g: string, rate: number) => {
  const G = Number(g);
  if (!Number.isFinite(G) || G <= 0) return { net: 0, vat: 0 };
  const net = Math.round((G / (1 + rate / 100)) * 100 + 1e-9) / 100;
  return { net, vat: Math.round((G - net) * 100) / 100 };
};

export function SimpleBillForm({ draft = null }: { draft?: SimpleDraft | null }) {
  const { L, lang } = useLang();
  const router = useRouter();
  const meta = useApi<Meta>("/api/purchases/invoices?status=__none__");
  const consts = useApi<Consts>("/api/purchases/simple");
  const sups = useApi<Supplier[]>("/api/accounting/ap/suppliers");
  const exps = useApi<Expense[]>("/api/accounting/ap/categories");
  const branches = useLocations();
  const misc = consts.data?.miscSupplierId ?? "sup_misc_cash";
  const [f, setF] = useState(() => ({
    supplierId: draft?.supplierId ?? "", vendorName: draft?.vendorName ?? "", vendorVatNumber: draft?.vendorVatNumber ?? "",
    supplierRef: draft?.supplierRef ?? "", invoiceDate: draft?.invoiceDate ?? todayRiyadh(), notes: draft?.notes ?? "", branchId: draft?.branchId ?? "", paidFrom: "",
  }));
  const [lines, setLines] = useState<Line[]>(() => draft?.lines.length
    ? draft.lines.map((l) => ({ key: ++seq, expenseCategoryId: l.expenseCategoryId ?? "", description: l.description, gross: l.gross, taxCode: l.taxCode ?? "P-S15", vat: "" }))
    : [blank()]);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const supplierId = f.supplierId || misc;
  const isMisc = supplierId === misc;
  const supplier = (sups.data ?? []).find((s) => s.id === supplierId);
  const hasVat = isMisc ? VAT_RE.test(f.vendorVatNumber.replace(/\s+/g, "")) : !!supplier?.vatNumber;
  const max = Number(consts.data?.maxLineGross ?? 5000);
  const maxLines = consts.data?.maxLines ?? 5;
  const can = meta.data?.can;
  const selfPost = !!meta.data && (meta.data.simpleMode || meta.data.sodSelfAllowed);
  const mayApprove = !!can?.ap && selfPost;
  // «مدفوعة من» = «الحساب» (WP-D paidFromAccountId): the postable cash / bank accounts; none yet (before the chart of
  // accounts exists) — the method alone (cash / bank: its role account).
  const cashAccts = useApi<{ accounts: { id: string; code: string; nameAr: string | null; nameEn: string; controlType: string | null }[] }>(mayApprove ? "/api/accounting/cash-accounts" : null);
  const fromAccounts = (cashAccts.data?.accounts ?? []).filter((a) => a.controlType === "CASH" || a.controlType === "BANK");
  const totals = useMemo(() => lines.reduce((a, l) => {
    const s = split(l.gross, TAX[l.taxCode]?.[2] ?? 0);
    const v = l.vat.trim() !== "" ? Number(l.vat) : s.vat;
    return { net: a.net + (Number(l.gross) || 0) - (Number.isFinite(v) ? v : 0), vat: a.vat + (Number.isFinite(v) ? v : 0), gross: a.gross + (Number(l.gross) || 0) };
  }, { net: 0, vat: 0, gross: 0 }), [lines]);
  const over = lines.some((l) => Number(l.gross) > max);
  const recoverableWithoutVat = lines.some((l) => l.taxCode === "P-S15") && !hasVat;
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));
  const setLine = (key: number, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  async function save(action: "draft" | "submit" | "post") {
    setError(null);
    if (!file && !draft) { setError(L("أرفق صورة الإيصال أو الفاتورة.", "Attach the receipt or invoice image.")); return; }
    setBusy(action);
    const data = {
      supplierId, vendorName: isMisc ? f.vendorName : null, vendorVatNumber: isMisc ? f.vendorVatNumber || null : null,
      supplierRef: f.supplierRef, invoiceDate: f.invoiceDate, notes: f.notes || null, branchId: f.branchId || undefined, action,
      ...(action === "post" && f.paidFrom.startsWith("acct:") ? { paidFromAccountId: f.paidFrom.slice(5) } : { paidFrom: action === "post" && f.paidFrom ? f.paidFrom : null }),
      lines: lines.map((l) => ({ expenseCategoryId: l.expenseCategoryId, description: l.description || null, gross: l.gross, taxCode: l.taxCode, vat: l.vat.trim() || null })),
    };
    const body = new FormData();
    body.set("data", JSON.stringify(data));
    if (file) body.set("file", file);
    const res = await fetch(draft ? `/api/purchases/simple/${draft.id}` : "/api/purchases/simple", { method: draft ? "PATCH" : "POST", body }).catch(() => null);
    setBusy(null);
    const j = res ? await res.json().catch(() => ({})) : {};
    if (!res || !res.ok) { setError(localizeApiError(j, lang) ?? L("تعذّر الحفظ.", "Could not save.")); return; }
    router.replace(`/dashboard/purchases/invoices/${(j as { invoice: { id: string } }).invoice.id}`);
  }

  if (!meta.data || !consts.data || !sups.data || !exps.data) return meta.error || consts.error ? <Notice tone="danger">{meta.error ?? consts.error}</Notice> : <OpsLoading />;
  return (
    <form className="hr-stack sb-form" data-testid="simple-bill-form" onSubmit={(e) => { e.preventDefault(); void save(mayApprove ? "post" : "submit"); }}>
      {error ? <Notice tone="danger"><span data-testid="sb-error">{error}</span></Notice> : null}
      <section className="acct-card" aria-labelledby="sb-head">
        <h2 id="sb-head">{L("بيانات الفاتورة", "Invoice details")}</h2>
        <div className="acct-row">
          <label className="hr-field acct-grow"><span className="hr-label">{L("المورد", "Supplier")}</span>
            <Select value={supplierId} onChange={(e) => set("supplierId", e.target.value)} data-testid="sb-supplier">
              <option value={misc}>{L("مورد نقدي متنوع (بائع لمرة واحدة)", "Misc. cash vendor (one-off)")}</option>
              {(sups.data ?? []).filter((s) => s.id !== misc).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select></label>
          <label className="hr-field"><span className="hr-label">{L("رقم الإيصال / الفاتورة", "Receipt / invoice no.")} *</span>
            <input className="hr-input" dir="ltr" required value={f.supplierRef} onChange={(e) => set("supplierRef", e.target.value)} data-testid="sb-ref" /></label>
          <label className="hr-field"><span className="hr-label">{L("التاريخ", "Date")}</span>
            <input type="date" className="hr-input" required value={f.invoiceDate} onChange={(e) => set("invoiceDate", e.target.value)} data-testid="sb-date" /></label>
          <label className="hr-field"><span className="hr-label">{L("الموقع", "Location")}</span>
            <Select value={f.branchId} onChange={(e) => set("branchId", e.target.value)} data-testid="sb-location">
              <option value="">{L("الافتراضي (موقعك)", "Default (yours)")}</option>
              {branches.map((b) => <option key={b.id} value={b.id}>{L(b.nameAr, b.nameEn)}</option>)}
            </Select></label>
        </div>
        {isMisc ? (
          <div className="acct-row">
            <label className="hr-field acct-grow"><span className="hr-label">{L("اسم البائع", "Vendor name")} *</span>
              <input className="hr-input" required maxLength={200} value={f.vendorName} onChange={(e) => set("vendorName", e.target.value)} placeholder={L("كما في الإيصال", "As on the receipt")} data-testid="sb-vendor" /></label>
            <label className="hr-field"><span className="hr-label">{L("الرقم الضريبي للبائع", "Vendor VAT number")}</span>
              <input className="hr-input" dir="ltr" inputMode="numeric" maxLength={15} value={f.vendorVatNumber} onChange={(e) => set("vendorVatNumber", e.target.value)} placeholder="3XXXXXXXXXXXXX3" data-testid="sb-vendor-vat" /></label>
          </div>
        ) : null}
        <p className="acct-hint">{hasVat
          ? L("الرقم الضريبي ظاهر: ضريبة الأسطر «15% قابلة للاسترداد» تُسترد (الخانة 7) مع إرفاق الفاتورة.", "A VAT number is on file: «15% recoverable» lines are claimed (box 7) with the invoice attached.")
          : L("بلا رقم ضريبي للبائع لا تُسترد الضريبة: اختر «15% غير قابلة للاسترداد» فتُحمَّل على المصروف.", "Without the vendor's VAT number the VAT is not claimed: choose «15% not recoverable» and it goes to the expense.")}</p>
      </section>

      <section className="acct-card" aria-labelledby="sb-lines">
        <h2 id="sb-lines">{L("الأسطر (المبلغ شامل الضريبة)", "Lines (amount VAT inclusive)")}</h2>
        <div className="hr-tablewrap">
          <table className="hr-table is-dense" data-testid="sb-lines-table">
            <thead><tr><th>{L("فئة المصروف", "Expense category")}</th><th>{L("الوصف", "Description")}</th><th>{L("الضريبة", "VAT")}</th><th className="num">{L("المبلغ شامل", "Amount incl.")}</th><th className="num">{L("قبل الضريبة", "Before VAT")}</th><th className="num">{L("قيمة الضريبة", "VAT amount")}</th><th aria-label={L("حذف", "Remove")} /></tr></thead>
            <tbody>
              {lines.map((l, i) => {
                const s = split(l.gross, TAX[l.taxCode]?.[2] ?? 0);
                const rate = TAX[l.taxCode]?.[2] ?? 0;
                return (
                  <tr key={l.key} data-testid={`sb-line-${i}`}>
                    <td><Select value={l.expenseCategoryId} onChange={(e) => setLine(l.key, { expenseCategoryId: e.target.value })} aria-label={L(`فئة المصروف للسطر ${i + 1}`, `Expense category, line ${i + 1}`)} data-testid={`sb-cat-${i}`}>
                      <option value="">{L("اختر", "Choose")}</option>
                      {(exps.data ?? []).filter((x) => x.isActive).map((x) => <option key={x.id} value={x.id}>{L(x.nameAr, x.nameEn || x.nameAr)}</option>)}
                    </Select></td>
                    <td><input className="hr-input" value={l.description} onChange={(e) => setLine(l.key, { description: e.target.value })} aria-label={L(`وصف السطر ${i + 1}`, `Description, line ${i + 1}`)} /></td>
                    <td><Select value={l.taxCode} onChange={(e) => setLine(l.key, { taxCode: e.target.value, vat: "" })} aria-label={L(`ضريبة السطر ${i + 1}`, `VAT, line ${i + 1}`)} data-testid={`sb-tax-${i}`}>
                      {(consts.data?.taxCodes ?? Object.keys(TAX)).map((c) => <option key={c} value={c}>{L(TAX[c]?.[0] ?? c, TAX[c]?.[1] ?? c)}</option>)}
                    </Select></td>
                    <td className="num"><input className="hr-input hr-num" dir="ltr" inputMode="decimal" required value={l.gross} onChange={(e) => setLine(l.key, { gross: e.target.value })} aria-label={L(`المبلغ شامل الضريبة للسطر ${i + 1}`, `Amount incl. VAT, line ${i + 1}`)} data-testid={`sb-gross-${i}`} />
                      {Number(l.gross) > max ? <span className="acct-bad hr-caption" style={{ display: "block" }} data-testid={`sb-over-${i}`}>{L("هل هذا أصل ثابت أو مصروف مقدم؟", "Is this a fixed asset or a prepaid expense?")} <Link href="/dashboard/purchases/invoices/new">{L("الفاتورة الكاملة", "Full invoice")}</Link></span> : null}</td>
                    <td className="num hr-num">{money(s.net)}</td>
                    <td className="num">{rate > 0 ? <input className="hr-input hr-num" dir="ltr" inputMode="decimal" value={l.vat} placeholder={s.vat.toFixed(2)} onChange={(e) => setLine(l.key, { vat: e.target.value })} title={L("عدّل بهللة واحدة على الأكثر لتطابق الورقة", "Adjust by 0.01 at most to match the paper")} aria-label={L(`قيمة الضريبة للسطر ${i + 1}`, `VAT amount, line ${i + 1}`)} data-testid={`sb-vat-${i}`} /> : <span className="hr-num">0.00</span>}</td>
                    <td>{lines.length > 1 ? <Btn size="sm" variant="ghost" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} aria-label={L(`حذف السطر ${i + 1}`, `Remove line ${i + 1}`)}>×</Btn> : null}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot><tr className="is-total"><td colSpan={3}>{L("الإجمالي (ر.س)", "Total (SAR)")}</td><td className="num hr-num" data-testid="sb-total">{money(totals.gross)}</td><td className="num hr-num">{money(totals.net)}</td><td className="num hr-num">{money(totals.vat)}</td><td /></tr></tfoot>
          </table>
        </div>
        {lines.length < maxLines ? <Btn size="sm" variant="ghost" onClick={() => setLines((ls) => [...ls, blank(hasVat ? "P-S15" : "P-S15-NR")])} data-testid="sb-add-line">+ {L("إضافة سطر", "Add a line")}</Btn> : <p className="acct-hint">{L(`حتى ${maxLines} أسطر في الفاتورة البسيطة.`, `Up to ${maxLines} lines on a simple invoice.`)}</p>}
        {recoverableWithoutVat ? <p className="acct-bad" role="status" data-testid="sb-vat-warning">{L("سطر «قابل للاسترداد» يحتاج الرقم الضريبي للبائع.", "A «recoverable» line needs the vendor's VAT number.")}</p> : null}
        <p className="acct-hint">{L("المعاينة للعرض فقط: الخادم يحسب الصافي والضريبة ويتحقق منهما.", "The preview is for display: the server computes and checks net and VAT.")}</p>
      </section>

      <section className="acct-card" aria-labelledby="sb-pay">
        <h2 id="sb-pay">{L("المرفق والسداد", "Receipt and payment")}</h2>
        <div className="acct-row">
          <label className="hr-field acct-grow"><span className="hr-label">{L("صورة الإيصال أو الفاتورة", "Receipt or invoice image")}{draft ? "" : " *"}</span>
            <input type="file" className="hr-input" accept="image/jpeg,image/png,application/pdf" required={!draft} onChange={(e) => setFile(e.target.files?.[0] ?? null)} data-testid="sb-file" />
            <span className="hr-caption">{L(`JPEG أو PNG أو PDF، حتى ${consts.data?.maxAttachmentMb ?? 10} ميغابايت — إلزامي (سند المصروف وشرط استرداد الضريبة).`, `JPEG, PNG or PDF, up to ${consts.data?.maxAttachmentMb ?? 10} MB — required (the expense's evidence and the VAT claim's condition).`)}</span></label>
          {mayApprove ? (
            <label className="hr-field"><span className="hr-label">{L("مدفوعة من", "Paid from")}</span>
              <Select value={f.paidFrom} onChange={(e) => set("paidFrom", e.target.value)} data-testid="sb-paid-from">
                <option value="">{L("لم تُدفع (تبقى في الذمم)", "Not paid (stays payable)")}</option>
                {fromAccounts.length
                  ? fromAccounts.map((a) => <option key={a.id} value={`acct:${a.id}`}>{a.code} · {L(a.nameAr || a.nameEn, a.nameEn)}</option>)
                  : <><option value="CASH">{L("الصندوق (نقدًا)", "Cash")}</option><option value="BANK">{L("البنك", "Bank")}</option></>}
              </Select></label>
          ) : null}
        </div>
        <label className="hr-field"><span className="hr-label">{L("ملاحظات", "Notes")}</span>
          <textarea className="hr-input" rows={2} value={f.notes} onChange={(e) => set("notes", e.target.value)} /></label>
      </section>

      <div className="acct-actions sb-actions">
        {mayApprove
          ? <Btn variant="primary" type="submit" disabled={!!busy || over} data-testid="sb-approve">{busy === "post" ? L("جارٍ الحفظ…", "Saving…") : f.paidFrom ? L("حفظ وموافقة وتسجيل السداد", "Save, approve and record the payment") : L("حفظ وموافقة", "Save and approve")}</Btn>
          : <><Btn variant="primary" type="submit" disabled={!!busy || over} data-testid="sb-submit">{busy === "submit" ? L("جارٍ الحفظ…", "Saving…") : L("حفظ وتقديم للاعتماد", "Save and submit for approval")}</Btn>
            <span className="acct-hint" data-testid="sb-needs-approval">{L("يحتاج اعتماد شخص آخر", "Needs another person's approval")}</span></>}
        <Btn type="button" disabled={!!busy || over} onClick={() => void save("draft")} data-testid="sb-draft">{busy === "draft" ? L("جارٍ الحفظ…", "Saving…") : L("حفظ كمسودة", "Save as draft")}</Btn>
      </div>
    </form>
  );
}
