"use client";
// «تحميص للمخزون» (owner-approved D14, Figma 1921:3): the «أمر تحميص للمخزون» dialog (coffee · SKU · green kg, the
// summary, the open stock orders with «إلغاء الأمر» on a PENDING one) and the «الدفعة الخضراء الافتراضية» picker it shares
// with the product page. Every rule is the API's (/api/production/stock-orders, /api/coffee-products/[id]/default-green).
import { useCallback, useEffect, useMemo, useState } from "react";
import { Btn, Dialog, Field, Notice } from "@/components/hr/ui";
import { Select } from "@/components/ui/Select";
import { useI18n } from "@/lib/i18n/context";

type Lot = { id: string; serialNumber: string; beanType: string; beanTypeAr: string | null; country: string; countryAr: string | null; quantityKg: number };
type Product = {
  id: string; productNameAr: string | null; productNameEn: string; expectedRoastLoss: number; defaultGreenBeanId: string | null;
  defaultGreenBean: { id: string; serialNumber: string; beanType: string; beanTypeAr: string | null; quantityKg: number; isActive: boolean } | null;
  productSkus: { id: string; skuCode: string; weightGrams: number; isBulk: boolean }[];
};
type Order = {
  id: string; productionNumber: string; status: string; expectedGreenBeanKg: number; targetWeightKg: number;
  productSku: { skuCode: string; product: { productNameAr: string | null; productNameEn: string } }; greenBean: { serialNumber: string } | null;
};
type Data = { orders: Order[]; lots: Lot[]; products: Product[] };
type Err = { error?: string; errorEn?: string };

const kg = (v: number) => v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function useL() {
  const { lang } = useI18n();
  const ar = lang !== "en";
  return { ar, L: (a: string, e: string) => (ar ? a : e), msg: (b: Err | null | undefined, fa: string, fe: string) => (ar ? b?.error || fa : b?.errorEn || b?.error || fe) };
}
async function send<T>(url: string, method: string, body?: unknown): Promise<{ ok: true; data: T } | { ok: false; data: Err }> {
  try {
    const r = await fetch(url, { method, cache: "no-store", headers: body !== undefined ? { "Content-Type": "application/json" } : undefined, body: body !== undefined ? JSON.stringify(body) : undefined });
    const data = await r.json().catch(() => ({}));
    return r.ok ? { ok: true, data: data as T } : { ok: false, data: data as Err };
  } catch { return { ok: false, data: {} }; }
}

export function lotText(l: { serialNumber: string; beanType: string; beanTypeAr: string | null; quantityKg: number }, ar: boolean) {
  return `${l.serialNumber} · ${(ar ? l.beanTypeAr || l.beanType : l.beanType) ?? ""} · ${ar ? "متوفر" : "available"} ${kg(l.quantityKg)} ${ar ? "كغ" : "kg"}`;
}

/** The lot picker: active green lots with stock, newest first (the API's order). */
export function GreenLotSelect({ lots, value, onChange, testId }: { lots: Lot[]; value: string; onChange: (v: string) => void; testId?: string }) {
  const { ar, L } = useL();
  return (
    <Select className="hr-select" value={value} onChange={(e) => onChange(e.target.value)} data-testid={testId}>
      <option value="">{L("اختر دفعة متوفرة…", "Choose a lot in stock…")}</option>
      {lots.map((l) => <option key={l.id} value={l.id}>{lotText(l, ar)}</option>)}
    </Select>
  );
}

/** «الدفعة الخضراء الافتراضية» — from the product page. */
export function DefaultGreenDialog({ productId, current, onClose, onSaved }: { productId: string; current: string | null; onClose: () => void; onSaved: () => void }) {
  const { L, msg } = useL();
  const [lots, setLots] = useState<Lot[] | null>(null);
  const [value, setValue] = useState(current ?? "");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { void send<Data>("/api/production/stock-orders", "GET").then((r) => { if (r.ok) setLots(r.data.lots); else setErr(msg(r.data, "تعذّر تحميل الدفعات.", "Could not load the lots.")); }); }, [msg]);
  const save = async () => {
    if (!value) { setErr(L("اختر دفعة.", "Choose a lot.")); return; }
    setBusy(true); setErr("");
    const r = await send(`/api/coffee-products/${productId}/default-green`, "PATCH", { greenBeanId: value });
    setBusy(false);
    if (r.ok) onSaved(); else setErr(msg(r.data, "تعذّر الحفظ.", "Could not save."));
  };
  return (
    <Dialog open title={L("الدفعة الخضراء الافتراضية", "Default green lot")} onClose={onClose} testId="default-green-dialog"
      sub={L("منها يُسحب البن الأخضر لتحضير الدلاء وأوامر المخزون. يُسجَّل كل تغيير.", "Prep and stock orders draw the green from it. Every change is recorded.")}
      actions={<><Btn onClick={onClose}>{L("إلغاء", "Cancel")}</Btn><Btn variant="primary" busy={busy} onClick={() => void save()} data-testid="default-green-save">{L("حفظ", "Save")}</Btn></>}>
      <Field label={L("الدفعة *", "Lot *")} help={L("الدفعات النشطة اللي فيها رصيد فقط، الأحدث أولًا.", "Active lots with stock only, newest first.")}>
        {lots ? <GreenLotSelect lots={lots} value={value} onChange={setValue} testId="default-green-select" /> : <span role="status">…</span>}
      </Field>
      {err ? <Notice tone="danger">{err}</Notice> : null}
    </Dialog>
  );
}

