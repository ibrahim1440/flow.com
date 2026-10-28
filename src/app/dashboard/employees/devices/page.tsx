"use client";

// UR-14 · أجهزة المحطات (Figma 607:4521 at 1440, 613:6626 at 1024; users.py stations()) and UR-14b,
// the one-time activation code (608:4487). Workstations W2: the shared factory devices — active,
// waiting for activation, revoked — «تسجيل جهاز» (with the code the device shows on S1), «رمز جديد»,
// «إلغاء الجهاز». Below the frame's table: the stations themselves («إضافة محطة»: name, type, place,
// the roaster of a roasting station) and the station policy (owner decision D7). The administrator
// only; every change asks for the password (J-4) and the server checks it again.
import { useCallback, useEffect, useState } from "react";
import { Btn, Dot, OpsLoading } from "@/components/ops/ui";
import { Ico } from "@/components/shell/icons";
import { Dialog } from "@/components/hr/ui";
import { Select } from "@/components/ui/Select";
import { NoAccess, PasswordConfirmField, ReasonField, SectionHead, UsersFrame, api, errText, fmtDate, fmtWhen, useLangL, usePasswordConfirm, useUsersChrome, type Lang } from "../_ui/shared";

type Station = { id: string; name: string; type: string; place: string | null; status: string; roasterId: string | null; roasterName: string | null; assigned: number; createdAt: string; createdByName: string | null; locationId?: string | null; locationNameAr?: string | null; locationNameEn?: string | null };
type SiteRow = { id: string; nameAr: string; nameEn: string | null; isProduction: boolean };
type Device = { id: string; name: string; deviceCode: string; status: "PENDING" | "ACTIVE" | "REVOKED"; stationId: string; stationName: string; stationType: string; place: string | null; codeLive: boolean; codeExpiresAt: string | null; activatedAt: string | null; lastSeenAt: string | null; registeredAt: string; registeredByName: string | null; revokedAt: string | null; revokedByName: string | null; revokeReason: string | null; alsoStationIds?: string[] };
type Policy = { idleMinutes: number; pinMaxAttempts: number; activationMinutes: number; stored: { idleMinutes: number | null; pinMaxAttempts: number | null; activationMinutes: number | null } };
type Overview = { stations: Station[]; devices: Device[]; policy: Policy; roasters: { id: string; name: string; status: string }[]; locations?: SiteRow[] };
type Code = { device: { id: string; name: string; stationName: string; deviceCode: string }; activationCode: string; expiresAt: string };

const TYPE: Record<string, { ar: string; en: string }> = { ROASTING: { ar: "التحميص", en: "Roasting" }, QUALITY: { ar: "الجودة", en: "Quality" }, PACKAGING: { ar: "التعبئة والتجهيز", en: "Packaging & fulfilment" } };
const typeWord = (t: string, lang: Lang) => (TYPE[t] ? TYPE[t][lang] : t);

