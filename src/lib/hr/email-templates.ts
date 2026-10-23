// HR e-mails — the templates, in code and versioned (feat/hr-expiry-email). Pure: no database, no clock;
// the service (./services/hr-email.ts) gathers the facts and the unit tests render them.
//
//   * hr-interview-invite/v1   «دعوة لمقابلة عمل» — to the applicant's e-mail (HrApplicant.email).
//   * hr-separation-notice/v1  «إشعار إنهاء الخدمة» — to the employee's PERSONAL e-mail
//                              (HrEmployeePrivate.personalEmail; the company e-mail only on an explicit
//                              confirmation).
//
// Arabic first (RTL), then an English section (LTR). Inline styles only (mail clients ignore
// stylesheets). No image, no tracking pixel, no external resource, no script; the only link is the
// online-interview link the HR user typed, and only when it is an http(s) URL. Every value is escaped.
// The company name comes from Settings (SystemConfig seller fields); when they are empty (production
// today) the e-mail names no legal entity and uses the product name «حِقبة» / «Hiqbah». A change to the
// wording is a new version: the version is recorded with every send (HrAuditLog).
//
// End-of-service amounts are NEVER in the notice: the separation service records the figures by hand
// and computes nothing (HrSeparation.eosAmount: «Entered, never computed»; the final settlement is a
// separate, reviewed record), so there is no computed amount to state.

export const HR_EMAIL_TEMPLATES = { interview: "hr-interview-invite/v1", separation: "hr-separation-notice/v1" } as const;

export type Company = { nameAr: string; nameEn: string; legal: boolean; phone: string | null };
export type Rendered = { subject: string; html: string; text: string; version: string };

const BRAND_AR = "حِقبة";
const BRAND_EN = "Hiqbah";

