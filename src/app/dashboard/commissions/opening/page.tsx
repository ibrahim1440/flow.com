"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useLang, api, formatDay, num } from "../../sales/_components/ui";
import { PerfHeader, PerfNotice, PerfLoading, PerfNote } from "../../sales/_components/perf";

/**
 * «تهيئة العملاء الحاليين قبل تفعيل العمولات» — commission plan builder, owner decision of 24 Oct.
 *
 * Every customer, with: the owning rep («المسؤول»), which order comes next for the sequence rates
 * (stored as the number of collected orders already had; «عميل حالي» = not set, the default for
 * every existing customer: the existing-client rate), and «مستثنى من عمولة العميل الجديد». Inline
 * editing of the table, CSV export / import (customerId, customer, rep, priorOrders, excluded).
 * Every change is logged. After the activation date this is the audited «تعديل ترتيب الطلب»,
 * and a reason is required.
 */
type Row = {
  customerId: string; name: string; nameAr: string | null; createdAt: string; repId: string | null; repName: string | null;
  priorOrders: number | null; excluded: boolean; exclusionReason: string | null; preExisting: boolean;
};
type Change = { repId?: string | null; priorOrders?: number | null; excluded?: boolean };
type Data = {
  settings: { activationDate: string | null };
  /** The activation date has passed: changes are the audited «تعديل ترتيب الطلب» and need a reason. */
  active: boolean;
  rows: Row[];
  reps: { id: string; name: string; username: string | null }[];
  log: { id: string; kind: string; source: string; customerId: string | null; createdAt: string; reason: string | null; before: Record<string, unknown> | null; after: Record<string, unknown> | null }[];
};

const NEXT_OPTIONS = [0, 1, 2, 3, 4, 5];

