// Owner decisions of 16 / 17 Oct (inventory privileges Option A; decision 4): `inventory › adjust`
// and `inventory › override` are held only through an INDEPENDENT second-person approval. This
// module is the single definition of what counts as that approval ("evidence"), shared by:
//   · the impact report and the suspension script (scripts/release/inventory-*.ts), through pg;
//   · the action-time gate (stockChangeGate, src/lib/auth-server.ts), through Prisma;
//   · the readiness check (scripts/release/inventory-stock-change-readiness.ts).
// It talks SQL through a `Query` function so both clients use the same statements.
//
// A held sub is EVIDENCED only by an APPLIED `PERMISSION_CHANGE` (HrConfigChange) for the account
// that actually GRANTED it (grantedSubs), whose decision was independent AND whose approver was
// eligible AT THE DECISION TIME (orchestrator ruling N1, under the owner's "preserve approved
// supervisors"): an approval stays valid when its approver later leaves, is demoted or loses their
// verification. Every condition must be PROVEN from the record and its history; anything not
// provable is not evidence (fail closed):
//   · `decidedBy` names an existing account (active or not today);
//   · the app's own decision audit row exists (N3): HrAuditLog CONFIG_CHANGE_APPROVE for this change,
//     by `decidedBy`, naming the same beneficiary and fingerprint, written with the decision
//     (|createdAt − decidedAt| ≤ 5 min). The app writes it only after it has required, at that moment,
//     an active account with a live session, `employees › edit`, a fresh step-up and a verified
//     individual (decidePermissionChange) — so the row is the proof of the approver's eligibility then;
//   · independently of that row, a verification attesting the approver's login was live at
//     `decidedAt` (HrIdentityVerification: verifiedAt ≤ decidedAt, not revoked before it);
//   · the approver is neither the beneficiary nor the requester, and not the SAME PERSON as either —
//     persons judged as personsOf does (current links, every link ever recorded in HrAuditLog, and
//     the same identity number on an employee and an external record).
// A forged row (no decision audit), a self-approval, a same-person approval or an approval by an
// approver who was not verified then is not evidence: the holder is EXPLICIT_UNAPPROVED. This holds
// whatever guards the table has (impl/payroll-lock adds an INSERT guard forcing PENDING).
// approverDrift() separately lists approvals whose approver is NO LONGER active / an editor / verified
// today — still valid, but the readiness check WARNs so a re-grant can be scheduled.
import { buildDefaultPermissions, hasModuleAccess, hasSubPrivilege, parsePermissions, type Permissions } from "@/lib/auth-shared";
import { effectivePermissions } from "@/lib/hr/sod";

export type Query = <T = Record<string, unknown>>(sql: string, params: unknown[]) => Promise<T[]>;

export const INVENTORY_PRIVILEGED = ["adjust", "override"] as const;
export type Sub = (typeof INVENTORY_PRIVILEGED)[number];

/** The "inventory" role template as it was before the owner decision (every inventory sub on). */
export function oldInventoryTemplate(): Permissions {
  const p = structuredClone(buildDefaultPermissions("inventory")) as Permissions;
  const inv = p.inventory;
  inv.sub = { ...(inv.sub ?? {}), adjust: true, override: true };
  return p;
}

export const isEmptyPermissions = (raw: string | null | undefined): boolean => {
  if (!raw) return true;
  const p = parsePermissions(raw);
  return !p || typeof p !== "object" || Object.keys(p).length === 0;
};

/** The permissions an account had under the OLD rule (old role template when nothing is stored). */
export function oldEffective(raw: string | null, role: string): Permissions {
  if (isEmptyPermissions(raw)) return role === "inventory" ? oldInventoryTemplate() : effectivePermissions(null, role);
  return parsePermissions(raw as string);
}

/** The permissions an account has under the NEW rule. */
export function newEffective(raw: string | null, role: string): Permissions {
  return effectivePermissions(isEmptyPermissions(raw) ? null : raw, role);
}

export const heldSubs = (p: Permissions): Sub[] => INVENTORY_PRIVILEGED.filter((s) => hasModuleAccess(p, "inventory") && hasSubPrivilege(p, "inventory", s));

