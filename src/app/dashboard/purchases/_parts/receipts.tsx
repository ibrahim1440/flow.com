"use client";
// «الاستلامات» — the receipts register of the purchases screen (phase 2), and «استلام بدون فاتورة», the EXCEPTION path
// (the goods arrived before their bill): the pane is today's green-coffee receive pane, unchanged in fields and API
// (POST /api/suppliers for a new supplier, then POST /api/purchases — inventory › receive). Every receipt shows what
// became of it: the invoice it is on, «لم تُفوتر بعد» with «إنشاء فاتورة من الاستلام», or «معكوس».
// Requests: GET /api/purchases/receipts (the inventory module), /api/suppliers, /api/green-beans.
import { localizeApiError } from "@/lib/i18n/api-errors";
import { Select } from "@/components/ui/Select";
import Link from "next/link";
import { useState, useEffect, useCallback, useMemo } from "react";
import { Btn, Field, FilterChip, Notice, OpsBanner, OpsLoading, OpsPane, opsDate, useL } from "@/components/ops/ui";
import { DownloadIcon, SortControl } from "../../inventory/_parts/shared";
import { PURCHASE_PERIODS, periodStart, purchaseTotals, sortPurchases, type PurchasePeriod, type PurchaseSort } from "@/lib/inventory/purchases-query";
import { useI18n } from "@/lib/i18n/context";

const fmtQty = (v: number | null | undefined, digits: number): string =>
  typeof v === "number" && Number.isFinite(v) ? v.toFixed(digits) : "—";

const money = (v: number | null | undefined, digits = 2): string =>
  typeof v === "number" && Number.isFinite(v)
    ? v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })
    : "—";

type Supplier = { id: string; name: string; contact: string | null };
type GreenBean = { id: string; beanType: string; beanTypeAr: string | null; serialNumber: string; quantityKg: number };

type FormState = {
  supplierId: string;
  isNewSupplier: boolean;
  newSupplierName: string;
  newSupplierContact: string;
  itemId: string;
  quantity: string;
  costPerUnit: string;
  purchaseDate: string;
  notes: string;
};

function emptyForm(itemId = ""): FormState {
  return { supplierId: "", isNewSupplier: false, newSupplierName: "", newSupplierContact: "", itemId, quantity: "", costPerUnit: "", purchaseDate: new Date().toISOString().slice(0, 10), notes: "" };
}

// ─── Add Purchase pane (221:748 drawer · 227:1505 phone page) ────────────────

