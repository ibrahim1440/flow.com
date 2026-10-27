"use client";
// One transfer («تحويل مخزون»): its route, lines (value at the moving average — information only: no journal entry), the
// movements it wrote at each location, and its activity log (the person audit: created, cancelled). «إلغاء التحويل»
// reverses the movements, only while the goods are still at the destination (inventory › adjust).
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
import { locationName } from "@/lib/inventory/locations";
import { unitWord } from "../../_parts/shared";

type L10n = { id: string; code: string; nameAr: string; nameEn: string | null };
type Transfer = {
  id: string; ref: string; number: number; status: string; transferDate: string; notes: string | null; createdByName: string | null; createdAt: string;
  cancelledAt: string | null; cancelledByName: string | null; cancelReason: string | null;
  fromLocation: L10n; toLocation: L10n; fromLocationId: string; toLocationId: string;
  lines: { id: string; lineNo: number; itemKind: string; entityId: string; qty: number; value: string; item: { code: string; name: string; nameAr: string | null; unit: string } | null }[];
  movements: { id: string; type: string; locationId: string; referenceEntityId: string | null; quantityChanged: number; previousQuantity: number; newQuantity: number; timestamp: string; notes: string | null }[];
  glStates: string[];
  activity: { id: string; action: string; at: string; by: string | null; metadata: { reason?: string | null; lines?: unknown[] } | null }[];
};
const money = (v: string | number) => Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function TransferPage() {
  const { id } = useParams<{ id: string }>();
  const sp = useSearchParams();
  const user = useUser();
  const { lang } = useI18n();
  const L = useL();
  const canCancel = !!user && hasSubPrivilege(user.permissions, "inventory", "adjust");
  const [t, setT] = useState<Transfer | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState("");
  const [cancelError, setCancelError] = useState("");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(sp.get("done") ? L("نُفّذ التحويل: انتقل الرصيد بين الموقعين.", "Transfer done: the stock moved between the two locations.") : null);

  const load = useCallback(async () => {
    const r = await fetch(`/api/inventory/transfers/${id}`);
    if (r.ok) { setT(await r.json()); setFailed(null); } else setFailed(localizeApiError(await r.json().catch(() => ({})), lang) ?? (lang === "ar" ? "تعذّر تحميل التحويل." : "Could not load the transfer."));
  }, [id, lang]);
  useEffect(() => {
    let off = false;
    fetch(`/api/inventory/transfers/${id}`).then(async (r) => { if (off) return; if (r.ok) setT(await r.json()); else setFailed(lang === "ar" ? "تعذّر تحميل التحويل." : "Could not load the transfer."); });
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

  if (failed) return <OpsRoot className="stk-inventory"><div className="hr-page"><OpsError message={failed} onRetry={load} /></div></OpsRoot>;
  if (!t) return <OpsRoot className="stk-inventory"><div className="hr-page"><OpsLoading /></div></OpsRoot>;
  const name = (l: L10n) => locationName(l, lang);
  const siteName = (locId: string) => (locId === t.fromLocationId ? name(t.fromLocation) : locId === t.toLocationId ? name(t.toLocation) : locId);
  const itemOf = (entityId: string | null) => t.lines.find((l) => l.entityId === entityId)?.item;
  const total = t.lines.reduce((s, l) => s + Number(l.value), 0);
  const ACTION: Record<string, [string, string]> = { STOCK_TRANSFER_CREATED: ["أنشأ التحويل ونفّذه", "Created and posted the transfer"], STOCK_TRANSFER_CANCELLED: ["ألغى التحويل", "Cancelled the transfer"] };

  return (
    <OpsRoot className="stk-inventory">
      <div className="hr-page">
        <PageHeader
          title={<><span className="hr-id">{t.ref}</span> · {L("تحويل مخزون", "Stock transfer")}</>}
          actions={<>
            <Link className="hr-btn is-ghost" href="/dashboard/inventory/transfers">{L("كل التحويلات", "All transfers")}</Link>
            {canCancel && t.status === "POSTED" ? <Btn variant="danger" onClick={() => { setCancelling(true); setCancelError(""); setReason(""); }} data-testid="transfer-cancel">{L("إلغاء التحويل", "Cancel transfer")}</Btn> : null}
          </>}
        >
          <span className="trf-route" data-testid="transfer-route">
            <span className="strong">{name(t.fromLocation)}</span> <span aria-hidden="true">←</span><span className="hr-sr">{L("إلى", "to")}</span> <span className="strong">{name(t.toLocation)}</span>
            <span className={`stk-flag ${t.status === "CANCELLED" ? "tone-warning" : "tone-success"}`} data-testid="transfer-status">{t.status === "CANCELLED" ? L("ملغى", "Cancelled") : L("منفّذ", "Posted")}</span>
          </span>
        </PageHeader>

        {toast ? <OpsBanner tone="success" onClose={() => setToast(null)}><span data-testid="transfer-toast">{toast}</span></OpsBanner> : null}

        <KV rows={[
          [L("تاريخ التحويل", "Transfer date"), opsDate(t.transferDate, lang)],
          [L("أنشأه", "Created by"), `${t.createdByName ?? "—"} · ${opsDate(t.createdAt, lang, true)}`],
          [L("ملاحظات", "Notes"), t.notes ?? "—"],
          ...(t.status === "CANCELLED" ? [[L("أُلغي", "Cancelled"), `${t.cancelledByName ?? "—"} · ${opsDate(t.cancelledAt, lang, true)} · ${t.cancelReason ?? ""}`] as [string, string]] : []),
        ]} />

        <Notice tone="info"><span data-testid="transfer-gl-note">{L("لا قيد محاسبي: التحويل بين مواقع الشركة لا يغيّر قيمة المخزون ولا حسابه. سُجّل في دفتر التكلفة خروج ودخول بالقيمة نفسها (متوسط التكلفة).", "No journal entry: a transfer between the company's locations changes neither the inventory value nor its account. The cost ledger records an out and an in at the same value (the moving average).")}</span></Notice>

        <SecHead title={L("الأصناف", "Items")} />
        <div className="hr-tablewrap">
          <table className="hr-table is-mrow" aria-label={L("أصناف التحويل", "Transfer lines")} data-testid="transfer-lines">
            <thead><tr><th>{L("الصنف", "Item")}</th><th className="num">{L("الكمية", "Quantity")}</th><th className="num hr-hide-mobile">{L("القيمة بالتكلفة (ر.س)", "Value at cost (SAR)")}</th></tr></thead>
            <tbody>
              {t.lines.map((l) => (
                <tr key={l.id}>
                  <td className="m-title">
                    <span className="strong">{l.item ? (lang === "ar" && l.item.nameAr ? l.item.nameAr : l.item.name) : l.entityId}</span>{" "}
                    <span className="hr-id hr-caption">{l.item?.code}</span>
                    <span className="hr-msub">{L("القيمة بالتكلفة", "Value at cost")} <span className="hr-num">{money(l.value)}</span> {L("ر.س", "SAR")}</span>
                  </td>
                  <td className="num"><span className="hr-num">{Number(l.qty.toFixed(4))}</span> <span className="hr-caption">{unitWord(l.item?.unit, lang, l.qty)}</span></td>
                  <td className="num hr-hide-mobile"><span className="hr-num">{money(l.value)}</span></td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr><td>{L(`${t.lines.length} سطر`, `${t.lines.length} line${t.lines.length === 1 ? "" : "s"}`)}</td><td /><td className="num hr-hide-mobile stk-tot"><span className="hr-num">{money(total)}</span></td></tr></tfoot>
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
                      <span className="hr-msub">{it ? (lang === "ar" && it.nameAr ? it.nameAr : it.name) : ""} · <bdi dir="ltr" className="hr-num">{Number(m.previousQuantity.toFixed(4))} → {Number(m.newQuantity.toFixed(4))}</bdi></span>
                    </td>
                    <td className="hr-hide-mobile">{it ? (lang === "ar" && it.nameAr ? it.nameAr : it.name) : "—"} <span className="hr-id hr-caption">{it?.code}</span></td>
                    <td className={`num ${m.quantityChanged < 0 ? "stk-loss" : "stk-gain"}`}><span className="hr-num">{m.quantityChanged > 0 ? "+" : ""}{Number(m.quantityChanged.toFixed(4))}</span></td>
                    <td className="num hr-hide-mobile"><bdi dir="ltr" className="hr-num">{Number(m.previousQuantity.toFixed(4))} → {Number(m.newQuantity.toFixed(4))}</bdi></td>
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
            tone: a.action === "STOCK_TRANSFER_CANCELLED" ? "danger" as const : "success" as const,
            text: <><span className="strong">{a.by ?? "—"}</span> · {ACTION[a.action] ? ACTION[a.action][lang === "ar" ? 0 : 1] : a.action}{a.metadata?.reason ? ` — ${a.metadata.reason}` : ""}</>,
            when: opsDate(a.at, lang, true),
          }))} />
        </div>

        <Dialog open={cancelling} title={L("إلغاء التحويل", "Cancel transfer")} sub={<span className="hr-id">{t.ref}</span>} onClose={() => setCancelling(false)}
          actions={<>
            <Btn variant="danger" busy={busy} disabled={reason.trim().length < 3} onClick={cancel} data-testid="transfer-cancel-confirm">{L("إلغاء التحويل", "Cancel transfer")}</Btn>
            <Btn onClick={() => setCancelling(false)}>{L("رجوع", "Back")}</Btn>
          </>}
        >
          {cancelError ? <Notice tone="danger"><span data-testid="transfer-cancel-error">{cancelError}</span></Notice> : null}
          <p style={{ margin: 0 }}>{L(`يعود الرصيد من «${name(t.toLocation)}» إلى «${name(t.fromLocation)}». لا يُلغى إذا استُخدمت البضاعة أو نُقلت من الوجهة.`, `The stock goes back from «${name(t.toLocation)}» to «${name(t.fromLocation)}». Refused if the goods were used or moved on from the destination.`)}</p>
          <Field label={`${L("سبب الإلغاء", "Reason")} *`}>
            <input className="hr-input" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} data-testid="transfer-cancel-reason" />
          </Field>
        </Dialog>
      </div>
    </OpsRoot>
  );
}
