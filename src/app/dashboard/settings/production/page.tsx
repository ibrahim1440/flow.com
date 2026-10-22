"use client";
// Settings › Production & roasting › Roasters — RM1 «المحامص» (Figma 387:182 at 1440, 388:435 at
// 1024, phone 378:2). The production roasters and their limits, the sample roasters (or the empty
// state), three metrics and the capacity footnote. GET /api/settings/production.
import Link from "next/link";
import { Metrics, OpsLoading, OpsRoot } from "@/components/ops/ui";
import { useD21Phone, useD21Title, usePhone } from "@/components/shell/page-context";
import { SettingsFrame } from "../../_components/tools-ui";
import { QcMinSection } from "./_parts/qc-min";
import { OrderRecomputeSection } from "./_parts/order-recompute";
import {
  BASE, CapacityNote, N, Plus, ReadOnlyNote, Retry, RoastersHead, StatusText, TYPE, dayLabel, useLang, useOverview, windowText,
  type Roaster,
} from "./_parts/shared";

export default function RoastersPage() {
  const { ar, L } = useLang();
  const phone = usePhone();
  const { data, error, reload } = useOverview();
  useD21Title(L("المحامص", "Roasters"));
  useD21Phone({
    title: L("المحامص", "Roasters"), sub: L("الإعدادات · الإنتاج والتحميص", "Settings · Production & roasting"),
    back: "/dashboard/settings",
    ...(data?.can.edit ? { action: { href: `${BASE}/roasters/new`, label: L("إضافة حمّاصة", "Add roaster"), icon: "plus" as const } } : {}),
  });

  const production = data?.roasters.filter((r) => r.type === "PRODUCTION") ?? [];
  const samples = data?.roasters.filter((r) => r.type === "SAMPLE") ?? [];
  const available = production.filter((r) => r.status === "AVAILABLE");
  const biggest = available.reduce<Roaster | null>((b, r) => (!b || Number(r.maxBatchKg) > Number(b.maxBatchKg) ? r : b), null);
  const def = production.find((r) => r.isDefault) ?? production[0] ?? null;
  const next = data?.nextMaintenance ?? null;
  const nextRoaster = next ? data?.roasters.find((r) => r.id === next.roasterId) : null;

  const unit = (u: string) => <span className="ss-unit">{u}</span>;
  const table = (rows: Roaster[], label: string) => (
    <div className="hr-tablewrap">
      <table className="hr-table ss-rtable" aria-label={label}>
        <thead>
          <tr>
            <th>{L("المحمصة", "Roaster")}</th>
            <th>{L("النوع", "Type")}</th>
            <th className="num ss-thwrap">{L("سعة المحمصة", "Roaster capacity")}</th>
            <th className="num ss-thwrap">{L("كمية التحميص الافتراضية", "Default roast quantity")}</th>
            <th className="num hr-hide-compact ss-thwrap">{L("أقل – أعلى كمية مسموحة للتحميص", "Min – max roast quantity")}</th>
            <th className="num hr-hide-compact">{L("الدورة", "Cycle")}</th>
            <th className="hr-hide-compact">{L("المشغّل الافتراضي", "Default operator")}</th>
            <th>{L("الحالة", "Status")}</th>
            <th aria-label={L("الافتراضية", "Default")} />
            <th aria-label={L("إجراء", "Action")} />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} data-testid="roaster-row">
              <td>
                <span className="strong">{r.name}</span>
                <span className="ss-sub">{r.manufacturerModel ?? L("الشركة المصنّعة والطراز: غير مُدخلين", "Manufacturer and model: not entered")}</span>
              </td>
              <td>{ar ? TYPE[r.type][0] : TYPE[r.type][1]}</td>
              <td className="num"><N>{r.nominalCapacityKg}</N></td>
              <td className="num"><N>{r.defaultTargetKg}</N></td>
              <td className="num hr-hide-compact"><N>{r.minBatchKg}</N> – <N>{r.maxBatchKg}</N></td>
              <td className="num hr-hide-compact"><N>{r.cycleMinutes}</N> {L("د", "min")}</td>
              <td className="hr-hide-compact">{r.defaultOperatorName ?? "—"}</td>
              <td><StatusText status={r.status} ar={ar} /></td>
              <td className="ss-muted">{r.isDefault ? L("افتراضية", "Default") : ""}</td>
              <td style={{ textAlign: "end" }}>
                {data?.can.edit ? <Link href={`${BASE}/roasters/${r.id}`} className="hr-btn is-sm" data-testid="roaster-edit">{L("تعديل", "Edit")}</Link> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  // Phone (378:2): one row per roaster, «6.00 كغ · كمية التحميص الافتراضية 5.00 · نورة السبيعي», status and «افتراضية».
  const list = (rows: Roaster[]) => (
    <ul className="ss-mlist">
      {rows.map((r) => (
        <li key={r.id}>
          <Link href={`${BASE}/roasters/${r.id}`} data-testid="roaster-row">
            <span className="ss-mrow">
              <strong>{r.name}</strong>
              <StatusText status={r.status} ar={ar} />
            </span>
            <span className="ss-mrow ss-muted">
              <span><N>{r.nominalCapacityKg}</N> {L("كغ", "kg")} · {L("كمية التحميص الافتراضية", "default roast quantity")} <N>{r.defaultTargetKg}</N>{r.defaultOperatorName ? ` · ${r.defaultOperatorName}` : ""}</span>
              {r.isDefault ? <span>{L("افتراضية", "Default")}</span> : null}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );

  const empty = (
    <div className="ss-empty" data-testid="sample-empty">
      <strong>{L("لا توجد محمصة عينات مسجّلة", "No sample roaster registered")}</strong>
      <p>{phone
        ? L("أضف محمصة عينات لتظهر في الجدولة.", "Add a sample roaster to see it in scheduling.")
        : L("جلسات التذوق تعمل دون محمصة عينات. أضف محمصة عينات لتظهر في الجدولة ويُسنَد إليها مشغّل.", "Cupping sessions work without a sample roaster. Add a sample roaster to see it in scheduling and assign it an operator.")}</p>
      {data?.can.edit ? <Link href={`${BASE}/roasters/new?type=SAMPLE`} className="hr-btn" data-testid="sample-add"><Plus />{L("إضافة حمّاصة", "Add roaster")}</Link> : null}
    </div>
  );

  return (
    <OpsRoot className="tl-root">
      <SettingsFrame>
        <RoastersHead tab="list" data={data} add />
        {error ? <Retry error={error} onRetry={reload} /> : !data ? <OpsLoading rows={5} /> : (
          <div className="ss-stack" data-testid="roasters-page">
            {phone ? null : (
              <Metrics
                className="ss-metrics"
                items={[
                  [L("محامص الإنتاج", "Production roasters"), <N key="n">{production.length}</N>,
                    available.length ? `${L("متاحة الآن", "Available now")} · ${available.map((r) => r.name).join("، ")}` : L("لا محمصة متاحة الآن", "None available now")],
                  [L("أعلى كمية مسموحة للتحميص", "Maximum roast quantity"), biggest ? <><N>{biggest.maxBatchKg}</N>{unit(L("كغ أخضر", "kg green"))}</> : "—",
                    def ? <>{L("كمية التحميص الافتراضية", "Default roast quantity")} <N>{def.defaultTargetKg}</N> {L("كغ", "kg")}</> : null],
                  [L("الصيانة القادمة", "Next maintenance"), next ? <span className="ss-mtext">{dayLabel(next.startsAt, ar)}</span> : "—",
                    next ? <>{next.title}{nextRoaster && (data.roasters.length > 1) ? ` · ${nextRoaster.name}` : ""} · <N>{windowText(next, ar)}</N></> : L("لا صيانة مخططة", "No maintenance planned")],
                ]}
              />
            )}
            <section>
              <div className="ss-bh">
                <h2>{L("محامص الإنتاج", "Production roasters")}</h2>
                {phone ? null : <span>{L("السعة بالكيلوغرام الأخضر لكل دفعة", "Capacity in kg of green coffee per batch")}</span>}
              </div>
              {production.length === 0
                ? <p className="ss-muted" data-testid="production-empty">{L("لا توجد محمصة إنتاج مسجّلة.", "No production roaster is registered.")}</p>
                : phone ? list(production) : table(production, L("محامص الإنتاج", "Production roasters"))}
            </section>
            <section>
              <div className="ss-bh"><h2>{L("محامص العينات", "Sample roasters")}</h2></div>
              {samples.length === 0 ? empty : phone ? list(samples) : table(samples, L("محامص العينات", "Sample roasters"))}
            </section>
            <QcMinSection />
            <OrderRecomputeSection />
            <CapacityNote short={phone} />
            {data.can.edit ? null : <ReadOnlyNote />}
          </div>
        )}
      </SettingsFrame>
    </OpsRoot>
  );
}
