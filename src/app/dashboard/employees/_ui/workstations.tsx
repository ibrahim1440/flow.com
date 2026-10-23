"use client";
// UR-13 · محطات العمل (Figma 601:1344 at 1440, 610:5512 at 1024; users.py ws()) — Workstations W2.
// Per station: may this person sign in there («الوصول»: غير مسموح / مسموح), the supervisor label (a
// label only, owner decision O-5), what they can do there (it comes from the module privileges, not
// from here) and «الآن»: can they sign in now, or why not — no station PIN yet (UR-S18), the module
// privilege is missing (UR-S17), the PIN is locked on a device, the administrator account (D12).
// The administrator saves with the reason and the password; the server checks it again.
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Btn, Dot } from "@/components/ops/ui";
import { ConfirmDialog } from "./dialogs";
import { api, errText, useLangL } from "./shared";

type Row = { stationId: string; name: string; type: string; place: string | null; allowed: boolean; supervisor: boolean; holdsPrivilege: boolean; now: string; lockedOn: string[] };
type Data = { employee: { id: string; name: string; admin: boolean; active: boolean }; pin: { set: boolean; setAt: string | null; locked: boolean; lockedOn: { device: string; at: string }[] }; stations: Row[] };

const ACTIONS: Record<string, { ar: string; en: string; needAr: string; needEn: string; moduleAr: string; moduleEn: string }> = {
  ROASTING: { ar: "بدء التحميص وتسجيل الأوزان", en: "Start roasts and record weights", needAr: "«بدء التحميص ومتابعته»", needEn: "“Start / continue roasting”", moduleAr: "الإنتاج", moduleEn: "production" },
  QUALITY: { ar: "تسجيل النتائج", en: "Record results", needAr: "«تسجيل نتائج الجودة»", needEn: "“Submit QC records”", moduleAr: "الجودة", moduleEn: "quality" },
  PACKAGING: { ar: "التعبئة والتسليم للشحن", en: "Pack and hand to dispatch", needAr: "التعبئة (تعديل)", needEn: "Packaging (edit)", moduleAr: "التعبئة", moduleEn: "packaging" },
};
const ICON: Record<string, string> = {
  ROASTING: "M12 3c2.5 3 3.5 5.5 3.5 7.5A3.5 3.5 0 0 1 12 14a3.5 3.5 0 0 1-3.5-3.5C8.5 8.5 9.5 6 12 3zM6 17h12M8 21h8",
  QUALITY: "M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4a2 2 0 0 0 1.8-3l-5-9V3",
  PACKAGING: "M3 7l9-4 9 4-9 4-9-4zM3 7v10l9 4 9-4V7M12 11v10",
};