/** A PERMISSION_CHANGE row as the evidence rule reads it. */
export type GrantRecord = { id: string; accountId: string; permissions: string | null; role: string | null; subs: unknown; beforePermissions: string | null; beforeRole: string | null; hasBefore: boolean; requestedBy?: string | null; decidedBy: string | null; decidedAt: Date | string | null };

/**
 * Which subs an APPLIED request actually GRANTED. `payload.subs` (the Option A flow) names them; for
 * an older request, the sub counts only if the account did not hold it before (judged under the OLD
 * rule) and the approved permissions hold it.
 */
export function grantedSubs(r: GrantRecord, accountRole: string): Sub[] {
  const listed = Array.isArray(r.subs) ? (r.subs as unknown[]).filter((x): x is string => typeof x === "string") : [];
  const after = r.permissions ? heldSubs(newEffective(r.permissions, r.role ?? accountRole)) : [];
  const before = r.hasBefore ? heldSubs(oldEffective(r.beforePermissions, r.beforeRole ?? r.role ?? accountRole)) : null;
  return INVENTORY_PRIVILEGED.filter((s) => listed.includes(`inventory.${s}`) || (before !== null && !before.includes(s) && after.includes(s)));
}

const GRANTS_SQL = `
  SELECT id, payload->>'accountId' AS "accountId", payload->>'permissions' AS permissions, payload->>'role' AS role, payload->'subs' AS subs,
         before->>'permissions' AS "beforePermissions", before->>'role' AS "beforeRole", (before IS NOT NULL AND jsonb_typeof(before::jsonb) = 'object') AS "hasBefore",
         "requestedBy", "decidedBy", "decidedAt"
    FROM "HrConfigChange" WHERE kind = 'PERMISSION_CHANGE' AND status = 'APPLIED'`;

/** APPLIED PERMISSION_CHANGE rows (all, or for the given beneficiary accounts). */
export async function loadGrantRecords(q: Query, accountIds?: string[]): Promise<GrantRecord[]> {
  return accountIds
    ? q<GrantRecord>(`${GRANTS_SQL} AND payload->>'accountId' = ANY($1::text[]) ORDER BY "decidedAt" NULLS LAST, id`, [accountIds])
    : q<GrantRecord>(`${GRANTS_SQL} ORDER BY "decidedAt" NULLS LAST, id`, []);
}

// identityOf's rule in SQL: the login's linked person (an HR employee takes precedence over an
// external person) is active and holds a live verification that attests THIS login.
export const VERIFIED_SQL = `
  WITH p AS (
    SELECT e."accountId" AS acc, 'EMPLOYEE' AS t, e.id, e.status::text <> 'SEPARATED' AS active FROM "HrEmployee" e WHERE e."accountId" IS NOT NULL
    UNION ALL
    SELECT x."accountId", 'EXTERNAL', x.id, x.active FROM "HrExternalPerson" x
     WHERE x."accountId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "HrEmployee" e WHERE e."accountId" = x."accountId")
  )
  SELECT p.acc AS "accountId" FROM p
    JOIN "HrIdentityVerification" v ON v."subjectType" = p.t AND v."subjectId" = p.id AND v."revokedAt" IS NULL AND v."accountId" = p.acc
   WHERE p.active`;

