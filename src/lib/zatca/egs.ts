// ZATCA Phase 2 (A4) — EGS units and their onboarding (admin only, step-up; the routes check):
//
//   create      the unit's particulars → a secp256k1 key pair (private key stored encrypted) and the CSR
//   compliance  the owner's OTP from the Fatoora portal → POST /compliance → the compliance CSID
//   checks      one signed sample of every document type the unit may issue (TSCZ flags: standard → invoice,
//               credit, debit note; simplified → the same three) → POST /compliance/invoices, each must pass
//   production  POST /production/csids (compliance_request_id) → the production CSID; the unit can now sign
//   renew       a new key and CSR + a new OTP → PATCH /production/csids → the renewed CSID (the old one superseded)
//   revoke      local: the unit stops signing (ZATCA-side revocation is done on the Fatoora portal, RUNBOOK §7)
// Every call to ZATCA is logged (ZatcaLog, redacted). The OTP is used once and never stored. The compliance samples
// use their own throw-away chain (ICV 1…n from the initial PIH): they never touch the unit's real counter.
import { randomUUID } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { prisma, TX_OPTS } from "@/lib/db";
import { setAuditContext, type AuditContext } from "@/lib/accounting/audit";
import { sellerSnapshot } from "@/lib/services/invoicing/settings";
import { MODES, serverAllows, serverEnabled, productionAllowed, type ZatcaMode } from "./config";
import { buildCsr, certFromToken, csrForApi, csrProblems, generateEgsKeyPair, loadPrivateKey, openSecret, sealSecret, zatcaKey, type CsrSubject, type ZatcaEnvironment } from "./crypto";
import { callFatoora, csidOf, validationOf } from "./fatoora";
import { writeLog } from "./log";
import { refuseZatca } from "./refusals";
import { stamp } from "./sign";
import { buildUbl, INITIAL_PIH } from "./ubl";
import { checkTypes, complianceSample } from "./compliance";

const SOLUTION = "Hiqbah";
const MODEL = "BeanFlowERP";

export type EgsInput = {
  environment: unknown; name: unknown; branchName: unknown; location: unknown; industry: unknown; invoiceTypes?: unknown;
  organizationName?: unknown; vatNumber?: unknown; commonName?: unknown; branchId?: unknown;
};

const txt = (v: unknown, max = 200) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : "");
const asEnv = (v: unknown): ZatcaEnvironment | null => (v === "SANDBOX" || v === "SIMULATION" || v === "PRODUCTION" ? v : null);

/** The public view of a unit — never the key, the CSR's key material, the token or the secret. */
export function egsView(u: Prisma.ZatcaEgsUnitGetPayload<{ include: { csids: true } }>) {
  const active = (kind: string) => u.csids.filter((c) => c.kind === kind && c.status === "ACTIVE").sort((a, b) => +b.createdAt - +a.createdAt)[0] ?? null;
  const csidView = (c: (typeof u.csids)[number] | null) => (c ? { id: c.id, kind: c.kind, requestId: c.requestId, certSerial: c.certSerial, certIssuer: c.certIssuer, certNotBefore: c.certNotBefore, certNotAfter: c.certNotAfter, status: c.status, createdAt: c.createdAt } : null);
  return {
    id: u.id, environment: u.environment, name: u.name, commonName: u.commonName, serialNumber: u.serialNumber, organizationName: u.organizationName,
    branchName: u.branchName, vatNumber: u.vatNumber, invoiceTypes: u.invoiceTypes, location: u.location, industry: u.industry,
    csidState: u.csidState, keyVersion: u.keyVersion, hasKey: !!u.privateKeyEnc, renewalPending: !!u.pendingCsrPem,
    icv: u.icv.toString(), lastHash: u.lastHash, lastDocumentAt: u.lastDocumentAt,
    complianceChecks: u.complianceChecks, complianceCheckedAt: u.complianceCheckedAt, retiredAt: u.retiredAt, createdAt: u.createdAt,
    compliance: csidView(active("COMPLIANCE")), production: csidView(active("PRODUCTION")),
    history: u.csids.map(csidView),
  };
}

