// Storage incidents and their alerts (owner requirement, feat/credit-hold).
//
// When the private Blob store of the customer files fails (an upload, a download, a delete) or is
// not configured on a production deployment, the accounts that hold Settings at edit are told —
// in the app (the bell, SystemAlert) and by e-mail (lib/notify/email.ts, when configured) — what
// happened, whether files are still being saved (the database fallback, ≤ 5 MB) or refused, and
// whether it fixes itself or what exactly the owner must do. The next successful Blob operation
// closes the incident and sends «تم إصلاح المشكلة» with the number of files that went to the
// database meanwhile.
//
// ── Deduplication ──
// One OPEN incident per kind (SystemIncident, partial unique index); further failures only count.
// An incident alert goes out when the incident opens — unless another incident alert of the same
// kind went out within ALERT_COOLDOWN_MS (a store that flaps does not mail every few minutes);
// the recovery alert goes out only for an incident that was alerted.
//
// Recipients: active accounts that hold Settings at edit (the administrator always, SIMPLE MODE
// included) — the people who can act on the deployment. Their address: the company e-mail
// (lib/notify/recipients.ts, purpose "system": the linked HR person's «بريد الشركة», else the
// account's own); an account without one gets the in-app alert only.
//
// Reporting never throws: an alert that cannot be written must not turn a saved file into an error.

import type { Prisma as PrismaNS, PrismaClient } from "@/generated/prisma/client";
import { canEdit, parsePermissions } from "@/lib/auth-shared";
import { simpleModePermissions } from "@/lib/simple-mode";
import { alertEmailHtml, sendEmail, type EmailResult } from "@/lib/notify/email";
import { looksLikeAuth } from "../customers/file-store";
import { recipientFor } from "@/lib/notify/recipients";

type Db = PrismaClient | PrismaNS.TransactionClient;

export const ALERT_COOLDOWN_MS = 30 * 60_000;
export type StorageCause = "UPLOAD_FAILED" | "DOWNLOAD_FAILED" | "DELETE_FAILED" | "NOT_CONFIGURED";
export type StorageOutcome = "FALLBACK" | "REFUSED" | "NONE";

/** The owner's own resource names (the brief): what to check in Vercel. */
const STORE = "flow-com-blob";
const PROJECT = "flow-com";
const FIX_AR = `افتح Vercel › Storage وتحقق أن مخزن Blob «${STORE}» (خاص) متصل بمشروع «${PROJECT}» لبيئتي Production وPreview، وأن المتغير BLOB_STORE_ID موجود في المشروع، ثم أعد نشر آخر إصدار.`;
const FIX_EN = `In Vercel › Storage, check that the private Blob store "${STORE}" is connected to project "${PROJECT}" for Production and Preview and that BLOB_STORE_ID is set on the project, then redeploy the latest version.`;

