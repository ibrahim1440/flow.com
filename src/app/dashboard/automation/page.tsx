"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, Zap } from "lucide-react";
import {
  Alert, Button, Card, DataTable, EmptyState, PageHeader, Spinner, Td, Tr, ROW_ACTION, api, useLang,
} from "../sales/_components/ui";
import { EVENT_GROUPS, getEvent, RECIPIENT_LABELS, type RecipientKind } from "@/lib/automation/catalog";
import { Badge, SEND_MODE_LABELS, useAutomationAbilities } from "./_components/shared";

/**
 * Automation rules: what the system sends on WhatsApp, and when.
 *
 * Each row reads as a sentence — when <event>, send to <recipients> — with what it sent in
 * the last 30 days, so a rule that has quietly stopped matching is visible from here.
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

type Connection = { sendMode: string; effectiveMode: string; effectiveNote: string | null; state: string | null; configured: boolean };

export default function AutomationRulesPage() {
  const lang = useLang();
  const ar = lang === "ar";
  const router = useRouter();
  const { canManageRules } = useAutomationAbilities();

  const [rows, setRows] = useState<Row[] | null>(null);
  const [conn, setConn] = useState<Connection | null>(null);
  const [error, setError] = useState("");
  const [reloadToken, setReloadToken] = useState(0);

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

  if (!rows && !error) return <Spinner />;

  const mode = conn ? SEND_MODE_LABELS[conn.effectiveMode] : null;

  return (
    <div className="space-y-[18px]">
      <PageHeader
        title={ar ? "قواعد الأتمتة" : "Automation rules"}
        subtitle={ar ? "رسائل واتساب ترسل تلقائيا عند أحداث النظام." : "WhatsApp messages sent automatically on system events."}
        actions={
          canManageRules ? (
            <Button onClick={() => router.push("/dashboard/automation/rules/new")} testId="new-rule">
              <Plus size={15} aria-hidden /> {ar ? "قاعدة جديدة" : "New rule"}
            </Button>
          ) : undefined
        }
      />

      {error && <Alert kind="error" onDismiss={() => setError("")}>{error}</Alert>}

      {conn && mode && (
        <Card className="flex flex-wrap items-center gap-3">
          <Badge tone={mode.tone}>{ar ? mode.ar : mode.en}</Badge>
          <span className="text-[13px] text-oo-text-secondary">
            {conn.effectiveMode === "OFF"
              ? ar
                ? "القواعد تعمل وتسجل ما كانت سترسله، لكن لا يرسل شيء."
                : "Rules run and record what they would send; nothing is sent."
              : conn.effectiveMode === "TEST"
                ? ar
                  ? "كل الرسائل تذهب لرقم التجربة فقط."
                  : "Every message goes to the test number only."
                : ar
                  ? "الرسائل تذهب للمستلمين الفعليين."
                  : "Messages go to the real recipients."}
            {conn.state && conn.state !== "open" && (ar ? " الواتساب غير متصل الآن." : " WhatsApp is not connected.")}
          </span>
          <Link href="/dashboard/automation/whatsapp" className={`${ROW_ACTION} ms-auto hover:border-oo-action-primary`}>
            {ar ? "إعدادات الإرسال" : "Sending settings"}
          </Link>
        </Card>
      )}

      {rows && rows.length === 0 ? (
        <Card>
          <EmptyState>
            <Zap size={28} aria-hidden className="mx-auto mb-2 text-oo-text-muted" />
            {ar ? "لا توجد قواعد بعد. أنشئ أول قاعدة لترسل رسالة عند حدث في النظام." : "No rules yet."}
          </EmptyState>
        </Card>
      ) : (
        rows && (
          <DataTable
            testId="rules-table"
            minWidth={860}
            cols={[
              { label: ar ? "القاعدة" : "Rule", w: "min-w-[220px]" },
              { label: ar ? "عند" : "When", w: "w-[200px]" },
              { label: ar ? "ترسل إلى" : "Sends to", w: "w-[180px]" },
              { label: ar ? "آخر 30 يوما" : "Last 30 days", w: "w-[170px]" },
              { label: ar ? "الحالة" : "Status", w: "w-[130px]" },
            ]}
          >
            {rows.map((r) => {
              const ev = getEvent(r.eventType);
              const group = EVENT_GROUPS.find((g) => g.key === ev?.group);
              const recipients = [...new Set(r.steps.filter((s) => s.type === "whatsapp" && s.to).map((s) => s.to!.kind))];
              const sent = r.last30Days.SENT ?? 0;
              const failed = r.last30Days.FAILED ?? 0;
              const skipped = r.last30Days.SKIPPED ?? 0;
              return (
                <Tr key={r.id} testId={`rule-${r.id}`}>
                  <Td>
                    <Link href={`/dashboard/automation/rules/${r.id}`} className="font-medium text-oo-text-primary hover:underline">
                      {r.name}
                    </Link>
                    {r.description && <span className="block text-[12px] leading-[18px] text-oo-text-muted">{r.description}</span>}
                  </Td>
                  <Td>
                    <span className="block">{ev ? (ar ? ev.ar : ev.en) : r.eventType}</span>
                    <span className="block text-[12px] text-oo-text-muted">
                      {group ? (ar ? group.ar : group.en) : ""}
                      {r.conditions.length > 0 && (ar ? ` · ${r.conditions.length} شرط` : ` · ${r.conditions.length} condition(s)`)}
                    </span>
                  </Td>
                  <Td>{recipients.map((k) => (ar ? RECIPIENT_LABELS[k]?.ar : RECIPIENT_LABELS[k]?.en) ?? k).join(ar ? "، " : ", ")}</Td>
                  <Td>
                    <span className="text-[13px]">
                      {ar ? `أرسلت ${sent}` : `${sent} sent`}
                      {failed > 0 && <span className="text-oo-status-blocked">{ar ? ` · فشلت ${failed}` : ` · ${failed} failed`}</span>}
                      {skipped > 0 && <span className="text-oo-text-muted">{ar ? ` · لم ترسل ${skipped}` : ` · ${skipped} skipped`}</span>}
                    </span>
                  </Td>
                  <Td>
                    {canManageRules ? (
                      <button
                        type="button"
                        onClick={() => toggle(r)}
                        data-testid={`toggle-${r.id}`}
                        className={`${ROW_ACTION} ${r.isActive ? "border-oo-status-success text-oo-status-success" : "text-oo-text-secondary"}`}
                      >
                        {r.isActive ? (ar ? "مفعلة" : "Active") : ar ? "متوقفة" : "Off"}
                      </button>
                    ) : (
                      <span>{r.isActive ? (ar ? "مفعلة" : "Active") : ar ? "متوقفة" : "Off"}</span>
                    )}
                  </Td>
                </Tr>
              );
            })}
          </DataTable>
        )
      )}
    </div>
  );
}