export default function StationDevicesPage() {
  const { lang, L } = useLangL();
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<{ text: string; status: number } | null>(null);
  const [reload, setReload] = useState(0);
  const [counts, setCounts] = useState<{ users?: number; roles?: number }>({});
  const [dlg, setDlg] = useState<null | "station" | "register" | "policy" | { newCode: Device } | { revoke: Device } | { retire: Station } | { serves: Device } | { site: Station }>(null);
  const [code, setCode] = useState<Code | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const refresh = useCallback(() => setReload((x) => x + 1), []);
  useUsersChrome({ title: L("أجهزة المحطات", "Station devices"), phone: { title: L("أجهزة المحطات", "Station devices"), sub: L("الإعدادات · المستخدمون والصلاحيات", "Settings · Users & permissions") } });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const r = await api<Overview>("/api/stations");
      if (cancelled) return;
      if (r.ok) { setData(r.data); setError(null); } else setError({ text: errText(r.data, lang, L("تعذّر تحميل الأجهزة.", "Could not load the devices.")), status: r.status });
    })();
    return () => { cancelled = true; };
  }, [reload, lang, L]);
  useEffect(() => {
    void Promise.all([api<{ users: unknown[] }>("/api/users"), api<{ roles: unknown[] }>("/api/roles")]).then(([u, r]) => setCounts({ users: u.ok ? u.data.users.length : undefined, roles: r.ok ? r.data.roles.length : undefined }));
  }, []);

  if (error?.status === 403) return <UsersFrame testId="ur-devices"><SectionHead tab="devices" isAdmin={false} counts={counts} meta={<span>{L("أجهزة المصنع المشتركة؛ يدخل فيها الموظف باختيار اسمه ثم رمز المحطة", "Shared factory devices; an employee signs in by choosing their name, then the station PIN")}</span>} /><NoAccess /></UsersFrame>;
  const active = data?.stations.filter((s) => s.status === "ACTIVE") ?? [];
  const status = (d: Device) => d.status === "ACTIVE" ? <Dot tone="success">{L("نشط", "Active")}</Dot> : d.status === "PENDING" ? <Dot tone="warning">{L("بانتظار التفعيل", "Waiting for activation")}</Dot> : <Dot tone="neutral">{L("ملغى", "Revoked")}</Dot>;
  return (
    <UsersFrame testId="ur-devices">
      <SectionHead tab="devices" isAdmin counts={{ ...counts, devices: data?.devices.length }}
        meta={<span>{L("أجهزة المصنع المشتركة؛ يدخل فيها الموظف باختيار اسمه ثم رمز المحطة", "Shared factory devices; an employee signs in by choosing their name, then the station PIN")}</span>}
        actions={data ? <>
          <Btn onClick={() => setDlg("station")} data-testid="ur-station-add">{L("إضافة محطة", "Add a station")}</Btn>
          <Btn variant="primary" disabled={!active.length} title={active.length ? undefined : L("أضف محطة أولًا", "Add a station first")} onClick={() => setDlg("register")} data-testid="ur-device-register"><Ico name="plus" small />{L("تسجيل جهاز", "Register a device")}</Btn>
        </> : null} />
      {notice ? <div className="hr-notice tone-success" role="status" data-testid="ur-devices-notice">{notice}</div> : null}
      {error ? <div className="hr-notice tone-danger" role="alert">{error.text}</div> : null}
      {!data && !error ? <OpsLoading rows={6} /> : null}
      {data ? (
        <>
          {data.devices.length === 0 ? (
            <div className="hr-state" data-testid="ur-devices-empty">
              <p style={{ margin: 0 }}><b>{active.length ? L("لا توجد أجهزة مسجّلة بعد.", "No devices registered yet.") : L("لا توجد محطات بعد.", "No stations yet.")}</b></p>
              <p className="ur-lead" style={{ margin: 0 }}>{active.length
                ? L("افتح الجهاز اللوحي على صفحة المحطة ليظهر «رمز هذا الجهاز»، ثم «تسجيل جهاز».", "Open the station page on the tablet to show “This device's code”, then “Register a device”.")
                : L("أضف المحطة أولًا (الاسم والموقع والحمّاصة)، ثم سجّل جهازها.", "Add the station first (name, place, roaster), then register its device.")}</p>
              {active.length ? <Btn variant="primary" onClick={() => setDlg("register")}>{L("تسجيل جهاز", "Register a device")}</Btn> : <Btn variant="primary" onClick={() => setDlg("station")} data-testid="ur-station-add-empty">{L("إضافة محطة", "Add a station")}</Btn>}
            </div>
          ) : (
            <div className="hr-tablewrap">
              <table className="hr-table ur-table" aria-label={L("أجهزة المحطات", "Station devices")} data-testid="ur-devices-table">
                <thead><tr>
                  <th>{L("الجهاز", "Device")}</th><th>{L("المحطة", "Station")}</th><th className="ur-hide-rail">{L("الموقع", "Place")}</th><th>{L("الحالة", "Status")}</th>
                  <th>{L("آخر ظهور", "Last seen")}</th><th className="ur-hide-rail">{L("سُجّل", "Registered")}</th><th aria-label={L("إجراء", "Action")} />
                </tr></thead>
                <tbody>
                  {data.devices.map((d) => (
                    <tr key={d.id} data-testid={`ur-device-${d.id}`} className={d.status === "REVOKED" ? "ur-dim" : undefined}>
                      <td><b style={{ fontWeight: 600, color: d.status === "REVOKED" ? "var(--text-secondary)" : undefined }}>{d.name}</b>{d.name !== d.stationName ? <small className="ur-muted" style={{ display: "block" }}>{d.stationName}</small> : null}
                        {d.alsoStationIds?.length ? <small className="ur-muted" style={{ display: "block" }} data-testid={`ur-device-serves-${d.id}`}>{L("يخدم أيضًا: ", "Also serves: ")}{d.alsoStationIds.map((id) => data.stations.find((x) => x.id === id)?.name ?? "—").join("، ")}</small> : null}</td>
                      <td>{typeWord(d.stationType, lang)}</td>
                      <td className="ur-hide-rail">{d.place ?? "—"}</td>
                      <td>{status(d)}{d.status === "PENDING" && !d.codeLive ? <small className="ur-muted" style={{ display: "block" }}>{L("لا رمز صالح", "No live code")}</small> : null}</td>
                      <td style={{ fontFamily: "var(--f-num)" }}>{d.status === "PENDING" ? "—" : fmtWhen(d.status === "REVOKED" ? d.revokedAt : d.lastSeenAt, lang)}</td>
                      <td className="ur-hide-rail ur-muted">{fmtDate(d.registeredAt, lang)}{d.registeredByName ? ` · ${d.registeredByName}` : ""}</td>
                      <td style={{ textAlign: "end" }}>
                        {d.status !== "REVOKED" ? <Btn size="sm" onClick={() => setDlg({ serves: d })} data-testid={`ur-device-serves-btn-${d.id}`}>{L("المحطات", "Stations")}</Btn> : null}
                        {d.status === "ACTIVE" ? <Btn size="sm" className="ur-danger" onClick={() => setDlg({ revoke: d })} data-testid={`ur-device-revoke-${d.id}`}>{L("إلغاء الجهاز", "Revoke device")}</Btn> : null}
                        {d.status === "PENDING" ? <Btn size="sm" onClick={() => setDlg({ newCode: d })} data-testid={`ur-device-code-${d.id}`}>{L("رمز جديد", "New code")}</Btn> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="ur-foot">{L("رمز التفعيل يُعرض مرة واحدة ويستخدم مرة واحدة. إلغاء الجهاز يُنهي كل جلساته فورًا. الأجهزة الشخصية الموثوقة تظهر في ملف كل مستخدم، لا هنا.", "The activation code is shown once and used once. Revoking a device ends all its sessions at once. Personal trusted devices are in each user's profile, not here.")}</p>

          {data.stations.length ? (
            <section className="ur-stsec" aria-labelledby="ur-stations-h" data-testid="ur-stations">
              <h2 className="ur-h2" id="ur-stations-h">{L("المحطات", "Stations")}</h2>
              <div className="hr-tablewrap">
                <table className="hr-table ur-table" aria-labelledby="ur-stations-h">
                  <thead><tr><th>{L("المحطة", "Station")}</th><th>{L("النوع", "Type")}</th><th>{L("الموقع", "Place")}</th><th>{L("الحمّاصة", "Roaster")}</th><th>{L("موقع المخزون", "Stock location")}</th><th>{L("المكلّفون", "Assigned")}</th><th>{L("الحالة", "Status")}</th><th aria-label={L("إجراء", "Action")} /></tr></thead>
                  <tbody>
                    {data.stations.map((s) => (
                      <tr key={s.id} data-testid={`ur-station-${s.id}`}>
                        <td><b style={{ fontWeight: 600 }}>{s.name}</b></td>
                        <td>{typeWord(s.type, lang)}</td>
                        <td>{s.place ?? "—"}</td>
                        <td>{s.roasterName ?? "—"}</td>
                        <td data-testid={`ur-station-site-${s.id}`}>
                          <span>{s.locationId ? (lang === "en" ? s.locationNameEn || s.locationNameAr : s.locationNameAr) ?? "—" : L("موقع الإنتاج (افتراضي)", "Production site (default)")}</span>
                          {s.status === "ACTIVE" && (data.locations?.length ?? 0) > 1 ? <> <Btn size="sm" onClick={() => setDlg({ site: s })} data-testid={`ur-station-site-edit-${s.id}`}>{L("تغيير", "Change")}</Btn></> : null}
                        </td>
                        <td style={{ fontFamily: "var(--f-num)" }}>{s.assigned}</td>
                        <td>{s.status === "ACTIVE" ? <Dot tone="success">{L("نشطة", "Active")}</Dot> : <Dot tone="neutral">{L("موقوفة", "Retired")}</Dot>}</td>
                        <td style={{ textAlign: "end" }}>{s.status === "ACTIVE" ? <Btn size="sm" onClick={() => setDlg({ retire: s })}>{L("إيقاف المحطة", "Retire")}</Btn> : null}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="ur-foot">{L("من يدخل محطةً يُحدَّد من ملف كل مستخدم › «محطات العمل». يعيّن كل موظف «رمز المحطة» بنفسه من «ملفي».", "Who signs in at a station is set in each user's profile › “Workstations”. Each employee sets their own “Station PIN” in their profile.")}</p>
            </section>
          ) : null}

          <section className="ur-stsec" aria-labelledby="ur-policy-h" data-testid="ur-station-policy">
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <h2 className="ur-h2" id="ur-policy-h" style={{ flex: 1 }}>{L("سياسة المحطات", "Station policy")}</h2>
              <Btn size="sm" onClick={() => setDlg("policy")} data-testid="ur-policy-edit">{L("تعديل", "Edit")}</Btn>
            </div>
            <dl className="ur-props ur-policy">
              <div><dt>{L("قفل الخمول", "Idle lock")}</dt><dd>{L(`${data.policy.idleMinutes} دقائق دون استخدام تُنهي الجلسة وتعود المحطة لاختيار الموظف`, `${data.policy.idleMinutes} minutes without use end the session`)}</dd></div>
              <div><dt>{L("محاولات الرمز", "PIN attempts")}</dt><dd>{L(`${data.policy.pinMaxAttempts} محاولات خاطئة لكل موظف على كل جهاز تُقفل رمزه حتى يعيد المسؤول تفعيله`, `${data.policy.pinMaxAttempts} wrong attempts per employee per device lock the PIN until re-enabled`)}</dd></div>
              <div><dt>{L("رمز التفعيل", "Activation code")}</dt><dd>{L(`يصلح ${data.policy.activationMinutes} دقيقة ولمرة واحدة`, `Valid ${data.policy.activationMinutes} minutes, once`)}</dd></div>
            </dl>
          </section>
        </>
      ) : null}

      {data && dlg === "station" ? <AddStationDialog roasters={data.roasters} onClose={() => setDlg(null)} onDone={(name) => { setDlg(null); setNotice(L(`أُضيفت «${name}». سجّل جهازها الآن.`, `“${name}” added. Register its device now.`)); refresh(); }} /> : null}
      {data && dlg === "register" ? <RegisterDialog stations={active} onClose={() => setDlg(null)} onDone={(c) => { setDlg(null); setCode(c); refresh(); }} /> : null}
      {data && dlg === "policy" ? <PolicyDialog policy={data.policy} onClose={() => setDlg(null)} onDone={() => { setDlg(null); refresh(); }} /> : null}
      {dlg && typeof dlg === "object" && "newCode" in dlg ? <NewCodeDialog device={dlg.newCode} onClose={() => setDlg(null)} onDone={(c) => { setDlg(null); setCode(c); refresh(); }} /> : null}
      {dlg && typeof dlg === "object" && "serves" in dlg ? <ServesDialog device={dlg.serves} stations={data?.stations.filter((x) => x.status === "ACTIVE" && x.id !== dlg.serves.stationId) ?? []} onClose={() => setDlg(null)} onDone={() => { setDlg(null); setNotice(L("حُفظت محطات الجهاز.", "The device's stations were saved.")); refresh(); }} /> : null}
      {dlg && typeof dlg === "object" && "revoke" in dlg ? <RevokeDialog device={dlg.revoke} onClose={() => setDlg(null)} onDone={(n) => { setDlg(null); setNotice(L(`أُلغي الجهاز وأُنهيت ${n} جلسة.`, `Device revoked; ${n} session(s) ended.`)); refresh(); }} /> : null}
      {dlg && typeof dlg === "object" && "retire" in dlg ? <RetireDialog station={dlg.retire} onClose={() => setDlg(null)} onDone={() => { setDlg(null); refresh(); }} /> : null}
      {dlg && typeof dlg === "object" && "site" in dlg ? <SiteDialog station={dlg.site} sites={data?.locations ?? []} onClose={() => setDlg(null)} onDone={() => { setDlg(null); refresh(); }} /> : null}
      {code ? <CodeDialog code={code} onClose={() => { setCode(null); refresh(); }} /> : null}
    </UsersFrame>
  );
}

// ── «إضافة محطة» ──────────────────────────────────────────────────────────────────────────────
function AddStationDialog({ roasters, onClose, onDone }: { roasters: Overview["roasters"]; onClose: () => void; onDone: (name: string) => void }) {
  const { lang, L } = useLangL();
  const [name, setName] = useState("");
  const [type, setType] = useState("ROASTING");
  const [place, setPlace] = useState("");
  const [roasterId, setRoasterId] = useState(roasters.length === 1 ? roasters[0].id : "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const pc = usePasswordConfirm();
  const ok = name.trim().length > 0 && (type !== "ROASTING" || !!roasterId);
  async function go() {
    setBusy(true); setErr(null);
    if (!(await pc.confirm())) { setBusy(false); return; }
    const r = await api("/api/stations", { method: "POST", body: { name, type, place, roasterId: type === "ROASTING" ? roasterId : null } });
    setBusy(false);
    if (!r.ok) { setErr(errText(r.data, lang, L("تعذّر الحفظ.", "Could not save."))); return; }
    onDone(name.trim());
  }
  return (
    <Dialog open onClose={onClose} title={L("إضافة محطة", "Add a station")} sub={L("المحطة مكان عمل واحد بجهازه المشترك. الجهاز وحده لا يمنح أي بيانات.", "A station is one place of work with its shared device. The device alone grants no data.")} className="ur-dlg" testId="ur-station-dialog"
      actions={<><Btn onClick={onClose}>{L("رجوع", "Back")}</Btn><Btn variant="primary" busy={busy} disabled={!ok} onClick={go} data-testid="ur-station-save">{L("إضافة المحطة", "Add the station")}</Btn></>}>
      <label className="hr-field"><span className="hr-label">{L("اسم المحطة", "Station name")}<span className="ur-req"> *</span></span><input className="hr-input" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder={L("محطة التحميص 1", "Roasting station 1")} data-testid="ur-station-name" /></label>
      <label className="hr-field"><span className="hr-label">{L("النوع", "Type")}</span>
        <Select value={type} onChange={(e) => setType(e.target.value)} data-testid="ur-station-type">
          {Object.keys(TYPE).map((k) => <option key={k} value={k}>{typeWord(k, lang)}</option>)}
        </Select>
        {type === "QUALITY" ? <span className="hr-help">{L("محطة الجودة: الفحص بالقياس وطلب الاستثناء، لمن يملك «تسجيل نتائج الجودة». جهاز التحميص نفسه يمكن أن يخدمها (زر «المحطات» في الجهاز).", "The QC station: measured inspection and the exception request, for holders of “Submit QC records”. The roasting device itself can serve it (the device's «Stations» button).")}</span> : type === "PACKAGING" ? <span className="hr-help">{L("تبويبا «التعبئة» و«تجهيز الطلبات»: يعمل فيهما من يملك صلاحية التعبئة أو التسليم والشحن.", "«Packaging» and «Order preparation»: for whoever holds the packaging or the dispatch privilege.")}</span> : null}
      </label>
      <label className="hr-field"><span className="hr-label">{L("الموقع", "Place")}</span><input className="hr-input" value={place} onChange={(e) => setPlace(e.target.value)} maxLength={80} placeholder={L("صالة التحميص", "Roasting hall")} data-testid="ur-station-place" /></label>
      {type === "ROASTING" ? (
        <label className="hr-field"><span className="hr-label">{L("الحمّاصة", "Roaster")}<span className="ur-req"> *</span></span>
          <Select value={roasterId} onChange={(e) => setRoasterId(e.target.value)} data-testid="ur-station-roaster">
            <option value="">{roasters.length ? L("اختر…", "Choose…") : L("لا حمّاصة إنتاج مسجّلة", "No production roaster registered")}</option>
            {roasters.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </Select>
          <span className="hr-help">{L("الجهاز يعمل على هذه الحمّاصة وحدها.", "The device works on this roaster only.")}</span>
        </label>
      ) : null}
      <PasswordConfirmField pc={pc} hint={L("مطلوبة لإضافة محطة. لا يُقبل الرمز السريع ولا البيانات الحيوية.", "Required to add a station. Quick PIN and biometrics are not accepted.")} />
      {err ? <div className="hr-notice tone-danger" role="alert">{err}</div> : null}
    </Dialog>
  );
}

// ── «تسجيل جهاز» ───────────────────────────────────────────────────────────────────────────────
function RegisterDialog({ stations, onClose, onDone }: { stations: Station[]; onClose: () => void; onDone: (c: Code) => void }) {
  const { lang, L } = useLangL();
  const [stationId, setStationId] = useState(stations.length === 1 ? stations[0].id : "");
  const [name, setName] = useState("");
  const [deviceCode, setDeviceCode] = useState("WS-");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const pc = usePasswordConfirm();
  const station = stations.find((s) => s.id === stationId);
  const codeOk = /^WS-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/.test(deviceCode);
  async function go() {
    setBusy(true); setErr(null);
    if (!(await pc.confirm())) { setBusy(false); return; }
    const r = await api<Code>(`/api/stations/${stationId}/devices`, { method: "POST", body: { deviceCode, name: name.trim() || station?.name } });
    setBusy(false);
    if (!r.ok) { setErr(errText(r.data, lang, L("تعذّر التسجيل.", "Could not register."))); return; }
    onDone(r.data);
  }
  return (
    <Dialog open onClose={onClose} title={L("تسجيل جهاز", "Register a device")} sub={L("افتح صفحة المحطة على الجهاز اللوحي، وانسخ «رمز هذا الجهاز» الظاهر عليه. يُصدر بعدها رمز تفعيل لمرة واحدة.", "Open the station page on the tablet and copy “This device's code” shown on it. A one-time activation code is then issued.")} className="ur-dlg" testId="ur-register-dialog"
      actions={<><Btn onClick={onClose}>{L("رجوع", "Back")}</Btn><Btn variant="primary" busy={busy} disabled={!station || !codeOk} onClick={go} data-testid="ur-register-go">{L("تسجيل وإصدار الرمز", "Register and issue the code")}</Btn></>}>
      <label className="hr-field"><span className="hr-label">{L("المحطة", "Station")}<span className="ur-req"> *</span></span>
        <Select value={stationId} onChange={(e) => setStationId(e.target.value)} data-testid="ur-register-station">
          <option value="">{L("اختر…", "Choose…")}</option>
          {stations.map((s) => <option key={s.id} value={s.id}>{s.name}{s.place ? ` · ${s.place}` : ""}</option>)}
        </Select>
      </label>
      <label className="hr-field"><span className="hr-label">{L("رمز هذا الجهاز", "This device's code")}<span className="ur-req"> *</span></span>
        <input className="hr-input" dir="ltr" value={deviceCode} onChange={(e) => { const v = e.target.value.toUpperCase().replace(/[^0-9A-Z-]/g, ""); setDeviceCode(v.startsWith("WS-") ? v.slice(0, 7) : `WS-${v.replace(/^W?S?-?/, "")}`.slice(0, 7)); }} style={{ fontFamily: "var(--f-mono)", letterSpacing: ".08em" }} maxLength={7} data-testid="ur-register-code" />
        <span className="hr-help">{L("يظهر على شاشة الجهاز «هذا الجهاز غير مسجّل كمحطة»، مثل WS-7F3K.", "Shown on the device's “not registered” screen, like WS-7F3K.")}</span>
      </label>
      <label className="hr-field"><span className="hr-label">{L("اسم الجهاز", "Device name")}</span><input className="hr-input" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder={station?.name ?? ""} data-testid="ur-register-name" /></label>
      <PasswordConfirmField pc={pc} hint={L("مطلوبة لتسجيل جهاز. لا يُقبل الرمز السريع ولا البيانات الحيوية.", "Required to register a device. Quick PIN and biometrics are not accepted.")} />
      {err ? <div className="hr-notice tone-danger" role="alert">{err}</div> : null}
    </Dialog>
  );
}

// ── UR-14b · the one-time activation code ──────────────────────────────────────────────────────
function CodeDialog({ code, onClose }: { code: Code; onClose: () => void }) {
  const { lang, L } = useLangL();
  const [now, setNow] = useState(() => Date.now());
  const [cancelled, setCancelled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);
  const left = Math.max(0, Math.floor((new Date(code.expiresAt).getTime() - now) / 1000));
  const mmss = `${String(Math.floor(left / 60)).padStart(2, "0")}:${String(left % 60).padStart(2, "0")}`;
  async function cancel() {
    setBusy(true); setErr(null);
    const r = await api(`/api/station-devices/${code.device.id}/code`, { method: "DELETE" });
    setBusy(false);
    if (!r.ok) { setErr(errText(r.data, lang, L("تعذّر إلغاء الرمز.", "Could not cancel the code."))); return; }
    setCancelled(true);
  }
  return (
    <Dialog open onClose={onClose} title={L(`رمز تفعيل «${code.device.name}»`, `Activation code for “${code.device.name}”`)} sub={L("أدخل الرمز في صفحة المحطة على الجهاز اللوحي. يُعرض الآن فقط، ويصلح لمرة واحدة.", "Enter the code on the tablet's station page. It is shown now only and works once.")} className="ur-dlg ur-code-dlg" testId="ur-code-dialog"
      actions={<><Btn onClick={cancel} busy={busy} disabled={cancelled || left === 0} data-testid="ur-code-cancel">{L("إلغاء الرمز", "Cancel the code")}</Btn><Btn variant="primary" onClick={onClose} data-testid="ur-code-close">{L("إغلاق", "Close")}</Btn></>}>
      <div className="ur-codebox" dir="ltr" aria-label={L("رمز التفعيل", "Activation code")} data-testid="ur-activation-code" data-code={cancelled ? "" : code.activationCode}>
        {code.activationCode.split("").map((c, i) => <span key={i} className={cancelled ? "is-off" : undefined}>{c}</span>)}
      </div>
      <p className="ur-codemeta" data-testid="ur-code-expiry">{cancelled ? L("أُلغي الرمز. لم يعد صالحًا.", "The code was cancelled.") : left === 0 ? L("انتهت صلاحية الرمز. اطلب «رمز جديد».", "The code expired. Ask for a “New code”.") : <>{L("ينتهي خلال", "Expires in")} <span dir="ltr" style={{ fontFamily: "var(--f-num)" }}>{mmss}</span> · {L("للجهاز", "for device")} <bdi dir="ltr" style={{ fontFamily: "var(--f-mono)" }}>{code.device.deviceCode}</bdi></>}</p>
      <div className="ur-codenote">
        <b>{L("بعد التفعيل يصبح الجهاز «نشطًا».", "After activation the device becomes “Active”.")}</b>
        <span>{L("لا يُقبل رمز المحطة إلا على جهاز مسجّل ونشط.", "A station PIN is accepted only on a registered, active device.")}</span>
      </div>
      {err ? <div className="hr-notice tone-danger" role="alert">{err}</div> : null}
    </Dialog>
  );
}

function NewCodeDialog({ device, onClose, onDone }: { device: Device; onClose: () => void; onDone: (c: Code) => void }) {
  const { lang, L } = useLangL();
  const [deviceCode, setDeviceCode] = useState(device.deviceCode);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const pc = usePasswordConfirm();
  async function go() {
    setBusy(true); setErr(null);
    if (!(await pc.confirm())) { setBusy(false); return; }
    const r = await api<Code>(`/api/station-devices/${device.id}/code`, { method: "POST", body: { deviceCode } });
    setBusy(false);
    if (!r.ok) { setErr(errText(r.data, lang, L("تعذّر إصدار الرمز.", "Could not issue the code."))); return; }
    onDone(r.data);
  }
  return (
    <Dialog open onClose={onClose} title={L(`رمز جديد لـ«${device.name}»`, `New code for “${device.name}”`)} sub={L("يتوقف الرمز السابق عن العمل. تأكد أن «رمز هذا الجهاز» لم يتغير على الجهاز.", "The earlier code stops working. Check that the device still shows the same code.")} className="ur-dlg" testId="ur-newcode-dialog"
      actions={<><Btn onClick={onClose}>{L("رجوع", "Back")}</Btn><Btn variant="primary" busy={busy} onClick={go} data-testid="ur-newcode-go">{L("إصدار رمز", "Issue a code")}</Btn></>}>
      <label className="hr-field"><span className="hr-label">{L("رمز هذا الجهاز", "This device's code")}</span><input className="hr-input" dir="ltr" value={deviceCode} onChange={(e) => setDeviceCode(e.target.value.toUpperCase().slice(0, 7))} style={{ fontFamily: "var(--f-mono)", letterSpacing: ".08em" }} data-testid="ur-newcode-code" /></label>
      <PasswordConfirmField pc={pc} />
      {err ? <div className="hr-notice tone-danger" role="alert">{err}</div> : null}
    </Dialog>
  );
}

function RevokeDialog({ device, onClose, onDone }: { device: Device; onClose: () => void; onDone: (sessions: number) => void }) {
  const { lang, L } = useLangL();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const pc = usePasswordConfirm();
  async function go() {
    setBusy(true); setErr(null);
    if (!(await pc.confirm())) { setBusy(false); return; }
    const r = await api<{ sessionsEnded: number }>(`/api/station-devices/${device.id}/revoke`, { method: "POST", body: { reason } });
    setBusy(false);
    if (!r.ok) { setErr(errText(r.data, lang, L("تعذّر الإلغاء.", "Could not revoke."))); return; }
    onDone(r.data.sessionsEnded);
  }
  return (
    <Dialog open onClose={onClose} title={L(`إلغاء «${device.name}»؟`, `Revoke “${device.name}”?`)} sub={L("تنتهي كل جلساته فورًا، ولا يدخل عليه أحد حتى يُسجَّل من جديد. لا يتحرك أي مخزون ولا تُحرَّر أي مهمة.", "All its sessions end at once; nobody signs in on it until it is registered again. No stock moves and no task is released.")} className="ur-dlg" testId="ur-revoke-device-dialog"
      actions={<><Btn onClick={onClose}>{L("رجوع", "Back")}</Btn><Btn variant="danger" busy={busy} disabled={reason.trim().length < 3} onClick={go} data-testid="ur-revoke-device-go">{L("إلغاء الجهاز", "Revoke device")}</Btn></>}>
      <ReasonField value={reason} onChange={setReason} required testId="ur-revoke-device-reason" options={[L("الجهاز مفقود", "The device is lost"), L("استُبدل الجهاز", "The device was replaced"), L("لم يعد مستخدمًا", "No longer used")]} />
      <PasswordConfirmField pc={pc} />
      {err ? <div className="hr-notice tone-danger" role="alert">{err}</div> : null}
    </Dialog>
  );
}

/**
 * W3 «يخدم أيضًا»: the same iPad at the roaster and in QC. The device asks which station before the
 * employee; the session is bound to the choice and the bar always names the station and the user.
 */
function ServesDialog({ device, stations, onClose, onDone }: { device: Device; stations: Station[]; onClose: () => void; onDone: () => void }) {
  const { lang, L } = useLangL();
  const [ids, setIds] = useState<string[]>(device.alsoStationIds ?? []);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const pc = usePasswordConfirm();
  async function go() {
    setBusy(true); setErr(null);
    if (!(await pc.confirm())) { setBusy(false); return; }
    const r = await api<{ stationIds: string[] }>(`/api/station-devices/${device.id}/stations`, { method: "PUT", body: { stationIds: ids } });
    setBusy(false);
    if (!r.ok) { setErr(errText(r.data, lang, L("تعذّر الحفظ.", "Could not save."))); return; }
    onDone();
  }
  return (
    <Dialog open onClose={onClose} title={L(`محطات «${device.name}»`, `Stations of “${device.name}”`)} sub={L(`محطته: ${device.stationName}. اختر المحطات الأخرى التي يخدمها الجهاز نفسه؛ يختار الموظف المحطة قبل اسمه، ويظهر في الشريط «المحطة · المستخدم».`, `Its station: ${device.stationName}. Choose the other stations the same device serves; the station is chosen before the employee.`)} className="ur-dlg" testId="ur-serves-dialog"
      actions={<><Btn onClick={onClose}>{L("رجوع", "Back")}</Btn><Btn variant="primary" busy={busy} onClick={go} data-testid="ur-serves-go">{L("حفظ", "Save")}</Btn></>}>
      <div style={{ display: "grid", gap: 8 }}>
        {stations.length === 0 ? <p className="ur-muted">{L("لا محطات أخرى نشطة.", "No other active station.")}</p> : stations.map((s) => (
          <label key={s.id} style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input type="checkbox" checked={ids.includes(s.id)} onChange={(e) => setIds(e.target.checked ? [...ids, s.id] : ids.filter((x) => x !== s.id))} data-testid={`ur-serves-${s.type}`} />
            {s.name} · {typeWord(s.type, lang)}
          </label>
        ))}
      </div>
      <PasswordConfirmField pc={pc} />
      {err ? <div className="hr-notice tone-danger" role="alert">{err}</div> : null}
    </Dialog>
  );
}

/**
 * «موقع المحطة» (20261117090000, owner decision 5): where this station draws stock from and books into — roasting draws
 * green there, packing draws materials and makes the finished lots there. Empty = the production site. Audited
 * (STATION_UPDATED, before / after); the password is asked again.
 */
function SiteDialog({ station, sites, onClose, onDone }: { station: Station; sites: SiteRow[]; onClose: () => void; onDone: () => void }) {
  const { lang, L } = useLangL();
  const [site, setSite] = useState(station.locationId ?? "");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const pc = usePasswordConfirm();
  async function go() {
    setBusy(true); setErr(null);
    if (!(await pc.confirm())) { setBusy(false); return; }
    const r = await api(`/api/stations/${station.id}`, { method: "PATCH", body: { locationId: site || null, ...(reason.trim() ? { reason } : {}) } });
    setBusy(false);
    if (!r.ok) { setErr(errText(r.data, lang, L("تعذّر الحفظ.", "Could not save."))); return; }
    onDone();
  }
  const name = (l: SiteRow) => (lang === "en" ? l.nameEn || l.nameAr : l.nameAr);
  return (
    <Dialog open onClose={onClose} title={L(`موقع «${station.name}»`, `Location of “${station.name}”`)} sub={L("تسحب المحطة البن والمواد من هذا الموقع وتسجّل فيه ما تنتجه. بلا موقع: موقع الإنتاج.", "The station draws coffee and materials from this location and books what it makes there. None: the production site.")} className="ur-dlg" testId="ur-site-dialog"
      actions={<><Btn onClick={onClose}>{L("رجوع", "Back")}</Btn><Btn variant="primary" busy={busy} disabled={(station.locationId ?? "") === site} onClick={go} data-testid="ur-site-save">{L("حفظ الموقع", "Save the location")}</Btn></>}>
      <label className="hr-field"><span className="hr-label">{L("موقع المخزون", "Stock location")}</span>
        <Select value={site} onChange={(e) => setSite(e.target.value)} data-testid="ur-site-select">
          <option value="">{L("موقع الإنتاج (افتراضي)", "Production site (default)")}</option>
          {sites.map((l) => <option key={l.id} value={l.id}>{name(l)}{l.isProduction ? L(" · موقع الإنتاج", " · production site") : ""}</option>)}
        </Select>
      </label>
      <ReasonField value={reason} onChange={setReason} />
      <PasswordConfirmField pc={pc} />
      {err ? <div className="hr-notice tone-danger" role="alert">{err}</div> : null}
    </Dialog>
  );
}

function RetireDialog({ station, onClose, onDone }: { station: Station; onClose: () => void; onDone: () => void }) {
  const { lang, L } = useLangL();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const pc = usePasswordConfirm();
  async function go() {
    setBusy(true); setErr(null);
    if (!(await pc.confirm())) { setBusy(false); return; }
    const r = await api(`/api/stations/${station.id}`, { method: "PATCH", body: { status: "RETIRED", reason } });
    setBusy(false);
    if (!r.ok) { setErr(errText(r.data, lang, L("تعذّر الإيقاف.", "Could not retire."))); return; }
    onDone();
  }
  return (
    <Dialog open onClose={onClose} title={L(`إيقاف «${station.name}»؟`, `Retire “${station.name}”?`)} sub={L("لا يدخل أحد على أجهزتها وتنتهي جلساتها فورًا. يبقى سجلها.", "Nobody signs in on its devices and its sessions end at once. Its history stays.")} className="ur-dlg" testId="ur-retire-dialog"
      actions={<><Btn onClick={onClose}>{L("رجوع", "Back")}</Btn><Btn variant="danger" busy={busy} disabled={reason.trim().length < 3} onClick={go}>{L("إيقاف المحطة", "Retire the station")}</Btn></>}>
      <ReasonField value={reason} onChange={setReason} required />
      <PasswordConfirmField pc={pc} />
      {err ? <div className="hr-notice tone-danger" role="alert">{err}</div> : null}
    </Dialog>
  );
}

function PolicyDialog({ policy, onClose, onDone }: { policy: Policy; onClose: () => void; onDone: () => void }) {
  const { lang, L } = useLangL();
  const [idle, setIdle] = useState(String(policy.idleMinutes));
  const [attempts, setAttempts] = useState(String(policy.pinMaxAttempts));
  const [act, setAct] = useState(String(policy.activationMinutes));
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const pc = usePasswordConfirm();
  async function go() {
    setBusy(true); setErr(null);
    if (!(await pc.confirm())) { setBusy(false); return; }
    const r = await api("/api/stations/policy", { method: "PUT", body: { idleMinutes: Number(idle), pinMaxAttempts: Number(attempts), activationMinutes: Number(act), reason } });
    setBusy(false);
    if (!r.ok) { setErr(errText(r.data, lang, L("تعذّر الحفظ.", "Could not save."))); return; }
    onDone();
  }
  const num = (label: string, v: string, set: (v: string) => void, hint: string, testId: string) => (
    <label className="hr-field"><span className="hr-label">{label}</span><input className="hr-input" inputMode="numeric" dir="ltr" value={v} onChange={(e) => set(e.target.value.replace(/\D/g, "").slice(0, 2))} style={{ maxWidth: 120, fontFamily: "var(--f-num)" }} data-testid={testId} /><span className="hr-help">{hint}</span></label>
  );
  return (
    <Dialog open onClose={onClose} title={L("سياسة المحطات", "Station policy")} sub={L("القيم المعتمدة: الخمول 5 دقائق، 5 محاولات، رمز التفعيل 15 دقيقة.", "Approved values: idle 5 min, 5 attempts, activation code 15 min.")} className="ur-dlg" testId="ur-policy-dialog"
      actions={<><Btn onClick={onClose}>{L("رجوع", "Back")}</Btn><Btn variant="primary" busy={busy} onClick={go} data-testid="ur-policy-save">{L("حفظ", "Save")}</Btn></>}>
      {num(L("قفل الخمول (دقائق)", "Idle lock (minutes)"), idle, setIdle, L("من 1 إلى 60", "1 to 60"), "ur-policy-idle")}
      {num(L("محاولات رمز المحطة", "Station PIN attempts"), attempts, setAttempts, L("من 3 إلى 10", "3 to 10"), "ur-policy-attempts")}
      {num(L("صلاحية رمز التفعيل (دقائق)", "Activation code (minutes)"), act, setAct, L("من 1 إلى 15", "1 to 15"), "ur-policy-activation")}
      <ReasonField value={reason} onChange={setReason} />
      <PasswordConfirmField pc={pc} />
      {err ? <div className="hr-notice tone-danger" role="alert">{err}</div> : null}
    </Dialog>
  );
}
