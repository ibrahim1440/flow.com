"use client";

// Inventory exceptions and the link with operations: every operational stock event (purchase,
// roast, blend, packing, dispatch, adjustment) becomes an inventory document automatically; what
// cannot post waits here with its reason. Cost of sales per invoice and the operational-vs-accounts
// quantity check sit beside it. Nothing is re-entered by hand: retry, dismiss with a reason, or link
// the posted document that already accounts for the event.
import { useState } from "react";
import Link from "next/link";
import { Play, RefreshCw } from "lucide-react";
import { api, ApiError, Badge, Button, Card, CardTitle, EmptyState, ErrorState, Field, INPUT, LoadingState, Notice, Segmented, Table, Td, Th, useApi, useL, type Tone } from "../../../finance/_components/ui";
import { useAmount, useCan, useDay, useExplain } from "../../_components/kit";
import { CostingStatus, OpsStatus, qty } from "../_ui";

type OpsRow = {
  id: string; kind: string; sourceId: string; seq: number; occurredOn: string; payload: unknown; userId: string | null; status: string; attempts: number; lastError: string | null;
  nextAttemptAt: string; documentId: string | null; resolution: string | null; resolvedBy: string | null; resolvedAt: string | null; createdAt: string;
  document: { id: string; docNo: number; status: string; type: string; docDate: string; originalDate: string | null } | null;
};
type OpsList = { rows: OpsRow[]; counts: Record<string, number> };
type CostRow = {
  id: string; invoiceId: string; status: string; attempts: number; lastError: string | null; nextAttemptAt: string; costedAt: string | null; cost: string; late: boolean;
  detail: { lineId: string; lineNo?: number; treatment?: string; status: string; reason?: string | null }[] | null; updatedAt: string;
  invoice: { id: string; invoiceNo: number; status: string; issueDate: string; customer: { name: string; nameAr: string | null } | null } | null;
};
type CostList = { rows: CostRow[]; counts: Record<string, number> };
type Recon = { location: { id: string; code: string } | null; rows: { itemId: string; code: string; name: string; ops: string; accounts: string; difference: string; openEvents: number; state: string }[]; exceptions: number; openEvents: number };
type Tab = "OPS" | "COSTING" | "RECON";

const OPS_OPEN = ["HELD", "BLOCKED", "FAILED", "PENDING", "PROCESSING"];
const COST_OPEN = ["PENDING", "AWAITING_POLICY", "AWAITING_DISPATCH", "BLOCKED", "FAILED", "UNCOSTED"];
const OPS_KIND: Record<string, [string, string]> = {
  PURCHASE: ["شراء", "Purchase"], OPENING: ["كمية افتتاحية", "Opening quantity"], ROAST: ["تحميص", "Roast"], ROAST_CANCEL: ["إلغاء دفعة تحميص", "Roast cancelled"],
  BLEND: ["خلط", "Blend"], PACK: ["تعبئة", "Packing"], DISPATCH: ["تسليم", "Dispatch"], ADJUST: ["تسوية جرد", "Count adjustment"], UNINTEGRATED: ["حركة غير مربوطة", "Unintegrated movement"],
};
const RECON_STATE: Record<string, [string, string, Tone]> = {
  MATCHED: ["متطابق", "Matched", "ok"], EXPLAINED_BY_OPEN_EVENTS: ["مفسَّر بأحداث مفتوحة", "Explained by open events", "warn"], EXCEPTION: ["استثناء", "Exception", "bad"],
};
const RETRYABLE = ["FAILED", "BLOCKED", "HELD", "PENDING"];
const LINKABLE = ["FAILED", "BLOCKED", "HELD"];
const COST_DONE = ["COSTED", "NOT_REQUIRED", "CANCELLED", "UNCOSTED"];

const sum = (c: Record<string, number> | undefined, ks: string[]) => ks.reduce((s, k) => s + (c?.[k] ?? 0), 0);
const errText = (e: unknown) => (e instanceof ApiError ? e.message : String(e));