function requireKey() {
  if (!zatcaKey()) throw refuseZatca("KEY_NOT_CONFIGURED");
}
function requireServer(env: ZatcaEnvironment) {
  if (!serverEnabled()) throw refuseZatca("SERVER_DISABLED");
  if (env === "PRODUCTION" && !productionAllowed()) throw refuseZatca("PRODUCTION_NOT_ALLOWED");
}

/** A new EGS unit with its key pair and CSR (nothing is sent to ZATCA yet). */
export async function createEgs(input: EgsInput, ctx: AuditContext) {
  requireKey();
  const environment = asEnv(input.environment);
  if (!environment) throw refuseZatca("BAD_INPUT", "environment.", "اختر البيئة.");
  const seller = await sellerSnapshot(prisma);
  const vat = txt(input.vatNumber, 15) || seller.vatNumber || "";
  const org = txt(input.organizationName, 160) || seller.name || "";
  const id = randomUUID();
  const subject: CsrSubject = {
    commonName: txt(input.commonName, 64) || `${MODEL}-${vat}-${id.slice(0, 8)}`,
    serialNumber: `1-${SOLUTION}|2-${MODEL}|3-${id}`,
    organizationIdentifier: vat, organizationUnit: txt(input.branchName, 64), organizationName: org, countryName: "SA",
    invoiceType: txt(input.invoiceTypes, 4) || "1100", location: txt(input.location, 120), industry: txt(input.industry, 120),
  };
  const problems = csrProblems(subject);
  if (problems.length) throw refuseZatca("CSR_INVALID", problems.map((p) => p.en).join(" "), problems.map((p) => p.ar).join(" "), { problems });
  const keys = generateEgsKeyPair();
  const csr = buildCsr(subject, environment, keys.privateKeyPem);
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, ctx);
    const u = await tx.zatcaEgsUnit.create({
      data: {
        environment, name: txt(input.name, 80) || subject.organizationUnit, commonName: subject.commonName, serialNumber: subject.serialNumber,
        organizationName: org, branchName: subject.organizationUnit, branchId: txt(input.branchId, 64) || null, vatNumber: vat,
        invoiceTypes: subject.invoiceType, location: subject.location, industry: subject.industry,
        privateKeyEnc: sealSecret(keys.privateKeyPem), publicKeyPem: keys.publicKeyPem, csrPem: csr, keyVersion: 1, createdById: ctx.actorId,
      },
      include: { csids: true },
    });
    await writeLog(tx, { egsId: u.id, action: "EGS_CREATED", environment, method: "-", endpoint: "-", outcome: "OK", actorId: ctx.actorId, request: { serialNumber: u.serialNumber, commonName: u.commonName, invoiceTypes: u.invoiceTypes, keyVersion: 1 } });
    return egsView(u);
  }, TX_OPTS);
}

async function loadEgs(id: string) {
  const u = await prisma.zatcaEgsUnit.findUnique({ where: { id }, include: { csids: true } });
  if (!u) throw refuseZatca("NOT_FOUND");
  return u;
}

const otpOf = (v: unknown) => {
  const s = typeof v === "string" ? v.trim() : "";
  if (!/^\d{6}$/.test(s)) throw refuseZatca("OTP_REQUIRED");
  return s;
};

function failed(action: string, r: { status: number | null; json: Record<string, unknown> | null; networkError: string | null }) {
  if (r.status === null) return refuseZatca("ZATCA_UNREACHABLE", `(${action}: ${r.networkError})`);
  const v = validationOf(r.json);
  const msg = [...v.errors.map((e) => `${e.code ?? ""} ${e.message ?? ""}`.trim()), typeof r.json?.message === "string" ? r.json.message : ""].filter(Boolean).join("; ").slice(0, 400);
  return refuseZatca("ZATCA_REFUSED", `(${action}: HTTP ${r.status}${msg ? ` — ${msg}` : ""})`, `(${action}: HTTP ${r.status})`, { httpStatus: r.status, errors: v.errors });
}

