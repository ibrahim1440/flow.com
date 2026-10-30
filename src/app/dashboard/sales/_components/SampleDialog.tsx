"use client";

import { useEffect, useState } from "react";
import { Alert, Button, Field, Modal, Select, TextInput, api } from "./ui";

/** A product's Arabic name on the Arabic screen (its English name, else its code, otherwise). */
export function skuName(sku: { skuCode: string; name: string | null; nameAr?: string | null } | null | undefined, ar: boolean): string | null {
  if (!sku) return null;
  return (ar ? sku.nameAr || sku.name : sku.name) || sku.skuCode;
}

/**
 * «طلب عيّنة». The rep's whole job is: pick the product, say how many bags, send the request. A product in units is a
 * STOCK sample — it goes to the dispatch queue as REQUESTED and leaves the shelf only when dispatch issues it, so there
 * is no status to choose. Free text or kilograms / grams stay what they always were: a record-only sample with no
 * stock movement, still allowed (and labelled as such) for the coffee that does not come out of a packed bag.
 */
export function SampleDialog({
  ar, opportunityId, customerId, sampledProductIds, manager, onClose, onDone,
}: {
  ar: boolean;
  /** The deal; null from the customer page when the customer has none yet — the server opens it WITH the request
   *  (`customerId`), so cancelling writes nothing (council fix round 2, item 3). */
  opportunityId: string | null; customerId?: string;
  /** The coffee products this customer already had a sample of («للعميل من كل محصول عيّنة واحدة»). */
  sampledProductIds: string[];
  /** A sales manager / admin: a second sample is recorded with their own approval. */
  manager: boolean;
  onClose: () => void; onDone: (requested: boolean, replayed: boolean, approval?: string, opportunityId?: string) => void;
}) {
  const [skus, setSkus] = useState<{ id: string; skuCode: string; name: string | null; nameAr?: string | null; coffee?: { id: string } | null }[]>([]);
  const [productSkuId, setProductSkuId] = useState("");
  const [description, setDescription] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [unit, setUnit] = useState("UNIT");
  // A request is always «قيد التحضير»: the rep asks, he does not pick a status (batch 24 council, seat 5).
  const status = "PREPARING";
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // One key per opening of the dialog: a double click or a retry after a lost answer is the same request, and the
  // server answers it with the request it already recorded (`replayed`) instead of a second one.
  const [requestKey] = useState(() => `smp-${typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`}`);
  // A product is always counted in units (the server refuses a product in KG / GRAM); free text keeps any unit.
  const unitShown = productSkuId ? "UNIT" : unit;
  // Same rule as the server (sample-rules.ts isStockSample): a product counted in units is issued from stock.
  const fromStock = !!productSkuId && unitShown === "UNIT";
  // Owner decision «للعميل من كل محصول عيّنة واحدة»: a stock sample is one unit (the server refuses more).
  const wholeOk = !fromStock || quantity.trim() === "1";
  // The same coffee through any of its SKUs counts (ProductSKU.productId): a second one waits for the manager.
  const productId = skus.find((s) => s.id === productSkuId)?.coffee?.id ?? null;
  const alreadySampled = fromStock && !!productId && sampledProductIds.includes(productId);

  useEffect(() => {
    // The catalogue endpoint answers with a bare array of SKUs, already filtered to the
    // active ones (each with its coffee product, `coffee.id`).
    api<{ id: string; skuCode: string; name: string | null; nameAr?: string | null; coffee?: { id: string } | null }[]>("/api/products").then((r) => {
      if (r.ok && Array.isArray(r.data)) setSkus(r.data);
    });
  }, []);

  return (
    <Modal
      title={ar ? "طلب عيّنة" : "Request a sample"}
      onClose={onClose}
      testId="sample-dialog"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>{ar ? "إلغاء" : "Cancel"}</Button>
          <Button
            disabled={busy || (!productSkuId && description.trim().length < 2) || Number(quantity) <= 0 || !wholeOk}
            testId="save-sample"
            onClick={async () => {
              setBusy(true);
              setErr("");
              const res = await api<{ error?: string; errorEn?: string; replayed?: boolean; sample?: { approval?: string }; opportunityId?: string }>("/api/sales/samples", {
                method: "POST",
                body: {
                  ...(opportunityId ? { opportunityId } : { customerId }), productSkuId: productSkuId || null, description, quantity, unit: unitShown,
                  ...(fromStock ? { requestKey } : { status }),
                },
              });
              setBusy(false);
              // A replay (200, the request already recorded a moment ago) is a success: the same request, once.
              if (res.ok) onDone(fromStock, res.data.replayed === true, res.data.sample?.approval, res.data.opportunityId);
              else setErr((ar ? res.data.error : res.data.errorEn ?? res.data.error) ?? "");
            }}
          >
            {alreadySampled && !manager
              ? (ar ? "إرسال للموافقة" : "Send for approval")
              : fromStock ? (ar ? "إرسال الطلب" : "Send request") : (ar ? "حفظ" : "Save")}
          </Button>
        </>
      }
    >
      {err && <Alert kind="error">{err}</Alert>}
      {alreadySampled && (
        <div data-testid="sample-second-warning">
          <Alert kind="info">
            {ar
              ? "سبق إرسال عينة من هذا المحصول لهذا العميل؛ يحتاج طلب عينة ثانية موافقة المدير"
              : "This customer has already had a sample of this product; a second sample needs the sales manager's approval"}
            {manager
              ? (ar ? " — ويُسجَّل طلبك بموافقتك." : " — your request records your own approval.")
              : (ar ? " — يُرسل طلبك إلى المدير ولا يصل إلى قسم الشحن قبل موافقته." : " — your request goes to the manager and reaches dispatch only once approved.")}
          </Alert>
        </div>
      )}
      <Field id="smp-sku" label={ar ? "المنتج" : "Product"}>
        <Select id="smp-sku" value={productSkuId} onChange={setProductSkuId}>
          <option value="">{ar ? "— وصف حر —" : "— free text —"}</option>
          {skus.map((s) => (
            <option key={s.id} value={s.id}>{skuName(s, ar)}</option>
          ))}
        </Select>
      </Field>
      {!productSkuId && (
        <Field id="smp-desc" label={ar ? "الوصف" : "Description"} required>
          <TextInput id="smp-desc" value={description} onChange={setDescription} />
        </Field>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Field id="smp-qty" label={ar ? "الكمية" : "Quantity"} required
          error={wholeOk ? undefined : (ar ? "العيّنة وحدة واحدة من كل محصول" : "A sample is one unit of each product")}>
          <TextInput id="smp-qty" value={quantity} onChange={setQuantity} inputMode={fromStock ? "numeric" : "decimal"} />
        </Field>
        <Field id="smp-unit" label={ar ? "الوحدة" : "Unit"}>
          <Select id="smp-unit" value={unitShown} onChange={setUnit}>
            <option value="UNIT">{ar ? "عبوة" : "Bag"}</option>
            {/* Kilograms / grams are for a free-text (record-only) sample; a product is always requested in bags. */}
            <option value="KG" disabled={!!productSkuId}>{ar ? "كجم (للتسجيل فقط)" : "kg (record only)"}</option>
            <option value="GRAM" disabled={!!productSkuId}>{ar ? "جرام (للتسجيل فقط)" : "Grams (record only)"}</option>
          </Select>
        </Field>
      </div>
      {/* It matters at the moment a sample is requested: what will (and will not) happen to the stock. */}
      <p data-ui="field-hint" data-testid="sample-stock-hint">
        {fromStock
          ? (ar
            ? "يصل الطلب إلى قسم الشحن. لا يُخصم شيء من المخزون الآن؛ يُخصم عند صرف العيّنة فقط، وترى حالتها هنا."
            : "The request goes to dispatch. Nothing is deducted now; the stock leaves only when the sample is issued, and you see its status here.")
          : (ar
            ? "عيّنة للتسجيل فقط: لا تُحرّك المخزون. لصرفها من المخزون اختر منتجًا بالعبوة."
            : "Record-only sample: it does not move stock. To have it issued from stock, pick a product (requested in units).")}
      </p>
    </Modal>
  );
}
