// «سجل الصلاحيات» (Figma UR-12) — the queries: the filtered log and its sensitive export. The words
// (actions, details, before / after) are in ./audit-format (pure, unit-tested).
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { AUDIT_ACTIONS, csvCell, describe, type AuditEntry, type AuditFilters, type Row } from "./audit-format";

export { AUDIT_ACTIONS, describe, parseFilters, type AuditCategory, type AuditEntry, type AuditFilters } from "./audit-format";


/** The rows matching the filters, newest first (cursor: the last row's "<iso>|<id>"). */
export async function queryAudit(f: AuditFilters, take = 50, lang: "ar" | "en" = "ar") {
  const actions = Object.entries(AUDIT_ACTIONS).filter(([, d]) => f.cat === "all" || !f.cat || d.cat === f.cat).map(([k]) => k);
  const where: Prisma.Sql[] = [Prisma.sql`action IN (${Prisma.join(actions)})`];
  // Sign-ins: successful and failed ones of known accounts; anonymous failures say nothing about a user.
  where.push(Prisma.sql`NOT (action = 'SIGN_IN' AND "userId" IS NULL)`);
  if (f.days) where.push(Prisma.sql`"occurredAt" >= ${new Date(Date.now() - f.days * 24 * 60 * 60 * 1000)}`);
  if (f.source && f.source !== "all") where.push(Prisma.sql`"sourceInterface" = ${f.source.toUpperCase()}`);
  if (f.q) {
    const like = `%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const ids = (await prisma.employee.findMany({ where: { OR: [{ name: { contains: f.q, mode: "insensitive" } }, { username: { contains: f.q.toLowerCase() } }] }, select: { id: true }, take: 200 })).map((e) => e.id);
    const byId = ids.length ? Prisma.sql`"userId" IN (${Prisma.join(ids)}) OR (metadata ->> 'targetEmployeeId') IN (${Prisma.join(ids)}) OR ` : Prisma.empty;
    where.push(Prisma.sql`(${byId}(metadata ->> 'targetName') ILIKE ${like} OR (metadata ->> 'roleName') ILIKE ${like})`);
  }
  if (f.before) {
    const [at, id] = f.before.split("|");
    const d = new Date(at);
    if (!Number.isNaN(d.getTime()) && id) where.push(Prisma.sql`("occurredAt", id) < (${d}, ${id})`);
  }
  const rows = await prisma.$queryRaw<Row[]>`
    SELECT id, "userId", action, result, "reasonCode", "sourceInterface", metadata, "occurredAt" FROM "AuthAuditLog"
    WHERE ${Prisma.join(where, " AND ")}
    ORDER BY "occurredAt" DESC, id DESC LIMIT ${take + 1}`;
  const page = rows.slice(0, take);
  const actorIds = [...new Set(page.flatMap((r) => [r.userId, (r.metadata as Record<string, unknown> | null)?.targetEmployeeId as string | undefined]).filter((x): x is string => !!x))];
  const names = new Map((await prisma.employee.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true } })).map((e) => [e.id, e.name]));
  return { entries: page.map((r) => describe(r, names, lang)), next: rows.length > take ? `${page[page.length - 1].occurredAt.toISOString()}|${page[page.length - 1].id}` : null };
}

const riyadh = (iso: string) => new Intl.DateTimeFormat("en-GB", { dateStyle: "short", timeStyle: "medium", timeZone: "Asia/Riyadh", hourCycle: "h23" }).format(new Date(iso));

/** UR-12 «تصدير حساس»: the filtered log as CSV (UTF-8 with BOM, Asia/Riyadh times), at most 5,000 rows. */
export async function exportAudit(f: AuditFilters): Promise<{ csv: string; rows: number }> {
  const out: AuditEntry[] = [];
  let cursor: string | null = null;
  do {
    const page: { entries: AuditEntry[]; next: string | null } = await queryAudit({ ...f, before: cursor }, 500);
    out.push(...page.entries);
    cursor = page.next;
  } while (cursor && out.length < 5000);
  const head = ["الوقت (Asia/Riyadh)", "المنفّذ", "الإجراء", "الهدف", "المصدر", "التفاصيل", "السبب", "النتيجة"];
  const lines = [head, ...out.slice(0, 5000).map((e) => [riyadh(e.at), e.actor, e.label, e.target, e.source, e.details, e.reason ?? "", e.result])].map((r) => r.map(csvCell).join(","));
  return { csv: "﻿" + lines.join("\r\n") + "\r\n", rows: Math.min(out.length, 5000) };
}
