"use client";

// UR-05 · الأدوار (Figma 604:3310 at 1440, 611:5459 at 1024, 615:7110 at 390; users.py roles()). The
// read-only system templates («قالب النظام», O-3) and the custom roles («مخصص»): users, sensitive
// count, last change. «مقارنة الأدوار» (UR-07) and «دور جديد» (UR-06 new, administrator only).
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Btn, OpsLoading } from "@/components/ops/ui";
import { Ico } from "@/components/shell/icons";
import { usersWord } from "@/lib/users/model";
import { SectionHead, Tag, UsersFrame, api, errText, fmtDate, useLangL, useUsersChrome } from "../_ui/shared";

type Role = { id: string; system: boolean; name: string; nameEn: string; description: string; members: number; sensitive: number; updatedAt: string | null; updatedByName: string | null };

export default function RolesPage() {
  const { lang, ar, L } = useLangL();
  const router = useRouter();
  const [roles, setRoles] = useState<Role[] | null>(null);
  const [caps, setCaps] = useState<{ manage: boolean } | null>(null);
  const [users, setUsers] = useState<number | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  useUsersChrome({ title: L("الأدوار", "Roles"), phone: { title: L("الأدوار", "Roles"), sub: L("الإعدادات · المستخدمون والصلاحيات", "Settings · Users & permissions") } });
  useEffect(() => {
    void (async () => {
      const [r, u] = await Promise.all([api<{ roles: Role[]; caps: { manage: boolean } }>("/api/roles"), api<{ users: unknown[] }>("/api/users")]);
      if (r.ok) { setRoles(r.data.roles); setCaps(r.data.caps); } else setError(errText(r.data, lang, L("تعذّر تحميل الأدوار.", "Could not load the roles.")));
      if (u.ok) setUsers(u.data.users.length);
    })();
  }, [lang, L]);
  const kind = (r: Role) => <Tag>{r.system ? L("قالب النظام", "System template") : L("مخصص", "Custom")}</Tag>;
  return (
    <UsersFrame testId="ur-roles">
      <SectionHead tab="roles" isAdmin={!!caps?.manage} counts={{ users, roles: roles?.length }}
        meta={<span>{L("الدور قالب صلاحيات؛ لكل مستخدم دور واحد واستثناءات صريحة", "A role is a permission template; each user has one role and explicit exceptions")}</span>}
        actions={<>
          <Link className="hr-btn" href="/dashboard/employees/roles/compare" data-testid="ur-compare">{L("مقارنة الأدوار", "Compare roles")}</Link>
          {caps?.manage ? <Btn variant="primary" onClick={() => router.push("/dashboard/employees/roles/new")} data-testid="ur-new-role"><Ico name="plus" small />{L("دور جديد", "New role")}</Btn> : null}
        </>} />
      {error ? <div className="hr-notice tone-danger" role="alert">{error}</div> : null}
      {!roles && !error ? <OpsLoading rows={6} /> : null}
      {roles ? (
        <>
          <div className="hr-tablewrap ur-hide-phone">
            <table className="hr-table ur-table" aria-label={L("الأدوار", "Roles")} data-testid="ur-roles-table">
              <thead><tr><th>{L("الدور", "Role")}</th><th>{L("النوع", "Type")}</th><th className="ur-hide-rail">{L("الوصف", "Description")}</th><th className="num">{L("المستخدمون", "Users")}</th><th className="num">{L("حساسة", "Sensitive")}</th><th>{L("آخر تغيير", "Last change")}</th><th aria-hidden /></tr></thead>
              <tbody>
                {roles.map((r) => (
                  <tr key={r.id} data-testid={`ur-role-${r.id}`}>
                    <td style={{ fontWeight: 600 }}>{ar ? r.name : r.nameEn}</td>
                    <td>{kind(r)}</td>
                    <td className="ur-hide-rail ur-wrap" style={{ maxWidth: 320, color: "var(--text-secondary)", fontSize: 13 }}>{r.description || "—"}</td>
                    <td className="num">{r.members}</td>
                    <td className="num">{r.sensitive}</td>
                    <td className="ur-wrap">{r.updatedAt ? <>{fmtDate(r.updatedAt, lang)}{r.updatedByName ? <span className="ur-sub2">{r.updatedByName}</span> : null}</> : "—"}</td>
                    <td style={{ textAlign: "end" }}><Link className="hr-btn is-sm" href={`/dashboard/employees/roles/${r.id}`}>{r.system || !caps?.manage ? L("عرض", "View") : L("تعديل", "Edit")}</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="ur-mlist is-plain ur-phone-only">
            {roles.map((r) => (
              <li key={r.id}><Link href={`/dashboard/employees/roles/${r.id}`}><span className="ur-mt">{ar ? r.name : r.nameEn}</span>{kind(r)}<span className="ur-ms">{usersWord(r.members, lang)}</span></Link></li>
            ))}
          </ul>
          <p className="ur-foot ur-hide-phone">{L("قوالب النظام للقراءة فقط؛ انسخ قالبًا لإنشاء دور مخصص. لا يمنح «تعديل» أي إجراء تلقائيًا؛ تُمنح الحساسة واحدة واحدة بسبب وتأكيد بكلمة المرور، ولا ينسخها نسخ القالب.", "System templates are read-only; copy one to make a custom role. “Edit” never turns on an action; sensitive permissions are granted one by one with a reason and the password, and a copy leaves them out.")}</p>
        </>
      ) : null}
    </UsersFrame>
  );
}