/** «أمر تحميص للمخزون» — from the schedule's «تحميص للمخزون». */
export function StockOrderDialog({ onClose }: { onClose: () => void }) {
  const { ar, L, msg } = useL();
  const [data, setData] = useState<Data | null>(null);
  const [productId, setProductId] = useState("");
  const [skuId, setSkuId] = useState("");
  const [green, setGreen] = useState("");
  const [lot, setLot] = useState("");
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [cancelAsk, setCancelAsk] = useState<string | null>(null);
  const load = useCallback(async () => {
    const r = await send<Data>("/api/production/stock-orders", "GET");
    if (r.ok) setData(r.data); else setErr(msg(r.data, "تعذّر التحميل.", "Could not load."));
  }, [msg]);
  useEffect(() => { const t = setTimeout(() => { void load(); }, 0); return () => clearTimeout(t); }, [load]);

  const product = useMemo(() => data?.products.find((p) => p.id === productId) ?? null, [data, productId]);
  const name = (p: { productNameAr: string | null; productNameEn: string }) => (ar ? p.productNameAr || p.productNameEn : p.productNameEn || p.productNameAr) ?? "";
  const g = Number(green);
  const roasted = product && g > 0 ? g * (1 - Math.min(Math.max(product.expectedRoastLoss, 0), 99.9) / 100) : null;
  const def = product?.defaultGreenBean && product.defaultGreenBean.isActive && product.defaultGreenBean.quantityKg > 0 ? product.defaultGreenBean : null;

  const pick = (id: string) => {
    setProductId(id); setLot(""); setErr("");
    const p = data?.products.find((x) => x.id === id);
    setSkuId(p?.productSkus[0]?.id ?? "");
  };
  const create = async () => {
    setErr(""); setNote("");
    if (!product || !skuId) { setErr(L("اختر القهوة وصنف البيع.", "Choose the coffee and the SKU.")); return; }
    if (!(g > 0)) { setErr(L("اكتب كمية البن الأخضر بالكيلو.", "Enter the green coffee in kg.")); return; }
    setBusy(true);
    if (!def) {
      if (!lot) { setBusy(false); setErr(L("حدّد الدفعة الخضراء الافتراضية أولًا.", "Set the default green lot first.")); return; }
      const s = await send(`/api/coffee-products/${product.id}/default-green`, "PATCH", { greenBeanId: lot });
      if (!s.ok) { setBusy(false); setErr(msg(s.data, "تعذّر حفظ الدفعة.", "Could not save the lot.")); return; }
    }
    const r = await send<{ productionNumber: string }>("/api/production/stock-orders", "POST", { productSkuId: skuId, greenKg: g });
    setBusy(false);
    if (!r.ok) { setErr(msg(r.data, "تعذّر إنشاء الأمر.", "Could not create the order.")); return; }
    setNote(L(`أُنشئ ${r.data.productionNumber} · يظهر في «تحضير الدلاء» تحت «مخزون».`, `${r.data.productionNumber} created · it shows in bucket prep under «Stock».`));
    setGreen(""); setLot("");
    await load();
  };
  const cancel = async (id: string) => {
    setErr(""); setNote("");
    const r = await send(`/api/production/stock-orders/${id}/cancel`, "POST");
    setCancelAsk(null);
    if (!r.ok) setErr(msg(r.data, "تعذّر الإلغاء.", "Could not cancel."));
    await load();
  };

  return (
    <Dialog open title={L("أمر تحميص للمخزون", "Roast-to-stock order")} onClose={onClose} testId="stock-order-dialog"
      sub={L("للرف، بدون طلب عميل. يظهر في «تحضير الدلاء» بالمحطة تحت «مخزون».", "For the shelf, no customer order. It shows in the station's bucket prep under «Stock».")}
      actions={<><Btn onClick={onClose}>{L("إغلاق", "Close")}</Btn><Btn variant="primary" busy={busy} onClick={() => void create()} disabled={!data} data-testid="stock-order-create">{L("إنشاء الأمر", "Create order")}</Btn></>}>
      {!data ? <span role="status">…</span> : (
        <>
          <Field label={L("القهوة *", "Coffee *")}>
            <Select className="hr-select" value={productId} onChange={(e) => pick(e.target.value)} data-testid="stock-order-product">
              <option value="">{L("اختر القهوة…", "Choose the coffee…")}</option>
              {data.products.map((p) => <option key={p.id} value={p.id}>{name(p)}</option>)}
            </Select>
          </Field>
          <Field label={L("صنف البيع *", "SKU *")} help={L("يحدد العبوة اللي تتعبّأ لها الدفعة لاحقًا.", "The pack the lot is packed into later.")}>
            <Select className="hr-select" value={skuId} onChange={(e) => setSkuId(e.target.value)} disabled={!product} data-testid="stock-order-sku">
              {(product?.productSkus ?? []).map((s) => <option key={s.id} value={s.id}>{`${s.skuCode} · ${s.isBulk ? L("سائب", "bulk") : `${s.weightGrams} ${L("غ", "g")}`}`}</option>)}
            </Select>
          </Field>
          <Field label={L("كمية البن الأخضر (كغ) *", "Green coffee (kg) *")}>
            <input className="hr-input" inputMode="decimal" dir="ltr" value={green} onChange={(e) => setGreen(e.target.value.replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).replace(/[^0-9.]/g, ""))} data-testid="stock-order-kg" />
          </Field>
          {product && !def ? (
            <>
              <Notice tone="warning">
                <b>{L("ما لهذه القهوة دفعة خضراء افتراضية.", "This coffee has no default green lot.")}</b>{" "}
                {L("حدّدها هنا أو من بيانات المنتج — تُحفظ للقهوة وتُستخدم في كل أمر بعدها.", "Set it here or in the product data — it is saved for the coffee and used for every order after.")}
              </Notice>
              <Field label={L("الدفعة الخضراء الافتراضية *", "Default green lot *")} help={L("الدفعات النشطة اللي فيها رصيد فقط.", "Active lots with stock only.")}>
                <GreenLotSelect lots={data.lots} value={lot} onChange={setLot} testId="stock-order-lot" />
              </Field>
            </>
          ) : null}
          {product && def ? (
            <div className="hr-notice tone-success" data-testid="stock-order-summary">
              <div>{L("الدفعة الخضراء:", "Green lot:")} <b>{lotText(def, ar)}</b></div>
              {roasted !== null ? <div>{L("الناتج المتوقع:", "Expected output:")} <b dir="ltr">{kg(roasted)}</b> {L(`كغ محمّص (فقد ${product.expectedRoastLoss.toFixed(1)}%)`, `kg roasted (loss ${product.expectedRoastLoss.toFixed(1)}%)`)}</div> : null}
              <small>{L("رقم الأمر يُعطى عند الحفظ: PRD-…", "The order number is given on save: PRD-…")}</small>
            </div>
          ) : null}
          {(() => {
            // A soft warning only: the lot may be topped up before roasting; the server does not refuse it.
            const pickedLot = def ?? (lot ? data.lots.find((x) => x.id === lot) ?? null : null);
            return pickedLot && g > pickedLot.quantityKg ? (
              <div data-testid="stock-order-over-lot"><Notice tone="warning">
                {L(`الكمية أكبر من المتوفر في الدفعة (${kg(pickedLot.quantityKg)} كغ). تقدر تكمّل، بس تأكد من الرصيد قبل التحضير.`, `More than the lot has (${kg(pickedLot.quantityKg)} kg). You can continue, but check the stock before prep.`)}
              </Notice></div>
            ) : null;
          })()}
          {err ? <Notice tone="danger">{err}</Notice> : null}
          {note ? <Notice tone="success">{note}</Notice> : null}

          <h3 className="hr-section" style={{ marginTop: 8 }}>{L("أوامر المخزون المفتوحة", "Open stock orders")}</h3>
          {data.orders.length === 0 ? <p className="hr-caption">{L("لا أوامر مخزون مفتوحة.", "No open stock orders.")}</p> : (
            <ul className="stock-orders" data-testid="stock-order-list" style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
              {data.orders.map((o) => (
                <li key={o.id} data-testid={`stock-order-${o.productionNumber}`} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, padding: "8px 0", borderTop: "1px solid var(--line, #E1E6E0)" }}>
                  <span style={{ display: "grid" }}>
                    <b><bdi dir="ltr">{o.productionNumber}</bdi> · {o.status === "PENDING" ? L("بانتظار التحضير", "Waiting for prep") : L("قيد الإنتاج", "In production")}</b>
                    <small className="hr-caption">{name(o.productSku.product)} · {kg(o.expectedGreenBeanKg)} {L("كغ أخضر", "kg green")} · <bdi dir="ltr">{o.productSku.skuCode}</bdi></small>
                  </span>
                  {o.status !== "PENDING" ? <small className="hr-caption">{L("لا يُلغى بعد البدء", "Not cancellable once started")}</small>
                    : cancelAsk === o.id ? (
                      <span style={{ display: "flex", gap: 6 }}>
                        <Btn size="sm" variant="danger" onClick={() => void cancel(o.id)} data-testid="stock-order-cancel-yes">{L("نعم · إلغاء", "Yes · cancel")}</Btn>
                        <Btn size="sm" onClick={() => setCancelAsk(null)}>{L("رجوع", "Back")}</Btn>
                      </span>
                    ) : <Btn size="sm" onClick={() => setCancelAsk(o.id)} data-testid="stock-order-cancel">{L("إلغاء الأمر", "Cancel order")}</Btn>}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Dialog>
  );
}
