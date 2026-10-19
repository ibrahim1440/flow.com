"use client";

// UR-01 · دليل المستخدمين (Figma 597:2 at 1440 with the preview drawer, 609:4773 at 1024, 614:6704
// at 390; users.py directory()). Every account with its role («مخصص» when it has exceptions), status,
// last sign-in and HR link; search and filters (role, status, module access); a non-modal preview
// that opens the profile and never edits. Read by any holder of the «إدارة المستخدمين» module; the
// buttons that change something are the administrator's (owner rule), and the server decides.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Btn, Empty, FilterChip, OpsLoading } from "@/components/ops/ui";
import { Ico } from "@/components/shell/icons";
import { moduleLabel, GROUPS } from "@/lib/users/catalog";
import {
  Avatar, Latin, SectionHead, SensFlag, StatusWord, Tag, UsersFrame, api, deviceText, errText, fmtWhen, METHOD_WORD, STATUS_WORD, useLangL, useUsersChrome,
  type DeviceInfo, type UserStatus,
} from "./_ui/shared";

type Row = {
  id: string; name: string; username: string | null; role: { key: string; id: string; name: string; nameEn: string; system: boolean }; customized: boolean; powerUser: boolean;
  status: UserStatus; active: boolean; overrides: { active: number; ended: number };
  lastSignIn: { at: string; method: string; device: DeviceInfo } | null; hr: { id: string; name: string; department: string | null } | null; external: boolean;
  modules: string[]; sensitive: { key: string; label: string; source: string }[];
};
type Caps = { view: boolean; manage: boolean; simpleMode: boolean };