async function storeCsid(tx: Prisma.TransactionClient, egsId: string, kind: "COMPLIANCE" | "PRODUCTION", keyVersion: number, c: { requestId: string; token: string; secret: string }, actorId: string) {
  const cert = certFromToken(c.token);
  return tx.zatcaCsid.create({
    data: {
      egsId, kind, requestId: c.requestId, tokenEnc: sealSecret(c.token), secretEnc: sealSecret(c.secret), keyVersion,
      certSerial: cert.serialDecimal, certIssuer: cert.issuerName.slice(0, 500), certSha256: cert.sha256, certNotBefore: cert.notBefore, certNotAfter: cert.notAfter, createdById: actorId,
    },
  });
}

/** Step 1: the compliance CSID, with the owner's OTP. */
export async function requestComplianceCsid(egsId: string, otpRaw: unknown, ctx: AuditContext) {
  requireKey();
  const otp = otpOf(otpRaw);
  const u = await loadEgs(egsId);
  requireServer(u.environment as ZatcaEnvironment);
  if (u.csidState !== "NONE" || u.retiredAt) throw refuseZatca("WRONG_STEP", "(the unit already holds a CSID)", "(الوحدة تحمل شهادة مسبقًا)");
  const r = await callFatoora({ action: "COMPLIANCE_CSID", environment: u.environment as ZatcaEnvironment, method: "POST", path: "/compliance", otp, body: { csr: csrForApi(u.csrPem!) } });
  const c = r.status === 200 ? csidOf(r.json) : null;
  await writeLog(prisma, { egsId, action: "COMPLIANCE_CSID", environment: u.environment, method: "POST", endpoint: r.url, httpStatus: r.status, outcome: c ? "ISSUED" : "FAILED", durationMs: r.durationMs, request: r.logRequest, response: r.logResponse, actorId: ctx.actorId });
  if (!c) throw failed("compliance CSID", r);
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, ctx);
    await storeCsid(tx, egsId, "COMPLIANCE", u.keyVersion, c, ctx.actorId);
    const done = await tx.zatcaEgsUnit.update({ where: { id: egsId }, data: { csidState: "COMPLIANCE", complianceChecks: [], complianceCheckedAt: null }, include: { csids: true } });
    return egsView(done);
  }, TX_OPTS);
}

/** Step 2: the compliance checks — every type the unit is registered for must pass. */
export async function runComplianceChecks(egsId: string, ctx: AuditContext) {
  requireKey();
  const u = await loadEgs(egsId);
  requireServer(u.environment as ZatcaEnvironment);
  if (u.csidState !== "COMPLIANCE") throw refuseZatca("WRONG_STEP", "(request the compliance CSID first)", "(اطلب شهادة الامتثال أولًا)");
  const csid = u.csids.find((c) => c.kind === "COMPLIANCE" && c.status === "ACTIVE");
  if (!csid) throw refuseZatca("WRONG_STEP");
  const seller = await sellerSnapshot(prisma);
  if (!seller.name || !seller.vatNumber || !seller.street || !seller.buildingNo || !seller.district || !seller.city || !seller.postalCode || !seller.crNumber) {
    throw refuseZatca("NOT_SIGNABLE", "(complete the seller block and national address in the invoicing settings first)", "(أكمل بيانات المنشأة وعنوانها الوطني في إعدادات الفوترة أولًا)");
  }
  const token = openSecret(csid.tokenEnc), secret = openSecret(csid.secretEnc);
  const cert = certFromToken(token);
  const key = loadPrivateKey(openSecret(u.privateKeyEnc!));
  const results: { type: string; ok: boolean; httpStatus: number | null; status: string | null; warnings: number; errors: { code?: string; message?: string }[]; at: string }[] = [];
  let pih = INITIAL_PIH;
  const types = checkTypes(u.invoiceTypes);
  for (let i = 0; i < types.length; i++) {
    const t = types[i];
    const sample = complianceSample(t, seller, { icv: i + 1, pih });
    const s = stamp({ xml: buildUbl(sample), privateKey: key, cert, timestamp: `${sample.issueDate}T${sample.issueTime}`, qr: { sellerName: seller.name, vatNumber: seller.vatNumber, total: sample.totals.grand, vat: sample.totals.tax, simplified: t.family === "SIMPLIFIED" } });
    pih = s.hash;
    const r = await callFatoora({ action: "COMPLIANCE_CHECK", environment: u.environment as ZatcaEnvironment, method: "POST", path: "/compliance/invoices", auth: { token, secret }, body: { invoiceHash: s.hash, uuid: sample.uuid, invoice: Buffer.from(s.xml, "utf8").toString("base64") } });
    const v = validationOf(r.json);
    const accepted = t.family === "STANDARD" ? r.json?.clearanceStatus === "CLEARED" : r.json?.reportingStatus === "REPORTED";
    const ok = (r.status === 200 || r.status === 202) && accepted && v.errors.length === 0;
    const type = `${t.family}_${t.kind}`;
    results.push({ type, ok, httpStatus: r.status, status: v.status, warnings: v.warnings.length, errors: v.errors.map((e) => ({ code: e.code, message: e.message })), at: new Date().toISOString() });
    await writeLog(prisma, { egsId, action: "COMPLIANCE_CHECK", environment: u.environment, method: "POST", endpoint: r.url, httpStatus: r.status, outcome: ok ? `PASS ${type}` : `FAIL ${type}`, durationMs: r.durationMs, request: { ...r.logRequest, type }, response: r.logResponse ?? (r.networkError ? { networkError: r.networkError } : null), actorId: ctx.actorId });
  }
  const all = results.length > 0 && results.every((x) => x.ok);
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, ctx);
    const done = await tx.zatcaEgsUnit.update({ where: { id: egsId }, data: { complianceChecks: results as unknown as Prisma.InputJsonValue, complianceCheckedAt: all ? new Date() : null }, include: { csids: true } });
    return { egs: egsView(done), passed: all, results };
  }, TX_OPTS);
}