/** The incident alert's words, by cause. Pure. */
export function incidentText(cause: StorageCause, detail: string | null, outcome: StorageOutcome): { titleAr: string; titleEn: string; bodyAr: string; bodyEn: string; severity: "danger" | "warning"; ownerMustAct: boolean } {
  const auth = !!detail && looksLikeAuth(detail);
  const code = detail ? ` (${detail})` : "";
  const saving = outcome === "REFUSED"
    ? { ar: "رُفض الملف لأنه أكبر من 5 ميغابايت، وهو حد الحفظ الاحتياطي في قاعدة البيانات. الملفات حتى 5 ميغابايت تُحفظ في قاعدة البيانات مؤقتًا ولا يضيع منها شيء.", en: "The file was refused because it is over 5 MB, the database fallback's limit. Files up to 5 MB are saved in the database meanwhile; nothing is lost." }
    : { ar: "الملفات حتى 5 ميغابايت تُحفظ مؤقتًا في قاعدة البيانات ولا يضيع منها شيء؛ الأكبر منها يُرفض حتى يعود التخزين.", en: "Files up to 5 MB are saved in the database meanwhile and nothing is lost; larger ones are refused until storage is back." };
  if (cause === "NOT_CONFIGURED") {
    return {
      severity: "warning", ownerMustAct: true,
      titleAr: "تخزين ملفات العملاء (Vercel Blob) غير مُعدّ في الإنتاج",
      titleEn: "Customer file storage (Vercel Blob) is not configured in production",
      bodyAr: `لا يجد النظام مخزن Blob في بيئة الإنتاج (المتغير BLOB_STORE_ID غير موجود)، فتُحفظ ملفات العملاء في قاعدة البيانات.\n${saving.ar}\nلن يُصلح هذا نفسه. المطلوب منك: ${FIX_AR}`,
      bodyEn: `The production deployment finds no Blob store (BLOB_STORE_ID is not set), so customer files are saved in the database.\n${saving.en}\nThis will not fix itself. What to do: ${FIX_EN}`,
    };
  }
  if (cause === "DOWNLOAD_FAILED") {
    return {
      severity: "danger", ownerMustAct: auth,
      titleAr: "تعذّر تنزيل ملفات العملاء من Vercel Blob",
      titleEn: "Customer files cannot be downloaded from Vercel Blob",
      bodyAr: `فشل تنزيل ملف محفوظ في Vercel Blob${code}. الملفات لم تُحذف، لكن تنزيلها يتعذّر الآن ويُعرض للمستخدم خطأ واضح.\n${auth ? `يبدو أن المخزن رفض صلاحيات النظام؛ لن يُصلح هذا نفسه. المطلوب منك: ${FIX_AR}` : "قد يكون عطلًا مؤقتًا في Vercel ويزول من تلقاء نفسه؛ سيصلك تنبيه «تم إصلاح المشكلة» عند أول عملية ناجحة. إن استمر أكثر من ساعة: " + FIX_AR}`,
      bodyEn: `Downloading a file kept in Vercel Blob failed${code}. No file was deleted, but downloads fail for now and users see a clear error.\n${auth ? `The store appears to refuse the app's credentials; this will not fix itself. What to do: ${FIX_EN}` : `It may be a temporary Vercel outage that clears by itself; you will get "Problem fixed" on the next successful operation. If it lasts over an hour: ${FIX_EN}`}`,
    };
  }
  const what = cause === "DELETE_FAILED"
    ? { ar: `فشل حذف ملف من Vercel Blob${code} (حُذف من النظام وبقيت نسخته في المخزن).`, en: `Deleting a file from Vercel Blob failed${code} (it is gone from the system; its copy stays in the store).` }
    : { ar: `فشل حفظ ملف عميل في Vercel Blob${code}.`, en: `Saving a customer file to Vercel Blob failed${code}.` };
  return {
    severity: "danger", ownerMustAct: auth,
    titleAr: "تعطّل تخزين ملفات العملاء في Vercel Blob",
    titleEn: "Customer file storage in Vercel Blob is failing",
    bodyAr: `${what.ar}\n${saving.ar}\n${auth ? `يبدو أن المخزن رفض صلاحيات النظام؛ لن يُصلح هذا نفسه. المطلوب منك: ${FIX_AR}` : `قد يكون عطلًا مؤقتًا في Vercel ويزول من تلقاء نفسه؛ سيصلك تنبيه «تم إصلاح المشكلة» عند أول عملية ناجحة. إن استمر أكثر من ساعة: ${FIX_AR}`}`,
    bodyEn: `${what.en}\n${saving.en}\n${auth ? `The store appears to refuse the app's credentials; this will not fix itself. What to do: ${FIX_EN}` : `It may be a temporary Vercel outage that clears by itself; you will get "Problem fixed" on the next successful operation. If it lasts over an hour: ${FIX_EN}`}`,
  };
}

/** The recovery alert's words. Pure. */
export function recoveredText(inc: { fallbackCount: number; refusedCount: number; openedAt: Date }) {
  const n = inc.fallbackCount;
  const filesAr = n === 0 ? "لم يُحفظ أي ملف في قاعدة البيانات خلال العطل." : n === 1 ? "حُفظ ملف واحد في قاعدة البيانات خلال العطل، ويعمل كالمعتاد." : `حُفظ ${n} ملفات في قاعدة البيانات خلال العطل، وتعمل كالمعتاد.`;
  const filesEn = n === 0 ? "No file was saved in the database meanwhile." : `${n} file${n === 1 ? " was" : "s were"} saved in the database meanwhile and work as usual.`;
  const refAr = inc.refusedCount > 0 ? `\nرُفض ${inc.refusedCount} ${inc.refusedCount === 1 ? "ملف" : "ملفات"} أكبر من 5 ميغابايت؛ يمكن رفعها الآن من جديد.` : "";
  const refEn = inc.refusedCount > 0 ? `\n${inc.refusedCount} file(s) over 5 MB were refused; they can be uploaded again now.` : "";
  return {
    severity: "success" as const,
    titleAr: "تم إصلاح المشكلة: تخزين ملفات العملاء يعمل",
    titleEn: "Problem fixed: customer file storage is working",
    bodyAr: `نجحت عملية على Vercel Blob من جديد، فعادت ملفات العملاء الجديدة تُحفظ فيه.\n${filesAr}${refAr}`,
    bodyEn: `An operation on Vercel Blob succeeded again, so new customer files are stored there.\n${filesEn}${refEn}`,
  };
}