export default function UsersDirectoryPage() {
  const { lang, ar, L } = useLangL();
  const router = useRouter();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [caps, setCaps] = useState<Caps | null>(null);
  const [roleCount, setRoleCount] = useState<number | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [role, setRole] = useState("");
  const [status, setStatus] = useState("");
  const [mod, setMod] = useState("");
  const [seg, setSeg] = useState<"all" | "active" | "action" | "inactive">("all");
  const [selected, setSelected] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useUsersChrome({
    title: L("المستخدمون", "Users"),
    phone: { title: L("المستخدمون", "Users"), sub: L("الإعدادات · المستخدمون والصلاحيات", "Settings · Users & permissions"), ...(caps?.manage ? { action: { href: "/dashboard/employees/new", label: L("مستخدم جديد", "New user"), icon: "plus" as const } } : {}) },
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [u, r] = await Promise.all([api<{ users: Row[]; caps: Caps }>("/api/users"), api<{ roles: unknown[] }>("/api/roles")]);
      if (cancelled) return;
      if (u.ok) { setRows(u.data.users); setCaps(u.data.caps); setError(null); } else setError(errText(u.data, lang, L("تعذّر تحميل المستخدمين.", "Could not load the users.")));
      if (r.ok) setRoleCount(r.data.roles.length);
    })();
    return () => { cancelled = true; };
  }, [reload, lang, L]);

  const roleOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rows ?? []) m.set(r.role.id, ar ? r.role.name : r.role.nameEn);
    return [...m.entries()].map(([value, label]) => ({ value, label }));
  }, [rows, ar]);
  const needle = q.trim().toLowerCase();
  const filtered = useMemo(() => (rows ?? []).filter((r) =>
    (!needle || r.name.toLowerCase().includes(needle) || (r.username ?? "").includes(needle))
    && (!role || r.role.id === role) && (!status || r.status === status) && (!mod || r.modules.includes(mod))
    && (seg === "all" || (seg === "active" && r.status === "active") || (seg === "action" && (r.status === "locked" || r.status === "mustChange")) || (seg === "inactive" && r.status === "inactive"))), [rows, needle, role, status, mod, seg]);
  const counts = useMemo(() => ({
    all: rows?.length ?? 0, active: rows?.filter((r) => r.status === "active").length ?? 0,
    action: rows?.filter((r) => r.status === "locked" || r.status === "mustChange").length ?? 0, inactive: rows?.filter((r) => r.status === "inactive").length ?? 0,
  }), [rows]);
  const sel = rows?.find((r) => r.id === selected) ?? null;
  const filtersOn = !!(needle || role || status || mod || seg !== "all");
  // Owner decision 19 Oct: a power user (employees › manage_access) carries «متقدّم» beside its role.
  const roleCell = (r: Row) => <span className="ur-role">{ar ? r.role.name : r.role.nameEn}{r.customized ? <Tag>{L("مخصص", "Custom")}</Tag> : null}{r.powerUser ? <Tag testId={`ur-power-${r.id}`}>{L("متقدّم", "Power user")}</Tag> : null}</span>;
  const signIn = (r: Row) => r.lastSignIn ? `${fmtWhen(r.lastSignIn.at, lang)} · ${ar ? METHOD_WORD[r.lastSignIn.method]?.ar ?? r.lastSignIn.method : METHOD_WORD[r.lastSignIn.method]?.en ?? r.lastSignIn.method}` : "—";

  function exportCsv() {
    const head = [L("المستخدم", "User"), L("اسم المستخدم", "Username"), L("الدور", "Role"), L("الحالة", "Status"), L("آخر دخول", "Last sign-in"), L("ملف الموظف", "HR record")];
    const cell = (v: string) => `"${(/^[=+\-@]/.test(v) ? `'${v}` : v).replace(/"/g, '""')}"`;
    const lines = [head, ...filtered.map((r) => [r.name, r.username ?? "", (ar ? r.role.name : r.role.nameEn) + (r.customized ? ` (${L("مخصص", "custom")})` : "") + (r.powerUser ? ` (${L("مستخدم متقدّم", "power user")})` : ""), ar ? STATUS_WORD[r.status].ar : STATUS_WORD[r.status].en, r.lastSignIn ? fmtWhen(r.lastSignIn.at, lang) : "—", r.hr ? r.hr.name : "—"])].map((x) => x.map(cell).join(","));
    const url = URL.createObjectURL(new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url; a.download = `users-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <UsersFrame testId="ur-directory">
      <div className={`hr-split${sel ? " has-preview" : ""} ur-split`}>
        <div className="ur-page">
          <SectionHead
            tab="users" isAdmin={!!caps?.manage} counts={{ users: rows?.length, roles: roleCount }}
            meta={<><span>{L("الإعدادات", "Settings")}</span><i aria-hidden /><span>{L("الحساب يربط الدخول والصلاحيات بملف الموظف", "An account ties sign-in and permissions to the employee record")}</span></>}
            actions={caps?.manage ? (
              <>
                <Btn variant="ghost" onClick={exportCsv} disabled={!rows?.length} data-testid="ur-export"><Ico name="dl" small />{L("تصدير", "Export")}</Btn>
                <Btn variant="primary" onClick={() => router.push("/dashboard/employees/new")} data-testid="ur-new-user"><Ico name="plus" small />{L("مستخدم جديد", "New user")}</Btn>
              </>
            ) : null}
          />

          <div className="ur-tool ur-hide-phone">
            <input className="hr-input hr-search" type="search" placeholder={L("الاسم أو اسم المستخدم", "Name or username")} aria-label={L("بحث", "Search")} value={q} onChange={(e) => setQ(e.target.value)} data-testid="ur-search" />
            <FilterChip label={L("الدور", "Role")} value={role} onChange={setRole} options={roleOptions} />
            <FilterChip label={L("الحالة", "Status")} value={status} onChange={setStatus} options={(Object.keys(STATUS_WORD) as UserStatus[]).map((k) => ({ value: k, label: ar ? STATUS_WORD[k].ar : STATUS_WORD[k].en }))} />
            <span className="ur-hide-rail">
              <FilterChip label={L("الوصول إلى وحدة", "Module access")} value={mod} onChange={setMod} options={GROUPS.flatMap((g) => g.modules).map((m) => ({ value: m, label: moduleLabel(m, lang) }))} />
            </span>
            <span className="tl-sp" />
            {rows ? <span className="ur-count">{ar ? `${filtered.length} مستخدمًا` : `${filtered.length} users`}</span> : null}
          </div>
          <div className="ur-phone-only">
            <input className="hr-input hr-search" type="search" placeholder={L("الاسم أو اسم المستخدم", "Name or username")} aria-label={L("بحث", "Search")} value={q} onChange={(e) => setQ(e.target.value)} style={{ width: "100%", height: 44, marginBottom: 10 }} />
            <div className="hr-tabs ur-segs" role="tablist" aria-label={L("الحالة", "Status")}>
              {([["all", L("الكل", "All"), counts.all], ["active", L("نشط", "Active"), counts.active], ["action", L("يحتاج إجراء", "Needs action"), counts.action], ["inactive", L("موقوف", "Inactive"), counts.inactive]] as const).map(([k, label, n]) => (
                <button key={k} type="button" role="tab" className="hr-tab" aria-selected={seg === k} onClick={() => setSeg(k)}>{label} <span className="hr-count">{n}</span></button>
              ))}
            </div>
          </div>

          {error ? <div className="hr-notice tone-danger" role="alert">{error} <Btn size="sm" onClick={() => setReload((x) => x + 1)}>{L("إعادة المحاولة", "Retry")}</Btn></div> : null}
          {!rows && !error ? <OpsLoading rows={8} label={L("جارٍ تحميل المستخدمين…", "Loading users…")} /> : null}

          {rows && rows.length <= 1 && !filtersOn ? (
            <Empty title={L("لا يوجد مستخدمون غيرك", "There are no users but you")} body={L("أنشئ حسابًا لكل موظف واربطه بملفه. يبدأ كل حساب بلا وصول.", "Create an account for each employee and link it to their record. Every account starts with no access.")}
              action={caps?.manage ? <Btn variant="primary" size="sm" onClick={() => router.push("/dashboard/employees/new")}>{L("مستخدم جديد", "New user")}</Btn> : undefined} />
          ) : rows && filtered.length === 0 ? (
            <div className="hr-state" data-testid="ur-no-results">
              <p style={{ margin: 0 }}>{needle ? L(`لا يطابق «${q.trim()}» أي مستخدم${status ? ` ضمن الحالة «${STATUS_WORD[status as UserStatus].ar}»` : ""}.`, `No user matches “${q.trim()}”${status ? ` with status “${STATUS_WORD[status as UserStatus].en}”` : ""}.`) : L("لا يطابق أي مستخدم عوامل التصفية.", "No user matches the filters.")}</p>
              <Btn size="sm" onClick={() => { setQ(""); setRole(""); setStatus(""); setMod(""); setSeg("all"); }}>{L("مسح عوامل التصفية", "Clear filters")}</Btn>
            </div>
          ) : rows ? (
            <>
              <div className="hr-tablewrap ur-hide-phone">
                <table className="hr-table ur-table" aria-label={L("المستخدمون", "Users")} data-testid="ur-users-table">
                  <thead>
                    <tr>
                      <th>{L("المستخدم", "User")}</th>
                      <th>{L("الدور", "Role")}</th>
                      <th>{L("الحالة", "Status")}</th>
                      <th>{L("محطات العمل", "Workstations")}</th>
                      <th className="ur-hide-rail">{L("آخر دخول", "Last sign-in")}</th>
                      <th className="ur-hide-rail">{L("ملف الموظف", "HR record")}</th>
                      <th aria-hidden />
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((r) => (
                      <tr key={r.id} className="ur-row" aria-selected={selected === r.id} onClick={() => setSelected((s) => (s === r.id ? null : r.id))} data-testid={`ur-row-${r.username ?? r.id}`}>
                        <td><div className="ur-user"><Avatar name={r.name} /><div><b>{r.name}</b>{r.username ? <small><Latin>{r.username}</Latin></small> : null}</div></div></td>
                        <td>{roleCell(r)}</td>
                        <td><StatusWord status={r.status} lang={lang} /></td>
                        <td className="ur-muted">—</td>
                        <td className="ur-hide-rail">{signIn(r)}</td>
                        <td className="ur-hide-rail">{r.hr ? L("مرتبط", "Linked") : r.external ? L("شخص خارجي", "External person") : <span className="ur-warn-text">{L("بلا ملف موظف", "No HR record")}</span>}</td>
                        <td className="ur-chev"><Link href={`/dashboard/employees/${r.id}`} aria-label={`${L("فتح ملف", "Open")} ${r.name}`} onClick={(e) => e.stopPropagation()}><Ico name="chev" small /></Link></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <ul className="ur-mlist ur-phone-only" data-testid="ur-users-list">
                {filtered.map((r) => (
                  <li key={r.id}>
                    <Link href={`/dashboard/employees/${r.id}`}>
                      <Avatar name={r.name} />
                      <span className="ur-mt">{r.name}</span>
                      <StatusWord status={r.status} lang={lang} />
                      <span className="ur-ms">{roleCell(r)}{r.username ? <Latin>{r.username}</Latin> : null}</span>
                    </Link>
                  </li>
                ))}
              </ul>
              <p className="ur-foot ur-hide-phone">
                <span>{L("«مخصص»: للمستخدم استثناءات على دوره.", "“Custom”: the user has exceptions to their role.")}</span><i aria-hidden />
                <span>{L("«متقدّم»: يغيّر صلاحيات الآخرين ضمن ما يملكه.", "“Power user”: changes others' permissions within its own access.")}</span><i aria-hidden />
                <span>{L("محطات العمل: تتطلب نموذج المحطات (I-10) — مخطط.", "Workstations: need the station model (I-10) — planned.")}</span>
                {caps?.manage ? <><i aria-hidden /><Link className="ur-link" href="/dashboard/employees/requests" data-testid="ur-requests-link">{L("التحقق من الهوية وطلبات الاعتماد", "Identity verification & approval requests")}</Link></> : null}
              </p>
            </>
          ) : null}
        </div>
        {sel ? (
          <>
            <div className="hr-scrim" onClick={() => setSelected(null)} />
            <aside className="hr-preview ur-drawer" aria-label={L("معاينة المستخدم", "User preview")} data-testid="ur-preview">
              <div className="hr-preview-head">
                <b style={{ fontWeight: 600 }}>{L("معاينة المستخدم", "User preview")}</b>
                <Btn variant="ghost" size="sm" className="hr-iconbtn" aria-label={L("إغلاق المعاينة", "Close preview")} onClick={() => setSelected(null)}>✕</Btn>
              </div>
              <div className="hr-preview-body">
                <div className="ur-who"><Avatar name={sel.name} size="md" /><div><b>{sel.name}</b><small>{sel.username ? <Latin>{sel.username}</Latin> : null}{sel.hr ? ` · ${L("مرتبط بملف الموظف", "linked to the HR record")}` : ""}</small></div></div>
                <dl className="ur-dl">
                  <dt>{L("الحالة", "Status")}</dt><dd><StatusWord status={sel.status} lang={lang} /></dd>
                  <dt>{L("الدور", "Role")}</dt><dd>{roleCell(sel)}</dd>
                  <dt>{L("الاستثناءات", "Exceptions")}</dt><dd>{ar ? `${sel.overrides.active} نشطة · ${sel.overrides.ended} منتهٍ` : `${sel.overrides.active} active · ${sel.overrides.ended} ended`}</dd>
                  <dt>{L("محطات العمل", "Workstations")}</dt><dd className="ur-muted">—</dd>
                  <dt>{L("آخر دخول", "Last sign-in")}</dt><dd>{sel.lastSignIn ? `${fmtWhen(sel.lastSignIn.at, lang)} · ${ar ? METHOD_WORD[sel.lastSignIn.method]?.ar ?? "" : METHOD_WORD[sel.lastSignIn.method]?.en ?? ""}` : "—"}</dd>
                </dl>
                <div>
                  <p className="ur-lbl">{L("صلاحيات حساسة فعّالة", "Active sensitive permissions")}</p>
                  {sel.sensitive.length ? (
                    <div style={{ display: "grid", gap: 6 }}>
                      {sel.sensitive.slice(0, 6).map((s) => <div key={s.key} className="ur-sensrow"><SensFlag lang={lang} /><span>{s.label}</span></div>)}
                      {sel.sensitive.length > 6 ? <span className="ur-muted" style={{ fontSize: 12.5 }}>{ar ? `و${sel.sensitive.length - 6} أخرى` : `and ${sel.sensitive.length - 6} more`}</span> : null}
                    </div>
                  ) : <span className="ur-muted" style={{ fontSize: 13.5 }}>{L("لا شيء", "None")}</span>}
                </div>
                <p className="hr-caption" style={{ margin: 0 }}>{L("تُعرض الصلاحيات الفعلية كما يحسبها الخادم. التعديل من ملف المستخدم.", "Effective permissions as the server computes them. Changes are made from the user's profile.")}</p>
                {sel.lastSignIn ? <p className="hr-caption" style={{ margin: 0 }}>{deviceText(sel.lastSignIn.device, lang)}</p> : null}
              </div>
              <div className="hr-preview-foot">
                <Link className="hr-btn is-primary" style={{ flex: 1, justifyContent: "center" }} href={`/dashboard/employees/${sel.id}`} data-testid="ur-preview-open">{L("فتح الملف", "Open profile")}</Link>
                <Link className="hr-btn" href={`/dashboard/employees/${sel.id}?tab=effective`}>{L("الصلاحيات الفعلية", "Effective permissions")}</Link>
              </div>
            </aside>
          </>
        ) : null}
      </div>
    </UsersFrame>
  );
}
