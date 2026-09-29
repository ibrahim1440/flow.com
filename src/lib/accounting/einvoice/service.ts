// E-invoicing service (stage 6, LOCAL validation only — STAGE_6_DESIGN.md).
//
// - Seller profile: prepared by one person, approved by another; an approved version never changes.
//   Nothing generates until a profile is approved (the fixture's profile is synthetic).
// - Generation: once per posted sales document (idempotent). The document is validated first; an
//   invalid one does not consume the ICV chain — its job waits with the errors until fixed and
//   retried. A valid one gets the next ICV of its EGS and the previous document's hash, under a
//   per-EGS advisory lock; the database re-checks the chain and forbids any later change.
// - Submission: environment LOCAL_ONLY records that nothing was sent. SANDBOX sends only to a
//   configured local stub or ZATCA's developer-portal / simulation paths, never to the production
//   ("core") path, and only with test credentials from the environment. Retryable failures are
//   retried with back-off; every attempt is appended, never edited.
import { randomUUID, createHash, generateKeyPairSync, createPrivateKey, type KeyObject } from "node:crypto";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { AccountingError } from "../errors";
import { ledgerTx } from "../journal-service";
import { auditAccounting } from "../audit";
import { dateStr } from "../dates";
import { riyadhDateString } from "@/lib/finance/dates";
import { buildXml, documentHash, qrTlv, signLocally, INITIAL_PIH, type EDoc, type TaxCat, type Address } from "./ubl";
import { validateDoc, standardsGaps, type RuleResult } from "./rules";
import { submissionTarget } from "./target";
export { submissionTarget };

type Tx = Prisma.TransactionClient;
type Client = Tx | typeof prisma;
export const SIGNER = "LOCAL_TEST_KEY";
const BACKOFF_MIN = [1, 5, 15, 60, 240];

// ── Local test signing key: from EINVOICE_LOCAL_TEST_KEY (PEM) or generated for this process. Never a ZATCA key.
let testKey: KeyObject | null = null;
function localKey() {
  if (testKey) return testKey;
  const pem = process.env.EINVOICE_LOCAL_TEST_KEY;
  testKey = pem ? createPrivateKey(pem) : generateKeyPairSync("ec", { namedCurve: "secp256k1" }).privateKey;
  return testKey;
}

// ── Profile ─────────────────────────────────────────────────────────────────────────────────
const PROFILE_FIELDS = ["sellerName", "sellerNameEn", "vatNumber", "crNumber", "street", "buildingNo", "district", "city", "postalCode", "countryCode", "egsSerial", "environment"] as const;

export async function draftProfile(b: Record<string, unknown>, userId: string) {
  const data: Record<string, string | null> = {};
  for (const k of PROFILE_FIELDS) { const v = typeof b[k] === "string" ? (b[k] as string).trim() : ""; data[k] = v || null; }
  for (const k of ["sellerName", "vatNumber", "crNumber", "street", "buildingNo", "district", "city", "postalCode", "egsSerial"]) if (!data[k]) throw new AccountingError(`${k} is required.`, 400);
  data.countryCode = data.countryCode ?? "SA";
  data.environment = data.environment ?? "LOCAL_ONLY";
  if (!["LOCAL_ONLY", "SANDBOX"].includes(data.environment!)) throw new AccountingError("The environment is LOCAL_ONLY or SANDBOX; production is not available in this branch.", 400);
  return ledgerTx(async (tx) => {
    const draft = await tx.eInvoiceProfile.findFirst({ where: { status: "DRAFT" } });
    if (draft) throw new AccountingError(`Version ${draft.version} is already a draft; approve it or have it discarded first.`, 409);
    const last = await tx.eInvoiceProfile.findFirst({ orderBy: { version: "desc" } });
    const p = await tx.eInvoiceProfile.create({ data: { ...(data as Record<string, string>), version: (last?.version ?? 0) + 1, preparedBy: userId } as never });
    await auditAccounting(tx, { action: "einvoice.profile.draft", entityType: "einvoice_profile", entityId: p.id, userId, after: data });
    return p;
  });
}

