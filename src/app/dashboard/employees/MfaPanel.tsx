"use client";

// Account editors: which privileged accounts still lack a username or two-step verification
// (before AUTH_MFA_MODE=required), and second-person MFA resets — request, decide, withdraw.
import { useCallback, useEffect, useState } from "react";
import { ShieldAlert } from "lucide-react";
import { Btn, Dialog, Field } from "@/components/hr/ui";

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
    <div className="emp-panel" data-testid="mfa-panel">
      <div className="emp-panel-head">
        <p className="emp-panel-title">
          <ShieldAlert size={16} aria-hidden="true" />
          {ar ? `الحسابات ذات الصلاحيات الحساسة: ${report.privilegedCount} — دون تحقق بخطوتين: ${report.unenrolledCount} — دون اسم مستخدم: ${report.withoutUsernameCount} — محظورة حتى التوثيق: ${report.blockedCount ?? 0}` : `Privileged accounts: ${report.privilegedCount} — without two-step verification: ${report.unenrolledCount} — without a username: ${report.withoutUsernameCount} — blocked until verified: ${report.blockedCount ?? 0}`}
        </p>
        <Btn size="sm" onClick={() => setOpen((v) => !v)} aria-expanded={open} data-testid="mfa-report-toggle">{open ? (ar ? "إخفاء" : "Hide") : (ar ? "التفاصيل" : "Details")}</Btn>
      </div>
      <p className="hr-caption" style={{ margin: 0 }}>{report.mode === "required" ? (ar ? "الوضع: التحقق بخطوتين إلزامي للحسابات الحساسة." : "Mode: two-step verification is required for privileged accounts.") : (ar ? "الوضع: يُطلب رمز التحقق من كل حساب فعّله." : "Mode: a code is required from every account that enabled it.")}</p>

      {pending.length > 0 && (
        <ul className="emp-reqs" data-testid="mfa-resets-pending">
          {pending.map((r) => (
            <li key={r.id} className="hr-notice tone-info">
              <span><b>{ar ? "إعادة تعيين التحقق بخطوتين" : "Two-step verification reset"}: {r.accountName ?? "—"}</b><span className="hr-caption emp-block">{ar ? "طلبه" : "Requested by"} {r.requestedByName ?? "—"} · {r.reason}</span></span>
              {r.mine ? (
                <Btn size="sm" onClick={() => void withdraw(r)}>{ar ? "سحب الطلب" : "Withdraw"}</Btn>
              ) : r.accountId === meId ? (
                <span className="hr-caption">{ar ? "طلب على حسابك؛ يقرره غيرك" : "A request on your account; someone else decides"}</span>
              ) : (
                <Btn size="sm" variant="primary" onClick={() => setDecide(r)} data-testid="mfa-reset-review">{ar ? "مراجعة وقرار" : "Review and decide"}</Btn>
              )}
            </li>
          ))}
        </ul>
      )}

      {open && (
        <div className="hr-tablewrap">
          <table className="hr-table" data-testid="mfa-report-table">
            <thead><tr><th>{ar ? "الحساب" : "Account"}</th><th>{ar ? "اسم المستخدم" : "Username"}</th><th>{ar ? "التحقق بخطوتين" : "Two-step"}</th><th>{ar ? "الهوية" : "Identity"}</th><th /></tr></thead>
            <tbody>
              {report.accounts.map((a) => (
                <tr key={a.id}>
                  <td className="emp-strong">{a.name}</td>
                  <td>{a.username ? <bdi dir="ltr">{a.username}</bdi> : <span className="hr-dot tone-danger">{ar ? "مطلوب" : "required"}</span>}</td>
                  <td>{a.mfaEnrolled ? <span className="hr-dot tone-success">{ar ? "مفعّل" : "on"}</span> : <span className="hr-dot tone-warning">{ar ? "غير مفعّل" : "off"}</span>}</td>
                  <td>{a.blocked ? <span className="hr-dot tone-danger">{ar ? "محظور حتى التوثيق" : "blocked until verified"}</span> : <span className="hr-dot tone-success">{ar ? "موثّق" : "verified"}</span>}</td>
                  <td style={{ textAlign: "end" }}>{a.mfaEnrolled && a.id !== meId && !pending.some((p) => p.accountId === a.id) ? <Btn size="sm" onClick={() => setRequestFor(a)} data-testid="mfa-reset-request">{ar ? "طلب إعادة تعيين" : "Request reset"}</Btn> : null}</td>
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

function Shell({ title, children, onClose, testid, actions }: { ar: boolean; title: string; children: React.ReactNode; onClose: () => void; testid: string; actions: React.ReactNode }) {
  return (
    <Dialog open title={title} onClose={onClose} testId={testid} actions={actions}>
      {children}
    </Dialog>
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
    <Shell ar={ar} title={ar ? `إعادة تعيين التحقق بخطوتين · ${acc.name}` : `Reset two-step verification · ${acc.name}`} onClose={onClose} testid="mfa-reset-request-dialog"
      actions={<><Btn variant="primary" disabled={reason.trim().length < 3} onClick={submit}>{ar ? "إرسال الطلب" : "Send request"}</Btn><Btn onClick={onClose}>{ar ? "إلغاء" : "Cancel"}</Btn></>}>
      <p className="emp-p">{ar ? "يُحذف مفتاح المصادقة ورموز الاسترداد وتنتهي كل جلسات الحساب، ثم يفعّل صاحبه التحقق من جديد. يقرر الطلب شخص آخر بعد التحقق من الهوية." : "The authenticator key and recovery codes are deleted and every session of the account ends; the holder then sets it up again. Another person decides after checking the holder's identity."}</p>
      <Field label={ar ? "السبب" : "Reason"}>
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} placeholder={ar ? "السبب (مثل: فقد الجهاز ورموز الاسترداد)" : "Reason (e.g. device and recovery codes lost)"} className="hr-textarea" />
      </Field>
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
    <Shell ar={ar} title={ar ? `قرار إعادة التعيين · ${r.accountName ?? ""}` : `Decide the reset · ${r.accountName ?? ""}`} onClose={onClose} testid="mfa-reset-decide-dialog"
      actions={<>
        <Btn variant="primary" disabled={!attest} onClick={() => void send("APPROVE")} data-testid="mfa-reset-approve">{ar ? "اعتماد وإعادة التعيين" : "Approve and reset"}</Btn>
        <Btn variant="danger" disabled={note.trim().length < 3} onClick={() => void send("REJECT")}>{ar ? "رفض" : "Reject"}</Btn>
        <Btn onClick={onClose}>{ar ? "إلغاء" : "Cancel"}</Btn>
      </>}>
      <p className="emp-p">{ar ? "طلبه" : "Requested by"} {r.requestedByName ?? "—"} · {r.reason}</p>
      <p className="hr-caption" style={{ margin: 0 }}>{ar ? "البصمة" : "Fingerprint"}: <bdi dir="ltr" className="font-mono">{r.fingerprint}</bdi></p>
      <label className="emp-check"><input type="checkbox" checked={attest} onChange={(e) => setAttest(e.target.checked)} data-testid="mfa-reset-attest" /><span>{ar ? "تأكدت بوسيلة مستقلة أن صاحب الحساب هو من يطلب إعادة التعيين، وتحققت من هويته." : "I confirmed out of band that the account holder is asking for this reset, and checked their identity."}</span></label>
      <Field label={ar ? "ملاحظة" : "Note"}>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder={ar ? "ملاحظة (مطلوبة عند الرفض)" : "Note (required to reject)"} className="hr-textarea" />
      </Field>
    </Shell>
  );
}
