"use client";
/**
 * D16 E1 «بلاغات المحامص» (owner-approved 9 Nov 2026) — the roasting station's reports in the ERP: the open ones first
 * (oldest first), then the last 30 days' ended ones. A supervisor (production › manage_roasters or manage_schedule) ends a
 * report here with the cause and the fix, through the same service call as the station. The «مشكلة في محطة التحميص»
 * notification opens this section (#problems). Without the privilege the section is not shown.
 */
import "./roast-problems.css";
import { useCallback, useEffect, useState } from "react";
import { newRequestKey } from "@/lib/request-key";
import { Btn, Dialog } from "@/components/hr/ui";
import { PROBLEM_KIND_LABEL, PROBLEM_TEXT_MAX, endNeedsTexts, problemReasonText } from "@/lib/station/v2/problem";

type Problem = {
  id: string; kind: string; reason: string; note: string | null; blocking: boolean; status: string;
  reportedByName: string | null; reportedAt: string; resolvedAt: string | null; resolvedByName: string | null;
  resolveCause: string | null; resolveFix: string | null; resolveNote: string | null; ageMinutes: number;
  roaster: { id: string; name: string; manufacturerModel: string | null };
  run: { serial: string } | null; markedRuns: { id: string; serial: string }[];
};
type Answer = { open: Problem[]; closed: Problem[]; serverTime: string };