export default function InventoryExceptionsPage() {
  const { L } = useL();
  const { can } = useCan();
  const [tab, setTab] = useState<Tab>("OPS");
  const [opsAll, setOpsAll] = useState(false);
  const [costAll, setCostAll] = useState(false);
  const ops = useApi<OpsList>(`/api/accounting/inventory/ops-events${opsAll ? "" : `?status=${OPS_OPEN.join(",")}`}`);
  const cost = useApi<CostList>(`/api/accounting/inventory/costing${costAll ? "" : `?status=${COST_OPEN.join(",")}`}`);
  const rec = useApi<Recon>("/api/accounting/inventory/reports/ops-reconciliation");
  const [running, setRunning] = useState(false);
  const [runMsg, setRunMsg] = useState<string | null>(null);
  const [runErr, setRunErr] = useState<string | null>(null);
  const reloadAll = () => { ops.reload(); cost.reload(); rec.reload(); };

  const runNow = async () => {
    setRunning(true); setRunErr(null); setRunMsg(null);
    try {
      const r = await api<{ processed: number; operations: Record<string, number>; costing: Record<string, number> }>("/api/accounting/events/process", { method: "POST", json: {} });
      const o = Object.values(r.operations ?? {}).reduce((s, n) => s + n, 0);
      const c = Object.values(r.costing ?? {}).reduce((s, n) => s + n, 0);
      setRunMsg(L(`تمت المعالجة: ${o} حدث تشغيلي، ${c} فاتورة لتكلفة المبيعات، ${r.processed} حدث محاسبي.`, `Processed: ${o} operational events, ${c} invoices for cost of sales, ${r.processed} ledger events.`));
      reloadAll();
    } catch (e) { setRunErr(errText(e)); }
    setRunning(false);
  };

  const opsOpen = sum(ops.data?.counts, OPS_OPEN);
  const costOpen = sum(cost.data?.counts, COST_OPEN);
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardTitle title={L("الاستثناءات والربط مع التشغيل", "Exceptions and the operations link")}
          sub={L("كل حركة مخزون تشغيلية (شراء، تحميص، خلط، تعبئة، تسليم، تسوية) تصبح مستند مخزون تلقائياً. ما لا يمكن ترحيله يظهر هنا مع سببه — ولا يُعاد إدخال شيء يدوياً.",
            "Every operational stock event (purchase, roast, blend, packing, dispatch, adjustment) becomes an inventory document automatically. Anything that cannot post appears here with its reason — nothing is re-entered by hand.")}
          right={<>
            <Link href="/dashboard/accounting/inventory"><Button>{L("قيمة المخزون", "Inventory value")}</Button></Link>
            <Button icon={RefreshCw} onClick={reloadAll}>{L("تحديث", "Refresh")}</Button>
            {can("events_process") && <Button kind="primary" icon={Play} busy={running} onClick={runNow}>{L("تشغيل الآن", "Run now")}</Button>}
          </>} />
        {runErr && <Notice tone="bad">{runErr}</Notice>}
        {runMsg && <Notice tone="ok">{runMsg}</Notice>}
        <Segmented<Tab> value={tab} onChange={setTab} options={[
          { value: "OPS", label: L(`الأحداث التشغيلية · ${opsOpen}`, `Operational events · ${opsOpen}`) },
          { value: "COSTING", label: L(`تكلفة المبيعات · ${costOpen}`, `Cost of sales · ${costOpen}`) },
          { value: "RECON", label: L(`المطابقة · ${rec.data?.exceptions ?? 0}`, `Reconciliation · ${rec.data?.exceptions ?? 0}`) }]} />
      </Card>
      {tab === "OPS" && <OpsTab q={ops} all={opsAll} setAll={setOpsAll} />}
      {tab === "COSTING" && <CostingTab q={cost} all={costAll} setAll={setCostAll} />}
      {tab === "RECON" && <ReconTab q={rec} />}
    </div>
  );
}

type Q<T> = { data: T | null; error: ApiError | null; loading: boolean; reload: () => void };

function ShowAll({ all, setAll }: { all: boolean; setAll: (v: boolean) => void }) {
  const { L } = useL();
  return <Segmented<"OPEN" | "ALL"> value={all ? "ALL" : "OPEN"} onChange={(v) => setAll(v === "ALL")} options={[{ value: "OPEN", label: L("المفتوحة فقط", "Open only") }, { value: "ALL", label: L("الكل", "All") }]} />;
}

