"use client";
// The roast sheet — production simplification item 1 (prototype «دفعة …» / «تحميص لمخزون الرف»).
// The roaster records what happened: the coffee (stock roasts only), the green weight that went
// in (pre-filled), the roasted weight that came out. The green lot is chosen by the system from
// the product (O1: FIFO fallback to the oldest lot of the same bean and origin) and shown as an
// info line; «تغيير» is offered to supervisors only (production › roast_to_stock — the one
// production privilege the roaster role does not hold by default). Loss = green − roasted, live,
// with a warning outside the product's normal range. POST /api/roasting-batches resolves the lot
// again under its transaction, so the line here and the server can never disagree silently.
import { localizeApiError } from "@/lib/i18n/api-errors";
import { useEffect, useMemo, useState } from "react";
import { OpsPane, useL } from "@/components/ops/ui";
import { AutoRow, Chips, Cta, NumIn, parseNum } from "@/components/ops/station";
import { Select } from "@/components/ui/Select";
import { pickGreenLot, greenRefusal, type GreenLot } from "@/lib/green-source";
import { useI18n } from "@/lib/i18n/context";

export type RoastLine = {
  id: string;
  beanTypeName: string;
  orderNumber: number;
  customerName: string;
  /** Finished kilograms the line still needs (context only). */
  remainingFinishedKg: number;
  profileHint: string;
  livePos: { id: string; productionNumber: string; status: string }[];
};
/** One coffee of the roast queue (GET /api/roasting-batches/queue — Phase C item 2). */
export type QueueCoffee = {
  productId: string;
  productNameEn: string;
  productNameAr: string | null;
  demandKg: number;
  pipelineKg: number;
  orders: { orderId: string; orderNumber: number; customerName: string; needKg: number }[];
  allocateTo: { orderItemId: string; orderNumber: number } | null;
  green: { id: string; serialNumber: string; quantityKg: number } | null;
};
type Product = { id: string; productNameEn: string; productNameAr: string | null };
type Bean = { id: string; beanType: string; serialNumber: string; quantityKg: number; isActive?: boolean };
type Facts = {
  productId: string | null; productNameEn: string | null; productNameAr: string | null;
  expectedRoastLoss: number; defaultLot: GreenLot | null; candidates: GreenLot[];
};

const LAST_CHARGE_KEY = "hq.roast.lastChargeKg";
const kgText = (v: number) => (Math.round(v * 100) / 100).toFixed(2);