export async function approveProfile(id: string, userId: string) {
  return ledgerTx(async (tx) => {
    const p = await tx.eInvoiceProfile.findUnique({ where: { id } });
    if (!p || p.status !== "DRAFT") throw new AccountingError("Only a draft profile can be approved.", 409);
    if (p.preparedBy === userId) throw new AccountingError("You prepared this profile; someone else must approve it.", 403);
    await tx.eInvoiceProfile.updateMany({ where: { status: "APPROVED" }, data: { status: "RETIRED" } });
    await tx.eInvoiceProfile.update({ where: { id }, data: { status: "APPROVED", approvedBy: userId, approvedAt: new Date() } });
    await auditAccounting(tx, { action: "einvoice.profile.approve", entityType: "einvoice_profile", entityId: id, userId });
    return tx.eInvoiceProfile.findUniqueOrThrow({ where: { id } });
  });
}

export async function discardProfile(id: string, userId: string) {
  return ledgerTx(async (tx) => {
    const res = await tx.eInvoiceProfile.deleteMany({ where: { id, status: "DRAFT" } });
    if (res.count === 0) throw new AccountingError("Only a draft profile can be discarded.", 409);
    await auditAccounting(tx, { action: "einvoice.profile.discard", entityType: "einvoice_profile", entityId: id, userId });
    return { ok: true };
  });
}

// ── Building the document ───────────────────────────────────────────────────────────────────
const label = (d: { kind: string; invoiceNo: number; debitNoteOfId?: string | null }) => `${d.kind === "CREDIT_NOTE" ? "CN" : d.debitNoteOfId ? "DN" : "INV"}-${d.invoiceNo}`;
const CAT_BY_TYPE: Record<string, TaxCat> = { STANDARD: "S", ZERO_RATED: "Z", EXEMPT: "E", OUT_OF_SCOPE: "O" };

async function docModel(tx: Client, salesInvoiceId: string, profile: { sellerName: string; vatNumber: string; crNumber: string; street: string; buildingNo: string; district: string; city: string; postalCode: string; countryCode: string }, chain: { icv: number; previousHash: string; uuid: string }): Promise<{ doc: EDoc; source: { status: string } }> {
  const d = await tx.salesInvoice.findUnique({ where: { id: salesInvoiceId }, include: { customer: true, lines: { orderBy: { lineNo: "asc" } }, originalInvoice: true, debitNoteOf: true } });
  if (!d) throw new AccountingError("Sales document not found.", 404);
  const taxes = new Map((await tx.taxCategory.findMany({ where: { id: { in: d.lines.map((l) => l.taxCategoryId).filter(Boolean) as string[] } } })).map((t) => [t.id, t]));
  const at = d.postedAt ?? new Date();
  const time = new Date(at.getTime() + 3 * 3600_000).toISOString().slice(11, 19);
  const addr = (d.customer.nationalAddress ?? null) as Partial<Address> | null;
  const standard = !!d.customer.vatNumber;
  const ref = d.kind === "CREDIT_NOTE" ? d.originalInvoice : d.debitNoteOf;
  const doc: EDoc = {
    id: label(d), uuid: chain.uuid, icv: chain.icv, previousHash: chain.previousHash,
    issueDate: dateStr(d.issueDate), issueTime: time, supplyDate: d.supplyDate ? dateStr(d.supplyDate) : null,
    typeCode: d.kind === "CREDIT_NOTE" ? "381" : d.debitNoteOfId ? "383" : "388", subtype: standard ? "0100000" : "0200000", currency: d.currency,
    billingReference: ref ? label(ref) : null, reason: d.kind === "CREDIT_NOTE" || d.debitNoteOfId ? d.reason : null,
    seller: { name: profile.sellerName, vatNumber: profile.vatNumber, crNumber: profile.crNumber, address: { street: profile.street, buildingNo: profile.buildingNo, district: profile.district, city: profile.city, postalCode: profile.postalCode, countryCode: profile.countryCode } },
    buyer: { name: d.customer.nameAr ?? d.customer.name, vatNumber: d.customer.vatNumber, crNumber: d.customer.crNumber, address: addr },
    lines: d.lines.map((l) => {
      const t = l.taxCategoryId ? taxes.get(l.taxCategoryId) : undefined;
      const cat = ((t?.zatcaTaxCategoryCode as TaxCat | null) ?? (t ? CAT_BY_TYPE[t.categoryType] : "O")) as TaxCat;
      return { no: l.lineNo, name: l.description ?? `Line ${l.lineNo}`, quantity: l.quantity.toString(), unitPrice: l.unitPrice.toFixed(4), discountPercent: l.discountPercent.toFixed(2), net: l.net.toFixed(2), vatRate: l.vatRate.toFixed(2), vat: l.vat.toFixed(2), category: cat, exemptionCode: t?.zatcaExemptionCode ?? null, exemptionReason: t?.zatcaExemptionReason ?? null };
    }),
    totals: { lineExtension: d.totalNet.toFixed(2), taxExclusive: d.totalNet.toFixed(2), tax: d.totalVat.toFixed(2), taxInclusive: d.totalGross.toFixed(2), prepaid: "0.00", payable: d.totalGross.toFixed(2) },
  };
  return { doc, source: { status: d.status } };
}