export function AddPurchasePane({
  suppliers,
  beans,
  initialBean,
  onClose,
  onSuccess,
}: {
  suppliers: Supplier[];
  beans: GreenBean[];
  initialBean?: string;
  onClose: () => void;
  onSuccess: (msg: string) => void;
}) {
  const { t, lang } = useI18n();
  const L = useL();
  const [form, setForm] = useState<FormState>(() => emptyForm(initialBean && beans.some((b) => b.id === initialBean) ? initialBean : ""));
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");

  const set = <K extends keyof FormState>(key: K, val: FormState[K]) =>
    setForm((p) => ({ ...p, [key]: val }));

  const qty = parseFloat(form.quantity) || 0;
  const cpu = parseFloat(form.costPerUnit) || 0;
  const previewTotal = qty * cpu;
  const chosen = beans.find((b) => b.id === form.itemId) ?? null;

  function handleSupplierSelect(val: string) {
    if (val === "__new__") {
      set("isNewSupplier", true);
      set("supplierId", "");
    } else {
      set("isNewSupplier", false);
      set("supplierId", val);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError("");

    if (!form.itemId) { setFormError("اختر صنف البن الأخضر"); return; }
    if (!form.quantity || qty <= 0) { setFormError("أدخل كمية صحيحة"); return; }
    if (!form.costPerUnit || cpu <= 0) { setFormError("أدخل سعر الكيلو"); return; }
    if (!form.purchaseDate) { setFormError("اختر تاريخ الشراء"); return; }
    if (!form.isNewSupplier && !form.supplierId) { setFormError("اختر المورد"); return; }
    if (form.isNewSupplier && !form.newSupplierName.trim()) {
      setFormError("أدخل اسم المورد الجديد");
      return;
    }

    setSaving(true);
    try {
      let supplierId = form.supplierId;

      // Create supplier first if needed
      if (form.isNewSupplier) {
        const sRes = await fetch("/api/suppliers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: form.newSupplierName.trim(),
            contact: form.newSupplierContact.trim() || null,
          }),
        });
        if (!sRes.ok) {
          const j = await sRes.json().catch(() => ({}));
          setFormError(localizeApiError(j, lang) || t("error"));
          setSaving(false);
          return;
        }
        const newSupplier: Supplier = await sRes.json();
        supplierId = newSupplier.id;
      }

      const res = await fetch("/api/purchases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          supplierId,
          itemId: form.itemId,
          quantity: qty,
          costPerUnit: cpu,
          purchaseDate: form.purchaseDate,
          notes: form.notes.trim() || null,
        }),
      });

      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setFormError(localizeApiError(j, lang) || t("purchaseFailed"));
        setSaving(false);
        return;
      }

      onSuccess(t("purchaseAdded"));
    } catch {
      setFormError(t("error"));
      setSaving(false);
    }
  }

  return (
    <OpsPane
      testId="purchase-pane"
      label={L("استلام بدون فاتورة", "Receipt without an invoice")}
      title={L("استلام بدون فاتورة", "Receipt without an invoice")}
      sub={L("للاستثناء: وصلت البضاعة قبل فاتورتها. الأصل «فاتورة مشتريات» تستلم وتسجّل الفاتورة معًا.", "The exception: the goods arrived before their bill. The default is a «Purchase invoice», which receives and records the bill together.")}
      phone="page"
      busy={saving}
      onClose={onClose}
      footer={
        <>
          <Btn variant="primary" type="submit" form="purchase-form" disabled={saving} style={{ flex: 1 }}>{saving ? t("saving") : L("تسجيل الاستلام", "Record the receipt")}</Btn>
          <Btn onClick={onClose} disabled={saving}>{t("cancel")}</Btn>
        </>
      }
    >
      {formError ? <Notice tone="danger">{formError}</Notice> : null}
      <form id="purchase-form" onSubmit={handleSubmit} className="hr-stack" style={{ gap: 14 }}>
        <Field label={`${t("supplier")} *`}>
          <Select className="hr-select" value={form.isNewSupplier ? "__new__" : form.supplierId} onChange={(e) => handleSupplierSelect(e.target.value)}>
            <option value="">{t("selectSupplier")}</option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
            <option value="__new__">＋ {t("addNewSupplier")}</option>
          </Select>
        </Field>

        {form.isNewSupplier && (
          <div className="hr-stack" style={{ gap: 12, padding: 12, borderRadius: 9, background: "var(--surface-subtle)" }}>
            <span className="hr-label">{t("newSupplierSection")}</span>
            <Field label={`${t("supplierName")} *`}>
              <input className="hr-input" value={form.newSupplierName} onChange={(e) => set("newSupplierName", e.target.value)} placeholder={lang === "ar" ? "مثال: شركة المحمصة للتوريد" : "e.g. Roastery Supply Co."} />
            </Field>
            <Field label={t("supplierContact")}>
              <input className="hr-input" dir="ltr" value={form.newSupplierContact} onChange={(e) => set("newSupplierContact", e.target.value)} placeholder="+966 5x xxx xxxx" />
            </Field>
          </div>
        )}

        <Field label={`${t("greenBeans")} *`} help={L("يُضاف الوزن إلى رصيد هذا اللوت، وتُسجَّل حركة «وارد · شراء».", "The weight is added to this lot's balance, and an «In · purchase» movement is recorded.")}>
          <Select className="hr-select" value={form.itemId} onChange={(e) => set("itemId", e.target.value)}>
            <option value="">{t("selectItem")}</option>
            {beans.map((b) => (
              <option key={b.id} value={b.id}>
                {lang === "ar" && b.beanTypeAr ? b.beanTypeAr : b.beanType} ({b.serialNumber})
              </option>
            ))}
          </Select>
        </Field>

        <div className="hr-form" style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}>
          <Field label={`${t("quantityKg")} *`}>
            <input className="hr-input" type="number" min="0.01" step="0.01" value={form.quantity} onChange={(e) => set("quantity", e.target.value)} placeholder="0.00" />
          </Field>
          <Field label={`${t("costPerUnit")} *`}>
            <input className="hr-input" type="number" min="0.01" step="0.01" value={form.costPerUnit} onChange={(e) => set("costPerUnit", e.target.value)} placeholder="0.00" />
          </Field>
        </div>

        <Field label={`${t("purchaseDate")} *`}>
          <input className="hr-input" type="date" value={form.purchaseDate} onChange={(e) => set("purchaseDate", e.target.value)} />
        </Field>

        <Field label={t("notes")}>
          <textarea className="hr-textarea" value={form.notes} onChange={(e) => set("notes", e.target.value)} rows={2}
            placeholder={L("ملاحظات اختيارية عن الشحنة…", "Optional notes about the shipment…")} />
        </Field>

        {previewTotal > 0 || chosen ? (
          <dl className="hr-kv">
            {previewTotal > 0 ? (
              <div>
                <dt>{t("totalCost")}</dt>
                <dd><strong className="hr-num">{money(previewTotal)}</strong> {lang === "ar" ? "ر.س" : "SAR"}</dd>
              </div>
            ) : null}
            {/* 221:748 «رصيد اللوت الآن» / «الرصيد بعد التسجيل»: the lot's balance, then + the quantity. */}
            {chosen ? (
              <div>
                <dt>{L("رصيد اللوت الآن", "Lot balance now")}</dt>
                <dd><span className="hr-num">{fmtQty(chosen.quantityKg, 2)}</span> {lang === "ar" ? "كغ" : "kg"}</dd>
              </div>
            ) : null}
            {chosen && qty > 0 ? (
              <div>
                <dt>{L("الرصيد بعد التسجيل", "Balance after recording")}</dt>
                <dd><strong className="hr-num">{fmtQty(chosen.quantityKg + qty, 2)}</strong> {lang === "ar" ? "كغ" : "kg"}</dd>
              </div>
            ) : null}
          </dl>
        ) : null}
      </form>
    </OpsPane>
  );
}

