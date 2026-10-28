"use client";
// «تحويل مخزون» — the transfer form (unified inventory phase 3; two-step and finished goods 20261117090000). From a
// location, to another, the date, the lines (a green lot, a material, or a finished-goods lot in whole packages — never
// more than the source holds / has free), notes. Two ways (owner decision 1): «إرسال» (default) — the goods leave the
// source into «في الطريق» and the destination receives them («استلام»); or «تحويل فوري» — both sides in one step.
// POST /api/inventory/transfers. Prefilled from the address (?from=&to=&kind=&item=&qty=) — the link a refusal offers
// («انقل الرصيد أولًا», a roast short of green at the roastery).
import { localizeApiError } from "@/lib/i18n/api-errors";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Trash2 } from "lucide-react";
import { Btn, Field, Notice, OpsLoading, OpsRoot, PageHeader, useL } from "@/components/ops/ui";
import { Select } from "@/components/ui/Select";
import "@/components/ops/stock.css";
import { useUser } from "../../../user-context";
import { hasSubPrivilege } from "@/lib/auth-shared";
import { useI18n } from "@/lib/i18n/context";
import { covers, locationName, pickerLocations, type TransferMode } from "@/lib/inventory/locations";
import { LocationSelect, useBalances, useLocations } from "../../_parts/locations";
import { unitWord } from "../../_parts/shared";

type Bean = { id: string; serialNumber: string; beanType: string; beanTypeAr: string | null; quantityKg: number; isActive: boolean };
type Mat = { id: string; code: string; name: string; nameAr?: string | null; unitOfMeasure: string; quantityOnHand: number; isActive: boolean };
type Line = { key: string; item: string; qty: string };
type Opt = { value: string; kind: "GREEN_BEAN" | "MATERIAL" | "FG_LOT"; id: string; label: string; unit: string; whole: boolean; free?: number };
type FgLot = { id: string; batchNumber: string; free: number; skuCode: string | null; name: string; nameAr: string | null };

const today = () => new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, "");

export default function NewTransferPage() {
  return <Suspense fallback={<OpsLoading />}><NewTransfer /></Suspense>;
}

