"use client";

// Shared pieces of the tax screens (Figma page 23, ACC-70..72). The banner is on every screen:
// validation is local and nothing is sent to ZATCA.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Notice, useL, type Tone } from "../../finance/_components/ui";

export function LocalOnlyBanner() {
  const { L } = useL();
  return <Notice tone="bad">{L("تحقق محلي فقط — لم يُرسل أي مستند إلى هيئة الزكاة والضريبة والجمارك (لا بيئة محاكاة ولا إنتاج). اجتياز التحقق المحلي لا يعني الامتثال.",
    "Local validation only — no document has been sent to ZATCA (neither simulation nor production). Passing local validation is not compliance.")}</Notice>;
}

export function TaxNav() {
  const { L } = useL();
  const path = usePathname();
  const items = [["/dashboard/accounting/tax", "الفواتير الإلكترونية", "E-invoices"], ["/dashboard/accounting/tax/profile", "ملف البائع", "Seller profile"], ["/dashboard/accounting/tax/vat-return", "إقرار ضريبة القيمة المضافة", "VAT return"]];
  return (
    <nav className="flex gap-2 flex-wrap" aria-label={L("أقسام الضريبة", "Tax sections")}>
      {items.map(([href, ar, en]) => <Link key={href} href={href} aria-current={path === href ? "page" : undefined} className={`px-3 py-1.5 rounded-lg text-[13px] font-bold border ${path === href ? "bg-orange text-white border-orange" : "bg-white text-brown border-border hover:bg-cream"}`}>{L(ar, en)}</Link>)}
    </nav>
  );
}

export const OUTCOME: Record<string, [string, string, Tone]> = {
  NOT_SENT: ["غير مُرسل", "Not sent", "info"], ACCEPTED: ["مقبول (بيئة اختبار)", "Accepted (test environment)", "ok"], ACCEPTED_WITH_WARNINGS: ["مقبول مع تحذيرات (اختبار)", "Accepted with warnings (test)", "warn"],
  REJECTED: ["مرفوض (اختبار)", "Rejected (test)", "bad"], AUTH_ERROR: ["خطأ اعتماد", "Authentication error", "bad"], RETRYABLE_ERROR: ["خطأ مؤقت — إعادة لاحقاً", "Temporary error — will retry", "warn"], FAILED: ["فشل بعد المحاولات", "Failed after retries", "bad"],
};
export const TYPE: Record<string, [string, string]> = { "388": ["فاتورة", "Invoice"], "381": ["إشعار دائن", "Credit note"], "383": ["إشعار مدين", "Debit note"] };
export const SUBTYPE: Record<string, [string, string]> = { "0100000": ["قياسية", "Standard"], "0200000": ["مبسطة", "Simplified"] };
export const JOB: Record<string, [string, string, Tone]> = {
  WAITING_PROFILE: ["بانتظار اعتماد ملف البائع", "Waiting for an approved seller profile", "warn"], INVALID: ["مخالف محلياً — لم يُصدَر", "Invalid locally — not issued", "bad"],
  FAILED: ["تعذّر الإنشاء", "Generation failed", "bad"], GENERATED: ["أُنشئ", "Generated", "ok"],
};
