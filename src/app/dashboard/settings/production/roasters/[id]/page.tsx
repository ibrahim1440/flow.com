"use client";
// RM3 «Mill City» — edit a roaster (Figma 391:1012 at 1440, 392:1228 at 1024) and, on a phone, its
// detail (382:89) with «تعديل» and «تغيير الحالة». GET / PATCH /api/settings/production/roasters/[id];
// «تغيير الحالة» is the RM4b dialog. Below the form: «أثر الحفظ» and «سجل التغييرات» (SettingsAuditLog).
import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Btn, OpsLoading, OpsRoot, PageHeader, Timeline } from "@/components/ops/ui";
import { useD21Phone, useD21Title, usePhone } from "@/components/shell/page-context";
import { SettingsFrame } from "../../../../_components/tools-ui";
import {
  BASE, call, kindText, N, Retry, StatusText, TYPE, dayLabel, stamp, useLang, useOverview, windowText,
  type ApiError, type HistoryRow, type Roaster,
} from "../../_parts/shared";
import { draftOf, RoasterForm } from "../../_parts/form";
import { StatusDialog } from "../../_parts/status-dialog";
import { historyText } from "../../_parts/history";

export default function RoasterPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { ar, L } = useLang();
  const phone = usePhone();
  const router = useRouter();
  const search = useSearchParams();
  const editing = !phone || search.get("edit") === "1";
  const { data: overview, error: oErr, reload: reloadOverview } = useOverview();
  const [roaster, setRoaster] = useState<Roaster | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [error, setError] = useState<ApiError | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const [formKey, setFormKey] = useState(0);

  const [token, setToken] = useState(0);
  const load = useCallback(() => setToken((t) => t + 1), []);
  useEffect(() => {
    let off = false;
    call<{ roaster: Roaster; history: HistoryRow[] }>(`/api/settings/production/roasters/${id}`).then((r) => {
      if (off) return;
      if (r.ok) { setRoaster(r.data.roaster); setHistory(r.data.history); setError(null); }
      else if (r.status === 404) setNotFound(true);
      else setError(r.data);
    });
    return () => { off = true; };
  }, [id, token]);
  const [now] = useState(() => Date.now());

  useD21Title(roaster?.name ?? null);
  useD21Phone({
    title: roaster?.name ?? L("الحمّاصة", "Roaster"), sub: L("الإعدادات · الحمّاصات", "Settings · Roasters"),
    back: editing && phone ? `${BASE}/roasters/${id}` : BASE, ownBar: true,
  });

  const next = overview?.maintenance
    .filter((m) => m.roasterId === id && (m.status === "PLANNED" || m.status === "IN_PROGRESS") && new Date(m.endsAt).getTime() > now)
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt))[0] ?? null;
  const others = {
    PRODUCTION: overview?.roasters.filter((r) => r.type === "PRODUCTION").length ?? 0,
    SAMPLE: overview?.roasters.filter((r) => r.type === "SAMPLE").length ?? 0,
  };
  const meta = roaster ? `${ar ? `حمّاصة ${TYPE[roaster.type][0]}` : `${TYPE[roaster.type][1]} roaster`}${roaster.isDefault ? L(" · افتراضية", " · default") : ""}` : "";
  const canEdit = !!overview?.can.edit;

  const body = () => {
    if (notFound) return <div className="hr-state" role="status"><h3>{L("الحمّاصة غير موجودة.", "Roaster not found.")}</h3><Link href={BASE} className="hr-btn">{L("رجوع إلى الحمّاصات", "Back to roasters")}</Link></div>;
    if (error || oErr) return <Retry error={(error ?? oErr)!} onRetry={() => { load(); reloadOverview(); }} />;
    if (!roaster || !overview) return <OpsLoading rows={8} />;

    if (phone && !editing) {
      // 382:89 — the detail: status, the limits, the next maintenance; «تغيير الحالة» · «تعديل».
      return (
        <div className="ss-stack" data-testid="roaster-detail">
          <div className="ss-mrow is-start"><StatusText status={roaster.status} ar={ar} /><span className="ss-muted">{meta}</span></div>
          <dl className="ss-kv">
            <dt>{L("سعة الحمّاصة (حسب الشركة المصنّعة)", "Roaster capacity (manufacturer rating)")}</dt><dd><N>{roaster.nominalCapacityKg}</N> {L("كغ أخضر", "kg green")}</dd>
            <dt>{L("كمية التحميص الافتراضية", "Default roast quantity")}</dt><dd><N>{roaster.defaultTargetKg}</N> {L("كغ", "kg")}</dd>
            <dt>{L("أقل كمية مسموحة للتحميص", "Minimum roast quantity")}</dt><dd><N>{roaster.minBatchKg}</N> {L("كغ", "kg")}</dd>
            <dt>{L("أعلى كمية مسموحة للتحميص", "Maximum roast quantity")}</dt><dd><N>{roaster.maxBatchKg}</N> {L("كغ", "kg")}</dd>
            <dt>{L("الدورة", "Cycle")}</dt><dd><N>{roaster.cycleMinutes}</N> {L("دقيقة", "min")}</dd>
            <dt>{L("المشغّل", "Operator")}</dt><dd>{roaster.defaultOperatorName ?? "—"}</dd>
          </dl>
          <section>
            <div className="ss-bh"><h2 className="ss-h3">{L("الصيانة القادمة", "Next maintenance")}</h2></div>
            {next ? (
              <div className="ss-mrow ss-line">
                <span><strong>{next.title}</strong><span className="ss-sub">{dayLabel(next.startsAt, ar)} · <N>{windowText(next, ar)}</N></span></span>
                <span className="ss-muted">{kindText(next, ar)}</span>
              </div>
            ) : <p className="ss-muted">{L("لا صيانة مخططة", "No maintenance planned")}</p>}
          </section>
          {canEdit ? (
            <div className="ss-formacts is-sticky is-two">
              <Btn onClick={() => setStatusOpen(true)} data-testid="roaster-status">{L("تغيير الحالة", "Change status")}</Btn>
              <Link href={`${BASE}/roasters/${id}?edit=1`} className="hr-btn is-primary" data-testid="roaster-edit-phone">{L("تعديل", "Edit")}</Link>
            </div>
          ) : null}
        </div>
      );
    }

    if (!canEdit) return <p className="tl-foot" data-testid="rm-readonly">{L("للعرض فقط · يغيّر الإعداد المدير", "Read only · the administrator changes the configuration")}</p>;
    return (
      <>
        {saved ? <div className="hr-notice tone-success" role="status" data-testid="roaster-saved">{L("حُفظت التغييرات.", "Changes saved.")}</div> : null}
        <RoasterForm
          key={formKey}
          mode="edit"
          initial={draftOf(roaster)}
          current={roaster}
          people={overview.people}
          othersOfType={others}
          onSaved={(r) => { setRoaster(r); setSaved(true); load(); reloadOverview(); if (phone) router.push(`${BASE}/roasters/${id}`); }}
        />
        {phone ? null : (
          <div className="ss-after" data-testid="roaster-after">
            <section>
              <h3 className="ss-lbl">{L("أثر الحفظ", "Effect of saving")}</h3>
              <dl className="ss-kv is-wide">
                <dt>{L("الدفعات المسجّلة", "Recorded batches")}</dt><dd>{L("لا تتغير أوزانها ولا فاقدها", "Their weights and loss do not change")}</dd>
                <dt>{L("الخطط المعتمدة", "Approved plans")}</dt><dd>{L("لا تتغير خاناتها", "Their slots do not change")}</dd>
                <dt>{L("الخطط الجديدة", "New plans")}</dt><dd>{L("تستخدم", "Use")} <N>{roaster.cycleMinutes}</N> {L("دقيقة", "min")}</dd>
              </dl>
            </section>
            <section>
              <h3 className="ss-lbl">{L("سجل التغييرات", "Change history")}</h3>
              {history.length === 0 ? <p className="ss-muted">{L("لا تغييرات مسجّلة.", "No changes recorded.")}</p> : (
                <Timeline items={history.map((h) => ({ key: h.id, text: historyText(h, ar), when: `${stamp(h.createdAt, ar)}${h.actorName ? ` · ${h.actorName}` : ""}` }))} />
              )}
            </section>
          </div>
        )}
      </>
    );
  };

  return (
    <OpsRoot className="tl-root">
      <SettingsFrame>
        <PageHeader
          title={roaster?.name ?? L("الحمّاصة", "Roaster")}
          actions={roaster && canEdit && !phone ? <Btn onClick={() => setStatusOpen(true)} data-testid="roaster-status">{L("تغيير الحالة", "Change status")}</Btn> : null}
        />
        <p className="tl-sub">
          {L("الإعدادات · الإنتاج والتحميص · الحمّاصات", "Settings · Production & roasting · Roasters")}
          {roaster ? <><span className="tl-sep">•</span>{meta}</> : null}
        </p>
        {body()}
      </SettingsFrame>
      <StatusDialog roaster={roaster} open={statusOpen} onClose={() => setStatusOpen(false)} onSaved={(r) => { setRoaster(r); setFormKey((k) => k + 1); load(); reloadOverview(); }} />
    </OpsRoot>
  );
}
