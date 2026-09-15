import type { Prisma } from "@/generated/prisma/client";

/**
 * Audit for employee administration.
 *
 * Creating an account, changing its role, changing its permissions, deactivating it and
 * deleting it are the highest-privilege operations in the system — they decide who may do
 * everything else — and none of them left any trace. An order line cannot change quantity
 * without an activity row, but somebody could be made an administrator with nothing written
 * down anywhere.
 *
 * ── Why AuthAuditLog and not a new table ───────────────────────────────────
 * AuthAuditLog already exists in the schema (migration 20260624120000) with exactly the
 * right shape — actor, action, result, reasonCode, ipHash, userAgent, a JSON metadata column
 * and a timestamp — and, until this change, nothing had ever written to it. These are
 * authorization events, which is what that log is for, so no migration is needed and none is
 * taken. OrderActivity is deliberately NOT used: it belongs to a customer order's timeline,
 * and employee administration has no order.
 *
 * ── The audit is a control, not telemetry ──────────────────────────────────
 * The write happens in the SAME transaction as the change it describes, and a failure to
 * record is a failure of the request. An earlier version logged the error and returned
 * success, which quietly recreated the gap this exists to close: a role change that happened
 * with no record of it happening is indistinguishable, afterwards, from one that never did.
 * If the two cannot both be committed, neither is.
 *
 * ── What is never recorded ─────────────────────────────────────────────────
 * No PIN, no password, no bcrypt hash, no lookup value — not even a redacted one. Whether a
 * credential CHANGED is auditable and useful; the credential itself is not, and a log that
 * holds it is a second place to steal it from.
 */

export type EmployeeAuditAction =
  | "EMPLOYEE_CREATED"
  | "EMPLOYEE_ROLE_CHANGED"
  | "EMPLOYEE_PERMISSIONS_CHANGED"
  | "EMPLOYEE_ACTIVATED"
  | "EMPLOYEE_DEACTIVATED"
  | "EMPLOYEE_CREDENTIAL_CHANGED"
  | "EMPLOYEE_DELETED";

export type EmployeeAuditEntry = {
  action: EmployeeAuditAction;
  targetEmployeeId: string;
  targetName?: string | null;
  metadata?: Record<string, unknown>;
};

/** Who did it and from where — the address already hashed, never stored raw. */
export type AuditContext = {
  actorId: string;
  ipHash: string;
  userAgent: string | null;
};

type AuditWriter = {
  authAuditLog: {
    createMany: (args: { data: Prisma.AuthAuditLogCreateManyInput[] }) => Promise<unknown>;
  };
};

/**
 * One changed authorization setting, named the way an auditor would ask about it.
 *
 * `path` is "<module>.access" for the module's own level, or "<module>.<subKey>" for an
 * individual privilege — "production.start_batch", "settings.reset" — so the record answers
 * "what may they now do that they could not?" rather than merely "something changed".
 */
export type PermissionChange = {
  path: string;
  from: unknown;
  to: unknown;
};

/**
 * Bounded so one sweeping regrant cannot write an unbounded document into the audit log.
 * Sixty is far above any real change — the whole permission model is fifteen modules and
 * about thirty sub-privileges — and a change larger than that is reported as truncated
 * rather than silently trimmed.
 */
export const PERMISSION_DIFF_LIMIT = 60;

type ParsedPermissions = Record<string, { access?: unknown; sub?: Record<string, unknown> }>;

function parsePermissionDocument(raw: unknown): ParsedPermissions {
  try {
    const obj = typeof raw === "string" ? JSON.parse(raw) : raw;
    return obj && typeof obj === "object" ? (obj as ParsedPermissions) : {};
  } catch {
    // Unparseable input yields an empty document rather than throwing: a permission blob
    // nobody can read is a change worth recording, not a reason to fail the request.
    return {};
  }
}

/**
 * The exact difference between two permission documents.
 *
 * A fingerprint proves only that something changed. An auditor asked to explain why an
 * operator could suddenly authorize surplus production needs the setting, its old value and
 * its new one, which is what this produces.
 */
