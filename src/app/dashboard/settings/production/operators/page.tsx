"use client";
// RM5 «المشغّلون» (Figma 397:2052 at 1440, 398:2217 at 1024). For one roaster: every login that can
// open production, its authorization (production › start_batch, from the roles — read only here)
// and its assignment to the roaster. GET / PUT /api/settings/production/roasters/[id]/operators.
// «مناوبة اليوم» and «دفعات اليوم» are not shown: no shift is recorded per person and a batch does
// not record its operator, so neither can be stated for a person.
import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Dot, OpsLoading, OpsRoot } from "@/components/ops/ui";
import { Select } from "@/components/ui/Select";
import { useD21Phone, useD21Title } from "@/components/shell/page-context";
import { SettingsFrame } from "../../../_components/tools-ui";
import { BASE, call, errText, ReadOnlyNote, Retry, RoastersHead, useLang, useOverview, type ApiError } from "../_parts/shared";

type Op = { id: string; name: string; role: string; roleAr: string; roleEn: string; authorized: boolean; assigned: boolean; active: boolean; isDefault: boolean };
type Ops = { roaster: { id: string; name: string; defaultOperatorId: string | null }; operators: Op[]; can?: { edit: boolean } };

export default function OperatorsPage() {
  const { ar, L } = useLang();
  const router = useRouter();
  const params = useSearchParams();
  const { data, error, reload } = useOverview();
  const roasters = data?.roasters ?? [];
  const chosen = params.get("roaster") ?? roasters.find((r) => r.isDefault && r.type === "PRODUCTION")?.id ?? roasters[0]?.id ?? null;
  const [ops, setOps] = useState<Ops | null>(null);
  const [opsErr, setOpsErr] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useD21Title(L("المشغّلون", "Operators"));
  useD21Phone({ title: L("المشغّلون", "Operators"), sub: L("الإعدادات · الحمّاصات", "Settings · Roasters"), back: BASE });

  const [token, setToken] = useState(0);
  const load = () => setToken((t) => t + 1);
  useEffect(() => {
    if (!chosen) return;
    let off = false;
    call<Ops>(`/api/settings/production/roasters/${chosen}/operators`).then((r) => {
      if (off) return;
      if (r.ok) { setOps(r.data); setOpsErr(null); } else setOpsErr(r.data);
    });
    return () => { off = true; };
  }, [chosen, token]);

  async function toggle(o: Op, assigned: boolean) {
    if (!chosen || busy) return;
    setBusy(o.id);
    setMsg(null);
    const r = await call<Ops>(`/api/settings/production/roasters/${chosen}/operators`, "PUT", { employeeId: o.id, assigned });
    setBusy(null);
    if (r.ok) { setOps((x) => ({ ...r.data, can: x?.can })); return; }
    setMsg({ ok: false, text: errText(r.data, ar) });
  }

  const tag = (o: Op) => o.isDefault ? L("افتراضية", "Default") : o.assigned ? (o.authorized ? L("احتياطي", "Backup") : L("غير نشط", "Inactive")) : o.authorized ? L("غير مُسندة", "Not assigned") : "";
  const canEdit = !!data?.can.edit;

  return (
    <OpsRoot className="tl-root">
      <SettingsFrame>
        <RoastersHead tab="ops" data={data} />
        {error ? <Retry error={error} onRetry={reload} /> : !data ? <OpsLoading rows={5} /> : (
          <div className="ss-stack" data-testid="operators-page">
            <p className="tl-note">
              <strong>{L("التخويل والإسناد أمران منفصلان.", "Authorization and assignment are separate.")}</strong>{" "}
              {L("التخويل يأتي من صلاحية", "Authorization comes from the permission")} <code className="ss-code">production.start_batch</code> {L("في الأدوار ولا يُعدَّل هنا. الإسناد يحدد من يُقترح لكل حمّاصة في الجدولة.", "in the roles and is not changed here. Assignment decides who is proposed for each roaster in scheduling.")}
            </p>
            {roasters.length === 0 ? <p className="ss-muted">{L("لا توجد حمّاصة مسجّلة.", "No roaster is registered.")}</p> : (
              <section>
                <div className="ss-bh">
                  <h2>{L("المشغّلون", "Operators")} · {ops?.roaster.name ?? roasters.find((r) => r.id === chosen)?.name}</h2>
                  <span>{L("من يمكن جدولته على هذه الحمّاصة", "Who can be scheduled on this roaster")}</span>
                  {roasters.length > 1 ? (
                    <span className="ss-bh-end">
                      <Select className="hr-select ss-roaster-pick" aria-label={L("الحمّاصة", "Roaster")} value={chosen ?? ""} onChange={(e) => router.replace(`${BASE}/operators?roaster=${e.target.value}`)}>
                        {roasters.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                      </Select>
                    </span>
                  ) : null}
                </div>
                {msg ? <div className={`hr-notice tone-${msg.ok ? "success" : "danger"}`} role={msg.ok ? "status" : "alert"}>{msg.text}</div> : null}
                {opsErr ? <Retry error={opsErr} onRetry={load} /> : !ops ? <OpsLoading rows={4} /> : ops.operators.length === 0 ? (
                  <p className="ss-muted">{L("لا يوجد مستخدم يملك وحدة الإنتاج.", "No user holds the production module.")}</p>
                ) : (
                  <div className="hr-tablewrap">
                    <table className="hr-table" aria-label={L("المشغّلون", "Operators")}>
                      <thead>
                        <tr>
                          <th>{L("المستخدم", "User")}</th>
                          <th className="hr-hide-compact">{L("الدور", "Role")}</th>
                          <th>{L("التخويل", "Authorization")}</th>
                          <th>{L(`الإسناد إلى ${ops.roaster.name}`, `Assigned to ${ops.roaster.name}`)}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {ops.operators.map((o) => (
                          <tr key={o.id} className={o.authorized ? undefined : "ss-off"} data-testid="operator-row">
                            <td><span className="strong">{o.name}</span></td>
                            <td className="hr-hide-compact">{ar ? o.roleAr : o.roleEn}</td>
                            <td>{o.authorized ? <Dot tone="success">{L("مخوّل", "Authorized")}</Dot> : <Dot tone="neutral">{L("غير مخوّل", "Not authorized")}</Dot>}</td>
                            <td>
                              {o.authorized || o.assigned ? (
                                <label className="tl-check">
                                  <input
                                    type="checkbox" checked={o.assigned} disabled={!canEdit || busy !== null || (o.assigned && o.isDefault) || (!o.assigned && !o.authorized)}
                                    aria-label={L(`إسناد ${o.name}`, `Assign ${o.name}`)} onChange={(e) => void toggle(o, e.target.checked)} data-testid="operator-assign"
                                  />
                                  <span className="ss-muted">{tag(o)}</span>
                                </label>
                              ) : <span className="ss-muted">{L("لا يمكن إسناده", "Cannot be assigned")}</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <p className="tl-foot">{L("لا يُسند مستخدم غير مخوّل. لا يُجدول مشغّل واحد على حمّاصتين في الوقت نفسه.", "A user who is not authorized is not assigned. One operator is not scheduled on two roasters at the same time.")}</p>
              </section>
            )}
            {canEdit ? null : <ReadOnlyNote />}
          </div>
        )}
      </SettingsFrame>
    </OpsRoot>
  );
}
