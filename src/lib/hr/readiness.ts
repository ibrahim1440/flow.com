// Decision C GAP-9 — the pre-activation READINESS CHECK of live payroll (read only). Turning live
// payroll on (HrSettings.payrollLive; ./payroll-lock) is refused while it reports any finding
// (config-change.ts, PAYROLL_LIVE_SET). It reads accounts, permissions and verified identities only —
// no pay, credentials or personal data.
//
// Findings (all BLOCKING):
//   CONFLICTING_PERMISSIONS   an active account whose EFFECTIVE permissions (stored, or its role's
//                             defaults — an `admin` on role defaults holds every payroll duty) hold a
//                             conflict pair of ./sod;
//   PRIVILEGED_UNVERIFIED     an active account holding a segregated duty or the admin role whose login
//                             is not linked to a verified person;
//   PRIVILEGED_NO_USERNAME    the same, without a username (privileged accounts sign in by username);
//   PERSON_CONFLICT           one person (identity.personsOf) whose active logins TOGETHER hold a pair;
//   ACCOUNT_EDITOR_CONFLICT   a person holding account editing (AE) whose logins together hold a pair;
//   ACCOUNT_EDITORS_FEWER_THAN_TWO   fewer than 2 distinct verified persons hold account editing;
//   ROLE_NOT_COVERED          a profile of the responsibility matrix has no verified holder
//                             (P1 + P2: two distinct persons with policy_manage; P3 payroll_prepare;
//                             P4 payroll_approve; P6 payroll_pay);
//   ACCOUNT_KEYS_UNMAPPED     an HR posting key (policy.ACCOUNT_KEYS) with no account mapped (re-review
//                             R1: the release gate needs the whole posting map; the accountant attests it);
//   SWITCH_REQUIRES_RELEASE_STEP  the database login cannot write HrSettings.payrollLive (re-review R4:
//                             the release grants reserve the switch for an owner-run migration).
// Admin role defaults (decision): FLAGGED as blocking (CONFLICTING_PERMISSIONS) rather than silently
// stripped — stripping would change running accounts without review; the gate forces every
// administrator onto explicit, reviewed permissions before payroll goes live.
import { type Db } from "./core";
import { ACCOUNT_KEYS } from "./services/policy";
import { identityOfMany, personsOf } from "./identity";
import { effectivePermissions, payrollDuties, payrollDutyConflicts, PAYROLL_CONFLICT_PAIRS, type PayrollSodDuty } from "./sod";
import { isSimpleMode } from "@/lib/simple-mode";

/** SIMPLE MODE: findings that only a team of several verified persons can clear. */
const SIMPLE_MODE_WAIVED = new Set(["CONFLICTING_PERMISSIONS", "PRIVILEGED_UNVERIFIED", "PERSON_CONFLICT", "ACCOUNT_EDITOR_CONFLICT", "ACCOUNT_EDITORS_FEWER_THAN_TWO", "ROLE_NOT_COVERED"]);

export type ReadinessFinding = { code: string; severity: "BLOCKING"; accounts?: { id: string; name: string }[]; detail: string; pairs?: [PayrollSodDuty, PayrollSodDuty][] };
export type Readiness = { ready: boolean; findings: ReadinessFinding[]; checkedAccounts: number };

const PROFILES: { profile: string; duty: PayrollSodDuty; persons: number }[] = [
  { profile: "P1+P2 policy preparer and approver (policy_manage)", duty: "policy_manage", persons: 2 },
  { profile: "P3 payroll preparer (payroll_prepare)", duty: "payroll_prepare", persons: 1 },
  { profile: "P4 payroll approver (payroll_approve)", duty: "payroll_approve", persons: 1 },
  { profile: "P6 payment recorder (payroll_pay)", duty: "payroll_pay", persons: 1 },
];

