// Local validation of an e-invoice document (stage 6). Pure.
//
// Rule IDs are LOCAL-*: they are this project's checks, written from what the official documents
// are known to require (titles and versions confirmed on zatca.gov.sa; contents not readable from
// this environment). They are NOT the official BR-KSA rule codes, and passing them is NOT ZATCA
// validation: only the official SDK or the Fatoora platform validates a document.
import { hashOfStoredXml, readQr, qrStampValues, verifyLocally, taxSubtotals, QR_ENCODING, type EDoc } from "./ubl";

export type RuleResult = { id: string; ok: boolean; en: string; ar: string; detail?: string };
const r2 = (n: number) => Math.round(n * 100) / 100;
const near = (a: number, b: number, tol = 0.01) => Math.abs(a - b) <= tol + 1e-9;
const VAT = /^3\d{13}3$/;

export function validateDoc(d: EDoc, stored?: { xml: string; invoiceHash: string; qr?: string | null; signature?: string | null; publicKey?: string | null }): RuleResult[] {
  const out: RuleResult[] = [];
  const rule = (id: string, ok: boolean, en: string, ar: string, detail?: string) => out.push({ id, ok, en, ar, ...(ok || !detail ? {} : { detail }) });
  const simplified = d.subtype === "0200000";
  const s = d.seller, sa = s.address;

  rule("LOCAL-SELLER-NAME", !!s.name?.trim(), "Seller legal name present", "اسم البائع القانوني موجود");
  rule("LOCAL-SELLER-VAT", VAT.test(s.vatNumber ?? ""), "Seller VAT number: 15 digits, starting and ending with 3", "رقم ضريبة البائع 15 رقماً يبدأ وينتهي بـ 3", s.vatNumber);
  rule("LOCAL-SELLER-CR", /^\d{10}$/.test(s.crNumber ?? ""), "Seller commercial registration: 10 digits", "السجل التجاري للبائع 10 أرقام", s.crNumber);
  rule("LOCAL-SELLER-ADDR", !!(sa?.street && sa.district && sa.city) && /^\d{4}$/.test(sa?.buildingNo ?? "") && /^\d{5}$/.test(sa?.postalCode ?? "") && sa?.countryCode === "SA",
    "Seller national address: street, 4-digit building number, district, city, 5-digit postal code, SA", "عنوان البائع الوطني: الشارع، رقم مبنى من 4 أرقام، الحي، المدينة، رمز بريدي من 5 أرقام، SA");

  const b = d.buyer, ba = b.address ?? {};
  if (!simplified) {
    rule("LOCAL-BUYER-NAME", !!b.name?.trim(), "Buyer name present (standard invoice)", "اسم المشتري موجود (فاتورة قياسية)");
    rule("LOCAL-BUYER-VAT", VAT.test(b.vatNumber ?? ""), "Buyer VAT number valid (standard invoice)", "رقم ضريبة المشتري صحيح (فاتورة قياسية)", b.vatNumber ?? "missing");
    const saAddr = (ba.countryCode ?? "SA") === "SA";
    rule("LOCAL-BUYER-ADDR", !!(ba.street && ba.city) && (!saAddr || (/^\d{4}$/.test(ba.buildingNo ?? "") && /^\d{5}$/.test(ba.postalCode ?? "") && !!ba.district)),
      "Buyer national address complete (standard invoice)", "عنوان المشتري الوطني مكتمل (فاتورة قياسية)", "street, building number, district, city, postal code");
  }

  rule("LOCAL-DOC-ID", !!d.id, "Document number present", "رقم المستند موجود");
  rule("LOCAL-UUID", /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(d.uuid), "UUID (version 4)", "المعرف الفريد UUID (الإصدار 4)");
  rule("LOCAL-TYPE", ["388", "381", "383"].includes(d.typeCode) && /^0[12]\d{5}$/.test(d.subtype), "Type code 388/381/383 with a standard (01…) or simplified (02…) subtype", "رمز النوع 388/381/383 مع نوع فرعي قياسي أو مبسط");
  rule("LOCAL-DATE", /^\d{4}-\d{2}-\d{2}$/.test(d.issueDate) && /^\d{2}:\d{2}:\d{2}$/.test(d.issueTime), "Issue date and time present", "تاريخ ووقت الإصدار موجودان");
  rule("LOCAL-CURRENCY", d.currency === "SAR", "Currency SAR", "العملة ريال سعودي", d.currency);
  rule("LOCAL-ICV", Number.isInteger(d.icv) && d.icv > 0, "Invoice counter (ICV) positive", "عداد الفواتير ICV موجب");
  rule("LOCAL-PIH", /^[A-Za-z0-9+/]+=*$/.test(d.previousHash) && d.previousHash.length >= 44, "Previous-invoice hash present (base64)", "تجزئة المستند السابق موجودة");

  if (d.typeCode !== "388") {
    rule("LOCAL-BILLING-REF", !!d.billingReference, "Credit/debit note names the original invoice", "الإشعار يذكر الفاتورة الأصلية");
    rule("LOCAL-REASON", !!d.reason && d.reason.trim().length >= 3, "Credit/debit note gives its reason", "الإشعار يذكر سببه");
  }

  const lineIssues: string[] = [];
  for (const l of d.lines) {
    const gross = Number(l.quantity) * Number(l.unitPrice);
    const net = r2(gross * (1 - Number(l.discountPercent) / 100));
    if (!near(Number(l.net), net)) lineIssues.push(`line ${l.no}: net ${l.net} ≠ ${net.toFixed(2)}`);
    if (!near(Number(l.vat), r2(Number(l.net) * Number(l.vatRate) / 100))) lineIssues.push(`line ${l.no}: VAT ${l.vat} ≠ ${(r2(Number(l.net) * Number(l.vatRate) / 100)).toFixed(2)}`);
  }
  rule("LOCAL-LINE-AMOUNTS", lineIssues.length === 0, "Each line: net = quantity × price less discount; VAT = net × rate", "كل بند: الصافي = الكمية × السعر ناقص الخصم؛ الضريبة = الصافي × النسبة", lineIssues.join("; "));
  const catIssues: string[] = [];
  for (const l of d.lines) {
    if (l.category === "S" && !(Number(l.vatRate) > 0)) catIssues.push(`line ${l.no}: standard-rated with rate ${l.vatRate}`);
    if (l.category !== "S" && Number(l.vatRate) !== 0) catIssues.push(`line ${l.no}: category ${l.category} with rate ${l.vatRate}`);
    if (l.category !== "S" && (!l.exemptionCode || !/^VATEX-SA-/.test(l.exemptionCode) || !l.exemptionReason)) catIssues.push(`line ${l.no}: category ${l.category} needs an exemption reason code (VATEX-SA-…) and text`);
  }
  rule("LOCAL-TAX-CATEGORY", catIssues.length === 0, "Tax categories: S has a rate; Z, E and O have rate 0 and an exemption reason code and text", "فئات الضريبة: القياسية لها نسبة؛ الصفرية والمعفاة وخارج النطاق نسبتها صفر مع رمز سبب ونصه", catIssues.join("; "));

  const T = d.totals;
  const sumLines = r2(d.lines.reduce((a, l) => a + Number(l.net), 0));
  rule("LOCAL-TOTAL-LINES", near(Number(T.lineExtension), sumLines) && near(Number(T.taxExclusive), Number(T.lineExtension)), "Total of lines = amount before VAT", "مجموع البنود = الإجمالي قبل الضريبة", `${T.lineExtension} vs ${sumLines.toFixed(2)}`);
  const subs = taxSubtotals(d);
  const subTax = r2(subs.reduce((a, x) => a + x.tax, 0));
  const expected = subs.map((x) => ({ cat: x.cat, want: r2(x.taxable * Number(x.rate) / 100), got: x.tax }));
  rule("LOCAL-TOTAL-TAX", near(Number(T.tax), subTax) && expected.every((e) => near(e.got, e.want, 0.01 * d.lines.length)), "VAT total = sum per category; each category ≈ taxable × rate (line rounding)", "إجمالي الضريبة = مجموع الفئات؛ كل فئة ≈ الوعاء × النسبة", expected.map((e) => `${e.cat} ${e.got.toFixed(2)}/${e.want.toFixed(2)}`).join("; "));
  rule("LOCAL-TOTAL-INCL", near(Number(T.taxInclusive), r2(Number(T.taxExclusive) + Number(T.tax))), "Amount with VAT = amount before VAT + VAT", "الإجمالي مع الضريبة = قبل الضريبة + الضريبة");
  rule("LOCAL-PAYABLE", near(Number(T.payable), r2(Number(T.taxInclusive) - Number(T.prepaid))), "Payable = amount with VAT − prepaid", "المستحق = الإجمالي مع الضريبة − المدفوع مقدماً");

  if (stored) {
    rule("LOCAL-HASH", hashOfStoredXml(stored.xml) === stored.invoiceHash, "Stored XML hashes to the stored document hash", "تجزئة XML المخزّن تساوي التجزئة المسجلة");
    if (simplified) {
      const q: Record<number, Buffer> = stored.qr ? readQr(stored.qr) : {};
      rule("LOCAL-QR", !!stored.qr && q[1]?.toString("utf8") === s.name && q[2]?.toString("utf8") === s.vatNumber,
        "QR present with seller name and VAT number", "رمز QR موجود باسم البائع ورقمه الضريبي");
      const v = qrStampValues(q);
      const hashLen = QR_ENCODING === "SDK_SAMPLE_TEXT" ? 44 : 32;
      rule("LOCAL-QR-HASH", q[6]?.length === hashLen && !!v.hash && v.hash.length === 32 && v.hash.equals(Buffer.from(stored.invoiceHash, "base64")),
        `QR tag 6 carries the document's SHA-256 hash (${QR_ENCODING}: ${hashLen} bytes)`, `الوسم 6 في QR يحمل تجزئة المستند (${hashLen} بايت)`, q[6] ? `${q[6].length} bytes` : "missing");
      rule("LOCAL-QR-STAMP", !!stored.signature && !!stored.publicKey && !!v.signature && !!q[8] &&
        v.signature.equals(Buffer.from(stored.signature, "base64")) && q[8].equals(Buffer.from(stored.publicKey, "base64")) && verifyLocally(stored.invoiceHash, stored.signature, stored.publicKey),
        "QR tags 7 and 8 carry the DER signature and DER public key (secp256k1) and verify against the hash — LOCAL test key, NOT a ZATCA cryptographic stamp",
        "الوسمان 7 و8 يحملان التوقيع والمفتاح العام (DER، secp256k1) ويتحققان مع التجزئة — مفتاح اختبار محلي وليس ختم الهيئة");
    }
  }
  return out;
}