/** Should the incident that is opening now be alerted? (cooldown). Pure. */
export function shouldAlert(lastIncidentAlertAt: Date | null, now: Date, cooldownMs = ALERT_COOLDOWN_MS): boolean {
  return !lastIncidentAlertAt || now.getTime() - lastIncidentAlertAt.getTime() >= cooldownMs;
}

/** Active accounts holding Settings at edit, and the address each is e-mailed at (if any). */
export async function alertRecipients(db: Db): Promise<{ id: string; email: string | null }[]> {
  const rows = await db.employee.findMany({
    where: { active: true },
    select: { id: true, role: true, permissions: true },
  });
  const out: { id: string; email: string | null }[] = [];
  for (const e of rows) {
    if (!canEdit(simpleModePermissions(parsePermissions(e.permissions as string), e.role), "settings")) continue;
    const r = await recipientFor(db, { accountId: e.id }, "system");
    out.push({ id: e.id, email: r.email });
  }
  return out;
}

async function raiseAlert(db: Db, a: { kind: "STORAGE_INCIDENT" | "STORAGE_RECOVERED"; severity: string; incidentId: string; titleAr: string; titleEn: string; bodyAr: string; bodyEn: string }) {
  const recipients = await alertRecipients(db);
  const to = recipients.map((r) => r.email).filter((x): x is string => !!x);
  const appUrl = process.env.APP_BASE_URL?.trim() || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : null);
  const status: EmailResult = await sendEmail({
    to,
    subject: `حِقبة · ${a.titleAr}`,
    html: alertEmailHtml({ ...a, appUrl }),
    text: `${a.titleAr}\n\n${a.bodyAr}\n\n— ${a.titleEn}\n${a.bodyEn}`,
  });
  return db.systemAlert.create({ data: { ...a, emailStatus: status, emailRecipients: status === "SENT" ? to.length : 0 } });
}

/**
 * A Blob operation failed (or Blob is missing in production). Opens the incident (alerting it,
 * cooldown permitting) or counts on the open one. Never throws.
 */
export async function reportStorageFailure(db: Db, cause: StorageCause, detail: string | null, outcome: StorageOutcome, now = new Date()): Promise<void> {
  try {
    const counts = { fallbackCount: outcome === "FALLBACK" ? 1 : 0, refusedCount: outcome === "REFUSED" ? 1 : 0 };
    const open = await db.systemIncident.findFirst({ where: { kind: "BLOB_STORAGE", status: "OPEN" }, select: { id: true } });
    if (open) {
      await db.systemIncident.update({
        where: { id: open.id },
        data: { lastSeenAt: now, occurrences: { increment: 1 }, fallbackCount: { increment: counts.fallbackCount }, refusedCount: { increment: counts.refusedCount } },
      });
      return;
    }
    let inc;
    try {
      inc = await db.systemIncident.create({ data: { kind: "BLOB_STORAGE", cause, detail: detail?.slice(0, 500) ?? null, openedAt: now, lastSeenAt: now, ...counts } });
    } catch {
      // Another request opened it a moment ago (partial unique index): count on that one.
      await reportStorageFailure(db, cause, detail, outcome, now);
      return;
    }
    const last = await db.systemAlert.findFirst({ where: { kind: "STORAGE_INCIDENT" }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
    if (!shouldAlert(last?.createdAt ?? null, now)) return;
    const t = incidentText(cause, detail, outcome);
    await raiseAlert(db, { kind: "STORAGE_INCIDENT", severity: t.severity, incidentId: inc.id, titleAr: t.titleAr, titleEn: t.titleEn, bodyAr: t.bodyAr, bodyEn: t.bodyEn });
    await db.systemIncident.update({ where: { id: inc.id }, data: { alertedAt: now } });
  } catch (e) {
    console.error("[storage-alerts] could not record the failure:", (e as Error)?.name ?? "error");
  }
}

/** A Blob operation succeeded: closes an open incident and, if it was alerted, says so. Never throws. */
export async function reportStorageSuccess(db: Db, now = new Date()): Promise<void> {
  try {
    const open = await db.systemIncident.findFirst({ where: { kind: "BLOB_STORAGE", status: "OPEN" } });
    if (!open) return;
    const closed = await db.systemIncident.updateMany({ where: { id: open.id, status: "OPEN" }, data: { status: "RESOLVED", resolvedAt: now } });
    if (closed.count === 0 || !open.alertedAt) return;
    const t = recoveredText(open);
    await raiseAlert(db, { kind: "STORAGE_RECOVERED", severity: t.severity, incidentId: open.id, titleAr: t.titleAr, titleEn: t.titleEn, bodyAr: t.bodyAr, bodyEn: t.bodyEn });
  } catch (e) {
    console.error("[storage-alerts] could not record the recovery:", (e as Error)?.name ?? "error");
  }
}