export async function payrollReadiness(db: Db): Promise<Readiness> {
  const rows = await db.employee.findMany({ where: { active: true }, select: { id: true, name: true, role: true, permissions: true, username: true } });
  const identity = await identityOfMany(db, rows.map((r) => r.id));
  const acc = rows.map((r) => {
    const eff = effectivePermissions(r.permissions as string | null, r.role);
    return { id: r.id, name: r.name, role: r.role, username: r.username, duties: payrollDuties(eff), conflicts: payrollDutyConflicts(eff), verified: !!identity.get(r.id)?.verified };
  });
  const findings: ReadinessFinding[] = [];
  const ref = (a: { id: string; name: string }) => ({ id: a.id, name: a.name });

  for (const a of acc.filter((x) => x.conflicts.length)) {
    findings.push({ code: "CONFLICTING_PERMISSIONS", severity: "BLOCKING", accounts: [ref(a)], pairs: a.conflicts, detail: a.role === "admin" ? "Admin account with conflicting duties (role defaults grant every payroll duty): give it explicit, reviewed permissions." : "Account holds conflicting duties." });
  }
  const privileged = acc.filter((x) => x.duties.length || x.role === "admin");
  for (const a of privileged.filter((x) => !x.verified)) findings.push({ code: "PRIVILEGED_UNVERIFIED", severity: "BLOCKING", accounts: [ref(a)], detail: "Privileged account not linked to a verified person." });
  for (const a of privileged.filter((x) => !x.username)) findings.push({ code: "PRIVILEGED_NO_USERNAME", severity: "BLOCKING", accounts: [ref(a)], detail: "Privileged account without a username." });

  // Persons: active privileged logins grouped by a shared HR person (every link ever made).
  const keys = new Map<string, Set<string>>();
  for (const a of privileged) keys.set(a.id, await personsOf(db, [a.id]));
  const parent = new Map(privileged.map((a) => [a.id, a.id]));
  const find = (x: string): string => (parent.get(x) === x ? x : find(parent.get(x)!));
  for (let i = 0; i < privileged.length; i++) for (let j = i + 1; j < privileged.length; j++) {
    const a = keys.get(privileged[i].id)!, b = keys.get(privileged[j].id)!;
    if ([...a].some((k) => b.has(k))) parent.set(find(privileged[i].id), find(privileged[j].id));
  }
  const groups = new Map<string, typeof privileged>();
  for (const a of privileged) groups.set(find(a.id), [...(groups.get(find(a.id)) ?? []), a]);
  const persons = [...groups.values()];
  for (const g of persons) {
    const all = new Set(g.flatMap((a) => a.duties));
    const pairs = PAYROLL_CONFLICT_PAIRS.filter(([x, y]) => all.has(x) && all.has(y));
    // Pairs no single login holds: they arise only by combining the person's logins.
    const cross = pairs.filter(([x, y]) => !g.some((a) => a.duties.includes(x) && a.duties.includes(y)));
    if (g.length > 1 && cross.length) findings.push({ code: "PERSON_CONFLICT", severity: "BLOCKING", accounts: g.map(ref), pairs: cross, detail: "One person's logins together hold conflicting duties." });
    if (all.has("accounts_edit") && pairs.length) findings.push({ code: "ACCOUNT_EDITOR_CONFLICT", severity: "BLOCKING", accounts: g.map(ref), pairs, detail: "An account editor (AE) whose logins hold conflicting duties." });
  }
  const verifiedPersons = (duty: PayrollSodDuty) => persons.filter((g) => g.some((a) => a.verified && a.duties.includes(duty))).length;
  const ae = verifiedPersons("accounts_edit");
  if (ae < 2) findings.push({ code: "ACCOUNT_EDITORS_FEWER_THAN_TWO", severity: "BLOCKING", detail: `Account editing needs two distinct verified persons (AE1 / AE2); found ${ae}.` });
  for (const p of PROFILES) {
    const n = verifiedPersons(p.duty);
    if (n < p.persons) findings.push({ code: "ROLE_NOT_COVERED", severity: "BLOCKING", detail: `${p.profile}: needs ${p.persons} distinct verified person(s); found ${n}.` });
  }
  // Re-review R1 (release gate): every HR posting key is mapped — the ledger lock protects exactly the
  // mapped (and ever-mapped) accounts. WHICH account each key maps to is the accountant's decision,
  // attested at the release gate (RUNBOOK §10.9); nothing here proposes or creates one.
  const mapped = new Set((await db.hrAccountMap.findMany({ select: { key: true } })).map((m) => m.key));
  const unmapped = ACCOUNT_KEYS.filter((k) => !mapped.has(k));
  if (unmapped.length) findings.push({ code: "ACCOUNT_KEYS_UNMAPPED", severity: "BLOCKING", detail: `${unmapped.length} of ${ACCOUNT_KEYS.length} HR posting keys are not mapped to an account (${unmapped.join(", ")}); the accountant maps them (two people).` });
  // Re-review R4: in a release the runtime login cannot write the switch at all (grant-hr-runtime.sql).
  const [p] = await db.$queryRaw<{ ok: boolean }[]>`SELECT has_column_privilege(current_user, '"HrSettings"', 'payrollLive', 'UPDATE') AND has_column_privilege(current_user, '"HrSettings"', 'payrollLiveChangeId', 'UPDATE') AS ok`;
  if (!p?.ok) findings.push({ code: "SWITCH_REQUIRES_RELEASE_STEP", severity: "BLOCKING", detail: "The application's database login cannot write the live-payroll switch: turning it on is an owner-run release step (a migration)." });
  // SIMPLE MODE: the person-based findings (verified identities, duty conflicts, two distinct persons)
  // do not block a single owner; the posting-map, username and release-step findings still do.
  if (isSimpleMode()) {
    const kept = findings.filter((f) => !SIMPLE_MODE_WAIVED.has(f.code));
    return { ready: kept.length === 0, findings: kept, checkedAccounts: rows.length };
  }
  return { ready: findings.length === 0, findings, checkedAccounts: rows.length };
}
