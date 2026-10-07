/**
 * Rule conditions: every condition must hold (AND) for a rule to act.
 *
 * Pure. Values are compared as the stored codes, never as display labels, so a condition on
 * "status.to equals Ready for Shipping" keeps working whatever language the message is in.
 */
import type { RenderContext } from "./template";

export const CONDITION_OPS = [
  "eq",
  "neq",
  "contains",
  "not_contains",
  "empty",
  "not_empty",
  "gt",
  "gte",
  "lt",
  "lte",
] as const;

export type ConditionOp = (typeof CONDITION_OPS)[number];

export type Condition = { field: string; op: ConditionOp; value?: string };

export const OPS_WITHOUT_VALUE: ReadonlySet<ConditionOp> = new Set(["empty", "not_empty"]);
export const NUMERIC_OPS: ReadonlySet<ConditionOp> = new Set(["gt", "gte", "lt", "lte"]);

export const CONDITION_OP_LABELS: Record<ConditionOp, { ar: string; en: string }> = {
  eq: { ar: "يساوي", en: "equals" },
  neq: { ar: "لا يساوي", en: "does not equal" },
  contains: { ar: "يحتوي", en: "contains" },
  not_contains: { ar: "لا يحتوي", en: "does not contain" },
  empty: { ar: "فارغ", en: "is empty" },
  not_empty: { ar: "غير فارغ", en: "is not empty" },
  gt: { ar: "أكبر من", en: "greater than" },
  gte: { ar: "أكبر من أو يساوي", en: "at least" },
  lt: { ar: "أصغر من", en: "less than" },
  lte: { ar: "أصغر من أو يساوي", en: "at most" },
};

export function isConditionOp(value: unknown): value is ConditionOp {
  return typeof value === "string" && (CONDITION_OPS as readonly string[]).includes(value);
}

const norm = (x: unknown) => (x === null || x === undefined ? "" : String(x)).trim().toLowerCase();

function toNumber(x: unknown): number | null {
  const s = norm(x).replace(/,/g, "");
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function evaluateCondition(c: Condition, ctx: RenderContext): boolean {
  const actual = ctx[c.field];
  const a = norm(actual);
  const b = norm(c.value);
  switch (c.op) {
    case "eq":
      return a === b;
    case "neq":
      return a !== b;
    case "contains":
      return a.includes(b);
    case "not_contains":
      return !a.includes(b);
    case "empty":
      return a === "";
    case "not_empty":
      return a !== "";
    default: {
      const x = toNumber(actual);
      const y = toNumber(c.value);
      if (x === null || y === null) return false;
      if (c.op === "gt") return x > y;
      if (c.op === "gte") return x >= y;
      if (c.op === "lt") return x < y;
      return x <= y;
    }
  }
}

/** The first condition that does not hold, or null when all do. */
export function firstFailingCondition(conditions: Condition[], ctx: RenderContext): Condition | null {
  for (const c of conditions) if (!evaluateCondition(c, ctx)) return c;
  return null;
}
