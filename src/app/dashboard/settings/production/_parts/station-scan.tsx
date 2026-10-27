"use client";
// Settings › Production & roasting › Roasting station (migration 20261116090000_station_lot_scan):
// «تأكيد الكيس بالمسح في محطة التحميص». Off (the default): the station shows no scan — the server picks the lot and the
// station says where to draw from. On: the station offers the scan as an override («كيس غير المقترح»), never a step.
// GET / PUT /api/settings/production/station (admin role, step-up, SettingsAuditLog).
import { useEffect, useState } from "react";
import { useL } from "@/components/ops/ui";
import { localizeApiError } from "@/lib/i18n/api-errors";
import { useI18n } from "@/lib/i18n/context";
import "../../_parts/sections.css";

type S = { lotScanRequired: boolean; can: { edit: boolean } };

export function StationScanSection() {
  const L = useL();
  const { lang } = useI18n();
  const [s, setS] = useState<S | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    fetch("/api/settings/production/station", { cache: "no-store" }).then((r) => (r.ok ? r.json() : Promise.reject())).then(setS).catch(() => setFailed(true));
  }, []);
  async function set(on: boolean) {
    setBusy(true);
    setMsg(null);
    const r = await fetch("/api/settings/production/station", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lotScanRequired: on }) });
    setBusy(false);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { setMsg({ ok: false, text: localizeApiError(j, lang) ?? L("تعذّر الحفظ.", "Could not save.") }); return; }
    setS((x) => (x ? { ...x, lotScanRequired: j.lotScanRequired === true } : x));
    setMsg({ ok: true, text: on ? L("حُفظ. تعرض المحطة المسح لاختيار كيس غير المقترح.", "Saved. The station offers the scan to pick a sack other than the suggested one.") : L("حُفظ. لا تعرض المحطة المسح؛ يختار النظام الكيس.", "Saved. The station shows no scan; the system picks the sack.") });
  }
  return (
    <section data-testid="station-settings">
      <div className="ss-bh">
        <h2>{L("محطة التحميص", "Roasting station")}</h2>
        <span>{L("يختار النظام الكيس الذي يُسحب منه، والمحطة تعرضه فقط", "The system picks the sack drawn from; the station only shows it")}</span>
      </div>
      {failed ? <p className="ss-muted" role="alert">{L("تعذّر تحميل إعداد المحطة.", "Could not load the station setting.")}</p> : !s ? null : (
        <div className="hr-stack" style={{ gap: 8 }}>
          <label style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
            <input type="checkbox" checked={s.lotScanRequired} disabled={!s.can.edit || busy} onChange={(e) => void set(e.target.checked)} data-testid="station-lot-scan" />
            <span>
              <strong>{L("تأكيد الكيس بالمسح في محطة التحميص", "Confirm the sack by scanning at the roasting station")}</strong>
              <span className="ss-muted" style={{ display: "block" }}>
                {L("معطّل (الافتراضي): لا يظهر المسح في المحطة. مفعّل: يظهر المسح لاختيار كيس غير المقترح فقط، ولا يصبح خطوة إلزامية.", "Off (the default): the station shows no scan. On: the scan appears only to choose a sack other than the suggested one — never a required step.")}
              </span>
            </span>
          </label>
          {!s.can.edit ? <p className="ss-muted">{L("يغيّره المدير فقط.", "Only the administrator changes it.")}</p> : null}
          {msg ? <div className={`hr-notice tone-${msg.ok ? "success" : "danger"}`} role={msg.ok ? "status" : "alert"} data-testid="station-lot-scan-msg">{msg.text}</div> : null}
        </div>
      )}
    </section>
  );
}
