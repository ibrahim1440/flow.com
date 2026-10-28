"use client";
// One transfer («تحويل مخزون»): its route, status, lines (value at the moving average — information only: no journal
// entry), the movements it wrote at each location (including «في الطريق»), and its activity log (the person audit).
// Two-step (20261117090000_locations_enhancements): «استلام» at the destination — what arrived per line, a shortfall with
// its reason (written off from transit — the receiver records it with transfer_receive alone and the inventory
// supervisors are notified, the owner before the locations release), finished goods in full — inventory › transfer_receive. «إلغاء التحويل» (inventory › transfer_cancel): one step — the movements reversed while the goods are
// still at the destination; in transit — everything back to the source.
import { localizeApiError } from "@/lib/i18n/api-errors";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { Btn, Field, KV, Notice, OpsBanner, OpsError, OpsLoading, OpsRoot, PageHeader, SecHead, Timeline, opsDate, useL } from "@/components/ops/ui";
import { Dialog } from "@/components/hr/ui";
import "@/components/ops/stock.css";
import { useUser } from "../../../user-context";
import { hasSubPrivilege } from "@/lib/auth-shared";
import { useI18n } from "@/lib/i18n/context";
import { TRANSFER_STATUS_LABEL, TRANSIT_LABEL, TRANSIT_LOCATION_ID, locationName, type TransferStatus } from "@/lib/inventory/locations";
import { unitWord } from "../../_parts/shared";

type L10n = { id: string; code: string; nameAr: string; nameEn: string | null };
type Item = { code: string; name: string; nameAr: string | null; unit: string };
type Transfer = {
  id: string; ref: string; number: number; status: TransferStatus; mode: "IMMEDIATE" | "TWO_STEP"; transferDate: string; notes: string | null; createdByName: string | null; createdAt: string;
  sentAt: string | null; receivedAt: string | null; receivedByName: string | null; receiveNote: string | null;
  cancelledAt: string | null; cancelledByName: string | null; cancelReason: string | null;
  fromLocation: L10n; toLocation: L10n; fromLocationId: string; toLocationId: string;
  lines: { id: string; lineNo: number; itemKind: string; entityId: string; fgLotId: string | null; qty: number; qtyReceived: number | null; qtyShort: number | null; varianceReason: string | null; value: string; item: Item | null; fgLot: Item | null }[];
  movements: { id: string; type: string; locationId: string; referenceEntityId: string | null; quantityChanged: number; previousQuantity: number; newQuantity: number; timestamp: string; notes: string | null }[];
  glStates: string[];
  activity: { id: string; action: string; at: string; by: string | null; metadata: { reason?: string | null; lines?: unknown[] } | null }[];
};
const money = (v: string | number) => Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const q4 = (n: number) => Number(n.toFixed(4));

