"use client";
// Purchases — Direction 2.1 (migration phase 2; Figma 221:748 at 1440, 273:6591 at 1024, the
// «تسجيل مشتريات» phone page 227:1505).
//
// Requests: GET /api/purchases?period=all, /api/suppliers, /api/green-beans; POST /api/suppliers for a
// new supplier, then POST /api/purchases (inventory › receive). Recording a purchase is the frame's
// pane: docked beside the register at 1440, a drawer at 1024, a full page on the phone. Batch
// "Inventory & products" adds the frame's period filter («آخر 90 يومًا»), the sort, «تصدير» (CSV of
// the same period / sort / search: GET /api/purchases/export), the 30-day metrics and the lot's
// balance before / after in the pane. A «تسجيل مشتريات» link from the green coffee tab arrives with
// ?bean=<lot id> and opens the pane on that lot.
import { Select } from "@/components/ui/Select";
import { useState, useEffect, useCallback, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { Btn, Field, FilterChip, Notice, OpsBanner, OpsLoading, OpsPane, OpsRoot, PageHeader, opsDate, useL } from "@/components/ops/ui";
import { DownloadIcon, SortControl } from "../inventory/_parts/shared";
import { PURCHASE_PERIODS, periodStart, purchaseTotals, sortPurchases, type PurchasePeriod, type PurchaseSort } from "@/lib/inventory/purchases-query";
import "@/components/ops/stock.css";
import { useUser } from "../user-context";
import { hasSubPrivilege } from "@/lib/auth-shared";
import { useI18n } from "@/lib/i18n/context";
import { PlusIcon } from "../_components/stock-materials";

/** A stored quantity for display: "—" when it is not a finite number (Infinity arrives as JSON null), so one bad row cannot crash the screen. */
const fmtQty = (v: number | null | undefined, digits: number): string =>
  typeof v === "number" && Number.isFinite(v) ? v.toFixed(digits) : "—";

const money = (v: number | null | undefined, digits = 2): string =>
  typeof v === "number" && Number.isFinite(v)
    ? v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })
    : "—";

// ─── Types ────────────────────────────────────────────────────────────────────

type Supplier = { id: string; name: string; contact: string | null };
type GreenBean = { id: string; beanType: string; beanTypeAr: string | null; serialNumber: string; quantityKg: number };
type PurchaseRecord = {
  id: string;
  supplier: Supplier;
  itemId: string | null;
  type: string;
  quantity: number;
  costPerUnit: number;
  totalCost: number;
  purchaseDate: string;
  notes: string | null;
  createdAt: string;
};

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
  return {
    supplierId: "",
    isNewSupplier: false,
    newSupplierName: "",
    newSupplierContact: "",
    itemId,
    quantity: "",
    costPerUnit: "",
    purchaseDate: new Date().toISOString().slice(0, 10),
    notes: "",
  };
}

// ─── Add Purchase pane (221:748 drawer · 227:1505 phone page) ────────────────