// personsOf in SQL, for many logins at once: every person linked now or ever (HrAuditLog
// ACCOUNT_LINK / ACCOUNT_UNLINK), plus the same human under the other kind of record (identity number).
const PERSONS_SQL = `
  WITH acc AS (SELECT unnest($1::text[]) AS id),
  emp AS (
    SELECT a.id AS acc, e.id AS pid FROM acc a JOIN "HrEmployee" e ON e."accountId" = a.id
    UNION SELECT a.id, l."entityId" FROM acc a JOIN "HrAuditLog" l ON l."entityType" = 'HrEmployee' AND l.action IN ('ACCOUNT_LINK', 'ACCOUNT_UNLINK')
       AND ((l.after::jsonb->>'accountId') = a.id OR (l.before::jsonb->>'accountId') = a.id)),
  ext AS (
    SELECT a.id AS acc, x.id AS pid FROM acc a JOIN "HrExternalPerson" x ON x."accountId" = a.id
    UNION SELECT a.id, l."entityId" FROM acc a JOIN "HrAuditLog" l ON l."entityType" = 'HrExternalPerson' AND l.action IN ('ACCOUNT_LINK', 'ACCOUNT_UNLINK')
       AND ((l.after::jsonb->>'accountId') = a.id OR (l.before::jsonb->>'accountId') = a.id))
  SELECT acc AS "accountId", 'E:' || pid AS key FROM emp
  UNION SELECT ext.acc, 'E:' || p."employeeId" FROM ext JOIN "HrExternalPerson" x ON x.id = ext.pid JOIN "HrEmployeePrivate" p ON p."idNumberNorm" = x."idNumberNorm" WHERE x."idNumberNorm" IS NOT NULL
  UNION SELECT acc, 'X:' || pid FROM ext
  UNION SELECT emp.acc, 'X:' || x.id FROM emp JOIN "HrEmployeePrivate" p ON p."employeeId" = emp.pid JOIN "HrExternalPerson" x ON x."idNumberNorm" = p."idNumberNorm" WHERE p."idNumberNorm" IS NOT NULL`;

export type EvidenceVerdict = { ok: true } | { ok: false; why: string };
export type EvidenceFacts = {
  /** Every account that exists, with its CURRENT state (current state is used only by approverDrift). */
  accounts: Map<string, { active: boolean; role: string; permissions: string | null }>;
  /** Logins verified NOW (identityOf's rule). */
  verified: Set<string>;
  persons: Map<string, Set<string>>;
  /** Record ids with a matching CONFIG_CHANGE_APPROVE audit row (N3). */
  decisionAudited: Set<string>;
  /** Record ids whose approver held a verification live at decidedAt (N1). */
  verifiedAtDecision: Set<string>;
};

/** Pure: the independence and as-of-decision rule for one record. */
export function judgeRecord(r: Pick<GrantRecord, "id" | "accountId" | "requestedBy" | "decidedBy">, facts: EvidenceFacts): EvidenceVerdict {
  const d = r.decidedBy;
  if (!d) return { ok: false, why: "no decider" };
  if (!facts.accounts.get(d)) return { ok: false, why: "decider is not an account" };
  if (d === r.accountId) return { ok: false, why: "self-approved" };
  if (r.requestedBy && d === r.requestedBy) return { ok: false, why: "decider is the requester" };
  if (!facts.decisionAudited.has(r.id)) return { ok: false, why: "no matching decision audit row (not decided through the app)" };
  if (!facts.verifiedAtDecision.has(r.id)) return { ok: false, why: "decider was not a verified individual at the decision" };
  const mine = facts.persons.get(d) ?? new Set<string>();
  const overlap = (other: string | null) => !!other && [...(facts.persons.get(other) ?? [])].some((k) => mine.has(k));
  if (overlap(r.accountId)) return { ok: false, why: "decider is the same person as the beneficiary" };
  if (overlap(r.requestedBy ?? null)) return { ok: false, why: "decider is the same person as the requester" };
  return { ok: true };
}

/** Pure: what changed about a VALID approval's approver since the decision (for the readiness WARN). */
export function approverDrift(r: Pick<GrantRecord, "decidedBy">, facts: EvidenceFacts): string[] {
  const acc = r.decidedBy ? facts.accounts.get(r.decidedBy) : undefined;
  if (!acc) return ["approver no longer exists"];
  const out: string[] = [];
  if (!acc.active) out.push("approver inactive");
  const p = newEffective(acc.permissions, acc.role);
  if (!(hasModuleAccess(p, "employees") && hasSubPrivilege(p, "employees", "edit"))) out.push("approver no longer an account editor");
  if (!facts.verified.has(r.decidedBy as string)) out.push("approver no longer verified");
  return out;
}

