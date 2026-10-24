// ZATCA Phase 2 (A4) — the document pipeline: issue → sign → submit.
//
//   1. signAtIssue(tx, invoiceId) — INSIDE the A2 issue transaction, after the database numbered the document:
//      when e-invoicing is on, lock the active EGS unit's row (SELECT … FOR UPDATE: every issuer on this unit waits
//      here, so ICVs are assigned in commit order, without gaps or duplicates), take ICV = last + 1 and PIH = the
//      last hash, build the UBL from the frozen snapshot, hash (C14N 1.1), sign (ECDSA secp256k1), embed the XAdES
//      properties and the QR, store the signed bytes (ZatcaDocument, bytea) and move the unit's counter and hash —
//      all in that one transaction (the database re-checks the chain). A rollback consumes nothing: no number, no
//      ICV. Nothing is sent from inside the transaction.
//   2. submitDocument(id) — AFTER commit: clearance for a standard document (the issue route calls it at once, so
//      the invoice is shared only once CLEARED; the cleared XML ZATCA returns is stored as the official copy), or
//      reporting for a simplified one (the queue: cron /api/cron/zatca-reporting, or on demand). Same signed bytes
//      every attempt (idempotent on UUID / hash / ICV); a lease keeps two workers off one document.
//   3. A rejection leaves the invoice ISSUED with zatcaStatus REJECTED and alerts the owner: the fix is a credit
//      note and a new invoice. The signed XML is never touched.
import type { Prisma } from "@/generated/prisma/client";
import { prisma, TX_OPTS } from "@/lib/db";
import { createHash } from "node:crypto";
import { notify } from "@/lib/notifications/notify";
import { REPORTING_WINDOW_MS, effectiveMode, serverAllows, type ZatcaMode } from "./config";
import { certFromToken, loadPrivateKey, openSecret } from "./crypto";
import { ublInput, ublProblems, sellerOf, type IssuedForUbl } from "./document";
import { backoffMs, callFatoora, classify, type Validation } from "./fatoora";
import { refuseZatca } from "./refusals";
import { stamp } from "./sign";
import { buildUbl } from "./ubl";
import { writeLog } from "./log";

type Tx = Prisma.TransactionClient;
type Db = Tx | typeof prisma;

export async function readMode(db: Db): Promise<{ stored: ZatcaMode; mode: ZatcaMode; activeEgsId: string | null }> {
  const s = await db.zatcaSettings.findUnique({ where: { id: "singleton" } });
  const stored = (s?.mode ?? "OFF") as ZatcaMode;
  return { stored, mode: effectiveMode(stored), activeEgsId: s?.activeEgsId ?? null };
}

const sha256hex = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** The signing material of an EGS unit: its key and the ACTIVE production CSID (decrypted in memory only). */
async function signingMaterial(tx: Tx, egs: { id: string; privateKeyEnc: string | null }, kind: "PRODUCTION" | "COMPLIANCE" = "PRODUCTION") {
  const csid = await tx.zatcaCsid.findFirst({ where: { egsId: egs.id, kind, status: "ACTIVE" }, orderBy: { createdAt: "desc" } });
  if (!csid || !egs.privateKeyEnc) return null;
  return { csid, privateKey: loadPrivateKey(openSecret(egs.privateKeyEnc)), cert: certFromToken(openSecret(csid.tokenEnc)) };
}

export type SignedAtIssue = { documentId: string; icv: string; hash: string; flow: "CLEARANCE" | "REPORTING"; environment: string } | null;

/**
 * Sign an invoice that this transaction just issued. Returns null when e-invoicing is OFF (A2 behaviour). Throws a
 * coded refusal (rolling the issue back) when it is on but the EGS unit or the document is not ready.
 */
