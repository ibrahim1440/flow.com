"use client";

// UR-12 · سجل الصلاحيات (Figma 607:4125 at 1440 with one expanded change, 613:6323 at 1024, 616:7307
// at 390; users.py audit()). Every change to accounts, roles, permissions and credentials, and the
// sign-in events: absolute Asia/Riyadh time, actor, action, target, source, details; a permission
// change expands to each key's before / after with the reason. Filters: actor or target, action,
// period, source. «تصدير حساس» (O-6): the password, then a CSV — the export is itself audited.
// Administrator only (the API refuses everyone else).
import { useCallback, useEffect, useState } from "react";
import { Btn, FilterChip, OpsLoading } from "@/components/ops/ui";
import { Ico } from "@/components/shell/icons";
import { usePhone } from "@/components/shell/page-context";
import { NoAccess, PasswordConfirmField, SectionHead, SensFlag, UsersFrame, api, errText, fmtDate, fmtTime, useLangL, usePasswordConfirm, useUsersChrome } from "../_ui/shared";
import { Dialog } from "@/components/hr/ui";

type Entry = { id: string; at: string; actor: string; action: string; label: string; target: string; source: string; details: string; reason: string | null; result: string; diff: { key: string; label: string; before: string; after: string }[] | null };

export default function PermissionAuditPage() {
  const { lang, L } = useLangL();
  const phone = usePhone();
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("");
  const [days, setDays] = useState("30");
  const [source, setSource] = useState("");
  const [rows, setRows] = useState<Entry[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<{ text: string; status: number } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [counts, setCounts] = useState<{ users?: number; roles?: number }>({});
  useUsersChrome({ title: L("سجل الصلاحيات", "Permission log"), phone: { title: L("سجل الصلاحيات", "Permission log"), sub: L("الإعدادات · المستخدمون والصلاحيات", "Settings · Users & permissions") } });

  const qs = useCallback((before?: string | null) => {
    const u = new URLSearchParams();
    if (q.trim()) u.set("q", q.trim());
    if (cat) u.set("cat", cat);
    u.set("days", days || "all");
    if (source) u.set("source", source);
    if (before) u.set("before", before);
    return u.toString();
  }, [q, cat, days, source]);

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(async () => {
      const r = await api<{ entries: Entry[]; next: string | null }>(`/api/users/audit?${qs()}`);
      if (cancelled) return;
      if (r.ok) { setRows(r.data.entries); setNext(r.data.next); setError(null); setOpen((o) => o ?? r.data.entries.find((e) => e.diff?.length)?.id ?? null); }
      else setError({ text: errText(r.data, lang, L("تعذّر تحميل السجل.", "Could not load the log.")), status: r.status });
    }, 200);
    return () => { cancelled = true; clearTimeout(t); };
  }, [qs, lang, L]);
  useEffect(() => {
    void Promise.all([api<{ users: unknown[] }>("/api/users"), api<{ roles: unknown[] }>("/api/roles")]).then(([u, r]) => setCounts({ users: u.ok ? u.data.users.length : undefined, roles: r.ok ? r.data.roles.length : undefined }));
  }, []);
  async function more() {
    const r = await api<{ entries: Entry[]; next: string | null }>(`/api/users/audit?${qs(next)}`);
    if (r.ok) { setRows((x) => [...(x ?? []), ...r.data.entries]); setNext(r.data.next); }
  }
  if (error?.status === 403) return <UsersFrame><NoAccess /></UsersFrame>;

  const segs: [string, string][] = [["", L("آخر 30 يومًا", "Last 30 days")], ["permissions", L("الصلاحيات", "Permissions")], ["signin", L("الدخول", "Sign-ins")], ["accounts", L("الحسابات", "Accounts")]];
  return (
    <UsersFrame testId="ur-audit">
      <SectionHead tab="audit" isAdmin counts={counts}
        meta={<><span>{L("كل تغيير على الحسابات والأدوار والصلاحيات، وأحداث الدخول", "Every change to accounts, roles and permissions, and sign-in events")}</span><i aria-hidden /><span dir="ltr">Asia/Riyadh</span></>}
        actions={<Btn onClick={() => setExporting(true)} data-testid="ur-audit-export"><Ico name="dl" small />{L("تصدير", "Export")} <SensFlag lang={lang} /></Btn>} />
      <div className="ur-tool ur-hide-phone">
        <input className="hr-input hr-search" type="search" placeholder={L("المنفّذ أو الهدف", "Actor or target")} aria-label={L("بحث", "Search")} value={q} onChange={(e) => setQ(e.target.value)} data-testid="ur-audit-search" />
        <FilterChip label={L("الإجراء", "Action")} value={cat} onChange={setCat} options={[{ value: "permissions", label: L("الصلاحيات والأدوار", "Permissions & roles") }, { value: "accounts", label: L("الحسابات وبيانات الدخول", "Accounts & credentials") }, { value: "signin", label: L("الدخول", "Sign-ins") }]} />
        <FilterChip label={L("الفترة", "Period")} value={days === "30" ? "" : days} onChange={(v) => setDays(v || "30")} allLabel={L("آخر 30 يومًا", "Last 30 days")} options={[{ value: "7", label: L("آخر 7 أيام", "Last 7 days") }, { value: "90", label: L("آخر 90 يومًا", "Last 90 days") }, { value: "365", label: L("آخر سنة", "Last year") }, { value: "all", label: L("كل السجل", "All") }]} />
        <span className="ur-hide-rail"><FilterChip label={L("المصدر", "Source")} value={source} onChange={setSource} options={[{ value: "web", label: L("ويب", "Web") }, { value: "station", label: L("محطة", "Station") }, { value: "system", label: L("النظام", "System") }]} /></span>
      </div>
      <div className="hr-tabs ur-segs ur-phone-only" role="tablist">
        {segs.map(([k, label]) => <button key={k || "all"} type="button" role="tab" className="hr-tab" aria-selected={cat === k} onClick={() => setCat(k)}>{label}</button>)}
      </div>
      {error ? <div className="hr-notice tone-danger" role="alert">{error.text}</div> : null}
      {!rows && !error ? <OpsLoading rows={8} /> : null}
      {rows && rows.length === 0 ? <div className="hr-state" data-testid="ur-audit-empty"><p style={{ margin: 0 }}>{L("لا أحداث تطابق عوامل التصفية.", "No events match the filters.")}</p><Btn size="sm" onClick={() => { setQ(""); setCat(""); setDays("30"); setSource(""); }}>{L("مسح عوامل التصفية", "Clear filters")}</Btn></div> : null}
      {rows && rows.length ? (
        phone ? (
          <ul className="ur-mlist is-plain" data-testid="ur-audit-list">
            {rows.map((e) => (
              <li key={e.id}><span className="ur-mt">{e.label} · {e.target}</span><span className="ur-muted" style={{ fontFamily: "var(--f-num)", fontSize: 12.5 }}>{fmtTime(e.at)}</span><span className="ur-ms"><span>{e.actor}</span><span>{fmtDate(e.at, lang)}</span></span></li>
            ))}
          </ul>
        ) : (
          <div className="hr-tablewrap">
            <table className="hr-table ur-table ur-audit" aria-label={L("سجل الصلاحيات", "Permission log")} data-testid="ur-audit-table">
              <thead><tr><th>{L("الوقت", "Time")}</th><th>{L("المنفّذ", "Actor")}</th><th>{L("الإجراء", "Action")}</th><th>{L("الهدف", "Target")}</th><th className="ur-hide-rail">{L("المصدر", "Source")}</th><th>{L("التفاصيل", "Details")}</th></tr></thead>
              <tbody>
                {rows.flatMap((e) => {
                  const isOpen = open === e.id && !!e.diff?.length;
                  const tr = (
                    <tr key={e.id} className={isOpen ? "is-open" : undefined} onClick={() => e.diff?.length && setOpen((o) => (o === e.id ? null : e.id))} style={{ cursor: e.diff?.length ? "pointer" : undefined }} data-testid={`ur-audit-${e.action}`}>
                      <td className="ur-when"><b>{fmtTime(e.at)}</b><small>{fmtDate(e.at, lang)}</small></td>
                      <td>{e.actor}</td>
                      <td className="ur-action">{e.label}</td>
                      <td>{e.target}</td>
                      <td className="ur-hide-rail">{e.source}</td>
                      <td className="ur-det">{e.details}</td>
                    </tr>
                  );
                  if (!isOpen) return [tr];
                  return [tr, (
                    <tr key={`${e.id}-x`} className="is-open ur-expand"><td colSpan={6}>
                      <div className="ur-adiff" data-testid="ur-audit-diff">
                        <b>{L("المفتاح", "Key")}</b><b>{L("قبل", "Before")}</b><b>{L("بعد", "After")}</b>
                        {e.diff!.slice(0, 20).map((d) => [<span key={`${d.key}-k`} className="ur-key" dir="ltr">{d.key}</span>, <span key={`${d.key}-b`}>{d.before}</span>, <span key={`${d.key}-a`}>{d.after}</span>])}
                        {e.reason ? <><span className="ur-muted">{L("السبب", "Reason")}</span><span className="ur-span2">{e.reason}</span></> : null}
                      </div>
                    </td></tr>
                  )];
                })}
              </tbody>
            </table>
          </div>
        )
      ) : null}
      {next ? <div style={{ textAlign: "center" }}><Btn size="sm" onClick={more}>{L("المزيد", "More")}</Btn></div> : null}
      <p className="ur-foot ur-hide-phone">{L("لا يُسجَّل أي سر: لا كلمة مرور ولا رمز ولا رمز تفعيل. السجل للإضافة فقط. مدة الاحتفاظ تحددها سياسة المنشأة. كل تصدير يُسجَّل بدوره.", "No secret is ever recorded: no password, PIN or activation code. The log is append-only. Retention follows the organisation's policy. Every export is itself recorded.")}</p>
      <ExportDialog open={exporting} onClose={() => setExporting(false)} filters={{ q: q.trim(), cat: cat || "all", days: days || "all", source: source || "all" }} periodLabel={days === "all" ? L("كل السجل", "All") : L(`آخر ${days} يومًا`, `Last ${days} days`)} />
    </UsersFrame>
  );
}

