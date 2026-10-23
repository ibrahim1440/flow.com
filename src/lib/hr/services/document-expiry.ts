// «تنبيهات انتهاء الوثائق» — the daily document-expiry check (feat/hr-expiry-email).
//
// Runs once a day from Vercel Cron (GET /api/cron/hr-document-expiry, 03:00 UTC = 06:00 Riyadh) and
// on demand from HR settings («تشغيل الآن», hr › policy_manage). The rules (what is checked, the
// thresholds, the weekly reminder once expired, the dedupe key) are pure: ../expiry-rules.ts.
//
// Who is told, for each item due:
//   * the employee themself (category «me»; their linked, active login) — about their own documents
//     and identity, never their contract end;
//   * the HR holders (category «hr»): an active account holding the HR duty that sees the item
//     (documents_view / private_view / contracts_manage) whose HR scope covers the person (all branches,
//     the person's branch, or a direct report — core.ts resolveScope), and the admin role (the owner)
//     while it holds the HR module. Never the person themself (they have their own), never an account
//     without HR, never another employee.
// Words and e-mail: the catalogue (hr.document_expiry / me.document_expiry). E-mail follows each
// person's choice per category and the adapter (lib/notify/email.ts) and goes to the company e-mail
// (purpose «system») — the delivery of every notification (lib/notifications/deliver.ts).
//
// Idempotent: one notification per item, step and recipient (the unique ("recipientId", "dedupeKey"));
// re-running the same day, or two runs at once, adds nothing. One item failing never stops the run.
import { prisma } from "@/lib/db";
import { hasModuleAccess, hasSubPrivilege } from "@/lib/auth-shared";
import { notify } from "@/lib/notifications/notify";
import { effectivePermissions } from "@/lib/notifications/recipients";
import { emailConfigured } from "@/lib/notify/email";
import { cronSecretConfigured } from "@/lib/cron/auth";
import { HrError, type HrActor, type HrScope, type Db, assertAny, assertCan, audit, can, inScope, resolveScope } from "../core";
import { addDays, dayString, localDay } from "../dates";
import {
  DEFAULT_EXPIRY_DAYS, SOURCE_SUB, SOURCE_TAB, daysUntil, expiryBadge, expiryDedupeKey, expiryLabel, normalizeThresholds, stepFor, thresholdsOrDefault,
  type ExpirySource,
} from "../expiry-rules";
import { activePolicyFor, settings } from "./policy";

export const EXPIRY_JOB_KEY = "job:hr-document-expiry";

export type ExpiryItem = {
  source: ExpirySource; id: string; employeeId: string; employeeNo: string; employeeName: string; branchId: string | null;
  accountId: string | null; expiresOn: string; daysLeft: number; labelAr: string; labelEn: string; category: string | null;
};

/** "Today" as the HR policy's calendar day (Asia/Riyadh when no policy is active). */
export async function hrDay(now: Date, db: Db = prisma): Promise<Date> {
  const p = await activePolicyFor(db, now);
  return localDay(now, p?.timezone ?? "Asia/Riyadh");
}

/** The stored thresholds (largest first), the defaults when unset or unusable. */
export async function expiryThresholds(db: Db = prisma): Promise<number[]> {
  const s = await settings(db);
  return thresholdsOrDefault((s as { expiryAlertDays?: unknown }).expiryAlertDays);
}

/** Every item that expires within `horizon` days of `today`, or already has — people still in service only. */
export async function collectExpiryItems(db: Db, today: Date, horizon: number, sources: ExpirySource[] = ["DOCUMENT", "IDENTITY", "CONTRACT"]): Promise<ExpiryItem[]> {
  const until = addDays(today, horizon);
  const person = { status: { not: "SEPARATED" as const } };
  const emp = { select: { id: true, employeeNo: true, fullNameAr: true, branchId: true, accountId: true } } as const;
  const [docs, ids, contracts] = await Promise.all([
    sources.includes("DOCUMENT") ? db.hrDocument.findMany({ where: { deletedAt: null, expiresOn: { not: null, lte: until }, employee: person }, select: { id: true, title: true, category: true, expiresOn: true, employee: emp } }) : Promise.resolve([]),
    sources.includes("IDENTITY") ? db.hrEmployeePrivate.findMany({ where: { idExpiry: { not: null, lte: until }, employee: person }, select: { employeeId: true, idType: true, idExpiry: true, employee: emp } }) : Promise.resolve([]),
    sources.includes("CONTRACT") ? db.hrContract.findMany({ where: { status: "ACTIVE", endDate: { not: null, lte: until }, employee: person }, select: { id: true, contractNo: true, endDate: true, employee: emp } }) : Promise.resolve([]),
  ]);
  const out: ExpiryItem[] = [];
  const push = (source: ExpirySource, id: string, e: { id: string; employeeNo: string; fullNameAr: string; branchId: string | null; accountId: string | null }, d: Date, label: { ar: string; en: string }, category: string | null) => {
    out.push({ source, id, employeeId: e.id, employeeNo: e.employeeNo, employeeName: e.fullNameAr, branchId: e.branchId, accountId: e.accountId, expiresOn: dayString(d), daysLeft: daysUntil(d, today), labelAr: label.ar, labelEn: label.en, category });
  };
  for (const d of docs) push("DOCUMENT", d.id, d.employee, d.expiresOn as Date, expiryLabel({ source: "DOCUMENT", title: d.title, category: d.category }), d.category);
  for (const p of ids) push("IDENTITY", p.employeeId, p.employee, p.idExpiry as Date, expiryLabel({ source: "IDENTITY", idType: p.idType }), p.idType ?? null);
  for (const c of contracts) push("CONTRACT", c.id, c.employee, c.endDate as Date, expiryLabel({ source: "CONTRACT", contractNo: c.contractNo }), null);
  return out.sort((a, b) => a.daysLeft - b.daysLeft || a.employeeName.localeCompare(b.employeeName));
}

