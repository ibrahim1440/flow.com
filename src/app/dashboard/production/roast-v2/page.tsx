"use client";
/**
 * Roasting station v2 — the supervisor's tools (D12): the discards waiting for a review (never by the person who
 * discarded the roast), and a lot correction (cancel-and-re-record with a reason; the lot reversed per component).
 * D16: «بلاغات المحامص» first (#problems, where the station-problem notification opens).
 */
import { useCallback, useEffect, useState } from "react";
import { newRequestKey } from "@/lib/request-key";
import { RoastProblems } from "./_ui/RoastProblems";

type Discard = { id: string; serial: string; discardedAt: string; discardReason: string; discardValue: string | null; operatorName: string | null; overdue: boolean; bucket: { seqNo: number; barcode: string } };
const V2 = "/api/station/roasting/v2";

export default function RoastV2Supervisor() {
  const [rows, setRows] = useState<Discard[] | null>(null);
  const [msg, setMsg] = useState("");
  const [lot, setLot] = useState({ id: "", kg: "", reason: "" });
  const load = useCallback(async () => {
    const r = await fetch(`${V2}/discards`, { cache: "no-store" });
    const j = await r.json().catch(() => []);
    if (r.ok) setRows(j); else { setRows([]); setMsg(j.error ?? "تعذّر التحميل."); }
  }, []);
  useEffect(() => { const t = setTimeout(() => { void load(); }, 0); return () => clearTimeout(t); }, [load]);
  const post = async (url: string, body: Record<string, unknown>) => {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": newRequestKey() }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    setMsg(r.ok ? "تم." : (j.error ?? "تعذّر الإجراء."));
    return r.ok ? j : null;
  };
  return (
    <div dir="rtl" style={{ padding: 24, display: "flex", flexDirection: "column", gap: 20, maxWidth: 1100 }} data-testid="rv2-supervisor">
      <h1 style={{ margin: 0, fontSize: 24 }}>محطة التحميص v2 · المشرف</h1>
      {msg && <div role="status" style={{ padding: 10, borderRadius: 8, background: "var(--surface-subtle,#fbf9f4)" }}>{msg}</div>}
      <RoastProblems />
      <section>
        <h2 style={{ fontSize: 18 }}>تحميصات تالفة بانتظار المراجعة</h2>
        {rows === null ? <p>…</p> : rows.length === 0 ? <p>لا تالف بانتظار المراجعة.</p> : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr><th align="right">التحميصة</th><th align="right">الدلو</th><th align="right">السبب</th><th align="right">القيمة</th><th align="right">المشغّل</th><th /></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id} style={{ borderTop: "1px solid var(--border-subtle,#efeadf)", background: r.overdue ? "var(--status-warning-tint,#fbf2da)" : undefined }}>
                <td><bdi dir="ltr">{r.serial}</bdi>{r.overdue ? " · متأخر" : ""}</td><td>{r.bucket.seqNo}</td><td>{r.discardReason}</td><td>{r.discardValue ?? "—"} ر.س</td><td>{r.operatorName}</td>
                <td><button onClick={async () => { if (await post(`${V2}/runs/${r.id}/review`, {})) void load(); }} data-testid={`rv2-review-${r.serial}`}>تمّت المراجعة</button></td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </section>
      <section style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 420 }}>
        <h2 style={{ fontSize: 18 }}>تصحيح دفعة</h2>
        <small>تُلغى الدفعة وتُعاد بالوزن الصحيح (لا تُعدَّل القيود المرحّلة). لا يصحّح الدفعة من حمّصها أو وزنها.</small>
        <input placeholder="معرّف الدفعة" value={lot.id} onChange={(e) => setLot({ ...lot, id: e.target.value })} />
        <input placeholder="الوزن المحمّص الصحيح (كجم)" inputMode="decimal" value={lot.kg} onChange={(e) => setLot({ ...lot, kg: e.target.value })} />
        <input placeholder="سبب التصحيح" value={lot.reason} onChange={(e) => setLot({ ...lot, reason: e.target.value })} />
        <button onClick={() => void post(`${V2}/lots/${encodeURIComponent(lot.id.trim())}/correct`, { roastedKg: Number(lot.kg), reason: lot.reason })} data-testid="rv2-correct">تصحيح</button>
      </section>
    </div>
  );
}
