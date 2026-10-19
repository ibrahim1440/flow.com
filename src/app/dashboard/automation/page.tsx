"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Btn, Dot, Empty, OpsBanner, OpsLoading, OpsRoot, useL } from "@/components/ops/ui";
import { useD21Phone } from "@/components/shell/page-context";
import { api, useLang } from "../sales/_components/ui";
import { EVENT_GROUPS, getEvent, RECIPIENT_LABELS, type RecipientKind } from "@/lib/automation/catalog";
import { AutomationHeader, LoadError, type Connection, useAutomationAbilities } from "./_components/shared";
import { PlusIco, SettingsFrame } from "../_components/tools-ui";

/**
 * Automation rules: what the system sends on WhatsApp, and when — Direction 2.1 (UI batch 2;
 * GX E-P01, Figma 1219:92499 at 1440, EN 1229:113163, 1024 1219:93946, phone 1228:123991).
 *
 * Each row reads as a sentence — when <event>, send to <recipients> — with what it sent in
 * the last 30 days, so a rule that has quietly stopped matching is visible from here. Visual
 * port only: the same requests (GET rules + connection, PATCH isActive) and the same gates.
 */

type Row = {
  id: string;
  name: string;
  description: string | null;
  eventType: string;
  isActive: boolean;
  steps: { type: string; to?: { kind: RecipientKind } }[];
  conditions: unknown[];
  updatedAt: string;
  last30Days: Record<string, number>;
};