/** Step 3: the production CSID (needs every compliance check passed). */
export async function requestProductionCsid(egsId: string, ctx: AuditContext) {
  requireKey();
  const u = await loadEgs(egsId);
  requireServer(u.environment as ZatcaEnvironment);
  if (u.csidState !== "COMPLIANCE") throw refuseZatca("WRONG_STEP");
  if (!u.complianceCheckedAt) throw refuseZatca("COMPLIANCE_FAILED");
  const csid = u.csids.find((c) => c.kind === "COMPLIANCE" && c.status === "ACTIVE")!;
  const r = await callFatoora({ action: "PRODUCTION_CSID", environment: u.environment as ZatcaEnvironment, method: "POST", path: "/production/csids", auth: { token: openSecret(csid.tokenEnc), secret: openSecret(csid.secretEnc) }, body: { compliance_request_id: csid.requestId } });
  const c = r.status === 200 ? csidOf(r.json) : null;
  await writeLog(prisma, { egsId, action: "PRODUCTION_CSID", environment: u.environment, method: "POST", endpoint: r.url, httpStatus: r.status, outcome: c ? "ISSUED" : "FAILED", durationMs: r.durationMs, request: r.logRequest, response: r.logResponse, actorId: ctx.actorId });
  if (!c) throw failed("production CSID", r);
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, ctx);
    await tx.zatcaCsid.update({ where: { id: csid.id }, data: { status: "SUPERSEDED", supersededAt: new Date() } });
    await storeCsid(tx, egsId, "PRODUCTION", u.keyVersion, c, ctx.actorId);
    const done = await tx.zatcaEgsUnit.update({ where: { id: egsId }, data: { csidState: "PRODUCTION" }, include: { csids: true } });
    return egsView(done);
  }, TX_OPTS);
}