// ── Generation ──────────────────────────────────────────────────────────────────────────────
export type GenerateOutcome = { status: "GENERATED" | "ALREADY" | "INVALID" | "WAITING_PROFILE" | "NOT_POSTED"; eInvoiceId?: string; errors?: RuleResult[] };

/** Generate (or retry generating) the e-invoice of a posted sales document. Idempotent. */
export async function generateEInvoice(salesInvoiceId: string, userId: string): Promise<GenerateOutcome> {
  const existing = await prisma.eInvoice.findUnique({ where: { salesInvoiceId } });
  if (existing) return { status: "ALREADY", eInvoiceId: existing.id };
  const d = await prisma.salesInvoice.findUnique({ where: { id: salesInvoiceId }, select: { status: true } });
  if (!d || !["POSTED", "REVERSED"].includes(d.status)) return { status: "NOT_POSTED" };
  const profile = await prisma.eInvoiceProfile.findFirst({ where: { status: "APPROVED" } });
  const job = async (status: string, errors: unknown, tx: Client = prisma) => tx.eInvoiceJob.upsert({
    where: { salesInvoiceId }, update: { status, errors: errors as Prisma.InputJsonValue, attempts: { increment: 1 }, lastAttemptAt: new Date() },
    create: { salesInvoiceId, status, errors: errors as Prisma.InputJsonValue, attempts: 1, lastAttemptAt: new Date() } });
  if (!profile) { await job("WAITING_PROFILE", null); return { status: "WAITING_PROFILE" }; }

  // Validate first, outside the chain: an invalid document never takes an ICV.
  const trial = await docModel(prisma, salesInvoiceId, profile, { icv: 1, previousHash: INITIAL_PIH, uuid: randomUUID() });
  const pre = validateDoc(trial.doc).filter((x) => !x.ok);
  if (pre.length) {
    await job("INVALID", pre);
    await prisma.$transaction((tx) => auditAccounting(tx, { action: "einvoice.invalid", entityType: "einvoice_job", entityId: salesInvoiceId, userId, after: pre.map((x) => x.id) }));
    return { status: "INVALID", errors: pre };
  }

  return ledgerTx(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"einv:" + profile.egsSerial}))`;
    const again = await tx.eInvoice.findUnique({ where: { salesInvoiceId } });
    if (again) return { status: "ALREADY" as const, eInvoiceId: again.id };
    const last = await tx.eInvoice.findFirst({ where: { egsSerial: profile.egsSerial }, orderBy: { icv: "desc" } });
    const chain = { icv: (last?.icv ?? 0) + 1, previousHash: last?.invoiceHash ?? INITIAL_PIH, uuid: randomUUID() };
    const { doc } = await docModel(tx, salesInvoiceId, profile, chain);
    const hash = documentHash(doc);
    const simplified = doc.subtype === "0200000";
    const signed = simplified ? signLocally(hash, localKey()) : null;
    const qr = qrTlv({ sellerName: doc.seller.name, vatNumber: doc.seller.vatNumber, timestamp: `${doc.issueDate}T${doc.issueTime}`, total: doc.totals.taxInclusive, vat: doc.totals.tax,
      ...(signed ? { hash, signature: signed.signatureDer, publicKey: signed.publicKeyDer } : {}) });
    const xml = buildXml(doc, { signature: signed ? { value: signed.signature, publicKey: signed.publicKey } : null, qr });
    const validation = validateDoc(doc, { xml, invoiceHash: hash, qr, signature: signed?.signature, publicKey: signed?.publicKey });
    const e = await tx.eInvoice.create({ data: {
      salesInvoiceId, profileId: profile.id, egsSerial: profile.egsSerial, icv: chain.icv, uuid: chain.uuid, typeCode: doc.typeCode, subtype: doc.subtype,
      issueAt: new Date(`${doc.issueDate}T${doc.issueTime}+03:00`), xml, invoiceHash: hash, previousHash: chain.previousHash, qr, signature: signed?.signature ?? null,
      publicKey: signed?.publicKey ?? null, signer: SIGNER, validation: validation as unknown as Prisma.InputJsonValue, createdBy: userId } });
    await job("GENERATED", null, tx);
    await auditAccounting(tx, { action: "einvoice.generate", entityType: "einvoice", entityId: e.id, userId, after: { doc: doc.id, icv: e.icv, hash, subtype: doc.subtype, valid: validation.every((v) => v.ok) } });
    return { status: "GENERATED" as const, eInvoiceId: e.id };
  });
}

/** Called after a sales document posts: never fails the posting; the job records any problem. */
export async function generateAfterPosting(salesInvoiceId: string, userId: string) {
  try { return await generateEInvoice(salesInvoiceId, userId); }
  catch (e) {
    await prisma.eInvoiceJob.upsert({ where: { salesInvoiceId }, update: { status: "FAILED", errors: [{ message: (e as Error).message }] as Prisma.InputJsonValue, attempts: { increment: 1 }, lastAttemptAt: new Date() },
      create: { salesInvoiceId, status: "FAILED", errors: [{ message: (e as Error).message }] as Prisma.InputJsonValue, attempts: 1, lastAttemptAt: new Date() } }).catch(() => undefined);
    return { status: "FAILED" as const, message: (e as Error).message };
  }
}

/** Re-run the local rules on a stored e-invoice (read-only; the document itself never changes). */
export async function revalidate(id: string) {
  const e = await prisma.eInvoice.findUnique({ where: { id }, include: { } });
  if (!e) throw new AccountingError("E-invoice not found.", 404);
  const profile = await prisma.eInvoiceProfile.findUniqueOrThrow({ where: { id: e.profileId } });
  const { doc } = await docModel(prisma, e.salesInvoiceId, profile, { icv: e.icv, previousHash: e.previousHash, uuid: e.uuid });
  const results = validateDoc(doc, { xml: e.xml, invoiceHash: e.invoiceHash, qr: e.qr, signature: e.signature, publicKey: e.publicKey });
  const prev = e.icv > 1 ? await prisma.eInvoice.findUnique({ where: { egsSerial_icv: { egsSerial: e.egsSerial, icv: e.icv - 1 } } }) : null;
  results.push({ id: "LOCAL-CHAIN", ok: e.icv === 1 ? e.previousHash === INITIAL_PIH : prev?.invoiceHash === e.previousHash, en: "ICV follows its predecessor and PIH is that document's hash", ar: "ICV يلي سابقه و PIH هو تجزئة المستند السابق" });
  return results;
}

// ── Submission (never production) ───────────────────────────────────────────────────────────
type Fetcher = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ status: number; json: () => Promise<unknown> }>;

export async function submitEInvoice(id: string, userId: string, opts: { fetcher?: Fetcher; env?: Record<string, string | undefined>; now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const e = await prisma.eInvoice.findUnique({ where: { id }, include: { submissions: { orderBy: { attempt: "desc" } } } });
  if (!e) throw new AccountingError("E-invoice not found.", 404);
  const last = e.submissions[0];
  if (last && ["ACCEPTED", "ACCEPTED_WITH_WARNINGS"].includes(last.outcome)) throw new AccountingError("This e-invoice has already been accepted; it is not sent again.", 409);
  if (last && last.outcome === "RETRYABLE_ERROR" && last.nextAttemptAt && last.nextAttemptAt > now) throw new AccountingError(`The next attempt is due at ${last.nextAttemptAt.toISOString()}.`, 409);
  const profile = await prisma.eInvoiceProfile.findUniqueOrThrow({ where: { id: e.profileId } });
  const target = submissionTarget(profile.environment, opts.env);
  const attempt = (last?.attempt ?? 0) + 1;
  const body = JSON.stringify({ invoiceHash: e.invoiceHash, uuid: e.uuid, invoice: Buffer.from(e.xml, "utf8").toString("base64") });
  const requestHash = createHash("sha256").update(body).digest("base64");
  const record = (data: { environment: string; endpoint?: string | null; outcome: string; httpStatus?: number | null; response?: unknown; nextAttemptAt?: Date | null }) => ledgerTx(async (tx) => {
    const s = await tx.eInvoiceSubmission.create({ data: { eInvoiceId: id, attempt, requestHash, createdBy: userId, environment: data.environment, endpoint: data.endpoint ?? null, outcome: data.outcome, httpStatus: data.httpStatus ?? null,
      response: data.response === undefined ? undefined : (JSON.parse(JSON.stringify(data.response)) as Prisma.InputJsonValue), nextAttemptAt: data.nextAttemptAt ?? null } });
    await auditAccounting(tx, { action: "einvoice.submit", entityType: "einvoice", entityId: id, userId, after: { attempt, environment: data.environment, outcome: data.outcome, httpStatus: data.httpStatus ?? null } });
    return s;
  });
  if ("refused" in target) return record({ environment: profile.environment, outcome: "NOT_SENT", response: { reason: target.refused } });
  if (target.environment === "LOCAL_ONLY") return record({ environment: "LOCAL_ONLY", outcome: "NOT_SENT", response: { reason: "Submission is disabled: the approved profile is LOCAL_ONLY. Nothing was sent to ZATCA." } });

  const endpoint = `${target.baseUrl}${e.subtype === "0200000" ? "/invoices/reporting/single" : "/invoices/clearance/single"}`;
  const fetcher: Fetcher = opts.fetcher ?? ((url, init) => fetch(url, init));
  let status = 0; let response: unknown = null;
  try {
    const res = await fetcher(endpoint, { method: "POST", headers: { "Content-Type": "application/json", "Accept-Version": "V2", "Accept-Language": "en", "Clearance-Status": e.subtype === "0200000" ? "0" : "1",
      Authorization: `Basic ${Buffer.from(`${target.token}:${target.secret}`).toString("base64")}` }, body });
    status = res.status; response = await res.json().catch(() => null);
  } catch (err) { status = 0; response = { error: (err as Error).message }; }
  const outcome = status === 200 ? "ACCEPTED" : status === 202 ? "ACCEPTED_WITH_WARNINGS" : status === 400 ? "REJECTED" : [401, 403].includes(status) ? "AUTH_ERROR" : "RETRYABLE_ERROR";
  const retries = e.submissions.filter((s) => s.outcome === "RETRYABLE_ERROR").length;
  const next = outcome === "RETRYABLE_ERROR" && retries < BACKOFF_MIN.length ? new Date(now.getTime() + BACKOFF_MIN[retries] * 60_000) : null;
  return record({ environment: "SANDBOX", endpoint, outcome: outcome === "RETRYABLE_ERROR" && !next ? "FAILED" : outcome, httpStatus: status || null, response, nextAttemptAt: next });
}

/** Retry every e-invoice whose last attempt was retryable and is due. */
export async function processDueSubmissions(userId: string, opts: { fetcher?: Fetcher; env?: Record<string, string | undefined>; now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const due = await prisma.$queryRaw<{ id: string }[]>`
    SELECT e."id" FROM "EInvoice" e JOIN LATERAL (SELECT s.* FROM "EInvoiceSubmission" s WHERE s."eInvoiceId" = e."id" ORDER BY s."attempt" DESC LIMIT 1) l ON true
     WHERE l."outcome" = 'RETRYABLE_ERROR' AND l."nextAttemptAt" <= ${now}`;
  const out = [];
  for (const { id } of due) out.push(await submitEInvoice(id, userId, opts).catch((err) => ({ id, error: (err as Error).message })));
  return out;
}

// ── Debit notes ─────────────────────────────────────────────────────────────────────────────
export async function markDebitNote(tx: Tx, draftId: string, originalId: string, reason: unknown) {
  const why = typeof reason === "string" ? reason.trim() : "";
  if (why.length < 5) throw new AccountingError("A debit note needs a reason (at least 5 characters).", 400);
  const [d, o] = await Promise.all([tx.salesInvoice.findUnique({ where: { id: draftId }, include: { lines: true } }), tx.salesInvoice.findUnique({ where: { id: originalId } })]);
  if (!d || d.status !== "DRAFT" || d.kind !== "INVOICE") throw new AccountingError("A debit note is prepared as a draft invoice.", 409);
  if (!o || o.kind !== "INVOICE" || o.debitNoteOfId || !["POSTED", "REVERSED"].includes(o.status)) throw new AccountingError("A debit note raises a posted invoice (not another debit note).", 400);
  if (o.customerId !== d.customerId) throw new AccountingError("A debit note is for the same customer as its invoice.", 400);
  if (d.orderId || d.lines.some((l) => l.stockTreatment === "GOODS" || l.productSkuId || l.invItemId)) throw new AccountingError("A debit note raises an amount (price or charge); it carries no goods lines or order.", 400);
  return tx.salesInvoice.update({ where: { id: draftId }, data: { debitNoteOfId: originalId, reason: why.slice(0, 300) } });
}

// ── Read models ─────────────────────────────────────────────────────────────────────────────
export async function eInvoiceList() {
  const docs = await prisma.salesInvoice.findMany({ where: { status: { in: ["POSTED", "REVERSED"] } }, include: { customer: true }, orderBy: { invoiceNo: "desc" }, take: 200 });
  const [einv, jobs] = await Promise.all([
    prisma.eInvoice.findMany({ where: { salesInvoiceId: { in: docs.map((d) => d.id) } }, include: { submissions: { orderBy: { attempt: "desc" }, take: 1 } } }),
    prisma.eInvoiceJob.findMany({ where: { salesInvoiceId: { in: docs.map((d) => d.id) } } }),
  ]);
  const byDoc = new Map(einv.map((e) => [e.salesInvoiceId, e])), jobBy = new Map(jobs.map((j) => [j.salesInvoiceId, j]));
  return docs.map((d) => {
    const e = byDoc.get(d.id), j = jobBy.get(d.id);
    const v = (e?.validation ?? []) as unknown as RuleResult[];
    return {
      salesInvoiceId: d.id, doc: label(d), kind: d.kind, debitNote: !!d.debitNoteOfId, status: d.status, customer: d.customer.nameAr ?? d.customer.name, customerId: d.customerId, nationalAddress: d.customer.nationalAddress, gross: d.totalGross.toFixed(2), issueDate: dateStr(d.issueDate),
      einvoice: e ? { id: e.id, icv: e.icv, typeCode: e.typeCode, subtype: e.subtype, valid: v.every((x) => x.ok), failed: v.filter((x) => !x.ok).length, lastSubmission: e.submissions[0] ? { outcome: e.submissions[0].outcome, attempt: e.submissions[0].attempt, environment: e.submissions[0].environment } : null } : null,
      job: j ? { status: j.status, attempts: j.attempts, errors: j.errors } : null,
      reversedAfterIssue: d.status === "REVERSED" && !!e,
    };
  });
}

export async function eInvoiceDetail(id: string) {
  const e = await prisma.eInvoice.findUnique({ where: { id }, include: { submissions: { orderBy: { attempt: "asc" } } } });
  if (!e) throw new AccountingError("E-invoice not found.", 404);
  const d = await prisma.salesInvoice.findUniqueOrThrow({ where: { id: e.salesInvoiceId }, include: { customer: true } });
  return { ...e, standardsGaps: standardsGaps(e.subtype, e.qr), doc: label(d), customer: d.customer.nameAr ?? d.customer.name, issueDay: riyadhDateString(e.issueAt), gross: d.totalGross.toFixed(2), vat: d.totalVat.toFixed(2) };
}