/** The sender's name from the Settings seller fields; the product name when they are empty. */
export function companyFrom(row: { sellerLegalNameAr?: string | null; sellerLegalNameEn?: string | null; sellerPhone?: string | null } | null | undefined): Company {
  const ar = row?.sellerLegalNameAr?.trim() || "";
  const en = row?.sellerLegalNameEn?.trim() || "";
  return { nameAr: ar || en || BRAND_AR, nameEn: en || ar || BRAND_EN, legal: !!(ar || en), phone: row?.sellerPhone?.trim() || null };
}

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** An http(s) URL the HR user typed, or null (anything else is shown as plain text, never linked). */
export function safeUrl(v: string | null | undefined): string | null {
  const t = (v ?? "").trim();
  if (!t || t.length > 500) return null;
  try {
    const u = new URL(t);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** A date-time in Asia/Riyadh, Gregorian with Latin digits (the HR screens' convention). */
export function riyadhDateTime(d: Date, lang: "ar" | "en"): string {
  const f = new Intl.DateTimeFormat(lang === "ar" ? "ar-SA-u-ca-gregory-nu-latn" : "en-GB", {
    timeZone: "Asia/Riyadh", weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true,
  });
  return `${f.format(d)} ${lang === "ar" ? "(بتوقيت الرياض)" : "(Riyadh time, UTC+3)"}`;
}

/** A calendar day «YYYY-MM-DD» as words, in the given language (no time zone shift). */
export function dayWords(day: string, lang: "ar" | "en"): string {
  const d = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return day;
  return new Intl.DateTimeFormat(lang === "ar" ? "ar-SA-u-ca-gregory-nu-latn" : "en-GB", { timeZone: "UTC", weekday: "long", year: "numeric", month: "long", day: "numeric" }).format(d);
}

/** Mask an address for logs and for a viewer without the private-data permission: «a•••@e•••.com». */
export function maskEmail(e: string | null | undefined): string | null {
  if (!e) return null;
  const [u, d] = e.split("@");
  if (!d) return "•••";
  const dot = d.lastIndexOf(".");
  const host = dot > 0 ? d.slice(0, dot) : d;
  const tld = dot > 0 ? d.slice(dot) : "";
  return `${u.slice(0, 1)}•••@${host.slice(0, 1)}•••${tld}`;
}

const para = (t: string) => t.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => `<p style="margin:0 0 10px">${esc(l)}</p>`).join("");
const row = (k: string, v: string) => `<tr><td style="padding:6px 0;color:#5f5b53;white-space:nowrap;vertical-align:top">${esc(k)}</td><td style="padding:6px 12px;font-weight:600">${v}</td></tr>`;

function shell(o: { lang: "ar"; title: string; heading: string; ar: string; en: string; footerAr: string; footerEn: string }): string {
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(o.title)}</title></head>
<body style="margin:0;background:#f6f5f2;font-family:'IBM Plex Sans Arabic',Tahoma,Arial,sans-serif;color:#1c1b19">
<div style="max-width:600px;margin:24px auto;background:#fff;border-radius:12px;border:1px solid #e7e4dd;overflow:hidden">
<div style="padding:14px 20px;border-bottom:1px solid #e7e4dd;font-weight:600">${esc(o.heading)}</div>
<div style="padding:20px;font-size:14px;line-height:1.8" dir="rtl">${o.ar}<p style="margin:16px 0 0;color:#5f5b53;font-size:12px">${esc(o.footerAr)}</p></div>
<hr style="border:0;border-top:1px solid #e7e4dd;margin:0">
<div dir="ltr" style="padding:20px;text-align:left;font-size:13px;line-height:1.7;color:#3d3a35">${o.en}<p style="margin:16px 0 0;color:#5f5b53;font-size:12px">${esc(o.footerEn)}</p></div>
</div></body></html>`;
}

// ── Interview invitation ───────────────────────────────────────────────────────────

export type InterviewInviteInput = {
  company: Company; applicantName: string; position: string | null; scheduledAt: Date; kind: string;
  location: string | null; contactName: string | null; contactPhone: string | null; note: string | null;
};

export function renderInterviewInvite(i: InterviewInviteInput): Rendered {
  const link = safeUrl(i.location);
  const whereAr = link ? `<a href="${esc(link)}" style="color:#1c1b19">${esc(link)}</a> (مقابلة عن بُعد)` : i.location ? esc(i.location) : "سنرسل لك تفاصيل المكان قبل الموعد";
  const whereEn = link ? `<a href="${esc(link)}" style="color:#1c1b19">${esc(link)}</a> (online)` : i.location ? esc(i.location) : "We will send you the location before the interview";
  const whenAr = riyadhDateTime(i.scheduledAt, "ar");
  const whenEn = riyadhDateTime(i.scheduledAt, "en");
  const posAr = i.position || "الوظيفة التي تقدّمت لها";
  const posEn = i.position || "the position you applied for";
  const contact = [i.contactName, i.contactPhone].filter(Boolean).join(" · ");
  const ar = `<h1 style="margin:0 0 12px;font-size:18px;line-height:1.5">دعوة لمقابلة عمل</h1>
<p style="margin:0 0 10px">السيد/السيدة ${esc(i.applicantName)}،</p>
<p style="margin:0 0 10px">يسعدنا دعوتك لمقابلة لوظيفة «${esc(posAr)}» لدى ${esc(i.company.nameAr)}.</p>
<table role="presentation" style="border-collapse:collapse;margin:8px 0 12px">${row("الموعد", esc(whenAr))}${row("نوع المقابلة", esc(i.kind))}${row("المكان أو الرابط", whereAr)}${contact ? row("للتواصل", esc(contact)) : ""}</table>
${i.note ? `<div style="margin:0 0 10px;padding:10px 12px;background:#f6f5f2;border-radius:8px">${para(i.note)}</div>` : ""}
<p style="margin:0 0 10px">نرجو تأكيد حضورك بالرد على هذه الرسالة. إن لم يناسبك الموعد فاقترح موعدًا آخر في ردّك وسنعيد الجدولة.</p>
<p style="margin:0">مع التحية،<br>${esc(i.company.nameAr)}</p>`;
  const en = `<h2 style="margin:0 0 10px;font-size:16px">Interview invitation</h2>
<p style="margin:0 0 10px">Dear ${esc(i.applicantName)},</p>
<p style="margin:0 0 10px">We are pleased to invite you to an interview for “${esc(posEn)}” at ${esc(i.company.nameEn)}.</p>
<table role="presentation" style="border-collapse:collapse;margin:8px 0 12px">${row("When", esc(whenEn))}${row("Interview", esc(i.kind))}${row("Where", whereEn)}${contact ? row("Contact", esc(contact)) : ""}</table>
<p style="margin:0 0 10px">Please confirm your attendance by replying to this e-mail. If the time does not suit you, suggest another in your reply and we will reschedule.</p>
<p style="margin:0">Kind regards,<br>${esc(i.company.nameEn)}</p>`;
  const subject = `دعوة لمقابلة عمل — ${posAr} | Interview invitation — ${posEn}`;
  const text = [
    "دعوة لمقابلة عمل", `السيد/السيدة ${i.applicantName}،`, `يسعدنا دعوتك لمقابلة لوظيفة «${posAr}» لدى ${i.company.nameAr}.`,
    `الموعد: ${whenAr}`, `نوع المقابلة: ${i.kind}`, `المكان أو الرابط: ${link ?? i.location ?? "سنرسل لك تفاصيل المكان قبل الموعد"}`, contact ? `للتواصل: ${contact}` : "",
    i.note ?? "", "نرجو تأكيد حضورك بالرد على هذه الرسالة. إن لم يناسبك الموعد فاقترح موعدًا آخر في ردّك وسنعيد الجدولة.", `مع التحية، ${i.company.nameAr}`,
    "", "— Interview invitation", `Dear ${i.applicantName},`, `We are pleased to invite you to an interview for "${posEn}" at ${i.company.nameEn}.`,
    `When: ${whenEn}`, `Interview: ${i.kind}`, `Where: ${link ?? i.location ?? "We will send you the location before the interview"}`, contact ? `Contact: ${contact}` : "",
    "Please confirm your attendance by replying to this e-mail. If the time does not suit you, suggest another in your reply and we will reschedule.", `Kind regards, ${i.company.nameEn}`,
  ].filter((l) => l !== "").join("\n");
  return {
    subject, text, version: HR_EMAIL_TEMPLATES.interview,
    html: shell({ lang: "ar", title: subject, heading: `${i.company.nameAr} · الموارد البشرية`, ar, en, footerAr: "رسالة من قسم الموارد البشرية. لا تحتوي على أي متتبع.", footerEn: "A message from Human Resources. It contains no tracking." }),
  };
}

// ── End-of-service notice ──────────────────────────────────────────────────────────

export const SEPARATION_TYPE_WORDS: Record<string, { ar: string; en: string }> = {
  RESIGNATION: { ar: "استقالة", en: "Resignation" },
  TERMINATION: { ar: "إنهاء من صاحب العمل", en: "Termination by the employer" },
  END_OF_CONTRACT: { ar: "انتهاء العقد", en: "End of contract" },
  OTHER: { ar: "أخرى", en: "Other" },
};
export const CLEARANCE_WORDS: Record<string, { ar: string; en: string }> = {
  ASSETS: { ar: "إعادة العهد", en: "Return company assets" },
  ADVANCES: { ar: "تسوية السلف", en: "Settle advances" },
  PENDING_LEAVE: { ar: "حسم طلبات الإجازة المعلّقة", en: "Close pending leave requests" },
  FINAL_PAYROLL: { ar: "مسير الرواتب الأخير", en: "Final payroll" },
  SETTLEMENT: { ar: "التسوية النهائية", en: "Final settlement" },
};

export type SeparationNoticeInput = {
  company: Company; employeeName: string; employeeNo: string; type: string; noticeDate: string; lastWorkingDay: string;
  reference: string; checklist: { key: string; ok: boolean }[]; contactName: string | null; note: string | null;
};

/** A short, stable reference for a separation («EOS-HR-001-1A2B3C»). */
export function separationReference(employeeNo: string, separationId: string): string {
  return `EOS-${employeeNo}-${separationId.slice(-6).toUpperCase()}`;
}

export function renderSeparationNotice(i: SeparationNoticeInput): Rendered {
  const t = SEPARATION_TYPE_WORDS[i.type] ?? { ar: i.type, en: i.type };
  const items = i.checklist.filter((c) => CLEARANCE_WORDS[c.key]);
  const listAr = items.map((c) => `<li style="margin:0 0 4px">${esc(CLEARANCE_WORDS[c.key].ar)} — ${c.ok ? "مكتمل" : "قائم"}</li>`).join("");
  const listEn = items.map((c) => `<li style="margin:0 0 4px">${esc(CLEARANCE_WORDS[c.key].en)} — ${c.ok ? "done" : "open"}</li>`).join("");
  const ar = `<h1 style="margin:0 0 12px;font-size:18px;line-height:1.5">إشعار إنهاء الخدمة</h1>
<p style="margin:0 0 10px">السيد/السيدة ${esc(i.employeeName)} (الرقم الوظيفي ${esc(i.employeeNo)})،</p>
<p style="margin:0 0 10px">نُشعرك بإنهاء خدمتك لدى ${esc(i.company.nameAr)} وفق البيانات التالية:</p>
<table role="presentation" style="border-collapse:collapse;margin:8px 0 12px">${row("نوع الإنهاء", esc(t.ar))}${row("تاريخ الإشعار", esc(dayWords(i.noticeDate, "ar")))}${row("آخر يوم عمل", esc(dayWords(i.lastWorkingDay, "ar")))}${row("مرجع إخلاء الطرف", `<span dir="ltr">${esc(i.reference)}</span>`)}</table>
<p style="margin:0 0 6px">قائمة التسليم وإخلاء الطرف:</p><ul style="margin:0 0 12px;padding-inline-start:20px">${listAr}</ul>
${i.note ? `<div style="margin:0 0 10px;padding:10px 12px;background:#f6f5f2;border-radius:8px">${para(i.note)}</div>` : ""}
<p style="margin:0 0 10px">نرجو إتمام التسليم قبل آخر يوم عمل. تُبلَّغ بالتسوية المالية النهائية بشكل مستقل بعد اعتمادها. للاستفسار ردّ على هذه الرسالة${i.contactName ? ` أو تواصل مع ${esc(i.contactName)}` : ""}.</p>
<p style="margin:0">مع التحية،<br>${esc(i.company.nameAr)} · الموارد البشرية</p>`;
  const en = `<h2 style="margin:0 0 10px;font-size:16px">End-of-service notice</h2>
<p style="margin:0 0 10px">Dear ${esc(i.employeeName)} (employee no. ${esc(i.employeeNo)}),</p>
<p style="margin:0 0 10px">This is to notify you of the end of your service with ${esc(i.company.nameEn)}, as follows:</p>
<table role="presentation" style="border-collapse:collapse;margin:8px 0 12px">${row("Type", esc(t.en))}${row("Notice date", esc(dayWords(i.noticeDate, "en")))}${row("Last working day", esc(dayWords(i.lastWorkingDay, "en")))}${row("Clearance reference", esc(i.reference))}</table>
<p style="margin:0 0 6px">Handover and clearance checklist:</p><ul style="margin:0 0 12px;padding-left:20px">${listEn}</ul>
<p style="margin:0 0 10px">Please complete the handover before your last working day. The final financial settlement is communicated separately once approved. For any question, reply to this e-mail${i.contactName ? ` or contact ${esc(i.contactName)}` : ""}.</p>
<p style="margin:0">Kind regards,<br>${esc(i.company.nameEn)} · Human Resources</p>`;
  const subject = `إشعار إنهاء الخدمة — ${i.employeeName} | End-of-service notice`;
  const text = [
    "إشعار إنهاء الخدمة", `السيد/السيدة ${i.employeeName} (الرقم الوظيفي ${i.employeeNo})،`, `نُشعرك بإنهاء خدمتك لدى ${i.company.nameAr} وفق البيانات التالية:`,
    `نوع الإنهاء: ${t.ar}`, `تاريخ الإشعار: ${i.noticeDate}`, `آخر يوم عمل: ${i.lastWorkingDay}`, `مرجع إخلاء الطرف: ${i.reference}`,
    "قائمة التسليم وإخلاء الطرف:", ...items.map((c) => `- ${CLEARANCE_WORDS[c.key].ar} — ${c.ok ? "مكتمل" : "قائم"}`),
    i.note ?? "", "نرجو إتمام التسليم قبل آخر يوم عمل. تُبلَّغ بالتسوية المالية النهائية بشكل مستقل بعد اعتمادها.",
    "", "— End-of-service notice", `Dear ${i.employeeName} (employee no. ${i.employeeNo}),`, `Type: ${t.en}`, `Notice date: ${i.noticeDate}`, `Last working day: ${i.lastWorkingDay}`, `Clearance reference: ${i.reference}`,
    ...items.map((c) => `- ${CLEARANCE_WORDS[c.key].en} — ${c.ok ? "done" : "open"}`),
    "Please complete the handover before your last working day. The final financial settlement is communicated separately once approved.",
  ].filter((l) => l !== "").join("\n");
  return {
    subject, text, version: HR_EMAIL_TEMPLATES.separation,
    html: shell({ lang: "ar", title: subject, heading: `${i.company.nameAr} · الموارد البشرية`, ar, en, footerAr: "رسالة من قسم الموارد البشرية. لا تحتوي على أي متتبع.", footerEn: "A message from Human Resources. It contains no tracking." }),
  };
}