const API = "/api/production/roast-problems";
const hhmm = (iso: string) => new Date(iso).toLocaleString("ar-SA-u-ca-gregory-nu-latn", { timeZone: "Asia/Riyadh", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
const age = (m: number) => (m < 60 ? `${m} د` : m < 1440 ? `${Math.floor(m / 60)} س ${m % 60 ? `${m % 60} د` : ""}`.trim() : `${Math.floor(m / 1440)} يوم`);
const kindAr = (k: string) => PROBLEM_KIND_LABEL[k]?.ar ?? k;

export function RoastProblems() {
  const [data, setData] = useState<Answer | null>(null);
  const [denied, setDenied] = useState(false);
  const [tab, setTab] = useState<"open" | "closed">("open");
  const [ending, setEnding] = useState<{ p: Problem; cause: string; fix: string; err: string; busy: boolean } | null>(null);

  const load = useCallback(async () => {
    const r = await fetch(API, { cache: "no-store" });
    if (r.status === 403 || r.status === 401) { setDenied(true); return; }
    if (r.ok) setData(await r.json());
  }, []);
  useEffect(() => { const t = setTimeout(() => { void load(); }, 0); return () => clearTimeout(t); }, [load]);

  const end = async () => {
    if (!ending) return;
    const needs = endNeedsTexts(ending.p.kind);
    if (needs && (!ending.cause.trim() || !ending.fix.trim())) { setEnding({ ...ending, err: "اكتب إيش كانت المشكلة وإيش الحل." }); return; }
    setEnding({ ...ending, busy: true, err: "" });
    const r = await fetch(`${API}/${ending.p.id}/resolve`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": newRequestKey() }, body: JSON.stringify({ cause: ending.cause, fix: ending.fix }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { setEnding({ ...ending, busy: false, err: j.error ?? "تعذّر إنهاء البلاغ." }); return; }
    setEnding(null);
    await load();
  };

  if (denied) return null;
  const rows = tab === "open" ? data?.open ?? [] : data?.closed ?? [];
  return (
    <section id="problems" data-testid="roast-problems" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <h2 style={{ fontSize: 20, margin: 0 }}>بلاغات المحامص</h2>
      <small style={{ color: "var(--text-muted,#6e6a61)" }}>ما أُبلغ عنه من محطة التحميص. المفتوحة أولًا؛ الإنهاء بكتابة المشكلة والحل.</small>
      <div role="tablist" style={{ display: "inline-flex", gap: 4, padding: 4, borderRadius: 8, background: "var(--surface-subtle,#fbf9f4)", alignSelf: "flex-start" }}>
        {(["open", "closed"] as const).map((k) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} data-testid={`roast-problems-tab-${k}`}
            style={{ padding: "6px 14px", borderRadius: 6, border: 0, background: tab === k ? "var(--surface,#fff)" : "transparent", fontWeight: tab === k ? 600 : 400, cursor: "pointer" }}>
            {k === "open" ? `المفتوحة · ${data?.open.length ?? "…"}` : "المغلقة (30 يومًا)"}
          </button>
        ))}
      </div>
      {!data ? <p>…</p> : rows.length === 0 ? <p>{tab === "open" ? "لا بلاغات مفتوحة." : "لا بلاغات أُنهيت في آخر 30 يومًا."}</p> : (
        <table className="rp-table" style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr>
            <th align="right">الحمّاصة</th><th align="right">النوع</th><th align="right">السبب</th><th align="right">أبلغ</th>
            <th align="right">{tab === "open" ? "منذ" : "المدة"}</th><th align="right">الدفعات المعلّمة</th>
            {tab === "open" ? <th /> : <th align="right">الإنهاء</th>}
          </tr></thead>
          <tbody>{rows.map((p) => (
            <tr key={p.id} style={{ borderTop: "1px solid var(--border-subtle,#efeadf)", verticalAlign: "top" }} data-testid={`roast-problem-${p.id}`}>
              <td data-label="الحمّاصة"><b>{p.roaster.name}</b>{p.roaster.manufacturerModel ? <div><small>{p.roaster.manufacturerModel}</small></div> : null}</td>
              <td data-label="النوع">
                <span style={{ display: "inline-block", padding: "2px 10px", borderRadius: 999, fontWeight: 600, fontSize: 13,
                  background: p.blocking ? "var(--status-warning-tint,#fbf2da)" : "var(--status-info-tint,#eaf0f5)", color: p.blocking ? "var(--status-warning,#946200)" : "var(--status-info,#3b6385)" }}>
                  {p.blocking ? `⛔ ${kindAr(p.kind)} · يوقف التحميل` : `● ${kindAr(p.kind)} · بسيط، التحميص مستمر`}
                </span>
              </td>
              <td data-label="السبب">{problemReasonText(p.reason, "ar")}{p.note ? <div><small>«{p.note}»</small></div> : null}{p.run ? <div><small>التحميصة <bdi dir="ltr">{p.run.serial}</bdi></small></div> : null}</td>
              <td data-label="أبلغ">{p.reportedByName ?? "—"}<div><small>{hhmm(p.reportedAt)}</small></div></td>
              <td data-label={tab === "open" ? "منذ" : "المدة"}>{age(p.ageMinutes)}</td>
              <td data-label="الدفعات المعلّمة">{p.markedRuns.length ? <>{p.markedRuns.length} دفعات<div><small><bdi dir="ltr">{p.markedRuns.map((r) => r.serial).join(" · ")}</bdi></small></div></> : "—"}</td>
              {tab === "open" ? (
                <td className="rp-action"><Btn variant="primary" size="sm" onClick={() => setEnding({ p, cause: "", fix: "", err: "", busy: false })} data-testid={`roast-problem-end-${p.id}`}>✓ إنهاء البلاغ</Btn></td>
              ) : (
                <td data-label="الإنهاء">
                  {p.resolvedByName ?? "—"}{p.resolvedAt ? <small> · {hhmm(p.resolvedAt)}</small> : null}
                  {p.resolveCause ? <div><small>المشكلة: {p.resolveCause}</small></div> : null}
                  {p.resolveFix ? <div><small>الحل: {p.resolveFix}</small></div> : null}
                  {!p.resolveCause && p.resolveNote ? <div><small>{p.resolveNote}</small></div> : null}
                </td>
              )}
            </tr>
          ))}</tbody>
        </table>
      )}
      {ending && (
        <Dialog open title="إنهاء البلاغ" onClose={() => setEnding(null)} testId="roast-problem-end-dialog"
          sub={`${ending.p.roaster.name} · ${kindAr(ending.p.kind)} · ${problemReasonText(ending.p.reason, "ar")} · أُبلغ ${hhmm(ending.p.reportedAt)} · ${ending.p.reportedByName ?? ""}`}
          actions={<>
            <Btn onClick={() => setEnding(null)}>رجوع</Btn>
            <Btn variant="primary" busy={ending.busy} disabled={endNeedsTexts(ending.p.kind) && (!ending.cause.trim() || !ending.fix.trim())} onClick={() => void end()} data-testid="roast-problem-end-confirm">إنهاء البلاغ</Btn>
          </>}>
          <label className="hr-field"><span className="hr-label">إيش كانت المشكلة؟ *</span>
            <textarea className="hr-textarea" rows={3} maxLength={PROBLEM_TEXT_MAX} value={ending.cause} onChange={(e) => setEnding({ ...ending, cause: e.target.value })} placeholder="مثال: حساس الحرارة في الدرام كان مفصول" data-testid="roast-problem-cause" />
          </label>
          <label className="hr-field"><span className="hr-label">إيش الحل؟ *</span>
            <textarea className="hr-textarea" rows={3} maxLength={PROBLEM_TEXT_MAX} value={ending.fix} onChange={(e) => setEnding({ ...ending, fix: e.target.value })} placeholder="مثال: رجّعنا توصيل الحساس وجرّبنا دفعة صغيرة" data-testid="roast-problem-fix" />
          </label>
          <small>الحقلان مطلوبان. يُحفظان مع اسمك ووقت الإنهاء. بعد الإنهاء يُفتح التحميل على الحمّاصة.</small>
          {ending.err ? <div role="alert" style={{ color: "var(--status-danger,#b42318)" }}>{ending.err}</div> : null}
        </Dialog>
      )}
    </section>
  );
}
