"use client";
// Packaging materials (MaterialItem) — Direction 2.1 (Figma 253:2987 «مواد التعبئة», 270:6058).
//
// The ONE place packaging materials are entered (small-fixes batch): the «مواد التعبئة» tab of
// Inventory, on the inventory ledger. The products screens (product page, add product) show a
// material's stock read only and link here. Requests, permission gates and validation: receive = inventory › receive (POST /api/materials/:id/receive), count =
// inventory › adjust (PATCH /api/materials/:id, reason required), create = POST /api/materials.
import { localizeApiError } from "@/lib/i18n/api-errors";
import { Select } from "@/components/ui/Select";
import { useState } from "react";
import { Btn, Field, useL } from "@/components/ops/ui";
import { Dialog } from "@/components/hr/ui";
import { useI18n } from "@/lib/i18n/context";
import { useUser } from "../user-context";
import { hasSubPrivilege } from "@/lib/auth-shared";

export type Material = {
  id: string;
  code: string;
  name: string;
  nameAr?: string | null;
  category: string;
  unitOfMeasure: string;
  quantityOnHand: number;
  reorderPoint: number;
  isActive: boolean;
  usedInProductCount: number;
  belowReorderPoint: boolean;
};

const CATEGORY_AR: Record<string, string> = { PACKAGING: "تعبئة", LABEL: "ملصق", CONSUMABLE: "مستهلك", OTHER: "أخرى" };

export function CheckIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="4" width="16" height="16" rx="3" /><path d="m8.5 12 2.5 2.5 4.5-5" />
    </svg>
  );
}
export function PlusIcon() {
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>;
}