function AddPurchasePane({
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
          setFormError(j.error || t("error"));
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
        setFormError(j.error || t("purchaseFailed"));
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
      label={t("addPurchase")}
      title={t("addPurchase")}
      sub={t("greenBeanPurchase")}
      phone="page"
      busy={saving}
      onClose={onClose}
      footer={
        <>
          <Btn variant="primary" type="submit" form="purchase-form" disabled={saving} style={{ flex: 1 }}>{saving ? t("saving") : t("addPurchase")}</Btn>
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
              <input className="hr-input" value={form.newSupplierName} onChange={(e) => set("newSupplierName", e.target.value)} placeholder="مثال: شركة المحمصة للتوريد" />
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

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function PurchasesPage() {
  const { t, lang } = useI18n();
  const L = useL();
  const user = useUser();
  const sp = useSearchParams();
  // Recording a purchase is the receiving duty, as the API requires (POST /api/purchases: inventory › receive).
  const canCreate = hasSubPrivilege(user?.permissions ?? {}, "inventory", "receive");
  const beanParam = sp.get("bean") ?? undefined;

  const [purchases, setPurchases] = useState<PurchaseRecord[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [beans, setBeans] = useState<GreenBean[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [period, setPeriod] = useState<PurchasePeriod | "">("90");
  const [sort, setSort] = useState<PurchaseSort>("newest");
  const [showForm, setShowForm] = useState(!!beanParam);
  const [toast, setToast] = useState<{ msg: string; type: "ok" | "err" } | null>(null);

  function showToast(msg: string, type: "ok" | "err" = "ok") {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  }

  // The whole register (newest 1,000): the period filter and the 30-day metrics are both read from it.
  const loadData = useCallback(async () => {
    setLoading(true);
    const [pRes, sRes, bRes] = await Promise.all([
      fetch("/api/purchases?period=all"),
      fetch("/api/suppliers"),
      fetch("/api/green-beans"),
    ]);
    if (pRes.ok) setPurchases(await pRes.json());
    if (sRes.ok) setSuppliers(await sRes.json());
    if (bRes.ok) setBeans(await bRes.json());
    setLoading(false);
  }, []);

  // The first load: the same three requests as loadData, with every state update after the await.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [pRes, sRes, bRes] = await Promise.all([
        fetch("/api/purchases?period=all"),
        fetch("/api/suppliers"),
        fetch("/api/green-beans"),
      ]);
      const [pj, sj, bj] = await Promise.all([pRes, sRes, bRes].map((r) => (r.ok ? r.json() : null)));
      if (cancelled) return;
      if (pj) setPurchases(pj);
      if (sj) setSuppliers(sj);
      if (bj) setBeans(bj);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  const beanMap = useMemo(() => new Map(beans.map((b) => [b.id, b])), [beans]);

  function beanLabel(itemId: string | null): string {
    if (!itemId) return "—";
    const b = beanMap.get(itemId);
    if (!b) return "—";
    return lang === "ar" && b.beanTypeAr ? b.beanTypeAr : b.beanType;
  }

  const effPeriod: PurchasePeriod = period || "all";
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const start = periodStart(effPeriod);
    const rows = purchases.filter((p) => {
      if (start && new Date(p.purchaseDate) < start) return false;
      if (!q) return true;
      const bean = p.itemId ? beanMap.get(p.itemId) : null;
      const beanName = (bean ? `${bean.beanType} ${bean.beanTypeAr ?? ""} ${bean.serialNumber}` : "").toLowerCase();
      return p.supplier.name.toLowerCase().includes(q) || beanName.includes(q) || (p.notes ?? "").toLowerCase().includes(q);
    });
    return sortPurchases(rows, sort);
  }, [purchases, search, beanMap, effPeriod, sort]);

  // 221:748 metrics: the last 30 days (spend, kg with the weighted SAR/kg), and the suppliers.
  const start30 = periodStart("30")!;
  const last30 = purchaseTotals(purchases.filter((p) => new Date(p.purchaseDate) >= start30));
  const uniqueSuppliers = new Set(purchases.map((p) => p.supplier.id)).size;
  const shown = purchaseTotals(filtered);
  const latest = purchases.reduce<PurchaseRecord | null>((a, p) => (!a || p.purchaseDate > a.purchaseDate ? p : a), null);

  function handleSuccess(msg: string) {
    setShowForm(false);
    showToast(msg, "ok");
    loadData();
  }

  const sar = lang === "ar" ? "ر.س" : "SAR";
  const kgU = lang === "ar" ? "كغ" : "kg";
  const open = canCreate && showForm;
  const periodLabel = (p: PurchasePeriod) => (p === "all" ? L("كل الفترات", "All time") : p === "365" ? L("آخر سنة", "Last year") : lang === "ar" ? `آخر ${p} يومًا` : `Last ${p} days`);
  const exportHref = `/api/purchases/export?${new URLSearchParams({ period: effPeriod, sort, ...(search.trim() ? { q: search.trim() } : {}) })}`;
  const opsWord = (n: number) => (lang === "ar" ? (n === 1 ? "عملية شراء واحدة" : n === 2 ? "عمليتا شراء" : n <= 10 ? `${n} عمليات شراء` : `${n} عملية شراء`) : `${n} ${n === 1 ? "purchase" : "purchases"}`);

  return (
    <OpsRoot className="stk-purchases">
    <div className={`hr-split${open ? " has-preview" : ""}`}>
    <div className="hr-page">
      <PageHeader
        title={t("purchasesTitle")}
        actions={<>
          <a className="hr-btn is-ghost" href={exportHref} download data-testid="purchases-export"><DownloadIcon />{L("تصدير", "Export")}</a>
          {canCreate ? <Btn variant="primary" onClick={() => setShowForm(true)}><PlusIcon />{t("addPurchase")}</Btn> : null}
        </>}
      >
        <span className="hr-caption">{t("purchasesSubtitle")}</span>
        <span className="hr-caption">{lang === "ar" ? `${uniqueSuppliers} موردين` : `${uniqueSuppliers} suppliers`}</span>
      </PageHeader>

      {toast ? <OpsBanner tone={toast.type === "ok" ? "success" : "danger"} onClose={() => setToast(null)}>{toast.msg}</OpsBanner> : null}

      {loading ? <OpsLoading /> : (
        <>
          <div className="stk-metrics" style={{ ["--stk-cols" as string]: 3 }}>
            <div>
              <span className="stk-lbl">{L("الإنفاق · آخر 30 يومًا", "Spend · last 30 days")}</span>
              <span className="stk-mid">{money(last30.spend, 0)}<span className="stk-unit">{sar}</span></span>
              <span className="stk-d">{opsWord(last30.count)}</span>
            </div>
            <div>
              <span className="stk-lbl">{L("بن أخضر مستلم · آخر 30 يومًا", "Green coffee received · last 30 days")}</span>
              <span className="stk-mid">{fmtQty(last30.kg, 2)}<span className="stk-unit">{kgU}</span></span>
              <span className="stk-d">{last30.avgPerKg === null ? "—" : lang === "ar" ? `متوسط ${money(last30.avgPerKg)} ر.س للكيلو` : `Average ${money(last30.avgPerKg)} SAR per kg`}</span>
            </div>
            <div>
              <span className="stk-lbl">{t("suppliersCount")}</span>
              <span className="stk-mid">{uniqueSuppliers}</span>
              <span className="stk-d">{latest ? `${L("آخر شراء", "Last purchase")} ${opsDate(latest.purchaseDate, lang)} · ${latest.supplier.name}` : (lang === "ar" ? "مورد نشط" : "active suppliers")}</span>
            </div>
          </div>

          <div className="stk-tool">
            <input type="search" className="hr-input hr-search" placeholder={L("المورد أو البن", "Supplier or coffee")} aria-label={t("searchPurchases")}
              value={search} onChange={(e) => setSearch(e.target.value)} />
            <FilterChip label={L("الفترة", "Period")} value={period} onChange={(v) => setPeriod(v as PurchasePeriod | "")} allLabel={periodLabel("all")}
              options={PURCHASE_PERIODS.filter((p) => p !== "all").map((p) => ({ value: p, label: periodLabel(p) }))} />
            <span className="stk-end">
              <SortControl<PurchaseSort> dir={sort === "oldest" ? "up" : "down"} value={sort} onChange={setSort} options={[
                { value: "newest", label: L("الأحدث", "Newest") }, { value: "oldest", label: L("الأقدم", "Oldest") },
                { value: "cost", label: L("الأعلى تكلفة", "Highest cost") }, { value: "qty", label: L("الأكبر كمية", "Largest quantity") },
              ]} />
            </span>
          </div>

          {filtered.length === 0 ? (
            <div className="hr-state"><h3>{search || period ? t("noData") : t("noPurchases")}</h3></div>
          ) : (
            <div className="hr-tablewrap">
              <table className="hr-table is-mrow" aria-label={t("purchasesTitle")}>
                <thead>
                  <tr>
                    <th>{t("date")}</th>
                    <th>{t("supplier")}</th>
                    <th>{t("greenBeans")}</th>
                    <th className="num">{lang === "ar" ? "الكمية · كغ" : "Qty · kg"}</th>
                    <th className="num">{lang === "ar" ? "سعر الكيلو" : "Price per kg"}</th>
                    <th className="num">{lang === "ar" ? "التكلفة · ر.س" : "Cost · SAR"}</th>
                    <th className="hr-hide-compact hr-hide-preview">{t("notes")}</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((p) => {
                    const bean = p.itemId ? beanMap.get(p.itemId) : undefined;
                    return (
                      <tr key={p.id}>
                        <td className="hr-caption" style={{ color: "var(--text-secondary)" }}>{opsDate(p.purchaseDate, lang)}</td>
                        <td className="m-title">
                          <span className="strong">{p.supplier.name}</span>
                          {p.supplier.contact ? <span className="stk-sub hr-desktop-only" dir="ltr" style={{ textAlign: "start" }}><bdi>{p.supplier.contact}</bdi></span> : null}
                          <span className="hr-msub">
                            {opsDate(p.purchaseDate, lang)} · {beanLabel(p.itemId)} · <span className="hr-num">{fmtQty(p.quantity, 2)}</span> {kgU}
                          </span>
                        </td>
                        <td>
                          <span>{beanLabel(p.itemId)}</span>
                          {bean ? <span className="stk-sub hr-id">{bean.serialNumber}</span> : null}
                        </td>
                        <td className="num"><span className="hr-num">{fmtQty(p.quantity, 2)}</span></td>
                        <td className="num"><span className="hr-num">{fmtQty(p.costPerUnit, 2)}</span></td>
                        <td className="num m-end" style={{ fontWeight: 600 }}><span className="hr-num">{money(p.totalCost)}</span><span className="hr-mobile-only">&nbsp;{sar}</span></td>
                        <td className="hr-hide-compact hr-hide-preview hr-caption" style={{ maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.notes || "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={3}>{opsWord(shown.count)} · {periodLabel(effPeriod)}</td>
                    <td className="num stk-tot"><span className="hr-num">{money(shown.kg)}</span></td>
                    <td />
                    <td className="num stk-tot"><span className="hr-num">{money(shown.spend)}</span></td>
                    <td className="hr-hide-compact hr-hide-preview" />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </>
      )}
    </div>

      {open && !loading ? (
        <AddPurchasePane
          suppliers={suppliers}
          beans={beans}
          initialBean={beanParam}
          onClose={() => setShowForm(false)}
          onSuccess={handleSuccess}
        />
      ) : null}
    </div>
    </OpsRoot>
  );
}
