"use client";

import { localizeApiError } from "@/lib/i18n/api-errors";
import { useState, useEffect, useMemo, useRef } from "react";
import Link from "next/link";
import { Printer } from "lucide-react";
import { Btn, Notice, OpsBanner, OpsEmpty, OpsError, OpsLoading, OpsPane, OpsRoot, PageHeader, StatusDot, Tabs, Kg, kg, opsDate, countNoun, UNIT_FORMS, useL } from "@/components/ops/ui";
import { useUser } from "../user-context";
import { hasModuleAccess, hasSubPrivilege } from "@/lib/auth-shared";
import { PRINT_PHASE1_NOTE_ID, PrintPhase1Notice, usePrintDocuments } from "@/components/print/Certification";
import { deliveryShipments } from "@/lib/print/delivery-note";
import { useI18n } from "@/lib/i18n/context";
import { LocationSelect, useLocations } from "../inventory/_parts/locations";
import { pickerLocations } from "@/lib/inventory/locations";
import { SamplesQueue, type SampleRequest } from "./SamplesQueue";

// ─── Dispatch without lots (production simplification, Phase D item 7) ───────────────────────
//
// «سلّم» is two interactions: tap the ready order, confirm. The quantity per line is pre-filled
// with what is ready and stays editable (a partial delivery); there is no lot picker. The server
// picks the lots — the line's reservations first, then free stock, oldest lot first — and answers
// with the lots it used, which the screen shows read-only after the delivery.

type ReadyLine = {
  orderItemId: string; isUnitLine: boolean; nameEn: string; nameAr: string | null; pack: string | null; skuCode: string | null;
  ordered: number; delivered: number; outstanding: number; reserved: number; ready: number; blocked: boolean;
  sources: { lotId: string; batchNumber: string | null; quantity: number; fromReservation: number }[];
};
type ReadyOrder = {
  id: string; orderNumber: number; status: string; createdAt: string;
  customer: { name: string; nameAr: string | null };
  lines: ReadyLine[]; complete: boolean;
  /** Workstations W4 (J-18): handed to dispatch by the preparation station, not delivered yet. */
  handoff?: { units: number; lines: Record<string, number>; stagingNote: string | null; packages: number | null; at: string; byName: string } | null;
};
type LotRef = { finishedGoodsLotId: string; batchNumber: string | null; quantityUnits: number | null; quantityKg: number; source: "line" | "ledger" };
type DeliveryRow = {
  id: string; date: string; createdAt: string; quantityKg: number; quantityUnits: number | null; deliveryType: string; notes: string | null;
  orderItem: { beanTypeName: string; order: { id: string; orderNumber: number; customer: { name: string } } };
  lots?: LotRef[];
};
type Done = { orderNumber: number; deliveryIds: string[]; lines: { name: string; isUnitLine: boolean; quantity: number; lots: LotRef[] }[]; complete: boolean };

/**
 * One dispatch, one key — per line. The server refuses a delivery without an Idempotency-Key
 * and uses it to tell a retry from a second dispatch. Minted once when the order is opened and
 * kept across a failed attempt, so a retry after a lost answer replays instead of shipping twice.
 * getRandomValues keeps 128 bits where randomUUID is unavailable (plain http on the shop LAN).
 */
