"use client";

// UR-07 · مقارنة الأدوار (Figma 606:4137 at 1440 — five roles, 612:5768 at 1024 — four; users.py
// compare()). Read-only: per module, each role's level and how many NON-sensitive actions it grants;
// «الأدوار: 5 من 6» picks the columns, «إظهار الفروق فقط» hides the modules where all agree; the
// module column is pinned and the table scrolls sideways.
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { Dot, OpsLoading } from "@/components/ops/ui";
import { usePhone } from "@/components/shell/page-context";
import { GROUPS, moduleLabel } from "@/lib/users/catalog";
import { actionsWord, compareCell, type Cells } from "@/lib/users/model";
import { UsersFrame, api, errText, useLangL, useUsersChrome } from "../../_ui/shared";

type Role = { id: string; system: boolean; name: string; nameEn: string; permissions: Cells };

export default function CompareRolesPage() {
  return <Suspense fallback={null}><CompareRolesPageInner /></Suspense>;
}

function CompareRolesPageInner() {
  const sp = useSearchParams();
  const { lang, ar, L } = useLangL();
  const phone = usePhone();
  const [roles, setRoles] = useState<Role[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [onlyDiff, setOnlyDiff] = useState(false);
  const [pickOpen, setPickOpen] = useState(false);
  useUsersChrome({ title: L("مقارنة", "Compare"), crumbs: [{ text: L("الأدوار", "Roles"), href: "/dashboard/employees/roles" }], phone: { title: L("مقارنة الأدوار", "Compare roles"), back: "/dashboard/employees/roles" } });
  useEffect(() => {
    void api<{ roles: Role[] }>("/api/roles").then((r) => {
      if (!r.ok) { setError(errText(r.data, lang, L("تعذّر تحميل الأدوار.", "Could not load the roles."))); return; }
      setRoles(r.data.roles);
      const want = sp.get("with");
      const first = r.data.roles.slice(0, 5).map((x) => x.id);
      setPicked(want && !first.includes(want) ? [...first.slice(0, 4), want] : first);
    });
  }, [lang, L, sp]);
  const cols = useMemo(() => (roles ?? []).filter((r) => picked.includes(r.id)), [roles, picked]);
  const cell = (r: Role, m: string) => compareCell(r.permissions, m);
  const same = (m: string) => cols.every((r) => { const a = cell(r, m), b = cell(cols[0], m); return a.level === b.level && a.actions === b.actions; });
  const lvl = (v: string) => (ar ? { none: "لا وصول", view: "عرض", edit: "تعديل" } : { none: "No access", view: "View", edit: "Edit" })[v as "none"];
  const hidden = (roles ?? []).filter((r) => !picked.includes(r.id));
  if (error) return <UsersFrame><div className="hr-notice tone-danger" role="alert">{error}</div></UsersFrame>;
  if (!roles) return <UsersFrame><OpsLoading rows={8} /></UsersFrame>;
  return (
    <UsersFrame testId="ur-compare">
      <div className="ur-headtext">
        <h1 className="hr-title">{L("مقارنة الأدوار", "Compare roles")}</h1>
        <div className="ur-meta"><span>{L("للقراءة فقط", "Read-only")}</span><i aria-hidden /><span>{L("عدد الإجراءات غير الحساسة في كل خانة", "Non-sensitive actions in each cell")}</span></div>
      </div>
      <div className="ur-tool">
        <span className="ur-pick">
          <button type="button" className="ur-chipbtn" aria-expanded={pickOpen} onClick={() => setPickOpen((o) => !o)} data-testid="ur-pick-roles">{L("الأدوار:", "Roles:")} <b>{ar ? `${cols.length} من ${roles.length}` : `${cols.length} of ${roles.length}`}</b></button>
          {pickOpen ? (
            <span className="ur-pickpop" role="group" aria-label={L("الأدوار", "Roles")}>
              {roles.map((r) => (
                <label key={r.id}><input type="checkbox" checked={picked.includes(r.id)} disabled={picked.includes(r.id) && picked.length <= 2} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, r.id] : p.filter((x) => x !== r.id)))} />{ar ? r.name : r.nameEn}</label>
              ))}
            </span>
          ) : null}
        </span>
        <button type="button" className="ur-chipbtn" aria-pressed={onlyDiff} onClick={() => setOnlyDiff((v) => !v)} data-testid="ur-only-diff">{L("إظهار الفروق فقط", "Differences only")}</button>
        <span className="tl-sp" />
        {hidden.length && !phone ? <span className="ur-count">{L(`مرّر أفقيًا لرؤية ${hidden.slice(0, 2).map((r) => `«${r.name}»`).join(" و")}`, `Add ${hidden.slice(0, 2).map((r) => `“${r.nameEn}”`).join(" and ")} from Roles`)}</span> : null}
      </div>
      <div className="hr-tablewrap ur-cmpwrap">
        <table className="hr-table ur-cmp" aria-label={L("مقارنة الأدوار", "Compare roles")} data-testid="ur-compare-table">
          <thead><tr><th className="ur-pin">{L("الوحدة", "Module")}</th>{cols.map((r) => <th key={r.id}>{ar ? r.name : r.nameEn}</th>)}</tr></thead>
          <tbody>
            {GROUPS.flatMap((g) => {
              const mods = g.modules.filter((m) => !onlyDiff || !same(m));
              if (!mods.length) return [];
              return [
                <tr key={g.key} className="ur-grp"><td className="ur-pin" colSpan={cols.length + 1}>{ar ? g.ar : g.en}</td></tr>,
                ...mods.map((m) => (
                  <tr key={m}>
                    <td className="ur-pin" style={{ fontWeight: 600 }}>{moduleLabel(m, lang)}</td>
                    {cols.map((r) => {
                      const c = cell(r, m);
                      return (
                        <td key={r.id} className={c.level === "none" ? "is-none" : undefined}>
                          <Dot tone={c.level === "edit" ? "success" : c.level === "view" ? "info" : "neutral"}>{lvl(c.level)}</Dot>
                          {c.actions ? <small>{actionsWord(c.actions, lang)}</small> : null}
                        </td>
                      );
                    })}
                  </tr>
                )),
              ];
            })}
          </tbody>
        </table>
      </div>
    </UsersFrame>
  );
}