function ExportDialog(props: Parameters<typeof ExportDialogInner>[0]) {
  return props.open ? <ExportDialogInner {...props} /> : null;
}

function ExportDialogInner({ open, onClose, filters, periodLabel }: { open: boolean; onClose: () => void; filters: Record<string, string>; periodLabel: string }) {
  const { L } = useLangL();
  const pc = usePasswordConfirm();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function go() {
    setBusy(true); setErr(null);
    if (!(await pc.confirm())) { setBusy(false); return; }
    const r = await fetch("/api/users/audit/export", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(filters) });
    setBusy(false);
    if (!r.ok) { const b = await r.json().catch(() => ({})); setErr(b.error ?? L("تعذّر التصدير.", "Could not export.")); return; }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `permissions-audit-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
    URL.revokeObjectURL(url);
    onClose();
  }
  return (
    <Dialog open={open} onClose={onClose} title={L("تصدير سجل الصلاحيات", "Export the permission log")} className="ur-dlg" testId="ur-export-dialog"
      sub={L(`تصدير حساس: يتضمن أسماء من دخلوا ومتى ومن غيّر ماذا. ${periodLabel}. يُسجَّل التصدير نفسه في السجل.`, `A sensitive export: who signed in, when, and who changed what. ${periodLabel}. The export itself is recorded.`)}
      actions={<><Btn onClick={onClose}>{L("رجوع", "Back")}</Btn><Btn variant="primary" busy={busy} onClick={go} data-testid="ur-export-go">{L("تصدير CSV", "Export CSV")}</Btn></>}>
      <PasswordConfirmField pc={pc} hint={L("التصدير يتطلب كلمة المرور. لا يُقبل الرمز السريع ولا البيانات الحيوية.", "Exporting needs your password. Quick PIN and biometrics are not accepted.")} />
      {err ? <div className="hr-notice tone-danger" role="alert">{err}</div> : null}
    </Dialog>
  );
}