function newIdempotencyKey(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  const bytes = new Uint8Array(16);
  c.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const r3 = (v: number) => Number(v.toFixed(3));

/** The preview of which lots a chosen quantity would leave from: a prefix of the full plan. */
function previewFor(line: ReadyLine, qty: number) {
  const out: { batchNumber: string | null; quantity: number; reserved: boolean }[] = [];
  let left = qty;
  for (const s of line.sources) {
    if (left <= (line.isUnitLine ? 0 : 0.0005)) break;
    const q = line.isUnitLine ? Math.min(left, s.quantity) : r3(Math.min(left, s.quantity));
    out.push({ batchNumber: s.batchNumber, quantity: q, reserved: s.fromReservation > 0 });
    left = line.isUnitLine ? left - q : r3(left - q);
  }
  return out;
}

export default function DispatchPage() {
  const { t, lang } = useI18n();
  const L = useL();
  const user = useUser();
  const canDeliver = hasSubPrivilege(user?.permissions ?? {}, "dispatch", "mark_delivered");
  // «طباعة إشعار التسليم» (feat/print-docs): the delivery note is an A4 document behind the document
  // gate (PRINT_DOCUMENTS_ENABLED; unknown = off, disabled with the Phase 1 note). Its page lives
  // under Orders (/dashboard/orders/print/delivery-note), so it is offered to whoever can open Orders.
  const printing = usePrintDocuments();
  const canOpenNote = hasModuleAccess(user?.permissions ?? {}, "orders");
  const noteHref = (ids: string[]) => `/dashboard/orders/print/delivery-note?ids=${ids.map(encodeURIComponent).join(",")}&from=dispatch`;

  const [ready, setReady] = useState<ReadyOrder[]>([]);
  const [deliveries, setDeliveries] = useState<DeliveryRow[]>([]);
  // «عيّنات للصرف» (docs/sales/SAMPLES_INVENTORY.md): the stock samples reps requested, waiting for this department.
  const [samples, setSamples] = useState<SampleRequest[]>([]);
  // A link from elsewhere may open the queue directly (/dashboard/dispatch?tab=samples). The tabs render only after
  // the client has loaded, so reading the URL here cannot disagree with the server's markup.
  const [tab, setTab] = useState<"ready" | "samples" | "history">(() =>
    typeof window !== "undefined" && new URLSearchParams(window.location.search).get("tab") === "samples" ? "samples" : "ready");
  const [search, setSearch] = useState("");
  const [readySearch, setReadySearch] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);

  // ── The open order ────────────────────────────────────────────────────
  const [open, setOpen] = useState<ReadyOrder | null>(null);
  const [qty, setQty] = useState<Record<string, number>>({});
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitKind, setSubmitKind] = useState<"refused" | "unconfirmed" | null>(null);
  const [submitError, setSubmitError] = useState("");
  const [done, setDone] = useState<Done | null>(null);
  // Not state: a retry must read exactly the keys the previous attempt used.
  const keysRef = useRef<Record<string, string>>({});
  const shippedRef = useRef<Record<string, { id: string; quantity: number; lots: LotRef[] }>>({});

  // «الشحن من» (20261117090000_locations_enhancements): the site the dispatch draws finished lots from. Starts on the
  // production site (where packing puts them); the list and the POST both use it.
  const { state: locs } = useLocations(false);
  const [shipFrom, setShipFrom] = useState("");
  const site = shipFrom || locs?.productionId || "";
  const multiSite = !!locs && pickerLocations(locs.locations).length > 1;

  useEffect(() => { loadData(); }, [site]); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadData() {
    const [readyRes, delRes, smpRes] = await Promise.all([fetch(`/api/deliveries/ready${site ? `?location=${encodeURIComponent(site)}` : ""}`), fetch("/api/deliveries"), fetch("/api/deliveries/samples")]);
    const take = async (r: Response) => (r.ok ? r.json() : (await r.text(), null));
    const [readyJ, delJ, smpJ] = await Promise.all([readyRes, delRes, smpRes].map(take));
    setLoadError(readyJ === null || delJ === null || smpJ === null);
    if (readyJ) setReady(readyJ.orders);
    if (delJ) setDeliveries(delJ);
    if (smpJ) setSamples(smpJ.samples ?? []);
    setLoaded(true);
  }

  const nameOf = (l: { nameEn: string; nameAr: string | null; pack: string | null }) =>
    `${lang === "ar" ? (l.nameAr || l.nameEn) : l.nameEn}${l.pack && !(lang === "ar" ? l.nameAr || l.nameEn : l.nameEn).includes(l.pack) ? ` ${l.pack}` : ""}`;
  const qtyText = (isUnit: boolean, n: number) => (isUnit ? countNoun(n, lang, UNIT_FORMS) : `${kg(n, 3)} ${t("opsKgUnit")}`);

  function openOrder(o: ReadyOrder) {
    if (!canDeliver) return;
    setOpen(o);
    // A handed-off order starts at what the preparation station handed over (J-18); else what is ready.
    setQty(Object.fromEntries(o.lines.map((l) => [l.orderItemId, o.handoff ? Math.min(l.ready, o.handoff.lines[l.orderItemId] ?? 0) : l.ready])));
    setNotes("");
    setSubmitKind(null);
    setSubmitError("");
    keysRef.current = Object.fromEntries(o.lines.map((l) => [l.orderItemId, newIdempotencyKey()]));
    shippedRef.current = {};
  }
  function closeOrder() {
    if (submitting) return;
    setOpen(null);
    keysRef.current = {};
    shippedRef.current = {};
  }

  function setLineQty(l: ReadyLine, v: number) {
    const max = l.ready;
    const n = l.isUnitLine ? Math.trunc(v) : r3(v);
    setQty((q) => ({ ...q, [l.orderItemId]: Math.max(0, Math.min(max, Number.isFinite(n) ? n : 0)) }));
  }

  const chosen = open ? open.lines.filter((l) => (qty[l.orderItemId] ?? 0) > 0) : [];
  const chosenUnits = chosen.filter((l) => l.isUnitLine).reduce((s, l) => s + (qty[l.orderItemId] ?? 0), 0);
  const chosenKg = r3(chosen.filter((l) => !l.isUnitLine).reduce((s, l) => s + (qty[l.orderItemId] ?? 0), 0));
  const completes = !!open && open.lines.every((l) => (qty[l.orderItemId] ?? 0) >= l.outstanding);

  async function confirm() {
    if (!open || submitting || chosen.length === 0) return;
    setSubmitting(true);
    setSubmitKind(null);
    setSubmitError("");
    try {
      // One POST per line, sequentially, each under its own key. A line already confirmed in an
      // earlier attempt is not sent again; a line whose answer was lost is resent with the same
      // key and comes back as a replay (200) instead of a second shipment.
      for (const l of chosen) {
        if (shippedRef.current[l.orderItemId]) continue;
        const key = keysRef.current[l.orderItemId] ?? (keysRef.current[l.orderItemId] = newIdempotencyKey());
        const q = qty[l.orderItemId];
        let res: Response;
        try {
          res = await fetch("/api/deliveries", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Idempotency-Key": key },
            body: JSON.stringify({
              orderItemId: l.orderItemId,
              ...(l.isUnitLine ? { quantityUnits: Math.trunc(q) } : { quantityKg: q }),
              notes: notes.trim() || null,
              ...(site ? { locationId: site } : {}),
            }),
          });
        } catch {
          setSubmitKind("unconfirmed");
          return;
        }
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          // 4xx: refused, nothing recorded for this line — its key is released. 5xx: it may have
          // been recorded; the key stays so the retry is a replay.
          if (res.status < 500) keysRef.current[l.orderItemId] = newIdempotencyKey();
          setSubmitKind(res.status >= 500 ? "unconfirmed" : "refused");
          setSubmitError(localizeApiError(data, lang) || "");
          return;
        }
        shippedRef.current[l.orderItemId] = { id: data.id, quantity: q, lots: data.lots ?? [] };
      }
      setDone({
        orderNumber: open.orderNumber,
        deliveryIds: Object.values(shippedRef.current).map((x) => x.id).filter(Boolean),
        complete: completes,
        lines: chosen.map((l) => ({ name: nameOf(l), isUnitLine: l.isUnitLine, quantity: shippedRef.current[l.orderItemId]?.quantity ?? 0, lots: shippedRef.current[l.orderItemId]?.lots ?? [] })),
      });
      setOpen(null);
      keysRef.current = {};
      shippedRef.current = {};
      loadData();
    } finally {
      setSubmitting(false);
    }
  }

  const shownReady = useMemo(() => {
    const q = readySearch.trim().toLowerCase();
    if (!q) return ready;
    return ready.filter((o) => `${o.orderNumber} ${o.customer.name} ${o.customer.nameAr ?? ""} ${o.lines.map((l) => `${l.nameEn} ${l.nameAr ?? ""}`).join(" ")}`.toLowerCase().includes(q));
  }, [ready, readySearch]);

  // The rows recorded together for one order (one confirm) print as one note.
  const shipmentOf = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const g of deliveryShipments(deliveries.map((d) => ({ id: d.id, orderId: d.orderItem.order.id, createdAt: d.createdAt ?? d.date, notes: d.notes })))) {
      const ids = g.map((x) => x.id);
      for (const id of ids) m.set(id, ids);
    }
    return m;
  }, [deliveries]);
  const noteButton = (ids: string[], testId: string, label: string) => (printing === true ? (
    <Link href={noteHref(ids)} className="hr-btn is-sm" data-testid={testId} aria-label={label}><Printer size={14} aria-hidden="true" /> {L("إشعار التسليم", "Delivery note")}</Link>
  ) : (
    <Btn size="sm" disabled aria-describedby={PRINT_PHASE1_NOTE_ID} data-testid={testId} aria-label={label}><Printer size={14} aria-hidden="true" /> {L("إشعار التسليم", "Delivery note")}</Btn>
  ));

  const shownDeliveries = deliveries.filter((d) =>
    `${d.orderItem.order.orderNumber} ${d.orderItem.order.customer.name} ${d.orderItem.beanTypeName} ${(d.lots ?? []).map((x) => x.batchNumber).join(" ")}`
      .toLowerCase().includes(search.toLowerCase())
  );

  // Each lot is its own isolated run: a Latin batch number inside Arabic text would otherwise
  // reorder the list («3 من R-2610-01، 3 من R-2610-04»).
  const lotsText = (lots: LotRef[] | undefined, isUnit: boolean) =>
    (lots ?? []).length === 0 ? "—" : (lots ?? []).map((x, j) => (
      <bdi key={j}>{j ? L("، ", ", ") : ""}<span className="hr-num">{isUnit && x.quantityUnits != null ? x.quantityUnits : kg(x.quantityKg, 3)}</span> {L("من", "from")} <span className="ops-serial">{x.batchNumber ?? "—"}</span></bdi>
    ));

  return (
    <OpsRoot className="ops-dispatch">
    <div className={`hr-split${open ? " has-preview" : ""}`}>
    <div className="hr-page">
      <PageHeader title={t("opsDispatchTitle")}>
        <span><span className="hr-num">{ready.length}</span> {L("طلب جاهز للتسليم", "orders ready to deliver")}</span>
      </PageHeader>

      {loadError ? <OpsError message={t("opsLoadFailed")} onRetry={loadData} /> : null}
      {!loaded && !loadError ? <OpsLoading /> : null}

      {done ? (
        <div data-testid="delivery-done">
          <OpsBanner tone="success" onClose={() => setDone(null)}>
            <strong className="d21-bold">
              {L(`سُجّل التسليم لطلب #${done.orderNumber}`, `Delivery recorded for order #${done.orderNumber}`)}
              {done.complete ? L(" · سُلّم الطلب كاملًا", " · the order is fully delivered") : L(" · سُلّم جزئيًا", " · partially delivered")}
            </strong>
            <span className="ops-dlots-head">{L("اللوتات المستخدمة (تلقائيًا)", "Lots used (picked automatically)")}</span>
            <ul className="ops-dlots" data-testid="delivery-lots-used">
              {done.lines.map((l, i) => (
                <li key={i}>
                  <span><bdi>{l.name}</bdi> · {qtyText(l.isUnitLine, l.quantity)}</span>
                  <span className="ops-dlots-src">{l.lots.map((x, j) => (
                    <span key={j}>{j ? L("، ", ", ") : ""}<span className="hr-num">{l.isUnitLine && x.quantityUnits != null ? x.quantityUnits : kg(x.quantityKg, 3)}</span> {L("من", "from")} <span className="ops-serial">{x.batchNumber ?? "—"}</span></span>
                  ))}</span>
                </li>
              ))}
            </ul>
            {canOpenNote && done.deliveryIds.length ? (
              <div style={{ marginTop: 8 }}>
                {printing === true ? (
                  <Link href={noteHref(done.deliveryIds)} className="hr-btn is-sm is-primary" data-testid="delivery-note-print">
                    <Printer size={14} aria-hidden="true" /> {L("طباعة إشعار التسليم", "Print delivery note")}
                  </Link>
                ) : (
                  <Btn size="sm" disabled aria-describedby={PRINT_PHASE1_NOTE_ID} data-testid="delivery-note-print">
                    <Printer size={14} aria-hidden="true" /> {L("طباعة إشعار التسليم", "Print delivery note")}
                  </Btn>
                )}
              </div>
            ) : null}
          </OpsBanner>
          {canOpenNote && printing === false ? <PrintPhase1Notice /> : null}
        </div>
      ) : null}

      {loaded ? (
        <Tabs
          label={t("opsDispatchTitle")}
          value={tab}
          onChange={setTab}
          items={[
            { key: "ready", label: t("readyForDelivery"), count: ready.length },
            { key: "samples", label: L("عيّنات للصرف", "Samples to issue"), count: samples.length },
            { key: "history", label: t("deliveryHistory"), count: deliveries.length },
          ]}
        />
      ) : null}

      {/* ── Samples to issue: requested by the reps, issued from finished stock here ── */}
      {loaded && tab === "samples" ? <SamplesQueue rows={samples} canIssue={canDeliver} onChanged={loadData} /> : null}

      {/* ── Ready to deliver: one card per order ── */}
      {loaded && tab === "ready" ? <section className="hr-stack" style={{ gap: 12 }} aria-label={t("readyForDelivery")}>
        {multiSite && locs ? (
          <div className="hr-filterbar" data-testid="dispatch-ship-from">
            <span className="hr-caption">{L("الشحن من", "Ship from")}</span>
            <LocationSelect locations={locs.locations} value={site} onChange={(id) => { if (!open) setShipFrom(id); }} label={L("الشحن من", "Ship from")} testId="dispatch-site" disabled={!!open} />
            <span className="hr-caption">{L("تُحسب الكميات الجاهزة من لوتات هذا الموقع فقط.", "Ready quantities count only the lots at this site.")}</span>
          </div>
        ) : null}
        {ready.length > 4 ? (
          <div className="hr-filterbar">
            <input type="search" className="hr-input hr-search" placeholder={L("ابحث برقم الطلب أو العميل", "Search by order or customer")} aria-label={L("بحث", "Search")} value={readySearch} onChange={(e) => setReadySearch(e.target.value)} />
          </div>
        ) : null}
        {ready.length === 0 ? (
          <OpsEmpty title={L("لا طلبات جاهزة", "No orders ready")} body={L("تظهر هنا تلقائيًا بعد التعبئة.", "They appear here automatically after packaging.")} />
        ) : shownReady.length === 0 ? (
          <OpsEmpty title={t("opsNoResults")} body={t("opsNoResultsBody")} action={<Btn onClick={() => setReadySearch("")}>{t("opsClearFilters")}</Btn>} />
        ) : (
          <div className="ops-dcards">
            {shownReady.map((o) => {
              const readyTotal = o.lines.reduce((s, l) => s + (l.isUnitLine ? l.ready : 0), 0);
              const leftTotal = o.lines.reduce((s, l) => s + (l.isUnitLine ? l.outstanding : 0), 0);
              const customer = lang === "ar" ? (o.customer.nameAr || o.customer.name) : o.customer.name;
              return (
                <button key={o.id} type="button" className="ops-dcard" data-testid={`dispatch-order-${o.orderNumber}`} aria-pressed={open?.id === o.id}
                  disabled={!canDeliver} onClick={() => openOrder(o)}>
                  <span className="ops-dcard-row">
                    <span className="ops-dcard-t"><span className="hr-id">#{o.orderNumber}</span> · <bdi>{customer}</bdi></span>
                    {canDeliver ? <span className="ops-dcard-go" aria-hidden="true">{L("سلّم", "Deliver")}</span> : null}
                  </span>
                  <span className="ops-dcard-s">
                    {o.lines.filter((l) => l.ready > 0).map((l, i) => (
                      <span key={l.orderItemId}>{i ? L("، ", ", ") : ""}{l.isUnitLine ? <span className="hr-num">{l.ready}</span> : <Kg v={l.ready} />}{l.isUnitLine ? " × " : " "}<bdi>{nameOf(l)}</bdi></span>
                    ))}
                  </span>
                  <span className="ops-dcard-tags">
                    {o.complete
                      ? <span className="ops-dtag tone-ok">{L("الطلب كاملًا", "Whole order")}</span>
                      : <span className="ops-dtag tone-info">{leftTotal > 0
                          ? L(`${readyTotal} من ${leftTotal} متبقية`, `${readyTotal} of ${leftTotal} remaining`)
                          : L("جزء جاهز", "Partly ready")}</span>}
                    {o.lines.some((l) => l.reserved > 0) ? <span className="ops-dtag">{L("محجوز للطلب", "Reserved for the order")}</span> : null}
                    {o.handoff ? <span className="ops-dtag tone-ok" data-testid={`dispatch-handed-${o.orderNumber}`}>{L("جاهز للشحن · سُلّم من التجهيز", "Ready to ship · handed over by preparation")}</span> : null}
                  </span>
                  {o.handoff ? (
                    <span className="ops-dcard-s" data-testid={`dispatch-staging-${o.orderNumber}`}>
                      {L("المكان: ", "Staged at: ")}<bdi>{o.handoff.stagingNote || L("لم يُحدَّد", "not given")}</bdi>
                      {o.handoff.packages != null ? <> · <span className="hr-num">{o.handoff.packages}</span> {L("طرود", "parcels")}</> : null}
                      {" · "}<span className="hr-num">{o.handoff.units}</span> {L("وحدة مُجهّزة", "units prepared")} · {L("جهّزه", "by")} <bdi>{o.handoff.byName}</bdi>
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        )}
      </section> : null}

      {/* ── History: every delivery with the lots it drew from ── */}
      {loaded && tab === "history" ? <section className="hr-stack" style={{ gap: 12 }} aria-label={t("deliveryHistory")}>
        {canOpenNote && printing === false && deliveries.length > 0 ? <PrintPhase1Notice /> : null}
        <div className="hr-filterbar">
          <input type="text" placeholder={t("searchDeliveries")} aria-label={t("searchDeliveries")} value={search} onChange={(e) => setSearch(e.target.value)} className="hr-input hr-search" />
        </div>
        {deliveries.length === 0 ? (
          <OpsEmpty title={t("noData")} />
        ) : shownDeliveries.length === 0 ? (
          <OpsEmpty title={t("opsNoResults")} body={t("opsNoResultsBody")} action={<Btn onClick={() => setSearch("")}>{t("opsClearFilters")}</Btn>} />
        ) : (
          <div className="hr-tablewrap">
            <table className="hr-table is-mrow" aria-label={t("deliveryHistory")}>
              <thead>
                <tr>
                  <th>{t("date")}</th>
                  <th>{t("orderCol")}</th>
                  <th>{t("customer")}</th>
                  <th>{t("beanCol")}</th>
                  <th className="num">{L("الكمية", "Quantity")}</th>
                  <th>{L("اللوتات", "Lots")}</th>
                  <th>{t("type")}</th>
                  {canOpenNote ? <th aria-label={L("إشعار التسليم", "Delivery note")} /> : null}
                </tr>
              </thead>
              <tbody>
                {shownDeliveries.map((d) => {
                  const unit = d.quantityUnits != null;
                  return (
                    <tr key={d.id} data-testid={`delivery-row-${d.id}`}>
                      <td>{opsDate(d.date, lang)}</td>
                      <td className="hr-id">#{d.orderItem.order.orderNumber}</td>
                      <td className="m-title">
                        <span className="strong">{d.orderItem.order.customer.name}</span>
                        <span className="hr-msub">
                          <span className="hr-id">#{d.orderItem.order.orderNumber}</span> · {d.orderItem.beanTypeName} · {unit ? countNoun(d.quantityUnits!, lang, UNIT_FORMS) : <Kg v={d.quantityKg} />} · {opsDate(d.date, lang)}
                        </span>
                        <span className="hr-msub ops-dlots-src">{L("اللوتات:", "Lots:")} {lotsText(d.lots, unit)}</span>
                      </td>
                      <td>{d.orderItem.beanTypeName}</td>
                      <td className="num"><span className="hr-num">{unit ? d.quantityUnits : kg(d.quantityKg)}</span>{unit ? null : <span className="hr-caption"> {t("opsKgUnit")}</span>}</td>
                      <td className="ops-dlots-src">{lotsText(d.lots, unit)}</td>
                      <td className="m-end">
                        <StatusDot map={{ full: [t("fullBadge"), "success"], partial: [t("partialBadge"), "warning"] }} value={d.deliveryType === "full" ? "full" : "partial"} />
                      </td>
                      {canOpenNote ? (
                        <td className="ops-actions">
                          {noteButton(shipmentOf.get(d.id) ?? [d.id], `delivery-note-${d.id}`, L(`إشعار تسليم الطلب #${d.orderItem.order.orderNumber}`, `Delivery note for order #${d.orderItem.order.orderNumber}`))}
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section> : null}
    </div>

      {/* The confirm sheet: pane beside the list at 1440, drawer at 1024, bottom sheet on the phone. */}
      {open ? (
        <OpsPane
          testId="delivery-pane"
          label={t("recordDelivery")}
          title={L(`تسليم #${open.orderNumber}`, `Deliver #${open.orderNumber}`)}
          sub={<><bdi>{lang === "ar" ? (open.customer.nameAr || open.customer.name) : open.customer.name}</bdi>{open.handoff ? <> · {L("المكان: ", "Staged at: ")}<bdi>{open.handoff.stagingNote || L("لم يُحدَّد", "not given")}</bdi></> : null}</>}
          busy={submitting}
          onClose={closeOrder}
          footer={
            <Btn variant="primary" className="ops-dcta" data-testid="delivery-confirm" disabled={chosen.length === 0} busy={submitting} onClick={confirm}>
              {chosen.length === 0
                ? L("اختر الكمية", "Choose a quantity")
                : <>
                    {L("سلّم ", "Deliver ")}
                    {chosenUnits > 0 ? countNoun(chosenUnits, lang, UNIT_FORMS) : null}
                    {chosenUnits > 0 && chosenKg > 0 ? " + " : null}
                    {chosenKg > 0 ? `${kg(chosenKg, 3)} ${t("opsKgUnit")}` : null}
                    {completes ? L(" · يكتمل الطلب", " · completes the order") : null}
                  </>}
            </Btn>
          }
        >
          {submitKind ? (
            <Notice tone="danger">
              <strong style={{ fontWeight: 600 }}>{submitKind === "refused" ? t("deliveryRefused") : t("deliveryUnconfirmed")}</strong>
              {submitError && lang === "en" ? <div>{submitError}</div> : null}
              {Object.keys(shippedRef.current).length ? <div>{L("سُجّلت بعض الأسطر قبل التوقف ولن تُرسل مرة أخرى.", "Some lines were recorded before it stopped and will not be sent again.")}</div> : null}
            </Notice>
          ) : null}
          <div className="ops-dlines">
            {open.lines.map((l) => {
              const q = qty[l.orderItemId] ?? 0;
              const step = l.isUnitLine ? 1 : 0.25;
              const sent = !!shippedRef.current[l.orderItemId];
              return (
                <div key={l.orderItemId} className="ops-dline" data-testid={`delivery-line-${l.orderItemId}`}>
                  <div className="ops-dline-t">
                    <div className="ops-dline-name"><bdi>{nameOf(l)}</bdi>{sent ? <span className="ops-dtag tone-ok">{L("سُجّل", "Recorded")}</span> : null}</div>
                    <div className="ops-dline-sub">
                      {L("جاهز", "Ready")} <span className="hr-num">{l.isUnitLine ? l.ready : kg(l.ready, 3)}</span> · {L("المطلوب", "Due")} <span className="hr-num">{l.isUnitLine ? l.outstanding : kg(l.outstanding, 3)}</span>
                      {l.blocked ? <> · {L("موقوف", "Blocked")}</> : null}
                    </div>
                  </div>
                  <div className="ops-stepper" role="group" aria-label={L(`كمية ${nameOf(l)}`, `Quantity of ${nameOf(l)}`)}>
                    <button type="button" aria-label={L("زيادة", "Increase")} disabled={submitting || sent || q >= l.ready} onClick={() => setLineQty(l, q + step)}>+</button>
                    <input type="number" inputMode={l.isUnitLine ? "numeric" : "decimal"} min={0} max={l.ready} step={l.isUnitLine ? 1 : 0.001}
                      value={q} disabled={submitting || sent} aria-label={L("الكمية", "Quantity")}
                      onChange={(e) => setLineQty(l, parseFloat(e.target.value) || 0)} />
                    <button type="button" aria-label={L("إنقاص", "Decrease")} disabled={submitting || sent || q <= 0} onClick={() => setLineQty(l, q - step)}>−</button>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="ops-dauto">
            <strong>{L("لا حاجة لاختيار اللوت", "No lot to choose")}</strong>
            <span>{L("يسحب النظام من المحجوز لهذا الطلب أولًا، ثم الأقدم تعبئة.", "The system takes what is reserved for this order first, then the oldest packed stock.")}</span>
          </div>
          <details className="ops-dmore">
            <summary>{L("من أين ستُسحب؟", "Where will it come from?")}</summary>
            <ul className="ops-dlots" data-testid="delivery-preview">
              {chosen.map((l) => (
                <li key={l.orderItemId}>
                  <span><bdi>{nameOf(l)}</bdi></span>
                  <span className="ops-dlots-src">{previewFor(l, qty[l.orderItemId] ?? 0).map((p, j) => (
                    <span key={j}>{j ? L("، ", ", ") : ""}<span className="hr-num">{l.isUnitLine ? p.quantity : kg(p.quantity, 3)}</span> {L("من", "from")} <span className="ops-serial">{p.batchNumber ?? "—"}</span>{p.reserved ? L(" (محجوز)", " (reserved)") : ""}</span>
                  ))}</span>
                </li>
              ))}
            </ul>
            <p className="hr-caption" style={{ margin: 0 }}>{L("معاينة فقط؛ يختار الخادم اللوتات عند التأكيد.", "Preview only; the server picks the lots when you confirm.")}</p>
          </details>
          <details className="ops-dmore">
            <summary>{L("إضافة ملاحظة", "Add a note")}</summary>
            <textarea className="hr-input" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} aria-label={t("notes")} style={{ width: "100%", minHeight: 64 }} />
          </details>
        </OpsPane>
      ) : null}
    </div>
    </OpsRoot>
  );
}
