// The WhatsApp Cloud API webhook payload, reduced to what the application acts on. Pure.

export type StatusEvent = { providerId: string; status: "sent" | "delivered" | "read" | "failed"; at: Date; recipient: string; errorText: string | null; billable: boolean | null; category: string | null };
export type InboundText = { from: string; text: string; at: Date };

/** The parts of a webhook this application acts on: message statuses and inbound text (opt-out). */
export function parseWebhook(payload: unknown): { statuses: StatusEvent[]; inbound: InboundText[] } {
  const statuses: StatusEvent[] = [];
  const inbound: InboundText[] = [];
  const entries = (payload as { entry?: unknown[] })?.entry ?? [];
  for (const e of entries as { changes?: { value?: Record<string, unknown> }[] }[]) {
    for (const c of e.changes ?? []) {
      const v = c.value ?? {};
      for (const s of (v.statuses as Record<string, unknown>[] | undefined) ?? []) {
        const st = String(s.status);
        if (!["sent", "delivered", "read", "failed"].includes(st)) continue;
        const errs = (s.errors as { title?: string; message?: string }[] | undefined) ?? [];
        const pricing = s.pricing as { billable?: boolean; category?: string } | undefined;
        statuses.push({
          providerId: String(s.id), status: st as StatusEvent["status"], at: new Date(Number(s.timestamp) * 1000 || Date.now()),
          recipient: String(s.recipient_id ?? ""), errorText: errs[0] ? String(errs[0].title ?? errs[0].message ?? "").slice(0, 300) : null,
          billable: typeof pricing?.billable === "boolean" ? pricing.billable : null, category: pricing?.category ?? null,
        });
      }
      for (const m of (v.messages as Record<string, unknown>[] | undefined) ?? []) {
        const text = (m.text as { body?: string } | undefined)?.body ?? (m.button as { text?: string } | undefined)?.text ?? "";
        if (m.from) inbound.push({ from: String(m.from), text: String(text).slice(0, 1000), at: new Date(Number(m.timestamp) * 1000 || Date.now()) });
      }
    }
  }
  return { statuses, inbound };
}

/** «إيقاف», «الغاء», STOP, UNSUBSCRIBE … — an inbound message that withdraws marketing consent. */
export function isOptOutText(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[إأآ]/g, "ا").replace(/ى/g, "ي");
  return /^(stop|unsubscribe|ايقاف|الغاء|لا ارغب|توقف)(\s|$|[.!،])/.test(t);
}