/** Renewal: a new key + CSR and a new OTP; the renewed production CSID supersedes the old one. */
export async function renewCsid(egsId: string, otpRaw: unknown, ctx: AuditContext) {
  requireKey();
  const otp = otpOf(otpRaw);
  const u = await loadEgs(egsId);
  requireServer(u.environment as ZatcaEnvironment);
  if (u.csidState !== "PRODUCTION" && u.csidState !== "RENEWED") throw refuseZatca("WRONG_STEP");
  const prod = u.csids.find((c) => c.kind === "PRODUCTION" && c.status === "ACTIVE");
  if (!prod) throw refuseZatca("WRONG_STEP");
  // The new key and CSR are kept as "pending" first, so a failed call loses nothing and can be retried.
  let pendingKeyPem: string, pendingCsr: string;
  if (u.pendingPrivateKeyEnc && u.pendingCsrPem) {
    pendingKeyPem = openSecret(u.pendingPrivateKeyEnc); pendingCsr = u.pendingCsrPem;
  } else {
    const keys = generateEgsKeyPair();
    pendingKeyPem = keys.privateKeyPem;
    pendingCsr = buildCsr({ commonName: u.commonName, serialNumber: u.serialNumber, organizationIdentifier: u.vatNumber, organizationUnit: u.branchName, organizationName: u.organizationName, countryName: "SA", invoiceType: u.invoiceTypes, location: u.location, industry: u.industry }, u.environment as ZatcaEnvironment, pendingKeyPem);
    await prisma.$transaction(async (tx) => {
      await setAuditContext(tx, { ...ctx, reason: "CSID renewal: new key pending" });
      await tx.zatcaEgsUnit.update({ where: { id: egsId }, data: { pendingPrivateKeyEnc: sealSecret(pendingKeyPem), pendingCsrPem: pendingCsr } });
    }, TX_OPTS);
  }
  const r = await callFatoora({ action: "RENEW_CSID", environment: u.environment as ZatcaEnvironment, method: "PATCH", path: "/production/csids", otp, auth: { token: openSecret(prod.tokenEnc), secret: openSecret(prod.secretEnc) }, body: { csr: csrForApi(pendingCsr) } });
  const c = r.status === 200 ? csidOf(r.json) : null;
  await writeLog(prisma, { egsId, action: "RENEW_CSID", environment: u.environment, method: "PATCH", endpoint: r.url, httpStatus: r.status, outcome: c ? "ISSUED" : "FAILED", durationMs: r.durationMs, request: r.logRequest, response: r.logResponse, actorId: ctx.actorId });
  if (!c) throw failed("CSID renewal", r);
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, { ...ctx, reason: "CSID renewed" });
    // Lock the unit: no document is signed between the key swap and the new CSID.
    await tx.$queryRaw`SELECT "id" FROM "ZatcaEgsUnit" WHERE "id" = ${egsId} FOR UPDATE`;
    await tx.zatcaCsid.update({ where: { id: prod.id }, data: { status: "SUPERSEDED", supersededAt: new Date() } });
    await storeCsid(tx, egsId, "PRODUCTION", u.keyVersion + 1, c, ctx.actorId);
    const done = await tx.zatcaEgsUnit.update({
      where: { id: egsId },
      data: { privateKeyEnc: sealSecret(pendingKeyPem), csrPem: pendingCsr, keyVersion: u.keyVersion + 1, pendingPrivateKeyEnc: null, pendingCsrPem: null, csidState: "RENEWED" },
      include: { csids: true },
    });
    return egsView(done);
  }, TX_OPTS);
}

/** Stop a unit signing (it keeps its counter and documents; a revoked unit is never used again). */
export async function revokeEgs(egsId: string, reason: string, ctx: AuditContext) {
  const r = reason.trim();
  if (r.length < 3) throw refuseZatca("BAD_INPUT", "(a reason is required)", "(السبب مطلوب)");
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, { ...ctx, reason: r });
    await tx.$queryRaw`SELECT "id" FROM "ZatcaEgsUnit" WHERE "id" = ${egsId} FOR UPDATE`;
    const u = await tx.zatcaEgsUnit.findUnique({ where: { id: egsId } });
    if (!u) throw refuseZatca("NOT_FOUND");
    await tx.zatcaCsid.updateMany({ where: { egsId, status: "ACTIVE" }, data: { status: "REVOKED", supersededAt: new Date() } });
    const s = await tx.zatcaSettings.findUnique({ where: { id: "singleton" } });
    if (s?.activeEgsId === egsId) await tx.zatcaSettings.update({ where: { id: "singleton" }, data: { activeEgsId: null, updatedById: ctx.actorId } });
    const done = await tx.zatcaEgsUnit.update({ where: { id: egsId }, data: { csidState: "REVOKED", retiredAt: new Date(), pendingPrivateKeyEnc: null, pendingCsrPem: null }, include: { csids: true } });
    await writeLog(tx, { egsId, action: "REVOKED", environment: u.environment, method: "-", endpoint: "-", outcome: "REVOKED", actorId: ctx.actorId, request: { reason: r.slice(0, 300) } });
    return egsView(done);
  }, TX_OPTS);
}