const DECISION_AUDIT_SQL = `
  SELECT c.id FROM "HrConfigChange" c
   WHERE c.id = ANY($1::text[]) AND c."decidedBy" IS NOT NULL AND c."decidedAt" IS NOT NULL
     AND EXISTS (SELECT 1 FROM "HrAuditLog" l
                  WHERE l.action = 'CONFIG_CHANGE_APPROVE' AND l."entityType" = 'HrConfigChange' AND l."entityId" = c.id
                    AND l."actorId" = c."decidedBy"
                    AND (l.after::jsonb->>'accountId') = (c.payload->>'accountId')
                    AND (l.after::jsonb->>'fingerprint') = c.fingerprint
                    AND abs(extract(epoch FROM (l."createdAt" - c."decidedAt"))) <= 300)`;
const VERIFIED_AT_DECISION_SQL = `
  SELECT c.id FROM "HrConfigChange" c
   WHERE c.id = ANY($1::text[]) AND c."decidedAt" IS NOT NULL
     AND EXISTS (SELECT 1 FROM "HrIdentityVerification" v
                  WHERE v."accountId" = c."decidedBy" AND v."verifiedAt" <= c."decidedAt"
                    AND (v."revokedAt" IS NULL OR v."revokedAt" > c."decidedAt"))`;

const has = async (q: Query, t: string) => (await q<{ ok: boolean }>(`SELECT to_regclass($1) IS NOT NULL AS ok`, [`"${t}"`]))[0]?.ok === true;

/** The facts the rule needs about these records (one round of queries). */
export async function evidenceFacts(q: Query, records: GrantRecord[]): Promise<EvidenceFacts> {
  const ids = [...new Set(records.flatMap((r) => [r.accountId, r.requestedBy, r.decidedBy]).filter((x): x is string => !!x))];
  const recIds = records.map((r) => r.id);
  const accounts = new Map((await q<{ id: string; active: boolean; role: string; permissions: string | null }>(`SELECT id, active, role, NULLIF(permissions::text, '') AS permissions FROM "Employee" WHERE id = ANY($1::text[])`, [ids])).map((a) => [a.id, a]));
  const identity = (await has(q, "HrIdentityVerification")) && (await has(q, "HrEmployee")) && (await has(q, "HrExternalPerson"));
  const audit = await has(q, "HrAuditLog");
  const verified = identity ? new Set((await q<{ accountId: string }>(VERIFIED_SQL, [])).map((r) => r.accountId)) : new Set<string>();
  const persons = new Map<string, Set<string>>();
  if (identity && audit && (await has(q, "HrEmployeePrivate"))) {
    for (const r of await q<{ accountId: string; key: string }>(PERSONS_SQL, [ids])) {
      if (!persons.has(r.accountId)) persons.set(r.accountId, new Set());
      persons.get(r.accountId)!.add(r.key);
    }
  }
  const decisionAudited = audit && recIds.length ? new Set((await q<{ id: string }>(DECISION_AUDIT_SQL, [recIds])).map((r) => r.id)) : new Set<string>();
  const verifiedAtDecision = identity && recIds.length ? new Set((await q<{ id: string }>(VERIFIED_AT_DECISION_SQL, [recIds])).map((r) => r.id)) : new Set<string>();
  return { accounts, verified, persons, decisionAudited, verifiedAtDecision };
}

/** The verdict of every record (by record id). */
export async function judgeEvidence(q: Query, records: GrantRecord[], facts?: EvidenceFacts): Promise<Map<string, EvidenceVerdict>> {
  const out = new Map<string, EvidenceVerdict>();
  if (!records.length) return out;
  const f = facts ?? (await evidenceFacts(q, records));
  for (const r of records) out.set(r.id, judgeRecord(r, f));
  return out;
}

/** Runtime: the subs of `account` that carry independent approval evidence. */
export async function evidencedSubs(q: Query, account: { id: string; role: string }): Promise<Sub[]> {
  if (!(await has(q, "HrConfigChange"))) return [];
  const records = await loadGrantRecords(q, [account.id]);
  const verdicts = await judgeEvidence(q, records);
  return INVENTORY_PRIVILEGED.filter((s) => records.some((r) => verdicts.get(r.id)?.ok && grantedSubs(r, account.role).includes(s)));
}