export default function AutomationRulesPage() {
  const lang = useLang();
  const ar = lang === "ar";
  const L = useL();
  const router = useRouter();
  const { canManageRules } = useAutomationAbilities();

  const [rows, setRows] = useState<Row[] | null>(null);
  const [conn, setConn] = useState<Connection | null>(null);
  const [error, setError] = useState("");
  const [reloadToken, setReloadToken] = useState(0);

  useD21Phone({ title: ar ? "الأتمتة والواتساب" : "Automation & WhatsApp", sub: ar ? "الإعدادات" : "Settings" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [r, c] = await Promise.all([api<{ rules: Row[] }>("/api/automation/rules"), api<Connection>("/api/automation/whatsapp")]);
      if (cancelled) return;
      if (r.ok) setRows(r.data.rules);
      else setError(r.data.error ?? (ar ? "تعذر تحميل القواعد." : "Could not load rules."));
      if (c.ok) setConn(c.data);
    })();
    return () => {
      cancelled = true;
    };
  }, [ar, reloadToken]);

  async function toggle(row: Row) {
    const res = await api(`/api/automation/rules/${row.id}`, { method: "PATCH", body: { isActive: !row.isActive } });
    if (!res.ok) setError(res.data.error ?? "");
    setReloadToken((t) => t + 1);
  }

  const status = (r: Row) => <Dot tone={r.isActive ? "success" : "neutral"}>{r.isActive ? L("مفعّلة", "Active") : L("متوقفة", "Off")}</Dot>;

  return (
    <OpsRoot className="tl-root">
      <SettingsFrame>
        <AutomationHeader
          lang={lang}
          conn={conn}
          ruleCount={rows?.length}
          actions={canManageRules ? (
            <Btn variant="primary" onClick={() => router.push("/dashboard/automation/rules/new")} data-testid="new-rule">
              <PlusIco /> {L("قاعدة جديدة", "New rule")}
            </Btn>
          ) : undefined}
        />

        {error && rows && <OpsBanner tone="danger" onClose={() => setError("")}>{error}</OpsBanner>}

        {!rows && error ? (
          <LoadError lang={lang} title={L("تعذّر تحميل القواعد", "Could not load the rules")} onRetry={() => { setError(""); setReloadToken((t) => t + 1); }} />
        ) : !rows && !error ? <OpsLoading /> : rows && rows.length === 0 ? (
          <div className="tl-empty"><Empty
            title={L("لا توجد قواعد بعد", "No rules yet")}
            body={L("أنشئ أول قاعدة لترسل رسالة عند حدث في النظام.", "Create a first rule to send a message when something happens.")}
            action={canManageRules ? <Btn variant="primary" onClick={() => router.push("/dashboard/automation/rules/new")}><PlusIco /> {L("قاعدة جديدة", "New rule")}</Btn> : undefined}
          /></div>
        ) : rows ? (
          <>
            <div className="hr-tablewrap">
              <table className="hr-table is-mrow" aria-label={L("القواعد", "Rules")} data-testid="rules-table">
                <thead>
                  <tr>
                    <th>{L("القاعدة", "Rule")}</th>
                    <th>{L("عند", "When")}</th>
                    <th className="hr-hide-compact">{L("تُرسل إلى", "Sends to")}</th>
                    <th>{L("آخر 30 يومًا", "Last 30 days")}</th>
                    <th>{L("الحالة", "Status")}</th>
                    {canManageRules ? <th><span className="hr-sr">{L("إجراء", "Action")}</span></th> : null}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const ev = getEvent(r.eventType);
                    const group = EVENT_GROUPS.find((g) => g.key === ev?.group);
                    const recipients = [...new Set(r.steps.filter((s) => s.type === "whatsapp" && s.to).map((s) => s.to!.kind))];
                    const to = recipients.map((k) => (ar ? RECIPIENT_LABELS[k]?.ar : RECIPIENT_LABELS[k]?.en) ?? k).join(ar ? "، " : ", ");
                    const sent = r.last30Days.SENT ?? 0;
                    const failed = r.last30Days.FAILED ?? 0;
                    const skipped = r.last30Days.SKIPPED ?? 0;
                    const evName = ev ? (ar ? ev.ar : ev.en) : r.eventType;
                    return (
                      <tr key={r.id} data-testid={`rule-${r.id}`}>
                        <td className="m-title">
                          <Link href={`/dashboard/automation/rules/${r.id}`} className="strong" style={{ fontWeight: 600, color: "var(--text-primary)", textDecoration: "none" }}>
                            {r.name}
                          </Link>
                          {r.description && <span className="stk-sub hr-desktop-only">{r.description}</span>}
                          <span className="hr-msub">{evName}{to ? ` · ${to}` : ""}</span>
                        </td>
                        <td>
                          <span style={{ display: "block", fontWeight: 500 }}>{evName}</span>
                          <span className="stk-sub">
                            {group ? (ar ? group.ar : group.en) : ""}
                            {" · "}
                            {r.conditions.length > 0
                              ? (ar ? `${r.conditions.length} شرط` : `${r.conditions.length} condition(s)`)
                              : L("بلا شروط", "no conditions")}
                          </span>
                        </td>
                        <td className="hr-hide-compact">{to}</td>
                        <td>
                          <span style={{ fontSize: 13, color: "var(--text-muted)" }}>
                            {ar ? `أرسلت ${sent}` : `${sent} sent`}
                            {failed > 0 && <span style={{ color: "var(--status-danger)" }}>{ar ? ` · ${failed} فشلت` : ` · ${failed} failed`}</span>}
                            {skipped > 0 && <span>{ar ? ` · لم ترسل ${skipped}` : ` · ${skipped} skipped`}</span>}
                          </span>
                        </td>
                        <td className="m-end">
                          {status(r)}
                          {canManageRules ? (
                            <span className="hr-mobile-only">
                              <Btn size="sm" onClick={() => toggle(r)}>{r.isActive ? L("إيقاف", "Turn off") : L("تفعيل", "Turn on")}</Btn>
                            </span>
                          ) : null}
                        </td>
                        {canManageRules ? (
                          <td style={{ textAlign: "end", width: 1 }}>
                            <Btn size="sm" onClick={() => toggle(r)} data-testid={`toggle-${r.id}`} aria-label={`${r.isActive ? L("إيقاف", "Turn off") : L("تفعيل", "Turn on")} — ${r.name}`}>
                              {r.isActive ? L("إيقاف", "Turn off") : L("تفعيل", "Turn on")}
                            </Btn>
                          </td>
                        ) : null}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="tl-foot tl-hide-phone">{L("المفعّلة أولًا ثم الأحدث تعديلًا · الإيقاف والتفعيل فوريان", "Active first, then most recently edited · turning a rule off or on is immediate")}</p>
            <div className="tl-note tl-hide-phone">
              {L("القاعدة المتوقفة لا تنشئ رسائل. الرسائل التي لم تُرسل بعد لا تُلغى عند الإيقاف؛ تُلغى عند حذف القاعدة.", "A rule that is off creates no messages. Messages not yet sent are not cancelled when it is turned off; they are cancelled when the rule is deleted.")}
            </div>
          </>
        ) : null}
      </SettingsFrame>
    </OpsRoot>
  );
}
