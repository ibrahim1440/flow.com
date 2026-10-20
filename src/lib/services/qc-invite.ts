import { randomUUID } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { emitAutomationEvent, requestAutomationDispatch } from "@/lib/automation/emit";
import { normalizePhoneForWhatsApp } from "@/lib/automation/phone";
import { effectiveMode, readSettings } from "@/lib/automation/settings";

type Tx = Prisma.TransactionClient;

/**
 * Guest evaluators (production simplification item 5b; owner decision D4 — only qc › manage).
 *
 *   · PRESENT — the guest evaluates on the inviting device: the existing guest form
 *     (/guest-qc/[batchId]/[token]) opens with the name filled in. No new evaluation endpoint.
 *   · LINK — the guest gets the batch's guest link. With a phone it goes through the existing
 *     WhatsApp automation as a queued WhatsAppMessage, under AutomationSettings.sendMode exactly
 *     as every automated message is: OFF records it as SKIPPED (nothing is sent), TEST sends it to
 *     the test number only, LIVE (and only with WHATSAPP_LIVE_ENABLED=true on the deployment)
 *     sends it to the guest. The screen always offers the link to copy as the fallback.
 *
 * Each invite is a QcInvite row, PENDING until a guest record with the same name arrives (DONE),
 * or the panel is decided (CANCELLED). The link carries the batch only — never the order or the
 * customer (the guest API reads the bean and the batch number, nothing else).
 */
export { GUEST_NAME_MAX, cleanGuestName, sameGuestName, guestInviteText } from "@/lib/qc-guest";
import { guestInviteText } from "@/lib/qc-guest";

/** The batch's guest token, created on first use (the token dies with the QC decision). */
export async function ensureGuestToken(tx: Tx, batch: { id: string; qcToken: string | null }): Promise<string> {
  if (batch.qcToken) return batch.qcToken;
  const token = randomUUID().replace(/-/g, "");
  // Conditional: two managers inviting at once share one token instead of overwriting it.
  const set = await tx.roastingBatch.updateMany({ where: { id: batch.id, qcToken: null }, data: { qcToken: token } });
  if (set.count === 1) return token;
  const row = await tx.roastingBatch.findUnique({ where: { id: batch.id }, select: { qcToken: true } });
  return row?.qcToken ?? token;
}

export type InviteResult = {
  invite: { id: string; channel: string; name: string; status: string };
  token: string;
  url: string;
  whatsapp: null | { status: "QUEUED" | "SKIPPED"; mode: "OFF" | "TEST" | "LIVE"; note: string | null };
};

export async function createQcInvite(tx: Tx, args: {
  batch: { id: string; qcToken: string | null };
  channel: "PRESENT" | "LINK";
  name: string;
  phone: string | null;
  origin: string;
  actorId: string;
}): Promise<InviteResult> {
  const token = await ensureGuestToken(tx, args.batch);
  const url = `${args.origin}/guest-qc/${args.batch.id}/${token}`;
  let phone: string | null = null;
  if (args.phone) {
    const p = normalizePhoneForWhatsApp(args.phone);
    if (!p.ok) throw { _appCode: 400, message: "رقم الجوال غير صالح لواتساب.", errorEn: `Phone: ${p.reason}`, code: "INVALID_PHONE" };
    phone = p.phone;
  }
  const invite = await tx.qcInvite.create({
    data: { batchId: args.batch.id, channel: args.channel, name: args.name, phone, createdById: args.actorId },
    select: { id: true, channel: true, name: true, status: true },
  });

  let whatsapp: InviteResult["whatsapp"] = null;
  if (args.channel === "LINK" && phone) {
    const mode = effectiveMode(await readSettings(tx));
    const base = {
      dedupeKey: `qc-invite:${invite.id}`,
      eventType: "qc.guest_invited",
      subjectType: "RoastingBatch",
      subjectId: args.batch.id,
      recipientKind: "qc_guest",
      recipientName: args.name,
      body: guestInviteText(args.name, url),
      createdById: args.actorId,
      ruleName: "دعوة مقيّم ضيف",
    };
    const row =
      mode.mode === "OFF"
        ? { ...base, phone, status: "SKIPPED" as const, statusNote: mode.note }
        : mode.mode === "TEST"
          ? { ...base, phone: mode.testPhone, intendedPhone: phone, status: "QUEUED" as const }
          : { ...base, phone, status: "QUEUED" as const };
    const msg = await tx.whatsAppMessage.create({ data: row, select: { id: true } });
    await tx.qcInvite.update({ where: { id: invite.id }, data: { messageId: msg.id } });
    whatsapp = { status: row.status, mode: mode.mode, note: mode.mode === "OFF" ? mode.note : null };
    if (row.status === "QUEUED") requestAutomationDispatch();
  }

  // For rules that want to hear about invitations (e.g. tell the QC lead). The guest's phone is
  // not in the payload: the message above is the only place it is used.
  await emitAutomationEvent(tx, {
    eventType: "qc.guest_invited",
    subjectType: "RoastingBatch",
    subjectId: args.batch.id,
    payload: { guestName: args.name, channel: args.channel },
    actorId: args.actorId,
  });

  return { invite, token, url, whatsapp };
}