function NewTransfer() {
  const user = useUser();
  const router = useRouter();
  const sp = useSearchParams();
  const { lang } = useI18n();
  const L = useL();
  // inventory › transfer_send (owner decision 4, 20261117090000).
  const canWrite = !!user && hasSubPrivilege(user.permissions, "inventory", "transfer_send");
  const [mode, setMode] = useState<TransferMode>(sp.get("mode") === "IMMEDIATE" ? "IMMEDIATE" : "TWO_STEP");
  const [fgLots, setFgLots] = useState<FgLot[]>([]);
  const { state } = useLocations(false);
  const bal = useBalances(0);
  const [beans, setBeans] = useState<Bean[] | null>(null);
  const [mats, setMats] = useState<Mat[] | null>(null);
  const [fromPicked, setFrom] = useState(sp.get("from") ?? "");
  const [toPicked, setTo] = useState<string | null>(sp.get("to"));
  const [date, setDate] = useState(today());
  const [notes, setNotes] = useState("");
  const prefKind = sp.get("kind"), prefItem = sp.get("item");
  const [lines, setLines] = useState<Line[]>(() => [{ key: "l1", item: prefKind && prefItem ? `${prefKind}:${prefItem}` : "", qty: sp.get("qty") ?? "" }]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const requestKey = useRef(newKey());

  useEffect(() => {
    let off = false;
    Promise.all([fetch("/api/green-beans?all=1"), fetch("/api/materials?activeOnly=false")]).then(async ([b, m]) => {
      const [bj, mj] = await Promise.all([b.ok ? b.json() : [], m.ok ? m.json() : []]);
      if (!off) { setBeans(bj); setMats(mj); }
    }).catch(() => { if (!off) { setBeans([]); setMats([]); } });
    return () => { off = true; };
  }, []);

  const at = (kind: Opt["kind"], id: string, loc: string) => kind === "FG_LOT"
    ? fgLots.find((l) => l.id === id)?.free ?? 0
    : ((kind === "GREEN_BEAN" ? bal?.green : bal?.material)?.[id] ?? []).find((r) => r.locationId === loc)?.qty ?? 0;
  const options: Opt[] = useMemo(() => {
    const out: Opt[] = [];
    // Finished goods at the source: whole packages of a lot's free units (20261117090000, owner decision 2).
    for (const l of fgLots) out.push({ value: `FG_LOT:${l.id}`, kind: "FG_LOT", id: l.id, label: `${lang === "ar" && l.nameAr ? l.nameAr : l.name}${l.skuCode ? ` · ${l.skuCode}` : ""} · ${l.batchNumber}`, unit: "UNIT", whole: true, free: l.free });
    for (const b of beans ?? []) out.push({ value: `GREEN_BEAN:${b.id}`, kind: "GREEN_BEAN", id: b.id, label: `${lang === "ar" && b.beanTypeAr ? b.beanTypeAr : b.beanType} · ${b.serialNumber}`, unit: "KG", whole: false });
    for (const m of mats ?? []) out.push({ value: `MATERIAL:${m.id}`, kind: "MATERIAL", id: m.id, label: `${lang === "ar" && m.nameAr ? m.nameAr : m.name} · ${m.code}`, unit: m.unitOfMeasure, whole: m.unitOfMeasure === "PIECE" || m.unitOfMeasure === "UNIT" });
    return out;
  }, [beans, mats, fgLots, lang]);
  // An item is offered when the source holds some of it and no other line has it (or it is this line's).
  const offered = (current: string) => options.filter((o) => o.value === current || (at(o.kind, o.id, from) > 0 && !lines.some((ln) => ln.item === o.value)));

  const locs = state?.locations ?? [];
  // The source defaults to the default site, the destination to another active one (until the person picks); never
  // «في الطريق».
  const sites = pickerLocations(locs);
  const from = fromPicked || state?.defaultId || sites[0]?.id || "";
  const to = toPicked ?? sites.find((l) => l.id !== from)?.id ?? "";
  useEffect(() => {
    let off = false;
    if (!from) return;
    fetch(`/api/inventory/transfers/lots?location=${encodeURIComponent(from)}`).then(async (r) => { if (!off) setFgLots(r.ok ? ((await r.json()) as { lots: FgLot[] }).lots : []); }).catch(() => { if (!off) setFgLots([]); });
    return () => { off = true; };
  }, [from]);
  const fromL = locs.find((l) => l.id === from), toL = locs.find((l) => l.id === to);
  const checked = lines.map((ln) => {
    const o = options.find((x) => x.value === ln.item);
    const q = Number(ln.qty);
    const have = o ? at(o.kind, o.id, from) : 0;
    const valid = !!o && Number.isFinite(q) && q > 0 && (!o.whole || Number.isInteger(q));
    return { ln, o, q, have, valid, short: !!o && valid && !covers(have, q) };
  });
  const ready = !!from && !!to && from !== to && checked.length > 0 && checked.every((c) => c.valid && !c.short);

  async function submit() {
    setSaving(true);
    setError("");
    const body = {
      mode, fromLocationId: from, toLocationId: to, transferDate: date, notes: notes.trim() || null, requestKey: requestKey.current,
      lines: checked.map((c) => ({ itemKind: c.o!.kind, entityId: c.o!.id, qty: c.q })),
    };
    const r = await fetch("/api/inventory/transfers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    setSaving(false);
    if (!r.ok) { setError(localizeApiError(j, lang) ?? L("تعذّر التحويل.", "The transfer failed.")); return; }
    router.push(`/dashboard/inventory/transfers/${j.id}?done=1`);
  }

  if (!canWrite) {
    return <OpsRoot className="stk-inventory"><div className="hr-page"><Notice tone="info">{L("التحويل لمن يملك صلاحية «إنشاء تحويلات المخزون وإرسالها».", "Transfers need the «Create and send stock transfers» permission.")}</Notice></div></OpsRoot>;
  }
  return (
    <OpsRoot className="stk-inventory">
      <div className="hr-page">
        <PageHeader title={L("تحويل مخزون", "Stock transfer")} actions={<Link className="hr-btn is-ghost" href="/dashboard/inventory/transfers">{L("كل التحويلات", "All transfers")}</Link>}>
          <span className="hr-caption">{mode === "TWO_STEP"
            ? L("إرسال: ينقص الرصيد من الموقع الأول ويبقى «في الطريق» حتى يستلمه الموقع الثاني. لا قيد محاسبي — التكلفة للشركة كلها.", "Send: the stock leaves the first location and stays «in transit» until the second one receives it. No journal entry — cost is company-wide.")
            : L("تحويل فوري: ينقص الرصيد من الموقع الأول ويزيد في الثاني في خطوة واحدة. لا قيد محاسبي — التكلفة للشركة كلها.", "Instant transfer: the balance leaves the first location and arrives at the second in one step. No journal entry — cost is company-wide.")}</span>
        </PageHeader>

        {error ? <Notice tone="danger"><span data-testid="transfer-error">{error}</span></Notice> : null}
        {!state || !beans || !mats || !bal ? <OpsLoading /> : (
          <div className="hr-stack" style={{ gap: 16 }}>
            <div className="hr-row" role="radiogroup" aria-label={L("طريقة التحويل", "Transfer type")} style={{ gap: 8, flexWrap: "wrap" }} data-testid="transfer-mode">
              {(["TWO_STEP", "IMMEDIATE"] as const).map((m) => (
                <label key={m} className="trf-mode-opt" data-testid={`transfer-mode-${m}`}>
                  <input type="radio" name="transfer-mode" checked={mode === m} onChange={() => setMode(m)} />
                  <span>{m === "TWO_STEP" ? L("إرسال ثم استلام", "Send, then receive") : L("تحويل فوري", "Instant transfer")}</span>
                </label>
              ))}
            </div>
            <div className="hr-form">
              <Field label={`${L("من موقع", "From location")} *`}>
                <LocationSelect locations={locs} value={from} onChange={(v) => { setFrom(v); if (v === to) setTo(""); }} label={L("من موقع", "From location")} testId="transfer-from" />
              </Field>
              <Field label={`${L("إلى موقع", "To location")} *`}>
                <LocationSelect locations={locs} value={to} onChange={setTo} allOption={L("اختر الموقع", "Choose a location")} label={L("إلى موقع", "To location")} testId="transfer-to" exclude={from} />
              </Field>
              <Field label={`${L("تاريخ التحويل", "Transfer date")} *`}>
                <input className="hr-input" type="date" max={today()} value={date} onChange={(e) => setDate(e.target.value)} data-testid="transfer-date" />
              </Field>
            </div>

            <section className="hr-stack" style={{ gap: 8 }}>
              <h2 className="hr-h3" style={{ margin: 0 }}>{L("الأصناف", "Items")}</h2>
              <div className="trf-lines">
                {checked.map(({ ln, o, q, have, short }, i) => (
                  <div className="trf-line" key={ln.key} data-testid={`transfer-line-${i}`}>
                    <Field label={L("الصنف", "Item")}>
                      <Select className="hr-select trf-item" value={ln.item} data-testid={`transfer-item-${i}`} aria-label={L("الصنف", "Item")}
                        onChange={(e) => setLines((ls) => ls.map((x) => (x.key === ln.key ? { ...x, item: e.target.value } : x)))}>
                        <option value="">{L("اختر صنفًا في الموقع المصدر", "Choose an item at the source")}</option>
                        {offered(ln.item).map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
                      </Select>
                    </Field>
                    <Field label={o ? `${L("الكمية", "Quantity")} (${unitWord(o.unit, lang, 2)})` : L("الكمية", "Quantity")}>
                      <input className="hr-input hr-num" inputMode="decimal" value={ln.qty} data-testid={`transfer-qty-${i}`}
                        onChange={(e) => setLines((ls) => ls.map((x) => (x.key === ln.key ? { ...x, qty: e.target.value } : x)))} />
                    </Field>
                    <span className={`trf-have${short ? " is-short" : ""}`} data-testid={`transfer-have-${i}`}>
                      {o ? <>{o.kind === "FG_LOT" ? L("الحر في", "Free at") : L("المتوفر في", "Available at")} {fromL ? locationName(fromL, lang) : "—"}: <span className="hr-num">{Number(have.toFixed(4))}</span> {unitWord(o.unit, lang, have)}{short ? ` — ${L("لا يكفي", "not enough")}` : ""}{o.whole && ln.qty && !Number.isInteger(q) ? ` — ${L("كمية صحيحة", "a whole number")}` : ""}</> : null}
                    </span>
                    <Btn size="sm" variant="ghost" className="hr-iconbtn" aria-label={L("حذف السطر", "Remove line")} title={L("حذف السطر", "Remove line")} disabled={lines.length === 1}
                      onClick={() => setLines((ls) => ls.filter((x) => x.key !== ln.key))}><Trash2 size={16} /></Btn>
                  </div>
                ))}
              </div>
              <div><Btn size="sm" onClick={() => setLines((ls) => [...ls, { key: `l${Date.now()}`, item: "", qty: "" }])} data-testid="transfer-add-line">{L("+ سطر", "+ Line")}</Btn></div>
            </section>

            <Field label={L("ملاحظات", "Notes")} wide>
              <textarea className="hr-textarea" rows={2} maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} data-testid="transfer-notes" placeholder={L("مثال: تزويد المقهى لنهاية الأسبوع", "e.g. stocking the café for the weekend")} />
            </Field>

            <div className="hr-row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <Btn variant="primary" busy={saving} disabled={!ready} onClick={submit} data-testid="transfer-submit">{mode === "TWO_STEP" ? L("إرسال", "Send") : L("تحويل فوري", "Transfer now")}</Btn>
              <span className="hr-caption">{fromL && toL ? `${locationName(fromL, lang)} ${lang === "en" ? "→" : "←"} ${locationName(toL, lang)}` : L("اختر الموقعين.", "Choose both locations.")}</span>
            </div>
          </div>
        )}
      </div>
    </OpsRoot>
  );
}