export function RoastSheet({ mode, products, beans, canChangeGreen, isAdmin, onClose, onSaved }: {
  mode: { kind: "order"; line: RoastLine } | { kind: "stock" } | { kind: "coffee"; coffee: QueueCoffee };
  products: Product[];
  beans: Bean[];
  canChangeGreen: boolean;
  isAdmin: boolean;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const L = useL();
  const { lang } = useI18n();
  const stock = mode.kind === "stock";
  const coffee = mode.kind === "coffee" ? mode.coffee : null;
  const [productId, setProductId] = useState<string | null>(coffee ? coffee.productId : null);
  // The facts of the coffee being roasted, keyed by what they were read for.
  const [loaded, setLoaded] = useState<{ key: string; facts: Facts | null; error: string } | null>(null);
  // The charge the roaster usually loads: their last one on this device, else (below) the default
  // production roaster's target (Settings › Production & roasting › Roasters).
  const [green, setGreen] = useState(() => {
    try { const v = Number(window.localStorage.getItem(LAST_CHARGE_KEY)); return Number.isFinite(v) && v > 0 ? String(v) : ""; } catch { return ""; }
  });
  const [roasted, setRoasted] = useState("");
  const [profile, setProfile] = useState(mode.kind === "order" ? mode.line.profileHint : "");
  const [changing, setChanging] = useState(false);
  const [statedLot, setStatedLot] = useState("");
  const [poChoice, setPoChoice] = useState(mode.kind === "order" && mode.line.livePos.length === 1 ? mode.line.livePos[0].id : "");
  const [surplus, setSurplus] = useState<{ message: string; reason: string } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [quick, setQuick] = useState<number[]>([]);

  useEffect(() => {
    fetch("/api/settings/production", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { roasters?: { type: string; status: string; isDefault: boolean; defaultTargetKg: string; minBatchKg: string; maxBatchKg: string }[] } | null) => {
        const prod = (j?.roasters ?? []).filter((r) => r.type === "PRODUCTION" && r.status !== "RETIRED");
        const def = prod.find((r) => r.isDefault) ?? prod[0];
        if (!def) return;
        const t = Number(def.defaultTargetKg);
        if (t > 0) setGreen((g) => g || String(t));
        setQuick([...new Set([Number(def.minBatchKg), t, Number(def.maxBatchKg)].filter((x) => Number.isFinite(x) && x > 0))].sort((a, b) => a - b));
      })
      .catch(() => {});
  }, []);

  const subject = mode.kind === "order" ? `orderItemId=${encodeURIComponent(mode.line.id)}` : productId ? `productId=${encodeURIComponent(productId)}` : null;
  useEffect(() => {
    if (!subject) return;
    let live = true;
    fetch(`/api/roasting-batches/green-source?${subject}`, { cache: "no-store" })
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!live) return;
        setLoaded(r.ok ? { key: subject, facts: j, error: "" } : { key: subject, facts: null, error: localizeApiError(j, lang) ?? (lang === "ar" ? "تعذّر قراءة مصدر البن." : "Could not read the green source.") });
      })
      .catch(() => { if (live) setLoaded({ key: subject, facts: null, error: lang === "ar" ? "تعذّر الاتصال." : "Network error." }); });
    return () => { live = false; };
  }, [subject, lang]);
  const facts = loaded && loaded.key === subject ? loaded.facts : null;
  const factsError = loaded && loaded.key === subject ? loaded.error : "";

  const g = parseNum(green), r = parseNum(roasted);
  const stated = statedLot ? beans.find((b) => b.id === statedLot) ?? null : null;
  const pick = useMemo(() => (facts ? pickGreenLot(facts.defaultLot, facts.candidates, Number.isFinite(g) ? g : 0) : null), [facts, g]);
  const lot = stated
    ? { id: stated.id, serialNumber: stated.serialNumber, beanType: stated.beanType, quantityKg: stated.quantityKg }
    : pick?.ok ? pick.lot : null;
  const lotName = (l: { beanType: string; beanTypeAr?: string | null }) => (lang === "ar" ? l.beanTypeAr || l.beanType : l.beanType);
  const expected = facts?.expectedRoastLoss ?? 15;

  let live: { tone: "" | "is-warn" | "is-bad"; left: string; right?: string } | null = null;
  if (Number.isFinite(g) && g > 0 && Number.isFinite(r) && r > 0) {
    if (r >= g) live = { tone: "is-bad", left: L("المحمّص يجب أن يكون أقل من الأخضر", "Roasted must be less than green") };
    else if (lot && g > lot.quantityKg) live = { tone: "is-bad", left: L(`المتاح من الأخضر ${kgText(lot.quantityKg)} كغ فقط`, `Only ${kgText(lot.quantityKg)} kg of green available`) };
    else {
      const pct = (1 - r / g) * 100;
      const off = Math.abs(pct - expected) > 5;
      live = { tone: off ? "is-warn" : "", left: L(`فاقد التحميص ${kgText(g - r)} كغ`, `Roast loss ${kgText(g - r)} kg`), right: `${pct.toFixed(1)}%${off ? L(" · خارج المعتاد", " · outside the normal range") : ""}` };
    }
  }
  const ready = (!stock || !!productId) && !!lot && Number.isFinite(g) && g > 0 && Number.isFinite(r) && r > 0 && r < g && g <= (lot?.quantityKg ?? 0)
    && !(mode.kind === "order" && mode.line.livePos.length > 1 && !poChoice);

  async function save(withSurplus = false) {
    if (!ready || busy) return;
    setBusy(true); setError("");
    try {
      const res = await fetch("/api/roasting-batches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // A coffee card: the server attributes the batch to the oldest order (Phase C item 2).
          ...(mode.kind === "order" ? { orderItemId: mode.line.id, productionOrderId: poChoice || undefined } : mode.kind === "coffee" ? { productId, allocate: "oldest" } : { productId }),
          // Sent only when a supervisor changed it; otherwise the server resolves the lot.
          ...(stated ? { greenBeanId: stated.id } : {}),
          greenBeanQuantity: +g.toFixed(3),
          roastedBeanQuantity: +r.toFixed(3),
          roastProfile: profile.trim() || undefined,
          ...(withSurplus && surplus ? { surplusOverride: true, surplusReason: surplus.reason.trim() } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 422 && isAdmin) { setSurplus({ message: localizeApiError(data, lang) ?? "", reason: surplus?.reason ?? "" }); return; }
        setError(localizeApiError(data, lang) || L("تعذّر تسجيل الدفعة.", "Could not record the batch."));
        return;
      }
      try { window.localStorage.setItem(LAST_CHARGE_KEY, String(+g.toFixed(3))); } catch { /* storage unavailable */ }
      const fallback = data.greenSource?.source === "fifo_fallback";
      onSaved(
        L(`سُجّلت الدفعة ${data.batchNumber} · أُرسلت للجودة تلقائيًا`, `Batch ${data.batchNumber} recorded · sent to QC`) +
        (fallback ? L(` · البن من ${data.greenBean?.serialNumber ?? ""} (الأقدم من نفس البن)`, ` · green from ${data.greenBean?.serialNumber ?? ""} (oldest of the same bean)`) : ""),
      );
    } catch {
      setError(L("تعذّر الاتصال. لم يُسجَّل شيء؛ أعد المحاولة.", "Network error. Nothing was recorded; try again."));
    } finally {
      setBusy(false);
    }
  }

  const coffeeName = coffee ? (lang === "ar" ? coffee.productNameAr || coffee.productNameEn : coffee.productNameEn) : "";
  const title = stock ? L("تحميص لمخزون الرف", "Roast to stock")
    : coffee ? L(`دفعة ${coffeeName}`, `Batch · ${coffeeName}`)
    : L(`دفعة ${mode.kind === "order" ? mode.line.beanTypeName : ""}`, `Batch · ${mode.kind === "order" ? mode.line.beanTypeName : ""}`);
  const sub = stock
    ? L("اختر القهوة، والباقي تلقائي", "Choose the coffee; the rest is automatic")
    : coffee ? L(`مطلوب ${kgText(coffee.demandKg)} كغ محمّص`, `${kgText(coffee.demandKg)} kg roasted needed`)
    : mode.kind !== "order" ? null : <>{`#${mode.line.orderNumber} · ${mode.line.customerName}`}{mode.line.remainingFinishedKg > 0 ? L(` · مطلوب ${kgText(mode.line.remainingFinishedKg)} كغ محمّص`, ` · ${kgText(mode.line.remainingFinishedKg)} kg roasted still needed`) : ""}</>;

  let greenLine: React.ReactNode = null;
  if (stock && !productId) greenLine = null;
  else if (factsError) greenLine = <AutoRow warn title={factsError} />;
  else if (!facts) greenLine = <AutoRow title={L("جارٍ تحديد البن الأخضر…", "Finding the green coffee…")} />;
  else if (stated) {
    greenLine = <AutoRow testId="roast-green" title={<>{L("البن الأخضر: ", "Green: ")}{stated.beanType} <span className="ops-serial">{stated.serialNumber}</span></>}
      sub={L(`اختاره المشرف · متاح ${kgText(stated.quantityKg)} كغ`, `Chosen by the supervisor · ${kgText(stated.quantityKg)} kg available`)}
      action={<button type="button" className="st-textlink is-sm" onClick={() => { setStatedLot(""); setChanging(false); }}>{L("العودة للتلقائي", "Back to automatic")}</button>} />;
  } else if (pick?.ok) {
    const fb = pick.source === "fifo_fallback";
    greenLine = <AutoRow testId="roast-green" warn={fb}
      title={<>{L("البن الأخضر: ", "Green: ")}{lotName(pick.lot)} <span className="ops-serial">{pick.lot.serialNumber}</span></>}
      sub={fb
        ? L(`اللوت الافتراضي ${pick.defaultLot?.serialNumber ?? ""} لا يكفي، فأُخذ الأقدم من نفس البن والبلد · متاح ${kgText(pick.lot.quantityKg)} كغ`, `The default lot ${pick.defaultLot?.serialNumber ?? ""} is short, so the oldest lot of the same bean and origin is used · ${kgText(pick.lot.quantityKg)} kg available`)
        : L(`محدد تلقائيًا من إعداد المنتج · متاح ${kgText(pick.lot.quantityKg)} كغ`, `Chosen automatically from the product · ${kgText(pick.lot.quantityKg)} kg available`)}
      action={canChangeGreen ? <button type="button" className="st-textlink is-sm" onClick={() => setChanging(true)} data-testid="roast-green-change">{L("تغيير", "Change")}</button> : undefined} />;
  } else if (pick && !pick.ok) {
    const msg = greenRefusal(pick, Number.isFinite(g) ? g : 0);
    greenLine = <AutoRow warn testId="roast-green" title={L("لا يكفي البن الأخضر", "Not enough green coffee")} sub={lang === "ar" ? msg.ar : msg.en}
      action={canChangeGreen ? <button type="button" className="st-textlink is-sm" onClick={() => setChanging(true)} data-testid="roast-green-change">{L("اختر مصدرًا", "Pick a lot")}</button> : undefined} />;
  }

  return (
    <OpsPane
      testId="roast-sheet"
      label={title}
      title={title}
      sub={sub}
      busy={busy}
      onClose={onClose}
      footer={<Cta testId="roast-save" disabled={!ready} busy={busy} onClick={() => save(false)}>{L("سجّل الدفعة", "Record the batch")}</Cta>}
    >
      <div className="st-body">
        {stock ? (
          <div className="st-field">
            <span className="st-label" id="roast-coffee-l">{L("القهوة", "Coffee")}</span>
            <Chips testId="roast-coffee" label={L("القهوة", "Coffee")} value={productId}
              onChange={(v) => { setProductId(v); setStatedLot(""); setChanging(false); }}
              options={products.map((p) => ({ value: p.id, label: lang === "ar" ? p.productNameAr || p.productNameEn : p.productNameEn }))} />
          </div>
        ) : null}
        {greenLine}
        {changing && canChangeGreen ? (
          <div className="st-field">
            <label htmlFor="roast-lot">{L("مصدر البن الأخضر (للمشرف)", "Green lot (supervisor)")}</label>
            <Select id="roast-lot" value={statedLot} onChange={(e) => setStatedLot(e.target.value)} className="hr-input" style={{ height: 48, width: "100%" }}>
              <option value="">{L("اختر لوتًا", "Choose a lot")}</option>
              {beans.filter((b) => b.isActive !== false && b.quantityKg > 0).map((b) => (
                <option key={b.id} value={b.id}>{b.beanType} ({b.serialNumber}) — {kgText(b.quantityKg)} {L("كغ", "kg")}</option>
              ))}
            </Select>
          </div>
        ) : null}
        <div>
          <NumIn id="roast-green-kg" testId="roast-green-kg" label={L("البن الأخضر الداخل للمحمصة", "Green coffee into the roaster")} value={green} onChange={setGreen} unit={L("كغ", "kg")} placeholder="0.00" />
          {quick.length ? (
            <div className="st-quick">{quick.map((v) => <button key={v} type="button" className="st-qb" onClick={() => setGreen(String(v))}>{v}</button>)}</div>
          ) : null}
        </div>
        <NumIn id="roast-roasted-kg" testId="roast-roasted-kg" label={L("المحمّص الخارج", "Roasted coffee out")} value={roasted} onChange={setRoasted} unit={L("كغ", "kg")} placeholder="0.00" autoFocus={!stock} />
        {live ? (
          <div className={`st-live ${live.tone}`} data-testid="roast-loss" role="status">
            <span>{live.left}</span>{live.right ? <span className="hr-num">{live.right}</span> : null}
          </div>
        ) : null}
        {mode.kind === "order" && mode.line.livePos.length > 1 ? (
          <div className="st-field">
            <label htmlFor="roast-po">{L("أمر الإنتاج", "Production order")}</label>
            <Select id="roast-po" value={poChoice} onChange={(e) => setPoChoice(e.target.value)} className="hr-input" style={{ height: 48, width: "100%" }}>
              <option value="">{L("اختر أمر الإنتاج لهذه الدفعة", "Which production order is this roast for?")}</option>
              {mode.line.livePos.map((p) => <option key={p.id} value={p.id}>{p.productionNumber}</option>)}
            </Select>
          </div>
        ) : null}
        <p className="st-note" data-testid="roast-allocation">{mode.kind === "order"
          ? L(`تُخصَّص لطلب #${mode.line.orderNumber} تلقائيًا، وتذهب للجودة.`, `Allocated to order #${mode.line.orderNumber} automatically, then to QC.`)
          : coffee
          ? (coffee.orders.length
              ? L(`تُخصَّص تلقائيًا لـ ${coffee.orders.map((o) => "#" + o.orderNumber).join(" ثم ")} حسب الأقدم، وتذهب للجودة.`, `Allocated automatically to ${coffee.orders.map((o) => "#" + o.orderNumber).join(" then ")}, oldest first, then to QC.`)
              : L("تذهب لمخزون الرف.", "Goes to the shelf."))
          : L("تذهب لمخزون الرف بعد الجودة، وتُخصَّص للطلبات الأقدم عند التعبئة.", "Goes to the shelf after QC; packaging promises it to the oldest orders.")}</p>
        <details className="st-more">
          <summary>{L("ملاحظة أو بروفايل (اختياري)", "Note or profile (optional)")}</summary>
          <div>
            <NumIn id="roast-profile" text small label={L("البروفايل", "Profile")} value={profile} onChange={setProfile} placeholder={L("مثال: متوسط", "e.g. medium")} inputMode="text" />
          </div>
        </details>
        {surplus ? (
          <div className="st-warnbox" role="alert" data-testid="roast-surplus">
            <b>{L("الدفعة تتجاوز المطلوب للطلب", "This roast exceeds what the order needs")}</b>
            <span>{surplus.message}</span>
            <NumIn id="roast-surplus-reason" text small label={L("سبب التحميص الزائد (8 أحرف على الأقل)", "Why roast the surplus (8+ characters)")} value={surplus.reason} onChange={(v) => setSurplus({ ...surplus, reason: v })} inputMode="text" />
            <button type="button" className="st-sec" disabled={surplus.reason.trim().length < 8 || busy} onClick={() => save(true)}>{L("سجّلها كفائض", "Record as surplus")}</button>
          </div>
        ) : null}
        {error ? <p className="hr-notice tone-danger" role="alert" style={{ margin: 0 }}>{error}</p> : null}
      </div>
    </OpsPane>
  );
}