export function diffPermissions(
  before: unknown,
  after: unknown,
): { changes: PermissionChange[]; truncated: boolean } {
  const a = parsePermissionDocument(before);
  const b = parsePermissionDocument(after);

  const changes: PermissionChange[] = [];
  const modules = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();

  for (const mod of modules) {
    const beforeModule = a[mod] ?? {};
    const afterModule = b[mod] ?? {};

    const beforeAccess = beforeModule.access ?? null;
    const afterAccess = afterModule.access ?? null;
    if (JSON.stringify(beforeAccess) !== JSON.stringify(afterAccess)) {
      changes.push({ path: `${mod}.access`, from: beforeAccess, to: afterAccess });
    }

    const beforeSub = (beforeModule.sub ?? {}) as Record<string, unknown>;
    const afterSub = (afterModule.sub ?? {}) as Record<string, unknown>;
    for (const key of [...new Set([...Object.keys(beforeSub), ...Object.keys(afterSub)])].sort()) {
      const from = beforeSub[key] ?? null;
      const to = afterSub[key] ?? null;
      if (JSON.stringify(from) !== JSON.stringify(to)) {
        changes.push({ path: `${mod}.${key}`, from, to });
      }
    }
  }

  if (changes.length > PERMISSION_DIFF_LIMIT) {
    return { changes: changes.slice(0, PERMISSION_DIFF_LIMIT), truncated: true };
  }
  return { changes, truncated: false };
}

/**
 * Work out which events an edit represents, by comparing the row before and after.
 *
 * Derived from the actual change rather than from what the request asked for: a request that
 * sets the role to what it already was is not a role change, and should not read like one
 * six months later.
 */
export function diffEmployeeChange(
  before: { role: string; active: boolean; permissions: string },
  after: { role: string; active: boolean; permissions: string },
  credentialsChanged: { pin?: boolean; password?: boolean },
): { action: EmployeeAuditAction; metadata: Record<string, unknown> }[] {
  const events: { action: EmployeeAuditAction; metadata: Record<string, unknown> }[] = [];

  if (before.role !== after.role) {
    events.push({
      action: "EMPLOYEE_ROLE_CHANGED",
      metadata: { oldRole: before.role, newRole: after.role },
    });
  }
  if (before.active !== after.active) {
    events.push({
      action: after.active ? "EMPLOYEE_ACTIVATED" : "EMPLOYEE_DEACTIVATED",
      metadata: { oldActive: before.active, newActive: after.active },
    });
  }

  const permissions = diffPermissions(before.permissions, after.permissions);
  if (permissions.changes.length > 0) {
    events.push({
      action: "EMPLOYEE_PERMISSIONS_CHANGED",
      metadata: { changes: permissions.changes, truncated: permissions.truncated },
    });
  }

  // Which class of credential was replaced, and nothing whatsoever about its value.
  const classes = [
    credentialsChanged.pin ? "pin" : null,
    credentialsChanged.password ? "password" : null,
  ].filter(Boolean);
  if (classes.length > 0) {
    events.push({ action: "EMPLOYEE_CREDENTIAL_CHANGED", metadata: { credentials: classes } });
  }

  return events;
}

/**
 * Write the events.
 *
 * Takes the transaction client, not the global one, so the caller can commit the change and
 * its record together. Errors propagate: if the audit cannot be written the transaction must
 * fail with it.
 */
export async function recordEmployeeAudit(
  client: AuditWriter,
  context: AuditContext,
  entries: EmployeeAuditEntry[],
): Promise<void> {
  if (entries.length === 0) return;
  await client.authAuditLog.createMany({
    data: entries.map((e) => ({
      userId: context.actorId,
      action: e.action,
      result: "SUCCESS",
      sourceInterface: "WEB",
      ipHash: context.ipHash,
      userAgent: context.userAgent,
      metadata: {
        targetEmployeeId: e.targetEmployeeId,
        ...(e.targetName ? { targetName: e.targetName } : {}),
        ...(e.metadata ?? {}),
      } as Prisma.InputJsonValue,
    })),
  });
}

/**
 * Serialise security-sensitive administration of one employee.
 *
 * Reading the row inside a transaction proves nothing on its own. A plain SELECT takes no
 * lock, so under READ COMMITTED another administrator can change the same employee between
 * this transaction's read and its write. Two consequences, both real:
 *
 *   - the audit lies. The diff is computed against a `before` that was already history when
 *     the update landed, so the record describes a transition out of a state that no longer
 *     existed — the one thing an audit log may never do.
 *   - changes are lost. `permissions` is a single document; two administrators editing an
 *     employee at once write whole blobs, and the later one silently discards the earlier
 *     one's grant with nothing to show it happened.
 *
 * So role, active, permissions, credentials and deletion all queue behind this lock, and
 * every one of them derives its validation, its diff and its write from the row it locked.
 *
 * Returns false when the employee does not exist, which is how the caller tells a 404 from a
 * successful lock — and is also how a concurrent delete is detected, since the row is gone
 * by the time this transaction acquires it.
 */
export async function lockEmployeeForAdmin(
  tx: { $queryRaw: (q: TemplateStringsArray, ...v: unknown[]) => Promise<unknown> },
  id: string,
): Promise<boolean> {
  const rows = (await tx.$queryRaw`
    SELECT "id" FROM "Employee" WHERE "id" = ${id} FOR UPDATE`) as { id: string }[];
  return rows.length > 0;
}