export default function TransferPage() {
  const { id } = useParams<{ id: string }>();
  const sp = useSearchParams();
  const user = useUser();
  const { lang } = useI18n();
  const L = useL();
  const canCancel = !!user && hasSubPrivilege(user.permissions, "inventory", "transfer_cancel");
  const canReceive = !!user && hasSubPrivilege(user.permissions, "inventory", "transfer_receive");
  const [t, setT] = useState<Transfer | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState("");
  const [cancelError, setCancelError] = useState("");
  const [busy, setBusy] = useState(false);
  const [receiving, setReceiving] = useState(false);
  const [recv, setRecv] = useState<Record<number, { qty: string; reason: string }>>({});
  const [recvNote, setRecvNote] = useState("");
  const [recvError, setRecvError] = useState("");
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await fetch(`/api/inventory/transfers/${id}`);
    if (r.ok) { setT(await r.json()); setFailed(null); } else setFailed(localizeApiError(await r.json().catch(() => ({})), lang) ?? (lang === "ar" ? "تعذّر تحميل التحويل." : "Could not load the transfer."));
  }, [id, lang]);
  useEffect(() => {
    let off = false;
    fetch(`/api/inventory/transfers/${id}`).then(async (r) => {
      if (off) return;
      if (!r.ok) { setFailed(lang === "ar" ? "تعذّر تحميل التحويل." : "Could not load the transfer."); return; }
      const j = (await r.json()) as Transfer;
      setT(j);
      if (sp.get("done")) setToast(j.status === "IN_TRANSIT"
        ? L("أُرسل التحويل: البضاعة «في الطريق» حتى يستلمها موقع الوصول.", "Transfer sent: the goods are «in transit» until the destination receives them.")
        : L("نُفّذ التحويل: انتقل الرصيد بين الموقعين.", "Transfer done: the stock moved between the two locations."));
    });
    return () => { off = true; };
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps -- once per transfer (the language is read when it fails)

  async function cancel() {
    setBusy(true);
    setCancelError("");
    const r = await fetch(`/api/inventory/transfers/${id}/cancel`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason }) });
    setBusy(false);
    if (!r.ok) { setCancelError(localizeApiError(await r.json().catch(() => ({})), lang) ?? L("تعذّر الإلغاء.", "Could not cancel.")); return; }
    setCancelling(false);
    setToast(L("أُلغي التحويل وعاد الرصيد إلى الموقع الأول.", "Transfer cancelled: the stock is back at the first location."));
    load();
  }

  function openReceive() {
    if (!t) return;
    setRecv(Object.fromEntries(t.lines.map((l) => [l.lineNo, { qty: String(q4(l.qty)), reason: "" }])));
    setRecvNote("");
    setRecvError("");
    setReceiving(true);
  }
  const recvRows = (t?.lines ?? []).map((l) => {
    const v = recv[l.lineNo] ?? { qty: String(l.qty), reason: "" };
    const n = v.qty.trim() === "" ? NaN : Number(v.qty);
    const short = Number.isFinite(n) ? q4(l.qty - n) : 0;
    const bad = !Number.isFinite(n) || n < 0 || n > l.qty + 1e-9 || (l.itemKind === "FG_LOT" && short > 0) || (short > 0 && v.reason.trim().length < 3);
    return { l, v, n, short, bad };
  });
  async function receive() {
    setBusy(true);
    setRecvError("");
    const body = { note: recvNote.trim() || null, lines: recvRows.map((r) => ({ lineNo: r.l.lineNo, qtyReceived: r.n, ...(r.short > 0 ? { varianceReason: r.v.reason.trim() } : {}) })) };
    const r = await fetch(`/api/inventory/transfers/${id}/receive`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    setBusy(false);
    if (!r.ok) { setRecvError(localizeApiError(await r.json().catch(() => ({})), lang) ?? L("تعذّر الاستلام.", "Could not receive.")); return; }
    setReceiving(false);
    setToast(L("استُلم التحويل: الرصيد الآن في موقع الوصول.", "Transfer received: the stock is now at the destination."));
    load();
  }

  if (failed) return <OpsRoot className="stk-inventory"><div className="hr-page"><OpsError message={failed} onRetry={load} /></div></OpsRoot>;
  if (!t) return <OpsRoot className="stk-inventory"><div className="hr-page"><OpsLoading /></div></OpsRoot>;
  const name = (l: L10n) => locationName(l, lang);
  const transitName = lang === "ar" ? TRANSIT_LABEL[0] : TRANSIT_LABEL[1];
  const siteName = (locId: string) => (locId === t.fromLocationId ? name(t.fromLocation) : locId === t.toLocationId ? name(t.toLocation) : locId === TRANSIT_LOCATION_ID ? transitName : locId);
  const itemOf = (entityId: string | null) => {
    const l = t.lines.find((x) => x.entityId === entityId || x.fgLotId === entityId);
    return l ? (l.fgLotId === entityId && l.fgLot ? l.fgLot : l.item) : undefined;
  };
  const total = t.lines.reduce((s, l) => s + Number(l.value), 0);
  const unitOf = (l: Transfer["lines"][number], n: number) => (l.itemKind === "FG_LOT" ? L(n === 1 ? "عبوة" : "عبوات", n === 1 ? "unit" : "units") : unitWord(l.item?.unit, lang, n));
  const ACTION: Record<string, [string, string]> = {
    STOCK_TRANSFER_CREATED: ["أنشأ التحويل ونفّذه", "Created and posted the transfer"],
    STOCK_TRANSFER_SENT: ["أرسل التحويل (في الطريق)", "Sent the transfer (in transit)"],
    STOCK_TRANSFER_RECEIVED: ["استلم التحويل", "Received the transfer"],
    STOCK_TRANSFER_CANCELLED: ["ألغى التحويل", "Cancelled the transfer"],
  };
  const statusText = TRANSFER_STATUS_LABEL[t.status] ? TRANSFER_STATUS_LABEL[t.status][lang === "ar" ? 0 : 1] : t.status;
  const statusTone = t.status === "CANCELLED" ? "tone-warning" : t.status === "IN_TRANSIT" ? "tone-info" : "tone-success";
  const anyShort = t.lines.some((l) => (l.qtyShort ?? 0) > 0);

  return (
    <OpsRoot className="stk-inventory">
      <div className="hr-page">
        <PageHeader
          title={<><span className="hr-id">{t.ref}</span> · {L("تحويل مخزون", "Stock transfer")}</>}
          actions={<>
            <Link className="hr-btn is-ghost" href="/dashboard/inventory/transfers">{L("كل التحويلات", "All transfers")}</Link>
            {canReceive && t.status === "IN_TRANSIT" ? <Btn variant="primary" onClick={openReceive} data-testid="transfer-receive">{L("استلام", "Receive")}</Btn> : null}
            {canCancel && (t.status === "POSTED" || t.status === "IN_TRANSIT") ? <Btn variant="danger" onClick={() => { setCancelling(true); setCancelError(""); setReason(""); }} data-testid="transfer-cancel">{L("إلغاء التحويل", "Cancel transfer")}</Btn> : null}
          </>}
        >
          <span className="trf-route" data-testid="transfer-route">
            <span className="strong">{name(t.fromLocation)}</span> <span aria-hidden="true">{lang === "en" ? "→" : "←"}</span><span className="hr-sr">{L("إلى", "to")}</span> <span className="strong">{name(t.toLocation)}</span>
            <span className={`stk-flag ${statusTone}`} data-testid="transfer-status">{statusText}</span>
          </span>
        </PageHeader>

        {toast ? <OpsBanner tone="success" onClose={() => setToast(null)}><span data-testid="transfer-toast">{toast}</span></OpsBanner> : null}
        {t.status === "IN_TRANSIT" ? (
          <Notice tone="info"><span data-testid="transfer-transit-note">{L(`البضاعة «في الطريق»: خرجت من «${name(t.fromLocation)}» ولم تصل «${name(t.toLocation)}» بعد. تبقى ضمن إجمالي المخزون وقيمته حتى الاستلام.`, `The goods are «in transit»: they left «${name(t.fromLocation)}» and have not reached «${name(t.toLocation)}» yet. They stay in the stock totals and value until received.`)}</span></Notice>
        ) : null}

        <KV rows={[
          [L("طريقة التحويل", "Transfer type"), t.mode === "TWO_STEP" ? L("إرسال ثم استلام", "Send, then receive") : L("تحويل فوري", "Instant transfer")],
          [L("تاريخ التحويل", "Transfer date"), opsDate(t.transferDate, lang)],
          [t.mode === "TWO_STEP" ? L("أرسله", "Sent by") : L("أنشأه", "Created by"), `${t.createdByName ?? "—"} · ${opsDate(t.sentAt ?? t.createdAt, lang, true)}`],
          ...(t.status === "RECEIVED" ? [[L("استلمه", "Received by"), `${t.receivedByName ?? "—"} · ${opsDate(t.receivedAt, lang, true)}${t.receiveNote ? ` · ${t.receiveNote}` : ""}`] as [string, string]] : []),
          [L("ملاحظات", "Notes"), t.notes ?? "—"],
          ...(t.status === "CANCELLED" ? [[L("أُلغي", "Cancelled"), `${t.cancelledByName ?? "—"} · ${opsDate(t.cancelledAt, lang, true)} · ${t.cancelReason ?? ""}`] as [string, string]] : []),
        ]} />

        <Notice tone="info"><span data-testid="transfer-gl-note">{anyShort
          ? L("لا قيد محاسبي للتحويل نفسه: انتقال بين مواقع الشركة بالقيمة نفسها (متوسط التكلفة). الفرق الناقص عند الاستلام شُطب كتسوية مخزون بسببه (فروقات المخزون).", "No journal entry for the transfer itself: a move between the company's locations at the same value (the moving average). The shortfall at receipt was written off as a stock adjustment with its reason (inventory variance).")
          : L("لا قيد محاسبي: التحويل بين مواقع الشركة لا يغيّر قيمة المخزون ولا حسابه. سُجّل في دفتر التكلفة خروج ودخول بالقيمة نفسها (متوسط التكلفة).", "No journal entry: a transfer between the company's locations changes neither the inventory value nor its account. The cost ledger records an out and an in at the same value (the moving average).")}</span></Notice>

        <SecHead title={L("الأصناف", "Items")} />
        <div className="hr-tablewrap">
          <table className="hr-table is-mrow" aria-label={L("أصناف التحويل", "Transfer lines")} data-testid="transfer-lines">
            <thead><tr><th>{L("الصنف", "Item")}</th><th className="num">{L("المرسَل", "Sent")}</th>{t.status === "RECEIVED" ? <th className="num">{L("المستلَم", "Received")}</th> : null}<th className="num hr-hide-mobile">{L("القيمة بالتكلفة (ر.س)", "Value at cost (SAR)")}</th></tr></thead>
            <tbody>
              {t.lines.map((l) => (
                <tr key={l.id} data-testid={`transfer-line-row-${l.lineNo}`}>
                  <td className="m-title">
                    <span className="strong">{l.item ? (lang === "ar" && l.item.nameAr ? l.item.nameAr : l.item.name) : l.entityId}</span>{" "}
                    <span className="hr-id hr-caption">{l.item?.code}</span>
                    {l.fgLot ? <span className="hr-caption" data-testid={`transfer-split-${l.lineNo}`}> · {L("لوت جديد من اللوت نفسه", "a new lot split from it")}</span> : null}
                    {(l.qtyShort ?? 0) > 0 ? <span className="stk-sub tr-short" data-testid={`transfer-short-${l.lineNo}`}>{L("ناقص", "Short")} <span className="hr-num">{q4(l.qtyShort!)}</span> — {l.varianceReason}</span> : null}
                    <span className="hr-msub">{L("القيمة بالتكلفة", "Value at cost")} <span className="hr-num">{money(l.value)}</span> {L("ر.س", "SAR")}</span>
                  </td>
                  <td className="num"><span className="hr-num">{q4(l.qty)}</span> <span className="hr-caption">{unitOf(l, l.qty)}</span></td>
                  {t.status === "RECEIVED" ? <td className="num"><span className="hr-num">{q4(l.qtyReceived ?? l.qty)}</span></td> : null}
                  <td className="num hr-hide-mobile"><span className="hr-num">{money(l.value)}</span></td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr><td>{L(`${t.lines.length} سطر`, `${t.lines.length} line${t.lines.length === 1 ? "" : "s"}`)}</td><td />{t.status === "RECEIVED" ? <td /> : null}<td className="num hr-hide-mobile stk-tot"><span className="hr-num">{money(total)}</span></td></tr></tfoot>
          </table>
        </div>

        <SecHead title={L("حركات المخزون", "Stock movements")} caption={L("الرصيد قبل وبعد في كل موقع", "The balance before and after at each location")} />
        <div className="hr-tablewrap">
          <table className="hr-table is-mrow" aria-label={L("حركات التحويل", "Transfer movements")} data-testid="transfer-movements">
            <thead><tr><th>{L("الموقع", "Location")}</th><th className="hr-hide-mobile">{L("الصنف", "Item")}</th><th className="num">{L("الكمية", "Quantity")}</th><th className="num hr-hide-mobile">{L("قبل → بعد", "Before → after")}</th></tr></thead>
            <tbody>
              {t.movements.map((m) => {
                const it = itemOf(m.referenceEntityId);
                return (
                  <tr key={m.id}>
                    <td className="m-title">
                      <span className="strong">{siteName(m.locationId)}</span>
                      <span className="hr-msub">{it ? (lang === "ar" && it.nameAr ? it.nameAr : it.name) : ""} · <bdi dir="ltr" className="hr-num">{q4(m.previousQuantity)} → {q4(m.newQuantity)}</bdi></span>
                    </td>
                    <td className="hr-hide-mobile">{it ? (lang === "ar" && it.nameAr ? it.nameAr : it.name) : "—"} <span className="hr-id hr-caption">{it?.code}</span></td>
                    <td className={`num ${m.quantityChanged < 0 ? "stk-loss" : "stk-gain"}`}><span className="hr-num">{m.quantityChanged > 0 ? "+" : ""}{q4(m.quantityChanged)}</span></td>
                    <td className="num hr-hide-mobile"><bdi dir="ltr" className="hr-num">{q4(m.previousQuantity)} → {q4(m.newQuantity)}</bdi></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <SecHead title={L("سجل النشاط", "Activity log")} />
        <div data-testid="transfer-activity">
          <Timeline items={t.activity.map((a) => ({
            key: a.id,
            tone: a.action === "STOCK_TRANSFER_CANCELLED" ? "danger" as const : a.action === "STOCK_TRANSFER_SENT" ? undefined : "success" as const,
            text: <><span className="strong">{a.by ?? "—"}</span> · {ACTION[a.action] ? ACTION[a.action][lang === "ar" ? 0 : 1] : a.action}{a.metadata?.reason ? ` — ${a.metadata.reason}` : ""}</>,
            when: opsDate(a.at, lang, true),
          }))} />
        </div>

        <Dialog open={receiving} title={L("استلام التحويل", "Receive the transfer")} sub={<><span className="hr-id">{t.ref}</span> · {name(t.fromLocation)} {lang === "en" ? "→" : "←"} {name(t.toLocation)}</>} onClose={() => setReceiving(false)} className="stk-wide"
          actions={<>
            <Btn variant="primary" busy={busy} disabled={recvRows.some((r) => r.bad)} onClick={receive} data-testid="transfer-receive-confirm">{L("تأكيد الاستلام", "Confirm receipt")}</Btn>
            <Btn onClick={() => setReceiving(false)}>{L("رجوع", "Back")}</Btn>
          </>}
        >
          {recvError ? <Notice tone="danger"><span data-testid="transfer-receive-error">{recvError}</span></Notice> : null}
          <p className="hr-caption" style={{ margin: 0 }}>{L(`سجّل ما وصل فعلًا إلى «${name(t.toLocation)}». إن وصل أقل: اكتب السبب، ويُشطب الناقص من المخزون كتسوية ويُبلَّغ مشرفو المخزون. المنتج الجاهز يُستلم كاملًا.`, `Record what actually reached «${name(t.toLocation)}». If less arrived, give the reason; the missing quantity is written off as an adjustment and the inventory supervisors are notified. Finished goods are received in full.`)}</p>
          <div className="tr-recv-lines" role="list" aria-label={L("سطور الاستلام", "Receipt lines")}>
            {recvRows.map(({ l, v, short }) => (
              <div key={l.id} className="tr-recv-line" role="listitem" data-testid={`receive-line-${l.lineNo}`}>
                <div className="tr-recv-item">
                  <span className="strong">{l.item ? (lang === "ar" && l.item.nameAr ? l.item.nameAr : l.item.name) : l.entityId}</span> <span className="hr-id hr-caption">{l.item?.code}</span>
                  <span className="hr-caption tr-recv-sent">{L("المرسَل", "Sent")} <span className="hr-num">{q4(l.qty)}</span> {unitOf(l, l.qty)}</span>
                </div>
                <label className="tr-recv-field">
                  <span className="hr-caption">{L("المستلَم", "Received")}</span>
                  <input className="hr-input tr-recv-in" inputMode="decimal" type="number" min={0} max={l.qty} step="any" disabled={l.itemKind === "FG_LOT"}
                    value={v.qty} data-testid={`receive-qty-${l.lineNo}`} onChange={(e) => setRecv((r) => ({ ...r, [l.lineNo]: { ...v, qty: e.target.value } }))} />
                </label>
                {short > 0 ? (
                  <label className="tr-recv-field tr-recv-why">
                    <span className="hr-caption">{L(`سبب الفرق (${q4(short)} ناقص)`, `Reason for the difference (${q4(short)} short)`)}</span>
                    <input className="hr-input tr-recv-reason" maxLength={300} placeholder={L("مثال: كيس تالف أثناء النقل", "e.g. a sack damaged on the way")}
                      value={v.reason} data-testid={`receive-reason-${l.lineNo}`} onChange={(e) => setRecv((r) => ({ ...r, [l.lineNo]: { ...v, reason: e.target.value } }))} />
                  </label>
                ) : null}
              </div>
            ))}
          </div>
          <Field label={L("ملاحظة الاستلام", "Receipt note")}>
            <input className="hr-input" maxLength={500} value={recvNote} onChange={(e) => setRecvNote(e.target.value)} data-testid="receive-note" />
          </Field>
        </Dialog>

        <Dialog open={cancelling} title={L("إلغاء التحويل", "Cancel transfer")} sub={<span className="hr-id">{t.ref}</span>} onClose={() => setCancelling(false)}
          actions={<>
            <Btn variant="danger" busy={busy} disabled={reason.trim().length < 3} onClick={cancel} data-testid="transfer-cancel-confirm">{L("إلغاء التحويل", "Cancel transfer")}</Btn>
            <Btn onClick={() => setCancelling(false)}>{L("رجوع", "Back")}</Btn>
          </>}
        >
          {cancelError ? <Notice tone="danger"><span data-testid="transfer-cancel-error">{cancelError}</span></Notice> : null}
          <p style={{ margin: 0 }}>{t.status === "IN_TRANSIT"
            ? L(`البضاعة في الطريق: تعود كلها إلى «${name(t.fromLocation)}».`, `The goods are in transit: they all go back to «${name(t.fromLocation)}».`)
            : L(`يعود الرصيد من «${name(t.toLocation)}» إلى «${name(t.fromLocation)}». لا يُلغى إذا استُخدمت البضاعة أو نُقلت من الوجهة.`, `The stock goes back from «${name(t.toLocation)}» to «${name(t.fromLocation)}». Refused if the goods were used or moved on from the destination.`)}</p>
          <Field label={`${L("سبب الإلغاء", "Reason")} *`}>
            <input className="hr-input" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} data-testid="transfer-cancel-reason" />
          </Field>
        </Dialog>
      </div>
    </OpsRoot>
  );
}