export async function signAtIssue(tx: Tx, invoiceId: string, now: Date = new Date()): Promise<SignedAtIssue> {
  const { stored, activeEgsId } = await readMode(tx);
  // OFF only when the OWNER switched it off. Switched on but not allowed by the server (ZATCA_ENABLED unset, or
  // production without ZATCA_PRODUCTION_ALLOWED): the issue is refused — never a silently unsigned tax invoice.
  if (stored === "OFF") return null;
  if (!serverAllows(stored)) throw refuseZatca(stored === "PRODUCTION" && process.env.ZATCA_ENABLED === "true" ? "PRODUCTION_NOT_ALLOWED" : "SERVER_DISABLED", "(switch e-invoicing OFF in the e-invoicing settings to issue without ZATCA)", "(أوقف الربط من إعدادات الفوترة الإلكترونية للإصدار دون الهيئة)");
  const mode = stored;
  if (!activeEgsId) throw refuseZatca("EGS_NOT_READY");
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "ZatcaEgsUnit" WHERE "id" = ${activeEgsId} FOR UPDATE`;
  if (!rows[0]) throw refuseZatca("EGS_NOT_READY");
  const egs = (await tx.zatcaEgsUnit.findUnique({ where: { id: activeEgsId } }))!;
  if (egs.environment !== mode) throw refuseZatca("EGS_ENVIRONMENT");
  if ((egs.csidState !== "PRODUCTION" && egs.csidState !== "RENEWED") || egs.retiredAt) throw refuseZatca("EGS_NOT_READY");
  const mat = await signingMaterial(tx, egs);
  if (!mat) throw refuseZatca("EGS_NOT_READY");

  const inv = await tx.salesInvoice.findUnique({
    where: { id: invoiceId },
    include: { lines: { orderBy: [{ position: "asc" }, { id: "asc" }] }, originalInvoice: { select: { number: true } } },
  });
  if (!inv || inv.status !== "ISSUED" || !inv.number) throw refuseZatca("NOT_FOUND");
  const doc = inv as unknown as IssuedForUbl;
  const problems = ublProblems(doc);
  if (problems.length) throw refuseZatca("NOT_SIGNABLE", problems.map((p) => p.en).join(" "), problems.map((p) => p.ar).join(" "), { problems });

  const icv = egs.icv + BigInt(1);
  const pih = egs.lastHash;
  const seller = sellerOf(doc);
  const timestamp = `${inv.issueDate!.toISOString().slice(0, 10)}T${inv.issueTime}`;
  const stamped = stamp({
    xml: buildUbl(ublInput(doc, { icv, pih })), privateKey: mat.privateKey, cert: mat.cert, timestamp,
    qr: { sellerName: seller.name, vatNumber: seller.vatNumber ?? "", total: Number(inv.grandTotal.toString()).toFixed(2), vat: Number(inv.taxTotal.toString()).toFixed(2), simplified: inv.family === "SIMPLIFIED" },
  });
  const bytes = Buffer.from(stamped.xml, "utf8");
  const flow = inv.family === "STANDARD" ? "CLEARANCE" : "REPORTING";
  await tx.zatcaEgsUnit.update({ where: { id: egs.id }, data: { icv, lastHash: stamped.hash, lastDocumentAt: now } });
  const created = await tx.zatcaDocument.create({
    data: {
      invoiceId, egsId: egs.id, csidId: mat.csid.id, environment: egs.environment, icv, pih, invoiceHash: stamped.hash, uuid: inv.uuid,
      flow, signedXml: bytes, signedXmlSha256: sha256hex(bytes), qr: stamped.qr, status: "PENDING", nextAttemptAt: now, signedAt: now,
      reportingDeadline: flow === "REPORTING" ? new Date((inv.issuedAt ?? now).getTime() + REPORTING_WINDOW_MS) : null,
    },
    select: { id: true },
  });
  await tx.salesInvoice.update({
    where: { id: invoiceId },
    data: { zatcaIcv: icv, zatcaPih: pih, zatcaInvoiceHash: stamped.hash, zatcaQr: stamped.qr, zatcaStatus: "PENDING", zatcaXmlRef: created.id },
  });
  return { documentId: created.id, icv: icv.toString(), hash: stamped.hash, flow, environment: egs.environment };
}

// ── submission ───────────────────────────────────────────────────────────────────────────────────────

const LEASE_MS = 90_000;

/** Take the document for one attempt (a lease): null when another worker holds it or it is not due / final. */
async function claim(id: string, force: boolean): Promise<boolean> {
  const n = await prisma.$executeRaw`
    UPDATE "ZatcaDocument" SET "leaseUntil" = now() + make_interval(secs => ${LEASE_MS / 1000}), "updatedAt" = now()
     WHERE "id" = ${id} AND "status" IN ('PENDING', 'ERROR') AND ("leaseUntil" IS NULL OR "leaseUntil" < now())
       AND (${force} OR "status" = 'PENDING') AND (${force} OR "nextAttemptAt" IS NULL OR "nextAttemptAt" <= now())`;
  return n === 1;
}

export type SubmitResult = { id: string; status: string; httpStatus: number | null; attempts: number; warnings: number; errors: number; reason?: string };

function messages(v: Validation | null) {
  return { warnings: v?.warnings.length ? (v.warnings as unknown as Prisma.InputJsonValue) : undefined, errors: v?.errors.length ? (v.errors as unknown as Prisma.InputJsonValue) : undefined };
}

/** One attempt at clearing / reporting a document. `force` = a person's resubmit (also retries an ERROR). */
export async function submitDocument(id: string, opts: { actorId?: string | null; force?: boolean } = {}): Promise<SubmitResult> {
  const head = await prisma.zatcaDocument.findUnique({ where: { id }, select: { id: true, status: true, attempts: true, environment: true } });
  if (!head) throw refuseZatca("NOT_FOUND");
  if (!["PENDING", "ERROR"].includes(head.status)) throw refuseZatca("FINAL");
  // The server's switch is also a kill switch for traffic: with ZATCA_ENABLED unset (or production not allowed) nothing
  // is sent — signed documents wait, PENDING, and go out once it is allowed again (the 24-hour clock keeps running).
  if (!serverAllows(head.environment as ZatcaMode)) throw refuseZatca(head.environment === "PRODUCTION" ? "PRODUCTION_NOT_ALLOWED" : "SERVER_DISABLED");
  if (!(await claim(id, !!opts.force))) {
    const now = await prisma.zatcaDocument.findUnique({ where: { id }, select: { status: true, attempts: true, lastHttpStatus: true } });
    if (now && !["PENDING", "ERROR"].includes(now.status)) return { id, status: now.status, httpStatus: now.lastHttpStatus, attempts: now.attempts, warnings: 0, errors: 0 };
    throw refuseZatca("IN_FLIGHT");
  }
  const d = (await prisma.zatcaDocument.findUnique({ where: { id } }))!;
  const egs = (await prisma.zatcaEgsUnit.findUnique({ where: { id: d.egsId } }))!;
  const csid = await prisma.zatcaCsid.findFirst({ where: { egsId: egs.id, kind: "PRODUCTION", status: "ACTIVE" }, orderBy: { createdAt: "desc" } });
  const attempts = d.attempts + 1;
  if (!csid) {
    await prisma.zatcaDocument.update({ where: { id }, data: { status: "ERROR", attempts, leaseUntil: null, lastError: "NO_ACTIVE_PRODUCTION_CSID", nextAttemptAt: null } });
    await alert(d.invoiceId, "ERROR", "NO_ACTIVE_PRODUCTION_CSID");
    return { id, status: "ERROR", httpStatus: null, attempts, warnings: 0, errors: 0, reason: "NO_ACTIVE_PRODUCTION_CSID" };
  }
  const flow = d.flow as "CLEARANCE" | "REPORTING";
  const r = await callFatoora({
    action: flow, environment: egs.environment as "SANDBOX", method: "POST",
    path: flow === "CLEARANCE" ? "/invoices/clearance/single" : "/invoices/reporting/single",
    clearanceStatus: flow === "CLEARANCE" ? "1" : "0",
    auth: { token: openSecret(csid.tokenEnc), secret: openSecret(csid.secretEnc) },
    body: { invoiceHash: d.invoiceHash, uuid: d.uuid, invoice: Buffer.from(d.signedXml).toString("base64") },
  });
  const outcome = classify(flow, r);
  await writeLog(prisma, { egsId: egs.id, documentId: id, action: flow, environment: egs.environment, method: "POST", endpoint: r.url, httpStatus: r.status, outcome: outcome.kind === "ACCEPTED" ? outcome.status : outcome.kind, durationMs: r.durationMs, attempt: attempts, request: r.logRequest, response: r.logResponse ?? (r.networkError ? { networkError: r.networkError } : null), actorId: opts.actorId ?? null });

  const base = { attempts, leaseUntil: null, lastHttpStatus: r.status, submittedAt: d.submittedAt ?? new Date() };
  if (outcome.kind === "RETRY") {
    await prisma.zatcaDocument.update({ where: { id }, data: { ...base, status: "PENDING", lastError: outcome.reason, nextAttemptAt: new Date(Date.now() + backoffMs(attempts)) } });
    return { id, status: "PENDING", httpStatus: r.status, attempts, warnings: 0, errors: 0, reason: outcome.reason };
  }
  const v = outcome.validation;
  if (outcome.kind === "ACCEPTED") {
    const cleared = outcome.clearedXmlB64 ? Buffer.from(outcome.clearedXmlB64, "base64") : null;
    const clearedQr = cleared ? qrOf(cleared.toString("utf8")) : null;
    await prisma.$transaction(async (tx) => {
      await tx.zatcaDocument.update({ where: { id }, data: { ...base, status: outcome.status, decidedAt: new Date(), nextAttemptAt: null, lastError: null, ...messages(v), ...(cleared ? { clearedXml: cleared, clearedXmlSha256: sha256hex(cleared) } : {}) } });
      await tx.salesInvoice.update({ where: { id: d.invoiceId }, data: { zatcaStatus: outcome.status, ...(clearedQr ? { zatcaQr: clearedQr } : {}) } });
    }, TX_OPTS);
    if (outcome.status.endsWith("_WITH_WARNINGS")) await alert(d.invoiceId, outcome.status, `${v.warnings.length} warning(s)`);
    return { id, status: outcome.status, httpStatus: r.status, attempts, warnings: v.warnings.length, errors: 0 };
  }
  const status = outcome.kind === "REJECTED" ? "REJECTED" : "ERROR";
  await prisma.$transaction(async (tx) => {
    await tx.zatcaDocument.update({ where: { id }, data: { ...base, status, decidedAt: status === "REJECTED" ? new Date() : null, nextAttemptAt: null, lastError: outcome.kind === "ERROR" ? outcome.reason : "REJECTED", ...messages(v) } });
    await tx.salesInvoice.update({ where: { id: d.invoiceId }, data: { zatcaStatus: status } });
  }, TX_OPTS);
  await alert(d.invoiceId, status, outcome.kind === "ERROR" ? outcome.reason : v.errors.map((e) => e.code).filter(Boolean).slice(0, 5).join(", "));
  return { id, status, httpStatus: r.status, attempts, warnings: v.warnings.length, errors: v.errors.length, reason: outcome.kind === "ERROR" ? outcome.reason : undefined };
}

/** The QR inside an XML document (the cleared copy carries ZATCA's). */
export function qrOf(xml: string): string | null {
  const m = /<cac:AdditionalDocumentReference>\s*<cbc:ID>QR<\/cbc:ID>[\s\S]*?<cbc:EmbeddedDocumentBinaryObject[^>]*>([^<]+)<\/cbc:EmbeddedDocumentBinaryObject>/.exec(xml);
  return m ? m[1].trim() : null;
}

/** The owner's alert (notification catalogue «finance.zatca_attention»), once per document and state. */
async function alert(invoiceId: string, state: string, detail: string) {
  try {
    const inv = await prisma.salesInvoice.findUnique({ where: { id: invoiceId }, select: { id: true, number: true } });
    await notify(prisma, { event: "finance.zatca_attention", dedupeKey: `${invoiceId}:${state}`, facts: { invoiceId, number: inv?.number ?? "", state, detail: detail.slice(0, 200) }, entity: { type: "SalesInvoice", id: invoiceId } });
  } catch (e) {
    console.error("[zatca] alert not written:", (e as Error)?.message?.slice(0, 200));
  }
}

/**
 * Drain the queue: every PENDING document whose attempt is due, oldest ICV first per unit (the order ZATCA's
 * chain expects), within a time budget. Reporting documents and standard documents whose synchronous clearance did
 * not finish both go through here. Returns what happened.
 */
export async function processQueue(opts: { limit?: number; budgetMs?: number; actorId?: string | null } = {}) {
  const t0 = Date.now();
  const allowed = (["SANDBOX", "SIMULATION", "PRODUCTION"] as const).filter((e) => serverAllows(e));
  const due = await prisma.zatcaDocument.findMany({
    where: { status: "PENDING", environment: { in: [...allowed] }, OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }], AND: [{ OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }] }] },
    orderBy: [{ egsId: "asc" }, { icv: "asc" }], take: opts.limit ?? 50, select: { id: true },
  });
  const results: SubmitResult[] = [];
  for (const d of due) {
    if (Date.now() - t0 > (opts.budgetMs ?? 45_000)) break;
    try { results.push(await submitDocument(d.id, { actorId: opts.actorId ?? null })); }
    catch (e) { results.push({ id: d.id, status: "SKIPPED", httpStatus: null, attempts: 0, warnings: 0, errors: 0, reason: (e as { code?: string })?.code ?? "error" }); }
  }
  const count = (s: string) => results.filter((r) => r.status === s || r.status.startsWith(`${s}_`)).length;
  return { due: due.length, processed: results.length, cleared: count("CLEARED"), reported: count("REPORTED"), rejected: count("REJECTED"), retry: results.filter((r) => r.status === "PENDING").length, error: count("ERROR"), results };
}

/**
 * Certificates about to expire (the renewal needs an OTP from the owner): one alert per CSID when fewer than 30 days
 * are left (and again in the last 7). Run by the cron.
 */
export async function certificateAlerts(now = new Date()): Promise<number> {
  const soon = await prisma.zatcaCsid.findMany({
    where: { kind: "PRODUCTION", status: "ACTIVE", certNotAfter: { lt: new Date(now.getTime() + 30 * 86_400_000) }, egs: { retiredAt: null } },
    select: { id: true, certNotAfter: true, egs: { select: { name: true } } },
  });
  let n = 0;
  for (const c of soon) {
    const days = Math.max(0, Math.ceil(((c.certNotAfter?.getTime() ?? 0) - now.getTime()) / 86_400_000));
    try {
      const r = await notify(prisma, { event: "finance.zatca_attention", dedupeKey: `${c.id}:CERT_EXPIRING:${days <= 7 ? "7" : "30"}`, facts: { state: "CERT_EXPIRING", number: c.egs.name, detail: String(days) }, entity: { type: "ZatcaCsid", id: c.id } });
      n += r.inserted;
    } catch (e) {
      console.error("[zatca] certificate alert not written:", (e as Error)?.message?.slice(0, 200));
    }
  }
  return n;
}

/** The board's counts: pending, failed (rejected / error), overdue (simplified unreported after 20 h). */
export async function queueStats(now = new Date()) {
  const [pending, rejected, error, overdue, cleared, reported] = await Promise.all([
    prisma.zatcaDocument.count({ where: { status: "PENDING" } }),
    prisma.zatcaDocument.count({ where: { status: "REJECTED" } }),
    prisma.zatcaDocument.count({ where: { status: "ERROR" } }),
    prisma.zatcaDocument.count({ where: { flow: "REPORTING", status: { in: ["PENDING", "ERROR"] }, signedAt: { lt: new Date(now.getTime() - 20 * 3_600_000) } } }),
    prisma.zatcaDocument.count({ where: { status: { in: ["CLEARED", "CLEARED_WITH_WARNINGS"] } } }),
    prisma.zatcaDocument.count({ where: { status: { in: ["REPORTED", "REPORTED_WITH_WARNINGS"] } } }),
  ]);
  return { pending, rejected, error, failed: rejected + error, overdue, cleared, reported };
}