/** The switch: mode + the unit that signs. Turning on needs the server to allow it and a unit ready for it. */
export async function setMode(input: { mode: unknown; activeEgsId?: unknown }, ctx: AuditContext) {
  const mode = (MODES as unknown[]).includes(input.mode) ? (input.mode as ZatcaMode) : null;
  if (!mode) throw refuseZatca("BAD_INPUT", "mode.", "اختر الوضع.");
  const egsId = typeof input.activeEgsId === "string" && input.activeEgsId ? input.activeEgsId : null;
  if (mode !== "OFF") {
    if (!serverAllows(mode)) throw refuseZatca(mode === "PRODUCTION" && serverEnabled() ? "PRODUCTION_NOT_ALLOWED" : "SERVER_DISABLED");
    if (!egsId) throw refuseZatca("EGS_NOT_READY");
    const u = await prisma.zatcaEgsUnit.findUnique({ where: { id: egsId } });
    if (!u) throw refuseZatca("NOT_FOUND");
    if (u.environment !== mode) throw refuseZatca("EGS_ENVIRONMENT");
    if ((u.csidState !== "PRODUCTION" && u.csidState !== "RENEWED") || u.retiredAt) throw refuseZatca("EGS_NOT_READY");
  }
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, ctx);
    const s = await tx.zatcaSettings.upsert({
      where: { id: "singleton" },
      create: { id: "singleton", mode, activeEgsId: egsId, updatedById: ctx.actorId },
      update: { mode, activeEgsId: mode === "OFF" ? egsId : egsId, updatedById: ctx.actorId },
    });
    await writeLog(tx, { egsId, action: "SETTINGS", environment: mode, method: "-", endpoint: "-", outcome: mode, actorId: ctx.actorId, request: { mode, activeEgsId: egsId } });
    return s;
  }, TX_OPTS);
}

/**
 * Numbering cut-over (owner: Qoyod's last invoice was INV316): the next number of a series, set before the series
 * issues anything in this system (the database refuses it afterwards). nextNumber 317 → the next document is
 * <series>-000317.
 */
export async function setSeriesStart(input: { series: unknown; nextNumber: unknown }, ctx: AuditContext) {
  const series = typeof input.series === "string" ? input.series.trim().toUpperCase() : "";
  const next = typeof input.nextNumber === "number" ? input.nextNumber : Number(input.nextNumber);
  if (!/^[A-Z0-9]{1,10}$/.test(series) || !Number.isInteger(next) || next < 1 || next > 999_999) throw refuseZatca("BAD_INPUT", "(series: 1–10 capital letters / digits; next number 1–999999)", "(السلسلة 1–10 أحرف لاتينية كبيرة أو أرقام؛ الرقم التالي 1–999999)");
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, { ...ctx, reason: `series ${series} starts at ${next}` });
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"sinv:series:" + series}, 0))`;
    const used = await tx.salesInvoice.count({ where: { series, status: "ISSUED" } });
    if (used > 0) throw refuseZatca("NUMBERING_IN_USE");
    await tx.$executeRaw`INSERT INTO "SalesDocumentCounter" ("tenantId", "series", "value") VALUES ('hiqbah', ${series}, ${next - 1})
                         ON CONFLICT ("tenantId", "series") DO UPDATE SET "value" = ${next - 1}`;
    await writeLog(tx, { action: "NUMBERING", environment: "-", method: "-", endpoint: "-", outcome: "SET", actorId: ctx.actorId, request: { series, nextNumber: next } });
    return { series, nextNumber: next };
  }, TX_OPTS);
}

export async function seriesCounters() {
  return prisma.salesDocumentCounter.findMany({ orderBy: { series: "asc" } });
}