type Holder = { id: string; admin: boolean; subs: Record<"documents_view" | "private_view" | "contracts_manage", boolean>; scope: HrScope };

/** The accounts that may be told about an item (see the header): HR duty holders with their scope, and the admin role. */
export async function loadExpiryHolders(db: Db): Promise<Holder[]> {
  const rows = await db.employee.findMany({ where: { active: true }, select: { id: true, role: true, permissions: true } });
  const out: Holder[] = [];
  for (const r of rows) {
    const permissions = effectivePermissions(r);
    if (!hasModuleAccess(permissions, "hr")) continue;
    const subs = {
      documents_view: hasSubPrivilege(permissions, "hr", "documents_view"),
      private_view: hasSubPrivilege(permissions, "hr", "private_view"),
      contracts_manage: hasSubPrivilege(permissions, "hr", "contracts_manage"),
    };
    const admin = r.role === "admin";
    if (!admin && !subs.documents_view && !subs.private_view && !subs.contracts_manage) continue;
    const scope = admin ? { all: true, branchIds: [], reportIds: [], selfEmployeeId: null } : await resolveScope({ id: r.id, role: r.role, permissions }, db);
    out.push({ id: r.id, admin, subs, scope });
  }
  return out;
}

/** The HR recipients of one item. Pure. */
export function hrRecipientsFor(item: Pick<ExpiryItem, "source" | "employeeId" | "branchId" | "accountId">, holders: Holder[]): string[] {
  return holders
    .filter((h) => h.id !== item.accountId)
    .filter((h) => h.admin || (h.subs[SOURCE_SUB[item.source]] && inScope(h.scope, { id: item.employeeId, branchId: item.branchId })))
    .map((h) => h.id)
    .sort();
}

export type ExpiryRunReport = {
  day: string; trigger: "cron" | "manual"; thresholds: number[];
  checked: number; due: number; notified: { hr: number; me: number }; failed: number; emailConfigured: boolean; at: string;
};

const ENTITY: Record<ExpirySource, string> = { DOCUMENT: "HrDocument", IDENTITY: "HrEmployeePrivate", CONTRACT: "HrContract" };

/** One run of the check. Never throws for an item; the report says what happened. */
export async function runExpiryCheck(opts: { trigger: "cron" | "manual"; now?: Date; db?: typeof prisma } = { trigger: "cron" }): Promise<ExpiryRunReport> {
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  const thresholds = await expiryThresholds(db);
  const today = await hrDay(now, db);
  const items = await collectExpiryItems(db, today, thresholds[0]);
  const holders = items.length ? await loadExpiryHolders(db) : [];
  const report: ExpiryRunReport = { day: dayString(today), trigger: opts.trigger, thresholds, checked: items.length, due: 0, notified: { hr: 0, me: 0 }, failed: 0, emailConfigured: emailConfigured(), at: now.toISOString() };
  for (const item of items) {
    const step = stepFor(item.daysLeft, thresholds);
    if (!step) continue;
    report.due++;
    const facts = { labelAr: item.labelAr, labelEn: item.labelEn, personName: item.employeeName, expiresOn: item.expiresOn, daysLeft: item.daysLeft, employeeId: item.employeeId, tab: SOURCE_TAB[item.source] };
    const dedupeKey = expiryDedupeKey(item.source, item.id, item.expiresOn, step);
    const entity = { type: ENTITY[item.source], id: item.id };
    try {
      const hr = hrRecipientsFor(item, holders);
      if (hr.length) report.notified.hr += (await notify(db, { event: "hr.document_expiry", dedupeKey, facts, people: { holders: hr }, entity })).inserted;
      if (item.source !== "CONTRACT" && item.accountId) {
        report.notified.me += (await notify(db, { event: "me.document_expiry", dedupeKey, facts, people: { subject: item.accountId }, entity })).inserted;
      }
    } catch (e) {
      report.failed++;
      console.error(`[hr-expiry] ${item.source} item failed: ${(e as Error)?.name ?? "error"}`);
    }
  }
  const state = `${report.day} ${report.trigger} checked=${report.checked} due=${report.due} hr=${report.notified.hr} me=${report.notified.me} failed=${report.failed} at=${report.at}`.slice(0, 200);
  await db.notificationWatch.upsert({ where: { key: EXPIRY_JOB_KEY }, create: { key: EXPIRY_JOB_KEY, state }, update: { state } }).catch(() => undefined);
  return report;
}