export default function CommissionOpeningPage() {
  const lang = useLang();
  const ar = lang === "ar";
  const [data, setData] = useState<Data | null>(null);
  const [edits, setEdits] = useState<Record<string, Change>>({});
  const [q, setQ] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [csvErrors, setCsvErrors] = useState<{ line: number; message: string }[]>([]);
  const [success, setSuccess] = useState("");
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState(0);

  useEffect(() => {
    let off = false;
    (async () => {
      const r = await api<Data>("/api/commissions/opening");
      if (off) return;
      if (r.ok) setData(r.data); else setError(r.data.error ?? "");
    })();
    return () => { off = true; };
  }, [token]);

  const shown = useMemo(() => {
    if (!data) return [];
    const t = q.trim().toLowerCase();
    return t ? data.rows.filter((r) => r.name.toLowerCase().includes(t) || (r.nameAr ?? "").includes(t) || (r.repName ?? "").toLowerCase().includes(t)) : data.rows;
  }, [data, q]);

  if (!data) return error ? <div className="pg"><PerfNotice kind="error" ar={ar}>{error}</PerfNotice></div> : <PerfLoading ar={ar} />;
  const active = data.active;
  const nameOf = (id: string | null) => data.rows.find((r) => r.customerId === id)?.name ?? "—";
  const repName = (id: unknown) => (typeof id === "string" ? data.reps.find((r) => r.id === id)?.name ?? id : "—");
  const val = <K extends keyof Change>(r: Row, k: K, base: Change[K]): Change[K] => (edits[r.customerId] && k in edits[r.customerId] ? edits[r.customerId][k] : base);
  const edit = (r: Row, patch: Change) => setEdits((e) => ({ ...e, [r.customerId]: { ...e[r.customerId], ...patch } }));
  const nextLabel = (n: number) => ar
    ? (["الطلب القادم: الأول", "الطلب القادم: الثاني", "الطلب القادم: الثالث", "الطلب القادم: الرابع", "الطلب القادم: الخامس", "الطلب القادم: السادس"][n] ?? `الطلب القادم: ${n + 1}`)
    : `Next order: #${n + 1}`;
  const priorText = (p: unknown) => (p === null || p === undefined ? (ar ? "عميل حالي" : "existing client") : ar ? `الطلب القادم ${Number(p) + 1}` : `next order ${Number(p) + 1}`);
  const changed = Object.keys(edits).length;

  async function saveInline() {
    setBusy(true); setError("");
    const r = await api<{ changed: number }>("/api/commissions/opening", { method: "PATCH", body: { reason, changes: Object.entries(edits).map(([customerId, c]) => ({ customerId, ...c })) } });
    setBusy(false);
    if (r.ok) { setSuccess(ar ? `حُفظ ${num(r.data.changed, lang)} عميل وسُجّل التغيير.` : `${r.data.changed} customers saved and logged.`); setEdits({}); setReason(""); setToken((x) => x + 1); }
    else setError(r.data.error ?? "");
  }

  async function importCsv(file: File) {
    setError(""); setCsvErrors([]);
    const csv = await file.text();
    const dry = await api<{ rows: number; errors?: { line: number; message: string }[] }>("/api/commissions/opening", { method: "POST", body: { csv, dryRun: true } });
    if (!dry.ok) { setError(dry.data.error ?? ""); setCsvErrors(dry.data.errors ?? []); return; }
    if (!window.confirm(ar ? `سيُطبَّق الملف على ${dry.data.rows} عميل. متابعة؟` : `Apply the file to ${dry.data.rows} customers?`)) return;
    const r = await api<{ rows: number; changed: number; errors?: { line: number; message: string }[] }>("/api/commissions/opening", { method: "POST", body: { csv, reason } });
    if (r.ok) { setSuccess(ar ? `استُورد الملف: ${num(r.data.changed, lang)} عميل تغيّر من ${num(r.data.rows, lang)}.` : `Imported: ${r.data.changed} of ${r.data.rows} customers changed.`); setToken((x) => x + 1); }
    else { setError(r.data.error ?? ""); setCsvErrors(r.data.errors ?? []); }
  }

  const setUp = data.rows.filter((r) => r.priorOrders !== null).length;
  return (
    <div className="pg">
      <PerfHeader ar={ar} title={ar ? "الأداء والعمولات" : "Performance and commissions"}
        phoneTitle={ar ? "تهيئة العملاء الحاليين" : "Existing customers setup"}
        meta={[
          active ? (ar ? "تعديل ترتيب الطلب — بعد التفعيل، مع السبب" : "Order-sequence edit — after activation, with a reason") : (ar ? "تهيئة العملاء الحاليين قبل تفعيل العمولات" : "Existing customers setup before commissions are activated"),
          <>{num(data.rows.length, lang)} {ar ? "عميل" : "customers"} · {num(setUp, lang)} {ar ? "بترتيب طلب" : "with a next order"}</>,
        ]}
        actions={<>
          <a className="btn" href="/api/commissions/opening?format=csv" data-testid="csv-export">{ar ? "تصدير CSV" : "Export CSV"}</a>
          <label className="btn" data-testid="csv-import-label">
            {ar ? "استيراد CSV" : "Import CSV"}
            <input type="file" accept=".csv,text/csv" className="sr-only" data-testid="csv-import" onChange={(e) => { const f = e.target.files?.[0]; if (f) void importCsv(f); e.target.value = ""; }} />
          </label>
          <Link className="btn" href="/dashboard/commissions/settings">{ar ? "إعدادات العمولات" : "Commission settings"}</Link>
        </>} />

      <PerfNotice kind="error" ar={ar} onDismiss={() => { setError(""); setCsvErrors([]); }}>{error}</PerfNotice>
      {csvErrors.length > 0 && (
        <ul className="notice er" data-testid="csv-errors" style={{ paddingInlineStart: 28 }}>
          {csvErrors.slice(0, 50).map((e, i) => <li key={i}>{ar ? `سطر ${e.line}: ` : `Line ${e.line}: `}{e.message}</li>)}
        </ul>
      )}
      <PerfNotice kind="success" ar={ar} onDismiss={() => setSuccess("")}>{success}</PerfNotice>

      <p className="callout" data-testid="opening-help">
        {ar
          ? "كل عميل حالي يُعامل افتراضياً «عميلاً حالياً» بنسبة العملاء الحاليين (0% افتراضياً). حدّد «الطلب القادم» للعميل الذي يستحق عليه المندوب عمولة ترتيب الطلب، وعلّم «مستثنى» لمن كان جارٍ التفاوض معه قبل المندوب. العملاء الجدد بعد التفعيل يتبعون القواعد تلقائياً. أعمدة CSV: customerId, customer, rep, priorOrders (عدد الطلبات المحصّلة السابقة؛ فارغ = عميل حالي), excluded (yes/no)."
          : "Every existing customer is an «existing client» by default, at the existing-client rate (0% by default). Set the next order for a customer whose rep earns the sequence commission, and tick «excluded» for one that was in negotiation before the rep. Customers created after activation follow the rules automatically. CSV columns: customerId, customer, rep, priorOrders (collected orders already had; blank = existing client), excluded (yes/no)."}
      </p>

      <div className="cb-grid" style={{ alignItems: "end", marginBottom: 12 }}>
        <div className="cb-f"><label htmlFor="op-q">{ar ? "بحث" : "Search"}</label><input id="op-q" value={q} onChange={(e) => setQ(e.target.value)} data-testid="op-search" /></div>
        <div className="cb-f" style={{ gridColumn: "span 2" }}><label htmlFor="op-reason">{active ? (ar ? "السبب (مطلوب بعد التفعيل)" : "Reason (required after activation)") : (ar ? "السبب (اختياري)" : "Reason (optional)")}</label>
          <input id="op-reason" value={reason} onChange={(e) => setReason(e.target.value)} data-testid="op-reason" /></div>
        <div><button type="button" className="btn p" disabled={busy || changed === 0} onClick={saveInline} data-testid="op-save">{ar ? `حفظ التغييرات (${num(changed, lang)})` : `Save changes (${changed})`}</button></div>
      </div>

      <div className="perf-scroll">
        <table className="t dense" data-testid="opening-table">
          <thead><tr>
            <th scope="col">{ar ? "العميل" : "Customer"}</th>
            <th scope="col">{ar ? "المندوب المسؤول" : "Owning rep"}</th>
            <th scope="col">{ar ? "ترتيب الطلب" : "Order sequence"}</th>
            <th scope="col">{ar ? "مستثنى من عمولة العميل الجديد" : "Excluded from new-client commission"}</th>
          </tr></thead>
          <tbody>
            {shown.slice(0, 500).map((r) => {
              const p = val(r, "priorOrders", r.priorOrders);
              const dirty = !!edits[r.customerId];
              return (
                <tr key={r.customerId} className={dirty ? "on" : undefined} data-testid={`op-row-${r.customerId}`}>
                  <td><bdi>{r.name}</bdi>{!r.preExisting && <span className="perf-code" style={{ marginInlineStart: 6 }}>{ar ? "بعد التفعيل" : "after activation"}</span>}</td>
                  <td>
                    <select aria-label={ar ? "المندوب" : "Rep"} value={val(r, "repId", r.repId) ?? ""} onChange={(e) => edit(r, { repId: e.target.value || null })} data-testid={`op-rep-${r.customerId}`}>
                      <option value="">—</option>
                      {data.reps.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                    </select>
                  </td>
                  <td>
                    <select aria-label={ar ? "ترتيب الطلب" : "Order sequence"} value={p === null || p === undefined ? "" : String(p)} onChange={(e) => edit(r, { priorOrders: e.target.value === "" ? null : Number(e.target.value) })} data-testid={`op-next-${r.customerId}`}>
                      <option value="">{r.preExisting ? (ar ? "عميل حالي — نسبة العملاء الحاليين" : "Existing client — existing rate") : (ar ? "تلقائي — قواعد العميل الجديد" : "Automatic — new-client rules")}</option>
                      {NEXT_OPTIONS.map((n) => <option key={n} value={n}>{nextLabel(n)}</option>)}
                      {p !== null && p !== undefined && !NEXT_OPTIONS.includes(p) && <option value={p}>{nextLabel(p)}</option>}
                    </select>
                  </td>
                  <td>
                    <label className="cb-check">
                      <input type="checkbox" checked={!!val(r, "excluded", r.excluded)} onChange={(e) => edit(r, { excluded: e.target.checked })} data-testid={`op-excl-${r.customerId}`} />
                      {r.excluded && r.exclusionReason ? <span className="cb-hint">{r.exclusionReason}</span> : null}
                    </label>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {shown.length > 500 && <p className="cb-hint">{ar ? "تُعرض أول 500 نتيجة؛ ضيّق البحث أو استخدم CSV." : "The first 500 are shown; narrow the search or use CSV."}</p>}

      <section className="cb-sec" data-testid="opening-log" style={{ marginTop: 24 }}>
        <div className="cb-sec-h"><h3>{ar ? "سجل التغييرات" : "Change log"}</h3></div>
        {data.log.length === 0 ? <p className="cb-hint">{ar ? "لا تغييرات بعد." : "No changes yet."}</p> : (
          <div className="perf-scroll">
            <table className="t dense">
              <thead><tr><th scope="col">{ar ? "الوقت" : "When"}</th><th scope="col">{ar ? "العميل" : "Customer"}</th><th scope="col">{ar ? "المصدر" : "Source"}</th><th scope="col">{ar ? "قبل" : "Before"}</th><th scope="col">{ar ? "بعد" : "After"}</th><th scope="col">{ar ? "السبب" : "Reason"}</th></tr></thead>
              <tbody>
                {data.log.map((l) => {
                  const show = (x: Record<string, unknown> | null) => (x ? [
                    "repId" in x ? `${ar ? "المندوب" : "rep"} ${repName(x.repId)}` : null,
                    "priorOrders" in x ? priorText(x.priorOrders) : null,
                    x.excluded ? (ar ? "مستثنى" : "excluded") : (ar ? "غير مستثنى" : "not excluded"),
                  ].filter(Boolean).join(" · ") : "—");
                  return (
                    <tr key={l.id}>
                      <td className="n">{formatDay(l.createdAt, lang)}</td>
                      <td><bdi>{nameOf(l.customerId)}</bdi></td>
                      <td>{l.source === "CSV" ? "CSV" : l.source === "CUSTOMER_FILE" ? (ar ? "ملف العميل" : "customer file") : (ar ? "الجدول" : "table")}</td>
                      <td className="sm">{show(l.before)}</td>
                      <td className="sm">{show(l.after)}</td>
                      <td>{l.reason ?? "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <PerfNote><span>{ar ? "«المندوب المسؤول» هو مسؤول حساب العميل؛ العمولة نفسها تتبع مالك الصفقة وحصصها كما كانت." : "The owning rep is the customer's account owner; commission itself still follows the deal's owner and splits, as before."}</span></PerfNote>
    </div>
  );
}