export function Workstations({ p, onSaved }: { p: { id: string; name: string; self: boolean; caps: { manageThis: boolean } }; onSaved: () => void }) {
  const { lang, ar, L } = useLangL();
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, { allowed: boolean; supervisor: boolean }>>({});
  const [confirm, setConfirm] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const r = await api<Data>(`/api/users/${p.id}/stations`);
      if (cancelled) return;
      if (r.ok) { setData(r.data); setDraft(Object.fromEntries(r.data.stations.map((s) => [s.stationId, { allowed: s.allowed, supervisor: s.supervisor }]))); setError(null); }
      else setError(errText(r.data, lang, L("تعذّر تحميل المحطات.", "Could not load the stations.")));
    })();
    return () => { cancelled = true; };
  }, [p.id, reload, lang, L]);
  const changed = useMemo(() => !!data && data.stations.some((s) => draft[s.stationId] && (draft[s.stationId].allowed !== s.allowed || draft[s.stationId].supervisor !== s.supervisor)), [data, draft]);
  const editable = p.caps.manageThis && !!data && !data.employee.admin;
  if (error) return <div className="hr-notice tone-danger" role="alert">{error}</div>;
  if (!data) return <div role="status" className="ur-muted">{L("جارٍ التحميل…", "Loading…")}</div>;
  const first = data.employee.name.split(" ")[0];
  const nowCell = (s: Row) => {
    const d = draft[s.stationId] ?? { allowed: s.allowed, supervisor: s.supervisor };
    const a = ACTIONS[s.type];
    if (!s.holdsPrivilege) return <span className="ur-warn-text" data-testid={`ur-ws-now-${s.stationId}`}>{L(`لا يملك صلاحية ${a?.moduleAr ?? ""} المطلوبة`, `Lacks the required ${a?.moduleEn ?? ""} privilege`)}</span>;
    if (!d.allowed) return <span className="ur-muted">—</span>;
    if (data.employee.admin) return <span className="ur-muted">{L("مدير المنشأة لا يدخل من أجهزة المحطات", "The administrator does not sign in at station devices")}</span>;
    if (!data.employee.active) return <Dot tone="neutral">{L("الحساب موقوف", "Account inactive")}</Dot>;
    if (!data.pin.set) return <span className="ur-warn-text" data-testid={`ur-ws-now-${s.stationId}`}>{L("لم يعيّن رمز المحطة بعد", "No station PIN yet")}</span>;
    if (data.pin.locked) return <Dot tone="danger">{L(`رمز المحطة مقفل على ${data.pin.lockedOn.map((x) => x.device).join("، ")}`, `Station PIN locked on ${data.pin.lockedOn.map((x) => x.device).join(", ")}`)}</Dot>;
    return <span data-testid={`ur-ws-now-${s.stationId}`}><Dot tone="success">{L("يستطيع الدخول الآن · رمز المحطة معيّن", "Can sign in now · station PIN set")}</Dot></span>;
  };
  // UR-S17 / UR-S18: what the saved access means today, said once above the table.
  const s17 = data.stations.filter((s) => (draft[s.stationId]?.allowed ?? s.allowed) && !s.holdsPrivilege);
  const s18 = !data.pin.set && data.stations.some((s) => draft[s.stationId]?.allowed ?? s.allowed);
  return (
    <div className="ur-page" data-testid="ur-workstations">
      <p className="ur-lead" style={{ maxWidth: 760 }}>{L("في المحطة يختار الموظف اسمه ثم يُدخل رمز المحطة (PIN). ما يفعله فيها يأتي من صلاحيات الوحدات؛ الوصول هنا يحدد أين يظهر اسمه فقط. «مشرف» وصفٌ يظهر على اسمه ولا يمنح أي صلاحية.", "At a station the employee chooses their name, then enters the station PIN. What they can do there comes from the module privileges; access here only decides where their name appears. “Supervisor” is a label on their name and grants nothing.")}</p>
      {data.employee.admin ? <div className="hr-notice tone-info" data-testid="ur-ws-admin">{L("حساب مدير المنشأة لا يدخل من أجهزة المحطات المشتركة؛ يستخدم المحطة من متصفحه بحسابه.", "The administrator account does not sign in at shared station devices; it uses the station from its own browser.")}</div> : null}
      {s17.map((s) => (
        <div key={s.stationId} className="hr-notice tone-warning" data-testid="ur-s17">
          <strong>{L(`${first} مسموح له بـ«${s.name}» ولا يملك ${ACTIONS[s.type]?.needAr ?? ""}.`, `${first} is allowed at “${s.name}” without ${ACTIONS[s.type]?.needEn ?? ""}.`)}</strong>{" "}
          {L("سيظهر اسمه في المحطة ولن يستطيع البدء. امنح الصلاحية أو أزل الوصول.", "Their name will show at the station but they cannot start. Grant the privilege or remove the access.")}
        </div>
      ))}
      {s18 ? (
        <div className="hr-notice tone-info" data-testid="ur-s18">
          <strong>{L(`لم يعيّن ${data.employee.name} رمز المحطة بعد.`, `${data.employee.name} has not set a station PIN yet.`)}</strong>{" "}
          {L("لا يظهر اسمه في المحطة حتى يعيّن رمزه بنفسه من «ملفي» (بعد التحقق من هويته بكلمة المرور).", "Their name does not appear at the station until they set it themselves in their profile (after confirming with the password).")}
        </div>
      ) : null}
      {data.stations.length === 0 ? (
        <div className="hr-state"><p style={{ margin: 0 }}>{L("لا توجد محطات بعد.", "No stations yet.")}</p><Link className="hr-btn" href="/dashboard/employees/devices">{L("أجهزة المحطات", "Station devices")}</Link></div>
      ) : (
        <div className="hr-tablewrap">
          <table className="hr-table ur-table ur-ws" data-testid="ur-ws-table">
            <thead><tr><th>{L("المحطة", "Station")}</th><th>{L("الوصول", "Access")}</th><th>{L("الإشراف", "Supervision")}</th><th>{L("الإجراءات فيها", "Actions there")}</th><th>{L("الآن", "Now")}</th></tr></thead>
            <tbody>
              {data.stations.map((s) => {
                const d = draft[s.stationId] ?? { allowed: s.allowed, supervisor: s.supervisor };
                const a = ACTIONS[s.type];
                const set = (v: Partial<{ allowed: boolean; supervisor: boolean }>) => setDraft((x) => { const n = { ...d, ...v }; if (!n.allowed) n.supervisor = false; return { ...x, [s.stationId]: n }; });
                return (
                  <tr key={s.stationId} data-testid={`ur-ws-${s.stationId}`}>
                    <td><span className="ur-wsname"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={ICON[s.type] ?? ICON.PACKAGING} /></svg>{s.name}</span>{s.place ? <small className="ur-muted" style={{ display: "block" }}>{s.place}</small> : null}</td>
                    <td>
                      <span className="ur-seg2" role="group" aria-label={L(`الوصول إلى ${s.name}`, `Access to ${s.name}`)}>
                        <button type="button" aria-pressed={!d.allowed} disabled={!editable} onClick={() => set({ allowed: false })} data-testid={`ur-ws-deny-${s.stationId}`}>{L("غير مسموح", "Not allowed")}</button>
                        <button type="button" aria-pressed={d.allowed} disabled={!editable} onClick={() => set({ allowed: true })} data-testid={`ur-ws-allow-${s.stationId}`}>{L("مسموح", "Allowed")}</button>
                      </span>
                    </td>
                    <td><label className="tl-check" style={{ margin: 0 }}><input type="checkbox" checked={d.supervisor} disabled={!editable || !d.allowed} onChange={(e) => set({ supervisor: e.target.checked })} data-testid={`ur-ws-sup-${s.stationId}`} />{L("مشرف", "Supervisor")}</label></td>
                    <td className="ur-acts">{a ? (ar ? `${a.ar} · يتطلب ${a.needAr}` : `${a.en} · needs ${a.needEn}`) : "—"}</td>
                    <td>{nowCell(s)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="ur-pinnote">
        <b>{L("رمز المحطة (PIN) لا يفتح النظام الرئيسي. الرمز السريع يعمل على جهازك الموثوق فقط.", "The station PIN does not open the main system. The quick PIN works on your trusted device only.")}</b>
        <span>{L("رمز المحطة يعيّنه الموظف بنفسه بعد التفعيل والتحقق من الهوية. لا يراه المسؤول ولا يمكن قراءته.", "The employee sets the station PIN themselves after activation and identity check. The administrator never sees it and it cannot be read.")}</span>
      </div>
      {p.caps.manageThis && !p.self ? (
        <div><Btn variant="primary" disabled={!changed || !editable} onClick={() => setConfirm(true)} data-testid="ur-ws-save">{L("حفظ التغييرات", "Save changes")}</Btn></div>
      ) : null}
      <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} needReason={false} title={L(`حفظ محطات ${data.employee.name}؟`, `Save ${data.employee.name}'s stations?`)} sub={L("يسري من الطلب التالي. إزالة الوصول تُنهي جلسته في تلك المحطة فورًا.", "Applies from the next request. Removing access ends their session at that station at once.")} confirmLabel={L("حفظ التغييرات", "Save changes")} testId="ur-ws-confirm"
        run={async (reason) => {
          const r = await api(`/api/users/${p.id}/stations`, { method: "PUT", body: { reason, stations: Object.entries(draft).map(([stationId, v]) => ({ stationId, ...v })) } });
          if (r.ok) { setConfirm(false); setReload((x) => x + 1); onSaved(); }
          return r;
        }} />
    </div>
  );
}