export function MaterialsPanel({
  materials,
  search,
  onChanged,
  onError,
}: {
  materials: Material[];
  search?: React.ReactNode;
  onChanged: () => void;
  onError: (m: string) => void;
}) {
  const { t, lang } = useI18n();
  const L = useL();
  const user = useUser();
  // A count changes the on-hand quantity: an inventory adjustment (privileged, SOD.md §20). Offered
  // only to inventory › adjust holders; the server enforces it (verified individual + step-up).
  const canCount = hasSubPrivilege(user?.permissions ?? {}, "inventory", "adjust");
  // Receiving a delivery only ADDS stock: the routine receiving duty (PIN-only staff), audited
  // (review P2-4). POST /api/materials/:id/receive.
  const canReceive = hasSubPrivilege(user?.permissions ?? {}, "inventory", "receive");
  const [receiving, setReceiving] = useState<Material | null>(null);
  const [rqty, setRqty] = useState("");
  const [rref, setRref] = useState("");
  const [adjusting, setAdjusting] = useState<Material | null>(null);
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("");

  async function saveCount(m: Material) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) {
      onError(L("الكمية المعدودة يجب ألا تكون سالبة.", "Counted quantity must be zero or more."));
      return;
    }
    const res = await fetch(`/api/materials/${m.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      // The reason is required (it is the only document behind a count).
      body: JSON.stringify({ newActualQuantity: n, reason: reason.trim() }),
    });
    if (!res.ok) onError(localizeApiError(await res.json().catch(() => ({})), lang) ?? L("تعذّرت تسوية المخزون.", "Failed to adjust stock."));
    setAdjusting(null);
    setValue("");
    setReason("");
    onChanged();
  }

  async function saveReceipt(m: Material) {
    const n = Number(rqty);
    if (!Number.isFinite(n) || n <= 0) {
      onError(L("الكمية المستلمة يجب أن تكون أكبر من صفر.", "Received quantity must be greater than zero."));
      return;
    }
    const res = await fetch(`/api/materials/${m.id}/receive`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ quantity: n, reference: rref.trim() }),
    });
    if (!res.ok) onError(localizeApiError(await res.json().catch(() => ({})), lang) ?? L("تعذّر استلام المخزون.", "Failed to receive stock."));
    setReceiving(null);
    setRqty("");
    setRref("");
    onChanged();
  }

  const low = materials.filter((m) => m.belowReorderPoint).length;
  const cat = (c: string) => (lang === "ar" ? CATEGORY_AR[c] ?? c : c.charAt(0) + c.slice(1).toLowerCase());
  const used = (n: number) => (n === 0 ? L("غير مستخدمة", "Not used") : lang === "ar" ? (n === 1 ? "منتج واحد" : `${n} منتجات`) : `${n} ${n === 1 ? "product" : "products"}`);
  const delta = adjusting ? Number(value) - adjusting.quantityOnHand : NaN;

  return (
    <>
      {search}
      {materials.length === 0 ? (
        <div className="hr-state"><h3>{t("noMaterialsYet")}</h3></div>
      ) : (
        <div className="hr-tablewrap">
          <table className="hr-table is-mrow" aria-label={t("tabMaterials")}>
            <thead>
              <tr>
                <th>{L("المادة", "Material")}</th>
                <th>{t("categoryLabel")}</th>
                <th className="num">{t("onHandLabel")}</th>
                <th className="num">{t("reorderPointLabel")}</th>
                <th className="hr-hide-compact">{t("usedInLabel")}</th>
                <th aria-label={L("التنبيه", "Flag")} />
                <th aria-label={t("actions")} />
              </tr>
            </thead>
            <tbody>
              {materials.map((m) => (
                <tr key={m.id} className={m.isActive ? undefined : "is-inactive"}>
                  <td className="m-title">
                    <span className="strong">{lang === "ar" && m.nameAr ? m.nameAr : m.name}</span>
                    <span className="stk-sub hr-id hr-desktop-only">{m.code}</span>
                    <span className="hr-msub">
                      <span className="hr-id">{m.code}</span> · {cat(m.category)} · {t("onHandLabel")} <span className="hr-num">{m.quantityOnHand}</span>
                    </span>
                  </td>
                  <td className="hr-caption" style={{ color: "var(--text-secondary)" }}>{cat(m.category)}</td>
                  <td className={`num${m.belowReorderPoint ? " is-low" : ""}`}><span className="hr-num">{m.quantityOnHand}</span></td>
                  <td className="num"><span className="hr-num">{m.reorderPoint || "—"}</span></td>
                  <td className="hr-hide-compact hr-caption" style={{ color: "var(--text-secondary)" }}>{used(m.usedInProductCount)}</td>
                  <td className="m-end" style={{ textAlign: "end" }}>
                    {m.belowReorderPoint ? <span className="stk-flag">{t("lowStockLabel")}</span> : null}
                  </td>
                  <td className="stk-acts stk-macts">
                    {canReceive && m.isActive && (
                      <Btn size="sm" data-testid="material-receive"
                        onClick={() => { setAdjusting(null); setReceiving(m); setRqty(""); setRref(""); }}>
                        {t("receiveStockLabel")}
                      </Btn>
                    )}
                    {canCount && (
                      <Btn size="sm" variant="ghost" title={t("adjustStockLabel")}
                        onClick={() => { setReceiving(null); setAdjusting(m); setValue(String(m.quantityOnHand)); setReason(""); }}>
                        <CheckIcon />{L("جرد", "Count")}
                      </Btn>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={2}>
                  {lang === "ar" ? `${materials.length} مواد · ${low} تحت حد إعادة الطلب` : `${materials.length} materials · ${low} below reorder point`}
                </td>
                <td colSpan={5} style={{ textAlign: "end", fontSize: 12 }}>
                  {L("لا يدعم النظام شراء مواد التعبئة بعد · يُصحَّح الرصيد بالجرد أو الاستلام", "Packaging purchases are not supported yet · the balance is corrected by a count or a receipt")}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      <Dialog
        open={!!receiving}
        title={t("receiveStockLabel")}
        sub={receiving ? <><span>{lang === "ar" && receiving.nameAr ? receiving.nameAr : receiving.name}</span> · <span className="hr-id">{receiving.code}</span></> : undefined}
        onClose={() => { setReceiving(null); setRqty(""); setRref(""); }}
        actions={receiving ? (
          <>
            <Btn variant="primary" disabled={!(Number(rqty) > 0) || rref.trim().length === 0} onClick={() => saveReceipt(receiving)}>{t("receiveStockLabel")}</Btn>
            <Btn onClick={() => { setReceiving(null); setRqty(""); setRref(""); }}>{t("cancel")}</Btn>
          </>
        ) : undefined}
      >
        <div className="hr-form">
          <Field label={t("receivedQtyLabel")}>
            <input className="hr-input" data-testid="material-receive-qty" type="number" min={0} value={rqty}
              onChange={(e) => setRqty(e.target.value)} placeholder={t("receivedQtyLabel")} />
          </Field>
          <Field label={t("receiveRefLabel")}>
            <input className="hr-input" data-testid="material-receive-ref" value={rref} maxLength={120}
              onChange={(e) => setRref(e.target.value)} placeholder={t("receiveRefLabel")} />
          </Field>
        </div>
      </Dialog>

      <Dialog
        open={!!adjusting}
        title={L("جرد وتسوية المخزون", "Count and adjust stock")}
        sub={adjusting ? <><span>{lang === "ar" && adjusting.nameAr ? adjusting.nameAr : adjusting.name}</span> · <span className="hr-id">{adjusting.code}</span></> : undefined}
        onClose={() => { setAdjusting(null); setValue(""); setReason(""); }}
        actions={adjusting ? (
          <>
            <Btn variant="primary" disabled={reason.trim().length < 8} onClick={() => saveCount(adjusting)}>{L("تسجيل التسوية", "Record adjustment")}</Btn>
            <Btn onClick={() => { setAdjusting(null); setValue(""); setReason(""); }}>{t("cancel")}</Btn>
          </>
        ) : undefined}
      >
        {adjusting ? (
          <>
            <div className="hr-form">
              <Field label={L("الكمية في النظام", "System quantity")}>
                <input className="hr-input" value={adjusting.quantityOnHand} disabled readOnly />
              </Field>
              <Field label={t("adjustStockLabel")}>
                <input className="hr-input" type="number" min={0} value={value} onChange={(e) => setValue(e.target.value)} placeholder={t("adjustStockLabel")} />
              </Field>
            </div>
            {Number.isFinite(delta) && value !== "" ? (
              <div className={`stk-diff${delta < 0 ? " tone-danger" : delta > 0 ? " tone-success" : ""}`}>
                <span>{L("الفارق", "Difference")}</span>
                <strong>{delta === 0 ? L("لا تغيير", "No change") : `${delta > 0 ? "+" : ""}${delta}`}</strong>
              </div>
            ) : null}
            <Field label={t("countReasonLabel")} help={L("مطلوب، 8 أحرف على الأقل.", "Required, at least 8 characters.")}>
              <input className="hr-input" data-testid="material-count-reason" value={reason} maxLength={500}
                onChange={(e) => setReason(e.target.value)} placeholder={t("countReasonLabel")} />
            </Field>
          </>
        ) : null}
      </Dialog>
    </>
  );
}

export function MaterialForm({ onClose, onSaved, onError }: { onClose: () => void; onSaved: () => void; onError: (m: string) => void }) {
  const { t, lang } = useI18n();
  const L = useL();
  const [form, setForm] = useState({ code: "", name: "", category: "PACKAGING", quantityOnHand: "0", reorderPoint: "0" });
  const [saving, setSaving] = useState(false);

  async function submit() {
    setSaving(true);
    try {
      const res = await fetch("/api/materials", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          code: form.code,
          name: form.name,
          category: form.category,
          quantityOnHand: Number(form.quantityOnHand),
          reorderPoint: Number(form.reorderPoint),
        }),
      });
      if (!res.ok) {
        onError(localizeApiError(await res.json().catch(() => ({})), lang) ?? L("تعذّر إنشاء المادة.", "Failed to create material."));
        return;
      }
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open
      title={t("newMaterialBtn")}
      onClose={onClose}
      actions={
        <>
          <Btn variant="primary" busy={saving} disabled={!form.code || !form.name} onClick={submit}>{t("newMaterialBtn")}</Btn>
          <Btn onClick={onClose}>{t("cancel")}</Btn>
        </>
      }
    >
      <div className="hr-form">
        <Field label={t("materialCodeLabel")}>
          <input className="hr-input" dir="ltr" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder="BAG-1KG" />
        </Field>
        <Field label={t("categoryLabel")}>
          <Select className="hr-select" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
            <option value="PACKAGING">{L("تغليف", "Packaging")}</option>
            <option value="LABEL">{L("ملصق", "Label")}</option>
            <option value="CONSUMABLE">{L("مستهلكات", "Consumable")}</option>
            <option value="OTHER">{L("أخرى", "Other")}</option>
          </Select>
        </Field>
        <Field label={t("materialNameLabel")} wide>
          <input className="hr-input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={L("كيس قهوة 1 كغ", "1KG Coffee Bag")} />
        </Field>
        <Field label={t("onHandLabel")}>
          <input className="hr-input" type="number" min={0} value={form.quantityOnHand} onChange={(e) => setForm({ ...form, quantityOnHand: e.target.value })} />
        </Field>
        <Field label={t("reorderPointLabel")}>
          <input className="hr-input" type="number" min={0} value={form.reorderPoint} onChange={(e) => setForm({ ...form, reorderPoint: e.target.value })} />
        </Field>
      </div>
    </Dialog>
  );
}