function OpsTab({ q, all, setAll }: { q: Q<OpsList>; all: boolean; setAll: (v: boolean) => void }) {
  const { L } = useL();
  const day = useDay();
  const explain = useExplain();
  const { can } = useCan();
  const [open, setOpen] = useState<{ id: string; mode: "ignore" | "link" } | null>(null);
  const [reason, setReason] = useState("");
  const [docId, setDocId] = useState("");
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const act = async (id: string, path: "retry" | "ignore" | "link", json: unknown = {}) => {
    setBusy(id + path); setErr(null);
    try { await api(`/api/accounting/inventory/ops-events/${id}/${path}`, { method: "POST", json }); setOpen(null); setReason(""); setDocId(""); q.reload(); }
    catch (e) { setErr(errText(e)); }
    setBusy("");
  };
  const toggle = (id: string, mode: "ignore" | "link") => { setOpen(open?.id === id && open.mode === mode ? null : { id, mode }); setReason(""); setDocId(""); setErr(null); };
  const d = q.data;
  const c = d?.counts;
  return (
    <Card>
      <CardTitle title={L("الأحداث التشغيلية", "Operational events")}
        sub={c ? L(`معلّقة ${c.HELD ?? 0} · محجوبة ${c.BLOCKED ?? 0} · فشلت ${c.FAILED ?? 0} · بانتظار ${(c.PENDING ?? 0) + (c.PROCESSING ?? 0)} · مرحّلة ${c.POSTED ?? 0} · مستبعدة ${c.IGNORED ?? 0}`,
          `Held ${c.HELD ?? 0} · blocked ${c.BLOCKED ?? 0} · failed ${c.FAILED ?? 0} · pending ${(c.PENDING ?? 0) + (c.PROCESSING ?? 0)} · posted ${c.POSTED ?? 0} · dismissed ${c.IGNORED ?? 0}`) : undefined}
        right={<ShowAll all={all} setAll={setAll} />} />
      {err && <Notice tone="bad">{err}</Notice>}
      {q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : !d ? <LoadingState /> : d.rows.length === 0 ? (
        <EmptyState title={all ? L("لا أحداث تشغيلية بعد", "No operational events yet") : L("لا استثناءات مفتوحة", "No open exceptions")} body={all ? undefined : L("كل حركة تشغيلية وصلت إلى مستند مخزون مرحّل.", "Every operational movement has reached a posted inventory document.")} />
      ) : (
        <Table>
          <thead><tr><Th>{L("التاريخ", "Date")}</Th><Th>{L("الحدث", "Event")}</Th><Th>{L("المصدر", "Source")}</Th><Th>{L("الحالة", "Status")}</Th><Th>{L("السبب", "Reason")}</Th><Th num>{L("المحاولات", "Attempts")}</Th><Th>{L("المستند", "Document")}</Th><Th /></tr></thead>
          <tbody>
            {d.rows.map((r) => {
              const k = OPS_KIND[r.kind] ?? [r.kind, r.kind];
              const canRetry = can("events_process") && r.kind !== "UNINTEGRATED" && RETRYABLE.includes(r.status);
              const canIgnore = can("inv_doc_approve") && RETRYABLE.includes(r.status);
              const canLink = can("inv_doc_approve") && LINKABLE.includes(r.status);
              const isOpen = open?.id === r.id;
              return [
                <tr key={r.id} className="hover:bg-cream/40">
                  <Td className="whitespace-nowrap">{day(r.occurredOn)}</Td>
                  <Td className="font-bold text-charcoal whitespace-nowrap">{L(k[0], k[1])}{r.seq ? <span className="text-brown font-normal"> · {r.seq}</span> : null}</Td>
                  <Td><span className="font-mono text-[12px] text-brown" dir="ltr" title={r.sourceId}>{r.sourceId.length > 10 ? `${r.sourceId.slice(0, 10)}…` : r.sourceId}</span></Td>
                  <Td><OpsStatus status={r.status} /></Td>
                  <Td className="min-w-[220px] max-w-[420px]">{r.lastError ? explain(r.lastError) : r.resolution ?? "—"}</Td>
                  <Td num>{r.attempts}</Td>
                  <Td>{r.document ? <Link className="font-bold text-orange hover:underline tabular-nums" href={`/dashboard/accounting/inventory/documents/${r.document.id}`}>#{r.document.docNo}</Link> : "—"}</Td>
                  <Td>
                    <span className="flex flex-col items-stretch gap-1.5 min-w-[120px]">
                      {canRetry && <Button busy={busy === r.id + "retry"} onClick={() => act(r.id, "retry")}>{L("إعادة المحاولة", "Retry")}</Button>}
                      {canLink && <Button kind="ghost" onClick={() => toggle(r.id, "link")}>{L("ربط مستند…", "Link document…")}</Button>}
                      {canIgnore && <Button kind="danger" onClick={() => toggle(r.id, "ignore")}>{L("استبعاد…", "Dismiss…")}</Button>}
                    </span>
                  </Td>
                </tr>,
                isOpen && (
                  <tr key={`${r.id}-form`} className="bg-cream/40">
                    <Td className="border-t-0" />
                    <Td className="border-t-0" />
                    <td colSpan={6} className="px-3 pb-3 pt-1">
                      <div className="flex items-end gap-2 flex-wrap">
                        {open.mode === "link" && (
                          <Field label={L("معرّف مستند المخزون المرحّل", "Posted inventory document id")}>
                            <input className={`${INPUT} min-w-[220px] font-mono`} dir="ltr" value={docId} onChange={(e) => setDocId(e.target.value.trim())} />
                          </Field>
                        )}
                        <Field label={L("السبب", "Reason")} hint={L("10 أحرف على الأقل", "At least 10 characters")}>
                          <input className={`${INPUT} min-w-[260px]`} value={reason} onChange={(e) => setReason(e.target.value)} />
                        </Field>
                        {open.mode === "link"
                          ? <Button kind="primary" disabled={reason.trim().length < 10 || !docId} busy={busy === r.id + "link"} onClick={() => act(r.id, "link", { documentId: docId, reason })}>{L("تأكيد الربط", "Confirm link")}</Button>
                          : <Button kind="danger" disabled={reason.trim().length < 10} busy={busy === r.id + "ignore"} onClick={() => act(r.id, "ignore", { reason })}>{L("تأكيد الاستبعاد", "Confirm dismissal")}</Button>}
                        <Button onClick={() => setOpen(null)}>{L("إلغاء", "Cancel")}</Button>
                      </div>
                    </td>
                  </tr>
                ),
              ];
            })}
          </tbody>
        </Table>
      )}
      <p className="text-xs text-brown">{L("الحدث المعلّق ينتظر شرطاً (سياسة، ربط حساب، فترة مفتوحة) ويُعاد تلقائياً. «حركة غير مربوطة» تعني أن سجلاً تشغيلياً غيّر المخزون دون حدث: اربطها بالمستند المرحّل الذي يغطيها أو استبعدها بسبب. الاستبعاد والربط يُسجَّلان في سجل التدقيق.",
        "A held event waits for a condition (policy, account mapping, open period) and is retried automatically. An “unintegrated movement” means an operational record changed stock without an event: link the posted document that covers it or dismiss it with a reason. Dismissals and links are recorded in the audit log.")}</p>
    </Card>
  );
}

function CostingTab({ q, all, setAll }: { q: Q<CostList>; all: boolean; setAll: (v: boolean) => void }) {
  const { L, lang } = useL();
  const day = useDay();
  const amt = useAmount();
  const explain = useExplain();
  const { can } = useCan();
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const retry = async (invoiceId: string) => {
    setBusy(invoiceId); setErr(null);
    try { await api(`/api/accounting/inventory/costing/${invoiceId}/retry`, { method: "POST", json: {} }); q.reload(); }
    catch (e) { setErr(errText(e)); }
    setBusy("");
  };
  const when = (s: string | null) => (s ? new Date(s).toLocaleString(lang === "ar" ? "ar-SA-u-nu-latn" : "en-GB", { timeZone: "Asia/Riyadh", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—");
  const reasonOf = (r: CostRow) => r.lastError ?? r.detail?.find((l) => l.reason)?.reason ?? null;
  const d = q.data;
  return (
    <Card>
      <CardTitle title={L("تكلفة المبيعات لكل فاتورة", "Cost of sales per invoice")}
        sub={L("كل فاتورة مرحّلة تُكلَّف تلقائياً عند تسليم بضاعتها؛ ما ينتظر سياسة أو تسليماً أو تعذّر يظهر هنا. «معكوسة» للعلم: عادت تكلفتها إلى «مسلَّم لم يُفوتر».",
          "Each posted invoice is costed automatically once its goods are dispatched; what waits for a policy or a dispatch, or failed, shows here. “Reversed” is for information: its cost went back to delivered, not invoiced.")}
        right={<ShowAll all={all} setAll={setAll} />} />
      {err && <Notice tone="bad">{err}</Notice>}
      {q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : !d ? <LoadingState /> : d.rows.length === 0 ? (
        <EmptyState title={all ? L("لا فواتير بعد", "No invoices yet") : L("لا فواتير بانتظار التكلفة", "No invoices waiting for cost")} />
      ) : (
        <Table>
          <thead><tr><Th>{L("الفاتورة", "Invoice")}</Th><Th>{L("التاريخ", "Date")}</Th><Th>{L("العميل", "Customer")}</Th><Th>{L("الحالة", "Status")}</Th><Th>{L("السبب", "Reason")}</Th><Th num>{L("التكلفة", "Cost")}</Th><Th num>{L("المحاولات", "Attempts")}</Th><Th>{L("المحاولة التالية", "Next attempt")}</Th><Th /></tr></thead>
          <tbody>
            {d.rows.map((r) => {
              const reason = reasonOf(r);
              return (
                <tr key={r.id} className="hover:bg-cream/40">
                  <Td>{r.invoice ? <Link className="font-bold text-orange hover:underline tabular-nums whitespace-nowrap" href={`/dashboard/accounting/receivables/${r.invoiceId}`}>INV-{r.invoice.invoiceNo}</Link> : <span className="font-mono text-[12px]" dir="ltr">{r.invoiceId.slice(0, 10)}…</span>}</Td>
                  <Td className="whitespace-nowrap">{day(r.invoice?.issueDate)}</Td>
                  <Td>{r.invoice?.customer ? L(r.invoice.customer.nameAr ?? r.invoice.customer.name, r.invoice.customer.name) : "—"}</Td>
                  <Td><span className="flex gap-1 flex-wrap"><CostingStatus status={r.status} />{r.late && <Badge tone="warn">{L("متأخرة", "Late")}</Badge>}</span></Td>
                  <Td className="min-w-[220px] max-w-[420px]">{reason ? explain(reason) : "—"}</Td>
                  <Td num>{r.status === "COSTED" ? amt(r.cost) : "—"}</Td>
                  <Td num>{r.attempts}</Td>
                  <Td className="whitespace-nowrap tabular-nums">{COST_DONE.includes(r.status) ? "—" : when(r.nextAttemptAt)}</Td>
                  <Td>{can("events_process") && !COST_DONE.includes(r.status) && <Button busy={busy === r.invoiceId} onClick={() => retry(r.invoiceId)}>{L("إعادة المحاولة", "Retry")}</Button>}</Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

function ReconTab({ q }: { q: Q<Recon> }) {
  const { L } = useL();
  const d = q.data;
  return (
    <Card>
      <CardTitle title={L("التطابق: التشغيل مقابل الحسابات", "Reconciliation: operations against the accounts")}
        sub={d ? L(`الكمية التشغيلية مقابل الكمية المحاسبية${d.location ? ` في الموقع ${d.location.code}` : ""} · الفرق المفسَّر بأحداث لم تُرحّل بعد ليس استثناءً · ${d.openEvents} حدث مفتوح`,
          `Operational quantity against the accounting quantity${d.location ? ` at location ${d.location.code}` : ""} · a difference explained by events not yet posted is not an exception · ${d.openEvents} open events`) : undefined}
        right={d ? <Badge tone={d.exceptions ? "bad" : "ok"}>{d.exceptions ? L(`${d.exceptions} استثناء`, `${d.exceptions} exceptions`) : L("✓ لا استثناءات", "✓ No exceptions")}</Badge> : undefined} />
      {q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : !d ? <LoadingState /> : (<>
        {!d.location && <Notice tone="warn">{L("لم يُحدَّد موقع المبيعات الافتراضي؛ الكمية المحاسبية تُعرض صفراً.", "No default sales location is set; the accounting quantity shows as zero.")}</Notice>}
        {d.rows.length === 0 ? <EmptyState title={L("لا أصناف مربوطة بسجلات التشغيل", "No items linked to operational records")} /> : (
          <Table>
            <thead><tr><Th>{L("الصنف", "Item")}</Th><Th num>{L("تشغيلياً", "Operations")}</Th><Th num>{L("محاسبياً", "Accounts")}</Th><Th num>{L("الفرق", "Difference")}</Th><Th num>{L("أحداث مفتوحة", "Open events")}</Th><Th>{L("الحالة", "State")}</Th></tr></thead>
            <tbody>
              {d.rows.map((r) => {
                const s = RECON_STATE[r.state] ?? [r.state, r.state, "info" as Tone];
                return (
                  <tr key={r.itemId}>
                    <Td>{r.code} · {r.name}</Td>
                    <Td num>{qty(r.ops)}</Td>
                    <Td num>{qty(r.accounts)}</Td>
                    <Td num className={Number(r.difference) !== 0 ? (r.state === "EXCEPTION" ? "text-red-700 font-bold" : "text-amber-700 font-bold") : ""}>{qty(r.difference)}</Td>
                    <Td num>{r.openEvents}</Td>
                    <Td><Badge tone={s[2]}>{L(s[0], s[1])}</Badge></Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </>)}
      <p className="text-xs text-brown">{L("للكشف فقط: لا يُعدَّل أي من السجلين. الاستثناء يعني فرقاً لا يفسّره حدث مفتوح — ابحث عن حركة تشغيلية لم تُسجَّل أو مستند مخزون يدوي.", "Detection only: neither record is changed. An exception is a difference no open event explains — look for an unrecorded operational movement or a manual inventory document.")}</p>
    </Card>
  );
}