export type StandardsGap = { id: string; en: string; ar: string };
/**
 * What stands between a locally valid document and a standards-compliant one. Always non-empty
 * here: no document produced by this branch has been validated by ZATCA's SDK or Fatoora, and a
 * simplified document has no ZATCA certificate (so no QR tag 9 and no CSID-based stamp).
 */
export function standardsGaps(subtype: string, qr?: string | null): StandardsGap[] {
  const gaps: StandardsGap[] = [
    { id: "NOT-SDK-VALIDATED", en: "Not validated by ZATCA's SDK or the Fatoora platform", ar: "لم يُتحقق منه بأداة الهيئة (SDK) أو منصة فاتورة" },
  ];
  if (subtype === "0200000") {
    gaps.push({ id: "NO-ZATCA-CERTIFICATE", en: "Stamped with a local test key, not a ZATCA-issued CSID; not a XAdES signature", ar: "مختوم بمفتاح اختبار محلي وليس بشهادة CSID من الهيئة؛ وليس توقيع XAdES" });
    gaps.push({ id: "QR-LAYOUT-UNCONFIRMED", en: `QR tags 6 and 7 use the ${QR_ENCODING} layout; which layout ZATCA requires is unconfirmed until its SDK runs`, ar: "صيغة الوسمين 6 و7 في QR غير مؤكدة حتى يُشغَّل SDK الهيئة" });
    if (!qr || !readQr(qr)[9]) gaps.push({ id: "QR-TAG-9-ABSENT", en: "QR tag 9 (ZATCA technical CA signature of the stamp's public key) is absent — it needs a ZATCA certificate", ar: "الوسم 9 في QR (توقيع جهة التصديق التقنية للهيئة على المفتاح العام) غير موجود — يتطلب شهادة من الهيئة" });
  }
  return gaps;
}
