"use client";

// Account editors: which privileged accounts still lack a username or two-step verification
// (before AUTH_MFA_MODE=required), and second-person MFA resets — request, decide, withdraw.
import { useCallback, useEffect, useState } from "react";
import { ShieldAlert } from "lucide-react";

type Report = { mode: "enrolled" | "required"; privilegedCount: number; unenrolledCount: number; withoutUsernameCount: number; blockedCount?: number; accounts: { id: string; name: string; username: string | null; reasons: string[]; mfaEnrolled: boolean; blocked?: boolean }[] };
type Reset = { id: string; status: string; fingerprint: string; reason: string; accountId: string; accountName: string | null; requestedByName: string | null; mine: boolean };

export function MfaPanel({ ar, meId, onToast }: { ar: boolean; meId: string; onToast: (ok: boolean, msg: string) => void }) {
  const [report, setReport] = useState<Report | null>(null);
  const [resets, setResets] = useState<Reset[]>([]);
  const [open, setOpen] = useState(false);
  const [requestFor, setRequestFor] = useState<Report["accounts"][number] | null>(null);
  const [decide, setDecide] = useState<Reset | null>(null);

  const load = useCallback(() => {
    fetch("/api/employees/mfa-report").then((r) => (r.ok ? r.json() : null)).then(setReport).catch(() => setReport(null));
    fetch("/api/employees/mfa-resets").then((r) => (r.ok ? r.json() : { resets: [] })).then((d) => setResets(d.resets ?? [])).catch(() => setResets([]));
  }, []);
  useEffect(load, [load]);
  if (!report) return null;
  const pending = resets.filter((r) => r.status === "PENDING");
  const msg = (d: { error?: string; errorEn?: string } | null) => (ar ? d?.error : d?.errorEn ?? d?.error) ?? (ar ? "تعذّر التنفيذ" : "Could not complete");

  async function withdraw(r: Reset) {
    const res = await fetch(`/api/employees/mfa-resets/${r.id}/withdraw`, { method: "POST" });
    const d = await res.json().catch(() => null);
    onToast(res.ok, res.ok ? (ar ? "سُحب الطلب." : "Request withdrawn.") : msg(d));
    load();
  }

  return (
    <div className="rounded-xl border border-border bg-white px-4 py-3 text-sm" dir={ar ? "rtl" : "ltr"} data-testid="mfa-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 font-bold text-charcoal">
          <ShieldAlert size={16} className="text-orange" />
          {ar ? `الحسابات ذات الصلاحيات الحساسة: ${report.privilegedCount} — دون تحقق بخطوتين: ${report.unenrolledCount} — دون اسم مستخدم: ${report.withoutUsernameCount} — محظورة حتى التوثيق: ${report.blockedCount ?? 0}` : `Privileged accounts: ${report.privilegedCount} — without two-step verification: ${report.unenrolledCount} — without a username: ${report.withoutUsernameCount} — blocked until verified: ${report.blockedCount ?? 0}`}
        </p>
        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="px-3 py-1.5 rounded-lg border border-border bg-white text-xs font-bold" data-testid="mfa-report-toggle">{open ? (ar ? "إخفاء" : "Hide") : (ar ? "التفاصيل" : "Details")}</button>
      </div>
      <p className="text-xs text-brown/60 mt-0.5">{report.mode === "required" ? (ar ? "الوضع: التحقق بخطوتين إلزامي للحسابات الحساسة." : "Mode: two-step verification is required for privileged accounts.") : (ar ? "الوضع: يُطلب رمز التحقق من كل حساب فعّله." : "Mode: a code is required from every account that enabled it.")}</p>

      {pending.length > 0 && (
        <ul className="mt-2 space-y-2" data-testid="mfa-resets-pending">
          {pending.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-sky-50 border border-sky-200 px-3 py-2">
              <span><b>{ar ? "إعادة تعيين التحقق بخطوتين" : "Two-step verification reset"}: {r.accountName ?? "—"}</b><span className="block text-xs text-brown/60">{ar ? "طلبه" : "Requested by"} {r.requestedByName ?? "—"} · {r.reason}</span></span>
              {r.mine ? (
                <button type="button" onClick={() => void withdraw(r)} className="px-3 py-1.5 rounded-lg border border-border bg-white text-xs font-bold">{ar ? "سحب الطلب" : "Withdraw"}</button>
              ) : r.accountId === meId ? (
                <span className="text-xs text-brown/60">{ar ? "طلب على حسابك؛ يقرره غيرك" : "A request on your account; someone else decides"}</span>
              ) : (
                <button type="button" onClick={() => setDecide(r)} className="px-3 py-1.5 rounded-lg bg-orange text-white text-xs font-bold" data-testid="mfa-reset-review">{ar ? "مراجعة وقرار" : "Review and decide"}</button>
              )}
            </li>
          ))}
        </ul>
      )}

      {open && (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-xs" data-testid="mfa-report-table">
            <thead><tr className="text-brown/60 text-start"><th className="text-start py-1">{ar ? "الحساب" : "Account"}</th><th className="text-start">{ar ? "اسم المستخدم" : "Username"}</th><th className="text-start">{ar ? "التحقق بخطوتين" : "Two-step"}</th><th className="text-start">{ar ? "الهوية" : "Identity"}</th><th /></tr></thead>
            <tbody>
              {report.accounts.map((a) => (
                <tr key={a.id} className="border-t border-border">
                  <td className="py-1.5 font-semibold">{a.name}</td>
                  <td>{a.username ? <bdi dir="ltr">{a.username}</bdi> : <span className="text-red-700">{ar ? "مطلوب" : "required"}</span>}</td>
                  <td>{a.mfaEnrolled ? <span className="text-green-700">{ar ? "مفعّل" : "on"}</span> : <span className="text-amber-700">{ar ? "غير مفعّل" : "off"}</span>}</td>
                  <td>{a.blocked ? <span className="text-red-700">{ar ? "محظور حتى التوثيق" : "blocked until verified"}</span> : <span className="text-green-700">{ar ? "موثّق" : "verified"}</span>}</td>
                  <td className="text-end">{a.mfaEnrolled && a.id !== meId && !pending.some((p) => p.accountId === a.id) ? <button type="button" onClick={() => setRequestFor(a)} className="px-2 py-1 rounded border border-border text-[11px] font-bold" data-testid="mfa-reset-request">{ar ? "طلب إعادة تعيين" : "Request reset"}</button> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {requestFor && <RequestDialog ar={ar} acc={requestFor} onClose={() => setRequestFor(null)} onDone={(ok, m) => { setRequestFor(null); onToast(ok, m); load(); }} msg={msg} />}
      {decide && <DecideDialog ar={ar} r={decide} onClose={() => setDecide(null)} onDone={(ok, m) => { setDecide(null); onToast(ok, m); load(); }} msg={msg} />}
    </div>
  );
}

function Shell({ ar, title, children, onClose, testid }: { ar: boolean; title: string; children: React.ReactNode; onClose: () => void; testid: string }) {
  return (
    <div className="fixed inset-0 z-50 bg-charcoal/50 flex items-end sm:items-center justify-center" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={title} data-testid={testid} dir={ar ? "rtl" : "ltr"} className="bg-white rounded-t-2xl sm:rounded-2xl p-6 w-full max-w-md max-h-[90vh] overflow-y-auto shadow-2xl space-y-3" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-extrabold text-charcoal">{title}</h2>
        {children}
      </div>
    </div>
  );
}

function RequestDialog({ ar, acc, onClose, onDone, msg }: { ar: boolean; acc: { id: string; name: string }; onClose: () => void; onDone: (ok: boolean, m: string) => void; msg: (d: { error?: string; errorEn?: string } | null) => string }) {
  const [reason, setReason] = useState("");
  async function submit() {
    const res = await fetch("/api/employees/mfa-resets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accountId: acc.id, reason }) });
    const d = await res.json().catch(() => null);
    onDone(res.ok, res.ok ? (ar ? "أُرسل الطلب؛ يقرره شخص آخر." : "Request sent; another person decides it.") : msg(d));
  }
  return (
    <Shell ar={ar} title={ar ? `إعادة تعيين التحقق بخطوتين · ${acc.name}` : `Reset two-step verification · ${acc.name}`} onClose={onClose} testid="mfa-reset-request-dialog">
      <p className="text-sm text-brown/80">{ar ? "يُحذف مفتاح المصادقة ورموز الاسترداد وتنتهي كل جلسات الحساب، ثم يفعّل صاحبه التحقق من جديد. يقرر الطلب شخص آخر بعد التحقق من الهوية." : "The authenticator key and recovery codes are deleted and every session of the account ends; the holder then sets it up again. Another person decides after checking the holder's identity."}</p>
      <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} placeholder={ar ? "السبب (مثل: فقد الجهاز ورموز الاسترداد)" : "Reason (e.g. device and recovery codes lost)"} className="w-full border-2 border-border rounded-xl px-3 py-2 text-sm" />
      <div className="flex gap-2"><button type="button" disabled={reason.trim().length < 3} onClick={submit} className="flex-1 py-2.5 bg-orange text-white font-bold rounded-xl disabled:opacity-40">{ar ? "إرسال الطلب" : "Send request"}</button><button type="button" onClick={onClose} className="px-4 py-2.5 border-2 border-border rounded-xl text-sm font-semibold">{ar ? "إلغاء" : "Cancel"}</button></div>
    </Shell>
  );
}

function DecideDialog({ ar, r, onClose, onDone, msg }: { ar: boolean; r: Reset; onClose: () => void; onDone: (ok: boolean, m: string) => void; msg: (d: { error?: string; errorEn?: string } | null) => string }) {
  const [attest, setAttest] = useState(false);
  const [note, setNote] = useState("");
  async function send(decision: "APPROVE" | "REJECT") {
    const res = await fetch(`/api/employees/mfa-resets/${r.id}/decide`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(decision === "APPROVE" ? { decision, expected: r.fingerprint, attested: attest, note } : { decision, note }) });
    const d = await res.json().catch(() => null);
    onDone(res.ok, res.ok ? (decision === "APPROVE" ? (ar ? "أُعيد تعيين التحقق بخطوتين وانتهت جلسات الحساب." : "Two-step verification reset; the account's sessions ended.") : (ar ? "رُفض الطلب." : "Request rejected.")) : msg(d));
  }
  return (
    <Shell ar={ar} title={ar ? `قرار إعادة التعيين · ${r.accountName ?? ""}` : `Decide the reset · ${r.accountName ?? ""}`} onClose={onClose} testid="mfa-reset-decide-dialog">
      <p className="text-sm text-brown/80">{ar ? "طلبه" : "Requested by"} {r.requestedByName ?? "—"} · {r.reason}</p>
      <p className="text-xs text-brown/60">{ar ? "البصمة" : "Fingerprint"}: <bdi dir="ltr" className="font-mono">{r.fingerprint}</bdi></p>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={attest} onChange={(e) => setAttest(e.target.checked)} className="mt-1" data-testid="mfa-reset-attest" /><span>{ar ? "تأكدت بوسيلة مستقلة أن صاحب الحساب هو من يطلب إعادة التعيين، وتحققت من هويته." : "I confirmed out of band that the account holder is asking for this reset, and checked their identity."}</span></label>
      <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder={ar ? "ملاحظة (مطلوبة عند الرفض)" : "Note (required to reject)"} className="w-full border-2 border-border rounded-xl px-3 py-2 text-sm" />
      <div className="flex gap-2 flex-wrap">
        <button type="button" disabled={!attest} onClick={() => void send("APPROVE")} className="flex-1 py-2.5 bg-orange text-white font-bold rounded-xl disabled:opacity-40" data-testid="mfa-reset-approve">{ar ? "اعتماد وإعادة التعيين" : "Approve and reset"}</button>
        <button type="button" disabled={note.trim().length < 3} onClick={() => void send("REJECT")} className="px-4 py-2.5 border-2 border-red-300 text-red-700 rounded-xl text-sm font-bold disabled:opacity-40">{ar ? "رفض" : "Reject"}</button>
        <button type="button" onClick={onClose} className="px-4 py-2.5 border-2 border-border rounded-xl text-sm font-semibold">{ar ? "إلغاء" : "Cancel"}</button>
      </div>
    </Shell>
  );
}