/** The last run, as recorded («2026-10-30 cron checked=… at=…»), or null. */
export async function lastExpiryRun(db: Db = prisma): Promise<{ state: string; updatedAt: Date } | null> {
  const w = await db.notificationWatch.findUnique({ where: { key: EXPIRY_JOB_KEY } });
  return w ? { state: w.state, updatedAt: w.updatedAt } : null;
}

// ── For the screens ────────────────────────────────────────────────────────────────

const VIEW_SUBS = ["documents_view", "private_view", "contracts_manage"] as const;

/**
 * The HR dashboard card «وثائق قريبة الانتهاء»: the items the caller may see (their duties, their scope),
 * expired or within the largest threshold. No document bytes, no identity number.
 */
export async function expiringForActor(actor: HrActor, now: Date) {
  assertAny(actor, [...VIEW_SUBS]);
  const sources = (Object.keys(SOURCE_SUB) as ExpirySource[]).filter((s) => can(actor, SOURCE_SUB[s]));
  const [thresholds, today, scope] = await Promise.all([expiryThresholds(), hrDay(now), resolveScope(actor)]);
  const items = (await collectExpiryItems(prisma, today, thresholds[0], sources)).filter((i) => inScope(scope, { id: i.employeeId, branchId: i.branchId }));
  return {
    today: dayString(today),
    thresholds,
    counts: { expired: items.filter((i) => i.daysLeft <= 0).length, soon: items.filter((i) => i.daysLeft > 0).length },
    items: items.slice(0, 50).map((i) => ({
      source: i.source, id: i.id, employeeId: i.employeeId, employeeNo: i.employeeNo, employeeName: i.employeeName,
      labelAr: i.labelAr, labelEn: i.labelEn, expiresOn: i.expiresOn, daysLeft: i.daysLeft, tab: SOURCE_TAB[i.source],
      badge: expiryBadge(i.daysLeft, thresholds[0]),
    })),
  };
}

/** HR settings «تنبيهات انتهاء الوثائق»: the thresholds, the last run, whether e-mail is on. */
export async function expirySettings(actor: HrActor) {
  assertCan(actor, "policy_manage");
  const [thresholds, last] = await Promise.all([expiryThresholds(), lastExpiryRun()]);
  return {
    thresholds, defaults: [...DEFAULT_EXPIRY_DAYS], lastRun: last ? { state: last.state, at: last.updatedAt.toISOString() } : null,
    emailConfigured: emailConfigured(),
    // Only whether a scheduler secret is set — never its value.
    cronSecretConfigured: cronSecretConfigured(),
  };
}

export async function saveExpirySettings(actor: HrActor, b: Record<string, unknown>) {
  assertCan(actor, "policy_manage");
  let days: number[];
  try {
    days = normalizeThresholds(b.thresholds);
  } catch (e) {
    throw new HrError((e as Error).message, 400, "EXPIRY_DAYS_INVALID");
  }
  return prisma.$transaction(async (tx) => {
    const before = thresholdsOrDefault((await settings(tx) as { expiryAlertDays?: unknown }).expiryAlertDays);
    await tx.hrSettings.update({ where: { id: "singleton" }, data: { expiryAlertDays: days, updatedBy: actor.id } });
    await audit(tx, { action: "EXPIRY_ALERTS_SET", entityType: "HrSettings", entityId: "singleton", before: { thresholds: before }, after: { thresholds: days }, actorId: actor.id });
    return { thresholds: days };
  });
}

/** «تشغيل الآن»: one run, then the e-mail of what it wrote (the delivery is idempotent). */
export async function runExpiryNow(actor: HrActor) {
  assertCan(actor, "policy_manage");
  const report = await runExpiryCheck({ trigger: "manual" });
  await audit(prisma, { action: "EXPIRY_CHECK_RUN", entityType: "HrSettings", entityId: "singleton", after: { day: report.day, due: report.due, notified: report.notified, failed: report.failed }, actorId: actor.id });
  const { deliverPendingEmails } = await import("@/lib/notifications/deliver");
  const emails = await deliverPendingEmails({ limit: 200 });
  return { ...report, emails: emails.length };
}
