// N-04: the order timeline in Arabic. The server writes each activity's `message` in English
// (an audit string, unchanged); this turns the known event types into Arabic from the
// activity's structured `metadata`, falling back to the known English message patterns.
// Text a person typed (a note, a hold / cancel / reject reason, a surplus reason) is shown as
// typed. A system message that matches nothing known is not shown in Arabic — the event title,
// author and time still are — so no English server sentence reaches the Arabic timeline.
// Presentation only: nothing here is sent back to the server.
import { countNoun, ITEM_FORMS, UNIT_FORMS } from "@/components/ops/ui";

export type ActivityLike = { type: string; message: string; metadata?: unknown };

export type ActivityText = {
  /** A reference shown with the title (a production order number), LTR-isolated. */
  ref: string | null;
  /** The event's details in Arabic, or null. */
  detail: string | null;
  /** Text a person typed, shown verbatim. */
  userText: string | null;
};

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);
const meta = (a: ActivityLike): Record<string, unknown> => (a.metadata && typeof a.metadata === "object" && !Array.isArray(a.metadata) ? (a.metadata as Record<string, unknown>) : {});
const kgAr = (v: number) => `${v.toFixed(2)} كغ`;
const units = (n: number) => countNoun(n, "ar", UNIT_FORMS);
const hasArabic = (s: string) => /[؀-ۿ]/.test(s);

/** «… by NAME: reason» → the reason, when the message carries one. */
function reasonAfterBy(message: string): string | null {
  const m = /^[^:]*? by [^:]+?: ([\s\S]+)$/.exec(message);
  return m ? m[1].trim() || null : null;
}

export function activityTextAr(a: ActivityLike, statusLabel: (status: string) => string): ActivityText {
  const m = meta(a);
  const msg = a.message ?? "";
  const out: ActivityText = { ref: null, detail: null, userText: null };
  switch (a.type) {
    case "MANUAL_NOTE":
      out.userText = msg || null;
      return out;
    case "ORDER_HELD":
    case "ORDER_CANCELLED":
    case "ORDER_COMPLETED":
    case "ORDER_REJECTED": {
      const r = a.type === "ORDER_REJECTED" ? (/^Order rejected: ([\s\S]+)$/.exec(msg)?.[1] ?? null) : reasonAfterBy(msg);
      out.userText = r ? r.trim() : null;
      return out;
    }
    case "ORDER_RESUMED":
    case "STATUS_CHANGED": {
      const s = /(?:Status recomputed to|Status set to) (.+?)\.$/.exec(msg)?.[1];
      if (s) out.detail = `الحالة: ${statusLabel(s)}`;
      return out;
    }
    case "OWNER_CHANGED": {
      // «Order owner changed by NAME: A → B.» / the recompute's assignment — the two names from
      // the metadata, so Arabic never shows the English sentence.
      const from = str(m.fromOwnerName) ?? "بلا مسؤول";
      const to = str(m.toOwnerName) ?? "بلا مسؤول";
      out.detail = m.trigger === "release_recompute" ? `عُيّن ${to} (منشئ الطلب)` : `من ${from} إلى ${to}`;
      return out;
    }
    case "ORDER_APPROVED": {
      const who = /Ownership transferred to (.+?)\.$/.exec(msg)?.[1];
      if (who) out.detail = `انتقلت الملكية إلى ${who}`;
      return out;
    }
    case "PREPARATION_REVIEWED": {
      const items = Array.isArray(m.items) ? m.items.length : num(/for (\d+) item\(s\)/.exec(msg)?.[1]);
      const s = /Order status set to (.+?)\.(?: |$)/.exec(msg)?.[1];
      const parts: string[] = [];
      if (items !== null) parts.push(countNoun(items, "ar", ITEM_FORMS));
      if (s) parts.push(`الحالة: ${statusLabel(s)}`);
      // «Order claimed by NAME.» — ownership taken with this review; kept so Arabic loses nothing.
      const claimedBy = /Order claimed by (.+?)\.$/.exec(msg)?.[1];
      if (claimedBy) parts.push(`استلمه ${claimedBy}`);
      out.detail = parts.length ? parts.join(" · ") : null;
      return out;
    }
    case "PRODUCTION_ORDER_CREATED": {
      out.ref = str(m.productionNumber) ?? /^Production order (\S+)/.exec(msg)?.[1] ?? null;
      const u = num(m.targetUnits) ?? num(/raised for (\d+) ×/.exec(msg)?.[1]);
      out.detail = u !== null ? units(u) : null;
      return out;
    }
    case "PRODUCTION_ORDER_RELEASED":
    case "PRODUCTION_ORDER_COMPLETED":
    case "PRODUCTION_ORDER_CANCELLED": {
      out.ref = str(m.productionNumber) ?? /^Production order (\S+)/.exec(msg)?.[1] ?? null;
      const u = num(/\((\d+) × /.exec(msg)?.[1]);
      out.detail = u !== null ? units(u) : null;
      out.userText = reasonAfterBy(msg);
      return out;
    }
    case "PRODUCTION_BATCH_LINKED":
    case "PRODUCTION_BATCH_UNLINKED": {
      const r = /^Batch (\S+)(?: \(([\d.]+) kg roasted\))? (?:linked to|unlinked from) production order (\S+?) by /.exec(msg);
      out.ref = r?.[3] ?? null;
      const batch = str(m.batchNumber) ?? r?.[1] ?? null;
      const kg = num(r?.[2]);
      out.detail = batch ? `الدفعة ${batch}${kg !== null ? ` · ${kgAr(kg)} محمّص` : ""}` : null;
      return out;
    }
    case "STOCK_RESERVED_FROM_PACKAGING": {
      const u = num(m.units) ?? num(/^(\d+) unit\(s\)/.exec(msg)?.[1]);
      const batch = /packaging batch (\S+?),/.exec(msg)?.[1] ?? null;
      const parts: string[] = [];
      if (u !== null) parts.push(units(u));
      if (batch) parts.push(`من دفعة التعبئة ${batch}`);
      out.detail = parts.length ? parts.join(" · ") : null;
      return out;
    }
    case "PRODUCTION_SURPLUS_OVERRIDDEN": {
      const r = /on batch (\S+?): ([\d.]+)kg roasted against a ([\d.]+)kg ceiling/.exec(msg);
      const batch = str(m.batchNumber) ?? r?.[1] ?? null;
      const req = num(m.requestedKg) ?? num(r?.[2]);
      const ceil = num(m.ceilingKg) ?? num(r?.[3]);
      const parts: string[] = [];
      if (batch) parts.push(`الدفعة ${batch}`);
      if (req !== null && ceil !== null) parts.push(`${kgAr(req)} مقابل حد ${kgAr(ceil)}`);
      out.detail = parts.length ? parts.join(" · ") : null;
      out.userText = str(m.reason) ?? (/ Reason: ([\s\S]+)$/.exec(msg)?.[1] ?? null);
      return out;
    }
    case "ORDER_ITEMS_EDITED": {
      const r = /: (\d+) changed, (\d+) added, (\d+) removed\.$/.exec(msg);
      if (r) out.detail = `عُدّل ${r[1]} · أُضيف ${r[2]} · حُذف ${r[3]}`;
      return out;
    }
    default:
      // An unknown event: show it only if it is already Arabic (typed text); never an English
      // server sentence.
      out.userText = msg && hasArabic(msg) ? msg : null;
      return out;
  }
}
