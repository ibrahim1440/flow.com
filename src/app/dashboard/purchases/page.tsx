"use client";
// Purchases — Direction 2.1 (migration phase 2; Figma 221:748 at 1440, 273:6591 at 1024, the
// «تسجيل مشتريات» phone page 227:1505).
//
// Visual port only: the same requests (GET /api/purchases, /api/suppliers, /api/green-beans; POST
// /api/suppliers for a new supplier, then POST /api/purchases), the same receiving gate and the
// same client validation as the legacy screen. Recording a purchase moves from a centred modal to
// the frame's pane: docked beside the register at 1440, a drawer at 1024, a full page on the phone.
// Export, the period filter and the sort control are drawn in the frame but not built.
import { Select } from "@/components/ui/Select";
import { useState, useEffect, useCallback, useMemo } from "react";
import { Btn, Field, Notice, OpsBanner, OpsLoading, OpsPane, OpsRoot, PageHeader, opsDate, useL } from "@/components/ops/ui";
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
type GreenBean = { id: string; beanType: string; beanTypeAr: string | null; serialNumber: string };
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

function emptyForm(): FormState {
  return {
    supplierId: "",
    isNewSupplier: false,
    newSupplierName: "",
    newSupplierContact: "",
    itemId: "",
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
  onClose,
  onSuccess,
}: {
  suppliers: Supplier[];
  beans: GreenBean[];
  onClose: () => void;
  onSuccess: (msg: string) => void;
}) {
  const { t, lang } = useI18n();
  const L = useL();
  const [form, setForm] = useState<FormState>(emptyForm());
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");

  const set = <K extends keyof FormState>(key: K, val: FormState[K]) =>
    setForm((p) => ({ ...p, [key]: val }));

  const qty = parseFloat(form.quantity) || 0;
  const cpu = parseFloat(form.costPerUnit) || 0;
  const previewTotal = qty * cpu;

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

        {previewTotal > 0 && (
          <dl className="hr-kv">
            <div>
              <dt>{t("totalCost")}</dt>
              <dd><strong className="hr-num">{money(previewTotal)}</strong> {lang === "ar" ? "ر.س" : "SAR"}</dd>
            </div>
          </dl>
        )}
      </form>
    </OpsPane>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function PurchasesPage() {
  const { t, lang } = useI18n();
  const L = useL();
  const user = useUser();
  // Recording a purchase is the receiving duty, as the API requires (POST /api/purchases: inventory › receive).
  const canCreate = hasSubPrivilege(user?.permissions ?? {}, "inventory", "receive");

  const [purchases, setPurchases] = useState<PurchaseRecord[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [beans, setBeans] = useState<GreenBean[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [toast, setToast] = useState<{ msg: string; type: "ok" | "err" } | null>(null);

  function showToast(msg: string, type: "ok" | "err" = "ok") {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  }

  const loadData = useCallback(async () => {
    setLoading(true);
    const [pRes, sRes, bRes] = await Promise.all([
      fetch("/api/purchases"),
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
        fetch("/api/purchases"),
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

  // Build a bean lookup map for table display
  const beanMap = useMemo(
    () => new Map(beans.map((b) => [b.id, b])),
    [beans]
  );

  function beanLabel(itemId: string | null): string {
    if (!itemId) return "—";
    const b = beanMap.get(itemId);
    if (!b) return "—";
    return lang === "ar" && b.beanTypeAr ? b.beanTypeAr : b.beanType;
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return purchases;
    return purchases.filter((p) => {
      const bean = p.itemId ? beanMap.get(p.itemId) : null;
      const beanName = (bean ? `${bean.beanType} ${bean.beanTypeAr ?? ""}` : "").toLowerCase();
      return (
        p.supplier.name.toLowerCase().includes(q) ||
        beanName.includes(q) ||
        (p.notes ?? "").toLowerCase().includes(q)
      );
    });
  }, [purchases, search, beanMap]);

  // Summary stats
  const totalSpendSAR = purchases.reduce((s, p) => s + p.totalCost, 0);
  const totalKg = purchases.reduce((s, p) => s + p.quantity, 0);
  const uniqueSuppliers = new Set(purchases.map((p) => p.supplier.id)).size;
  const shownKg = filtered.reduce((s, p) => s + (Number.isFinite(p.quantity) ? p.quantity : 0), 0);
  const shownSpend = filtered.reduce((s, p) => s + (Number.isFinite(p.totalCost) ? p.totalCost : 0), 0);
  const latest = purchases.reduce<PurchaseRecord | null>((a, p) => (!a || p.purchaseDate > a.purchaseDate ? p : a), null);

  function handleSuccess(msg: string) {
    setShowForm(false);
    showToast(msg, "ok");
    loadData();
  }

  const sar = lang === "ar" ? "ر.س" : "SAR";
  const kgU = lang === "ar" ? "كغ" : "kg";
  const open = canCreate && showForm;

  return (
    <OpsRoot className="stk-purchases">
    <div className={`hr-split${open ? " has-preview" : ""}`}>
    <div className="hr-page">
      <PageHeader
        title={t("purchasesTitle")}
        actions={canCreate ? <Btn variant="primary" onClick={() => setShowForm(true)}><PlusIcon />{t("addPurchase")}</Btn> : null}
      >
        <span className="hr-caption">{t("purchasesSubtitle")}</span>
        <span className="hr-caption">{lang === "ar" ? `${uniqueSuppliers} موردين` : `${uniqueSuppliers} suppliers`}</span>
      </PageHeader>

      {toast ? <OpsBanner tone={toast.type === "ok" ? "success" : "danger"} onClose={() => setToast(null)}>{toast.msg}</OpsBanner> : null}

      {loading ? <OpsLoading /> : (
        <>
          <div className="stk-metrics" style={{ ["--stk-cols" as string]: 3 }}>
            <div>
              <span className="stk-lbl">{t("totalSpend")}</span>
              <span className="stk-mid">{money(totalSpendSAR, 0)}<span className="stk-unit">{sar}</span></span>
              <span className="stk-d">{purchases.length} {lang === "ar" ? "عملية شراء" : "transactions"}</span>
            </div>
            <div>
              <span className="stk-lbl">{t("totalReceived")}</span>
              <span className="stk-mid">{totalKg.toFixed(1)}<span className="stk-unit">{kgU}</span></span>
              <span className="stk-d">{lang === "ar" ? "بن أخضر مستلم" : "green bean received"}</span>
            </div>
            <div>
              <span className="stk-lbl">{t("suppliersCount")}</span>
              <span className="stk-mid">{uniqueSuppliers}</span>
              <span className="stk-d">{latest ? `${L("آخر شراء", "Last purchase")} ${opsDate(latest.purchaseDate, lang)} · ${latest.supplier.name}` : (lang === "ar" ? "مورد نشط" : "active suppliers")}</span>
            </div>
          </div>

          <div className="stk-tool">
            <input type="search" className="hr-input hr-search" placeholder={t("searchPurchases")} aria-label={t("searchPurchases")}
              value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>

          {filtered.length === 0 ? (
            <div className="hr-state"><h3>{search ? t("noData") : t("noPurchases")}</h3></div>
          ) : (
            <div className="hr-tablewrap">
              <table className="hr-table is-mrow" aria-label={t("purchasesTitle")}>
                <thead>
                  <tr>
                    <th>{t("date")}</th>
                    <th>{t("supplier")}</th>
                    <th>{t("greenBeans")}</th>
                    <th className="num">{lang === "ar" ? "الكمية · كغ" : "Qty · kg"}</th>
                    <th className="num">{t("costPerUnit")}</th>
                    <th className="num">{t("totalCost")}</th>
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
                    <td colSpan={3}>{lang === "ar" ? `${filtered.length} عمليات شراء` : `${filtered.length} purchases`}</td>
                    <td className="num stk-tot"><span className="hr-num">{fmtQty(shownKg, 2)}</span></td>
                    <td />
                    <td className="num stk-tot"><span className="hr-num">{money(shownSpend)}</span></td>
                    <td className="hr-hide-compact hr-hide-preview" />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </>
      )}
    </div>

      {open ? (
        <AddPurchasePane
          suppliers={suppliers}
          beans={beans}
          onClose={() => setShowForm(false)}
          onSuccess={handleSuccess}
        />
      ) : null}
    </div>
    </OpsRoot>
  );
}