// ─── The register ─────────────────────────────────────────────────────────────

export type ReceiptRow = {
  id: string; type: string; supplier: Supplier; purchaseDate: string; createdAt: string; quantity: number; costPerUnit: number; totalCost: number; notes: string | null;
  item: { kind: string; id: string; code: string; name: string; nameAr: string | null; unit: string } | null;
  value: string | null; reversed: boolean;
  invoice: { id: string; number: string; status: string; own: boolean } | null;
};

const UNIT: Record<string, [string, string]> = { KG: ["كغ", "kg"], GRAM: ["غ", "g"], PIECE: ["حبة", "pcs"], UNIT: ["وحدة", "units"], LITER: ["لتر", "L"] };

export function ReceiptsTab({ canReceive, canDraft, initialBean }: { canReceive: boolean; canDraft: boolean; initialBean?: string }) {
  const { t, lang } = useI18n();
  const L = useL();
  const [rows, setRows] = useState<ReceiptRow[] | null>(null);
  const [error, setError] = useState("");
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [beans, setBeans] = useState<GreenBean[]>([]);
  const [search, setSearch] = useState("");
  const [period, setPeriod] = useState<PurchasePeriod | "">("90");
  const [which, setWhich] = useState<"" | "open" | "invoiced">("");
  const [sort, setSort] = useState<PurchaseSort>("newest");
  const [showForm, setShowForm] = useState(!!initialBean);
  const [toast, setToast] = useState<{ msg: string; type: "ok" | "err" } | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((x) => x + 1), []);

  useEffect(() => {
    let off = false;
    (async () => {
      const [rRes, sRes, bRes] = await Promise.all([fetch("/api/purchases/receipts"), fetch("/api/suppliers"), fetch("/api/green-beans")]);
      const [rj, sj, bj] = await Promise.all([rRes, sRes, bRes].map((r) => r.json().catch(() => null)));
      if (off) return;
      if (rRes.ok) setRows(rj); else setError(localizeApiError(rj, lang) ?? t("error"));
      if (sRes.ok) setSuppliers(sj);
      if (bRes.ok) setBeans(bj);
    })();
    return () => { off = true; };
  }, [tick, lang, t]);

  const unit = (u: string | undefined) => { const e = UNIT[u ?? ""]; return e ? (lang === "ar" ? e[0] : e[1]) : ""; };
  const itemName = (r: ReceiptRow) => (r.item ? (lang === "ar" && r.item.nameAr ? r.item.nameAr : r.item.name) : "—");
  const effPeriod: PurchasePeriod = period || "all";
  const all = useMemo(() => rows ?? [], [rows]);
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const start = periodStart(effPeriod);
    return sortPurchases(all.filter((p) => {
      if (start && new Date(p.purchaseDate) < start) return false;
      if (which === "open" && (p.invoice || p.reversed)) return false;
      if (which === "invoiced" && (!p.invoice || p.reversed)) return false;
      if (!q) return true;
      return `${p.supplier.name} ${p.item?.name ?? ""} ${p.item?.nameAr ?? ""} ${p.item?.code ?? ""} ${p.notes ?? ""} ${p.invoice?.number ?? ""}`.toLowerCase().includes(q);
    }), sort);
  }, [all, search, effPeriod, sort, which]);

  const live = all.filter((p) => !p.reversed);
  const start30 = periodStart("30")!;
  const last30 = purchaseTotals(live.filter((p) => new Date(p.purchaseDate) >= start30));
  const green30 = purchaseTotals(live.filter((p) => p.type === "GREEN_BEAN" && new Date(p.purchaseDate) >= start30));
  const notInvoiced = live.filter((p) => !p.invoice);
  const notInvoicedValue = notInvoiced.reduce((s, p) => s + (Number(p.value ?? p.totalCost) || 0), 0);
  const shown = purchaseTotals(filtered.filter((p) => !p.reversed));
  const sar = lang === "ar" ? "ر.س" : "SAR";
  const kgU = lang === "ar" ? "كغ" : "kg";
  const open = canReceive && showForm;
  const periodLabel = (p: PurchasePeriod) => (p === "all" ? L("كل الفترات", "All time") : p === "365" ? L("آخر سنة", "Last year") : lang === "ar" ? `آخر ${p} يومًا` : `Last ${p} days`);
  const exportHref = `/api/purchases/export?${new URLSearchParams({ period: effPeriod, sort, ...(search.trim() ? { q: search.trim() } : {}) })}`;
  const opsWord = (n: number) => (lang === "ar" ? (n === 1 ? "استلام واحد" : n === 2 ? "استلامان" : n <= 10 ? `${n} استلامات` : `${n} استلامًا`) : `${n} ${n === 1 ? "receipt" : "receipts"}`);

  function status(p: ReceiptRow) {
    if (p.reversed) return <span className="pur-rev"><span className="hr-dot tone-cancelled"><span>{L("معكوس", "Reversed")}</span></span>{p.invoice ? <Link className="acct-code pur-inv-link" href={`/dashboard/purchases/invoices/${p.invoice.id}`}>{p.invoice.number}</Link> : null}</span>;
    if (p.invoice) return <Link className="acct-code pur-inv-link" href={`/dashboard/purchases/invoices/${p.invoice.id}`}>{p.invoice.number}</Link>;
    return <span className="hr-dot tone-warning" data-testid={`receipt-open-${p.id}`}><span>{L("لم تُفوتر بعد", "Not invoiced yet")}</span></span>;
  }

  return (
    <div className={`hr-split${open ? " has-preview" : ""}`}>
    <div className="hr-stack pur-tab" data-testid="receipts-tab">
      <div className="pur-tabhead">
        <p className="hr-caption">{L("كل بضاعة استُلمت: بفاتورة مشتريات أو بدونها. الاستلام بدون فاتورة استثناء حين تصل البضاعة قبل فاتورتها.", "Every goods receipt: with a purchase invoice or without one. A receipt without an invoice is the exception, for goods that arrive before their bill.")}</p>
        <span className="pur-actions">
          <a className="hr-btn is-ghost" href={exportHref} download data-testid="purchases-export"><DownloadIcon />{L("تصدير", "Export")}</a>
          {canReceive ? <Btn onClick={() => setShowForm(true)} data-testid="receive-without-invoice">{L("استلام بدون فاتورة", "Receipt without an invoice")}</Btn> : null}
        </span>
      </div>

      {toast ? <OpsBanner tone={toast.type === "ok" ? "success" : "danger"} onClose={() => setToast(null)}>{toast.msg}</OpsBanner> : null}

      {error ? <Notice tone="danger">{error}</Notice> : !rows ? <OpsLoading /> : (
        <>
          <div className="stk-metrics" style={{ ["--stk-cols" as string]: 3 }}>
            <div>
              <span className="stk-lbl">{L("المستلم · آخر 30 يومًا", "Received · last 30 days")}</span>
              <span className="stk-mid">{money(last30.spend, 0)}<span className="stk-unit">{sar}</span></span>
              <span className="stk-d">{opsWord(last30.count)}</span>
            </div>
            <div>
              <span className="stk-lbl">{L("بن أخضر مستلم · آخر 30 يومًا", "Green coffee received · last 30 days")}</span>
              <span className="stk-mid">{fmtQty(green30.kg, 2)}<span className="stk-unit">{kgU}</span></span>
              <span className="stk-d">{green30.avgPerKg === null ? "—" : lang === "ar" ? `متوسط ${money(green30.avgPerKg)} ر.س للكيلو` : `Average ${money(green30.avgPerKg)} SAR per kg`}</span>
            </div>
            <div>
              <span className="stk-lbl">{L("لم تُفوتر بعد", "Not invoiced yet")}</span>
              <span className="stk-mid" data-testid="receipts-open-value">{money(notInvoicedValue, 2)}<span className="stk-unit">{sar}</span></span>
              <span className="stk-d">{opsWord(notInvoiced.length)}</span>
            </div>
          </div>

          <div className="stk-tool">
            <input type="search" className="hr-input hr-search" placeholder={L("المورد أو الصنف أو الفاتورة", "Supplier, item or invoice")} aria-label={t("searchPurchases")}
              value={search} onChange={(e) => setSearch(e.target.value)} />
            <FilterChip label={L("الفترة", "Period")} value={period} onChange={(v) => setPeriod(v as PurchasePeriod | "")} allLabel={periodLabel("all")}
              options={PURCHASE_PERIODS.filter((p) => p !== "all").map((p) => ({ value: p, label: periodLabel(p) }))} />
            <FilterChip label={L("الفوترة", "Invoicing")} value={which} onChange={(v) => setWhich(v as "" | "open" | "invoiced")} allLabel={L("الكل", "All")}
              options={[{ value: "open", label: L("لم تُفوتر بعد", "Not invoiced yet") }, { value: "invoiced", label: L("مفوترة", "Invoiced") }]} />
            <span className="stk-end">
              <SortControl<PurchaseSort> dir={sort === "oldest" ? "up" : "down"} value={sort} onChange={setSort} options={[
                { value: "newest", label: L("الأحدث", "Newest") }, { value: "oldest", label: L("الأقدم", "Oldest") },
                { value: "cost", label: L("الأعلى تكلفة", "Highest cost") }, { value: "qty", label: L("الأكبر كمية", "Largest quantity") },
              ]} />
            </span>
          </div>

          {filtered.length === 0 ? (
            <div className="hr-state"><h3>{search || period || which ? t("noData") : t("noPurchases")}</h3></div>
          ) : (
            <div className="hr-tablewrap">
              <table className="hr-table is-mrow" aria-label={L("الاستلامات", "Receipts")} data-testid="receipts-table">
                <thead>
                  <tr>
                    <th>{t("date")}</th>
                    <th>{t("supplier")}</th>
                    <th>{L("الصنف", "Item")}</th>
                    <th className="num">{L("الكمية", "Qty")}</th>
                    <th className="num hr-hide-compact">{L("سعر الوحدة", "Unit price")}</th>
                    <th className="num">{L("التكلفة · ر.س", "Cost · SAR")}</th>
                    <th>{L("الفاتورة", "Invoice")}</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((p) => (
                    <tr key={p.id} className={p.reversed ? "is-muted" : undefined}>
                      <td className="hr-caption" style={{ color: "var(--text-secondary)" }}>{opsDate(p.purchaseDate, lang)}</td>
                      <td className="m-title">
                        <span className="strong">{p.supplier.name}</span>
                        <span className="hr-msub">{opsDate(p.purchaseDate, lang)} · {itemName(p)} · <span className="hr-num">{fmtQty(p.quantity, p.type === "GREEN_BEAN" ? 2 : 0)}</span> {unit(p.item?.unit)}</span>
                      </td>
                      <td><span>{itemName(p)}</span>{p.item ? <span className="stk-sub hr-id">{p.item.code}</span> : null}</td>
                      <td className="num"><span className="hr-num">{fmtQty(p.quantity, p.type === "GREEN_BEAN" ? 2 : 0)}</span> <span className="hr-caption">{unit(p.item?.unit)}</span></td>
                      <td className="num hr-hide-compact"><span className="hr-num">{money(p.costPerUnit, 2)}</span></td>
                      <td className="num" style={{ fontWeight: 600 }}><span className="hr-num">{money(Number(p.value ?? p.totalCost))}</span></td>
                      <td className="m-end">
                        <span className="pur-cell">
                          {status(p)}
                          {!p.invoice && !p.reversed && canDraft && p.value && Number(p.value) > 0 ? (
                            <Link className="hr-btn is-sm is-ghost" href={`/dashboard/purchases/invoices/new?receipt=${p.id}`} data-testid={`invoice-from-${p.id}`}>{L("إنشاء فاتورة من الاستلام", "Create the invoice")}</Link>
                          ) : null}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={5}>{opsWord(shown.count)} · {periodLabel(effPeriod)}</td>
                    <td className="num stk-tot"><span className="hr-num">{money(shown.spend)}</span></td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </>
      )}
    </div>
      {open && rows ? (
        <AddPurchasePane suppliers={suppliers} beans={beans} initialBean={initialBean} onClose={() => setShowForm(false)}
          onSuccess={(msg) => { setShowForm(false); setToast({ msg, type: "ok" }); reload(); }} />
      ) : null}
    </div>
  );
}
