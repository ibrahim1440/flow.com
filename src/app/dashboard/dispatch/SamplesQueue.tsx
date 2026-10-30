"use client";

import { useState } from "react";
import { Btn, OpsBanner, OpsEmpty, StatusDot, countNoun, UNIT_FORMS, opsDate, useL } from "@/components/ops/ui";
import { useI18n } from "@/lib/i18n/context";
import { localizeApiError } from "@/lib/i18n/api-errors";

// ─── «عيّنات للصرف» — the dispatch side of a sales sample (docs/sales/SAMPLES_INVENTORY.md) ─────────────────
//
// A rep requests a sample from the deal; it waits here. The department starts preparing it («بدء التجهيز», no stock
// moves) and issues it («صرف»): only then do the units leave finished goods — free units only, oldest lot first, never
// what is reserved for an order nor a lot on QC hold. Issuing twice is harmless: the server answers the second press
// with the first issue (the sample is its own idempotency key), so a lost answer is simply pressed again.

export type SampleRequest = {
  id: string; status: "REQUESTED" | "PREPARING"; units: number; description: string | null; requestedAt: string;
  sku: { id: string; skuCode: string; name: string | null; pack: string } | null;
  customer: { name: string; nameAr: string | null } | null;
  rep: string | null;
  freeUnits: number;
};

type Issued = { name: string; units: number; lots: { batchNumber: string; units: number }[]; replayed: boolean };

export function SamplesQueue({ rows, canIssue, onChanged }: { rows: SampleRequest[]; canIssue: boolean; onChanged: () => void }) {
  const { lang } = useI18n();
  const L = useL();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [done, setDone] = useState<Issued | null>(null);

  const nameOf = (r: SampleRequest) => (r.sku ? `${r.sku.name ?? r.sku.skuCode}${r.sku.name?.includes(r.sku.pack) ? "" : ` ${r.sku.pack}`}` : r.description ?? "—");

  async function act(r: SampleRequest, action: "prepare" | "issue") {
    if (busyId) return;
    setBusyId(r.id);
    setError("");
    try {
      const res = await fetch(`/api/deliveries/samples/${encodeURIComponent(r.id)}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(localizeApiError(data, lang) || L("تعذّر التنفيذ.", "It could not be done.")); return; }
      if (action === "issue") {
        setDone({ name: nameOf(r), units: r.units, replayed: !!data.replayed, lots: (data.sample?.lots ?? []).map((l: { batchNumber: string; units: number }) => ({ batchNumber: l.batchNumber, units: l.units })) });
      }
      onChanged();
    } catch {
      // The answer was lost: the issue may or may not have happened. Pressing «صرف» again is safe — it replays.
      setError(L("انقطع الاتصال قبل وصول الرد. اضغط «صرف» مرة أخرى؛ لن يُخصم المخزون مرتين.", "The connection dropped before the answer arrived. Press «Issue» again; stock is never deducted twice."));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="hr-stack" style={{ gap: 12 }} aria-label={L("عيّنات للصرف", "Samples to issue")} data-testid="dispatch-samples">
      {done ? (
        <OpsBanner tone="success" onClose={() => setDone(null)}>
          <strong className="d21-bold">
            {done.replayed ? L("صُرفت هذه العيّنة من قبل", "This sample was already issued") : L("صُرفت العيّنة من المخزون", "Sample issued from stock")}
            {" · "}<bdi>{done.name}</bdi> · {countNoun(done.units, lang, UNIT_FORMS)}
          </strong>
          <ul className="ops-dlots" data-testid="sample-lots-used">
            {done.lots.map((l, i) => (
              <li key={i}><span className="hr-num">{l.units}</span> {L("من", "from")} <span className="ops-serial">{l.batchNumber}</span></li>
            ))}
          </ul>
        </OpsBanner>
      ) : null}
      {error ? <OpsBanner tone="danger" onClose={() => setError("")}><span data-testid="sample-error">{error}</span></OpsBanner> : null}
      <p className="hr-caption" style={{ margin: 0 }}>
        {L("طلبات العيّنات من المندوبين. لا يُخصم المخزون إلا عند «صرف»، ومن غير المحجوز للطلبات فقط.",
          "Sample requests from the reps. Stock is deducted only on «Issue», and only from units not reserved for orders.")}
      </p>
      {rows.length === 0 ? (
        <OpsEmpty title={L("لا عيّنات بانتظار الصرف", "No samples waiting")} body={L("تظهر هنا عندما يطلب مندوب عيّنة من صفقته.", "They appear here when a rep requests a sample from a deal.")} />
      ) : (
        <div className="hr-tablewrap">
          <table className="hr-table is-mrow" aria-label={L("عيّنات للصرف", "Samples to issue")}>
            <thead>
              <tr>
                <th>{L("طُلبت", "Requested")}</th>
                <th>{L("المنتج", "Product")}</th>
                <th className="num">{L("الكمية", "Quantity")}</th>
                <th>{L("العميل · المندوب", "Customer · rep")}</th>
                <th className="num">{L("المتاح غير المحجوز", "Free units")}</th>
                <th>{L("الحالة", "Status")}</th>
                <th aria-label={L("إجراء", "Action")} />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const short = r.freeUnits < r.units;
                const customer = r.customer ? (lang === "ar" ? r.customer.nameAr || r.customer.name : r.customer.name) : "—";
                return (
                  <tr key={r.id} data-testid={`sample-req-${r.id}`}>
                    <td>{opsDate(r.requestedAt, lang)}</td>
                    <td className="m-title">
                      <span className="strong"><bdi>{nameOf(r)}</bdi></span>
                      <span className="hr-msub">{countNoun(r.units, lang, UNIT_FORMS)} · <bdi>{customer}</bdi>{r.rep ? <> · <bdi>{r.rep}</bdi></> : null}</span>
                    </td>
                    <td className="num"><span className="hr-num">{r.units}</span></td>
                    <td><bdi>{customer}</bdi>{r.rep ? <span className="hr-caption"> · <bdi>{r.rep}</bdi></span> : null}</td>
                    <td className="num"><span className="hr-num">{r.freeUnits}</span>{short ? <span className="hr-caption"> · {L("لا يكفي", "not enough")}</span> : null}</td>
                    <td><StatusDot map={{ REQUESTED: [L("مطلوبة", "Requested"), "info"], PREPARING: [L("قيد التجهيز", "Preparing"), "warning"] }} value={r.status} /></td>
                    <td className="ops-actions m-end">
                      {canIssue ? (
                        <>
                          {r.status === "REQUESTED" ? (
                            <Btn size="sm" disabled={!!busyId} busy={busyId === r.id} data-testid={`sample-prepare-${r.id}`} onClick={() => act(r, "prepare")}>
                              {L("بدء التجهيز", "Start preparing")}
                            </Btn>
                          ) : null}
                          {" "}
                          <Btn size="sm" variant="primary" disabled={!!busyId || short} busy={busyId === r.id} data-testid={`sample-issue-${r.id}`} onClick={() => act(r, "issue")}
                            title={short ? L("المتاح غير المحجوز لا يكفي", "Not enough free units") : undefined}>
                            {L("صرف", "Issue")} {countNoun(r.units, lang, UNIT_FORMS)}
                          </Btn>
                        </>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
