// QUOTATIONS AND CSV — pure domain, no database and no HTTP.
//
// Every expected figure is worked out independently and written as a literal. None of it is
// produced by calling the code and asserting the code agrees with itself, which would pass
// just as happily with the arithmetic inverted.
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");

const load = async (rel) => {
  const p = path.join(ROOT, ".test-build/lib/services", rel);
  return import(`file://${p}`).catch((e) => {
    console.log("FATAL: build the domain first — npm run build:test-domain");
    console.log(String(e?.message ?? e));
    process.exit(1);
  });
};

const quotes = await load("sales/quotes.js");
const csvlib = await load("sales/csv.js");
const engine = await load("commissions/engine.js");

const {
  priceLine, priceQuote, validateLines, discountNeedsApproval, parseLineInputs,
  ALLOWED_QUOTE_TRANSITIONS, isEditable, isRevisable, assertTransition, hasExpired,
  DISCOUNT_APPROVAL_THRESHOLD_PERCENT, MAX_DISCOUNT_PERCENT,
} = quotes;
const {
  parseCsv, toCsv, csvField, neutralizeCsvCell, stripFormulaGuard, parseLeadCsv,
  MAX_IMPORT_ROWS,
} = csvlib;
const { Decimal } = engine;

const D = (v) => new Decimal(v);
const results = { pass: 0, fail: 0, failures: [] };
function check(name, ok, detail = "") {
  if (ok) { results.pass++; console.log(`  [PASS] ${name}`); }
  else { results.fail++; results.failures.push(name); console.log(`  [FAIL] ${name}  << ${detail}`); }
}
const section = (t) => console.log(`\n${"=".repeat(78)}\n  ${t}\n${"=".repeat(78)}`);
const sub = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 62 - t.length))}`);
const money = (d) => d.toFixed(2);

const line = (qty, price, disc = "0", tax = "0") => ({
  quantity: D(qty), unitPrice: D(price), discountPercent: D(disc), taxRatePercent: D(tax),
  productSkuId: null, description: "line",
});

const refusal = (fn) => {
  try { fn(); return null; } catch (e) { return e; }
};

// ═══════════════════════════════════════════════════════════════════════════
section("A — LINE PRICING");

sub("A1. quantity x price, with no discount and no tax");
{
  const p = priceLine(line("10", "25.50"));
  check("gross is 255.00", money(p.gross) === "255.00", money(p.gross));
  check("nothing is discounted", money(p.discountAmount) === "0.00", money(p.discountAmount));
  check("the line total equals the gross", money(p.lineTotal) === "255.00", money(p.lineTotal));
}

sub("A2. a 15% VAT line");
{
  // 4 x 96.00 = 384.00; VAT 15% = 57.60; total 441.60.
  const p = priceLine(line("4", "96", "0", "15"));
  check("subtotal 384.00", money(p.lineSubtotal) === "384.00", money(p.lineSubtotal));
  check("tax 57.60", money(p.lineTax) === "57.60", money(p.lineTax));
  check("total 441.60", money(p.lineTotal) === "441.60", money(p.lineTotal));
}

sub("A3. the discount comes off BEFORE tax");
{
  // 10 x 100 = 1,000; 10% off = 100; net 900; VAT 15% of 900 = 135; total 1,035.
  // Taxing the gross and discounting after would give 1,150 - 100 = 1,050 — fifteen riyals
  // of VAT charged on coffee the customer was never billed for.
  const p = priceLine(line("10", "100", "10", "15"));
  check("discount 100.00", money(p.discountAmount) === "100.00", money(p.discountAmount));
  check("net 900.00", money(p.lineSubtotal) === "900.00", money(p.lineSubtotal));
  check("tax on the NET, 135.00", money(p.lineTax) === "135.00", money(p.lineTax));
  check("total 1035.00", money(p.lineTotal) === "1035.00", money(p.lineTotal));
}

sub("A4. fractional kilograms price exactly");
{
  // 2.5 kg at 73.20 = 183.00 exactly. A float would reach 183.00000000000003.
  const p = priceLine(line("2.5", "73.20"));
  check("2.5 x 73.20 is exactly 183.00", money(p.gross) === "183.00", money(p.gross));
}

sub("A5. a rounding case that a float gets wrong");
{
  // 3 x 0.415 = 1.245, which rounds half-up to 1.25. In binary floating point 1.245 is
  // stored slightly BELOW 1.245, and Math.round(1.245*100)/100 gives 1.24.
  const p = priceLine(line("3", "0.415"));
  check("3 x 0.415 rounds up to 1.25, not down to 1.24", money(p.gross) === "1.25", money(p.gross));
}

// ═══════════════════════════════════════════════════════════════════════════
section("B — QUOTE TOTALS");

sub("B1. the stored components reconcile exactly");
{
  const p = priceQuote([line("10", "100", "10", "15"), line("4", "96", "0", "15"), line("1", "35")]);
  // 1,000 + 384 + 35 = 1,419 gross; discount 100; net 1,319; tax 135 + 57.60 = 192.60.
  check("subtotal 1419.00", money(p.subtotal) === "1419.00", money(p.subtotal));
  check("discount total 100.00", money(p.discountTotal) === "100.00", money(p.discountTotal));
  check("tax total 192.60", money(p.taxTotal) === "192.60", money(p.taxTotal));
  check("grand total 1511.60", money(p.grandTotal) === "1511.60", money(p.grandTotal));

  const reconciles = p.subtotal.minus(p.discountTotal).plus(p.taxTotal).equals(p.grandTotal);
  check("subtotal - discount + tax === grand total, exactly", reconciles, money(p.grandTotal));

  const sumOfLines = p.lines.reduce((a, l) => a.plus(l.lineTotal), D(0));
  check("and the printed line totals add up to the same figure",
    money(sumOfLines) === money(p.grandTotal), `${money(sumOfLines)} vs ${money(p.grandTotal)}`);
}

sub("B2. an empty quote is zero, not NaN");
{
  const p = priceQuote([]);
  check("grand total 0.00", money(p.grandTotal) === "0.00", money(p.grandTotal));
  check("the effective discount of nothing is 0, not a division by zero",
    money(p.effectiveDiscountPercent) === "0.00", String(p.effectiveDiscountPercent));
}

sub("B3. the effective discount is measured against the pre-discount subtotal");
{
  // 1,000 gross with 120 off is 12%.
  const p = priceQuote([line("10", "100", "12")]);
  check("12%", p.effectiveDiscountPercent.toFixed(2) === "12.00", p.effectiveDiscountPercent.toString());
}

sub("B4. a mixed-discount quote averages by value, not by line count");
{
  // 9,000 at 20% off and 1,000 at nothing: 1,800 off 10,000 is 18%, not the 10% a
  // per-line average would report.
  const p = priceQuote([line("90", "100", "20"), line("10", "100", "0")]);
  check("18%", p.effectiveDiscountPercent.toFixed(2) === "18.00", p.effectiveDiscountPercent.toString());
}

// ═══════════════════════════════════════════════════════════════════════════
section("C — WHAT IS REFUSED");

const skus = new Map([
  ["sku_unit", { id: "sku_unit", isActive: true, unitOfMeasure: "UNIT", skuCode: "BAG-1KG" }],
  ["sku_kg", { id: "sku_kg", isActive: true, unitOfMeasure: "KG", skuCode: "BULK" }],
  ["sku_off", { id: "sku_off", isActive: false, unitOfMeasure: "UNIT", skuCode: "OLD-500G" }],
]);

sub("C1. a line with neither a product nor a description");
{
  const problems = validateLines([{ ...line("1", "10"), description: null }], skus);
  check("refused", problems.some((p) => p.code === "NO_SUBJECT"), JSON.stringify(problems));
}

sub("C2. zero and negative quantities");
{
  check("zero is refused", validateLines([line("0", "10")], skus).some((p) => p.code === "QTY"), "");
  check("negative is refused", validateLines([line("-1", "10")], skus).some((p) => p.code === "QTY"), "");
}

sub("C3. a negative price");
{
  check("refused", validateLines([line("1", "-5")], skus).some((p) => p.code === "PRICE"), "");
}

sub("C4. a discount above the hard ceiling");
{
  const over = D(MAX_DISCOUNT_PERCENT).plus(1);
  const problems = validateLines([{ ...line("1", "100"), discountPercent: over }], skus);
  check(`above ${MAX_DISCOUNT_PERCENT.toString()}% is refused outright`,
    problems.some((p) => p.code === "DISCOUNT_CEILING"), JSON.stringify(problems));
  check("and a discount at the ceiling is allowed",
    validateLines([{ ...line("1", "100"), discountPercent: D(MAX_DISCOUNT_PERCENT) }], skus).length === 0, "");
}

sub("C5. fractional retail packs");
{
  const frac = { ...line("1.5", "96"), productSkuId: "sku_unit", description: null };
  check("1.5 bags is refused", validateLines([frac], skus).some((p) => p.code === "SKU_FRACTION"), "");

  const kg = { ...line("1.5", "96"), productSkuId: "sku_kg", description: null };
  check("but 1.5 kg of bulk coffee is ordinary and allowed", validateLines([kg], skus).length === 0, "");
}

sub("C6. an inactive product");
{
  const l = { ...line("1", "96"), productSkuId: "sku_off", description: null };
  check("refused, naming the SKU",
    validateLines([l], skus).some((p) => p.code === "SKU_INACTIVE" && p.message.includes("OLD-500G")), "");
}

sub("C7. an empty quotation");
{
  check("refused", validateLines([], skus).some((p) => p.code === "EMPTY"), "");
}

// ═══════════════════════════════════════════════════════════════════════════
section("D — THE DISCOUNT APPROVAL THRESHOLD");

sub("D1. at, below and above the threshold");
{
  const t = Number(DISCOUNT_APPROVAL_THRESHOLD_PERCENT.toString());
  const below = priceQuote([line("10", "100", String(t - 1))]);
  const exact = priceQuote([line("10", "100", String(t))]);
  const above = priceQuote([line("10", "100", String(t + 0.01))]);

  check(`${t - 1}% needs no approval`, discountNeedsApproval(below) === false, "");
  // At the threshold, not above it: "up to 10%" is what a rep is told they may give.
  check(`exactly ${t}% needs no approval`, discountNeedsApproval(exact) === false, "");
  check(`${t + 0.01}% does`, discountNeedsApproval(above) === true, "");
}

sub("D2. the threshold is measured on the whole quote, not per line");
{
  // Two lines at 6% each is a 6% quote and needs nothing. One line at 6% next to a much
  // bigger one at 12% is what the whole-quote figure is there to catch.
  const even = priceQuote([line("10", "100", "6"), line("10", "100", "6")]);
  check("6% across two lines needs no approval", discountNeedsApproval(even) === false, "");

  const lopsided = priceQuote([line("1", "100", "0"), line("100", "100", "12")]);
  check("a 12% discount on the bulk of the value does need approval",
    discountNeedsApproval(lopsided) === true, lopsided.effectiveDiscountPercent.toString());
}

// ═══════════════════════════════════════════════════════════════════════════
section("E — THE LIFECYCLE");

sub("E1. nothing leads out of ACCEPTED or SUPERSEDED");
{
  check("ACCEPTED is terminal", ALLOWED_QUOTE_TRANSITIONS.ACCEPTED.length === 0, "");
  check("SUPERSEDED is terminal", ALLOWED_QUOTE_TRANSITIONS.SUPERSEDED.length === 0, "");
  check("REJECTED is terminal", ALLOWED_QUOTE_TRANSITIONS.REJECTED.length === 0, "");
}

sub("E2. only a draft may be edited");
{
  check("DRAFT is editable", isEditable("DRAFT") === true, "");
  for (const s of ["ISSUED", "ACCEPTED", "REJECTED", "EXPIRED", "SUPERSEDED"]) {
    check(`${s} is not`, isEditable(s) === false, "");
  }
}

sub("E3. an accepted quotation cannot be revised, but a lapsed one can");
{
  check("ISSUED is revisable", isRevisable("ISSUED") === true, "");
  check("EXPIRED is revisable", isRevisable("EXPIRED") === true, "");
  check("REJECTED is revisable", isRevisable("REJECTED") === true, "");
  check("ACCEPTED is NOT — it is what the customer agreed to", isRevisable("ACCEPTED") === false, "");
  check("nor is a SUPERSEDED one", isRevisable("SUPERSEDED") === false, "");
}

sub("E4. illegal transitions are refused with an explanation");
{
  const e1 = refusal(() => assertTransition("DRAFT", "ACCEPTED"));
  check("a draft cannot be accepted without being issued", e1?._appCode === 409, JSON.stringify(e1));

  const e2 = refusal(() => assertTransition("ACCEPTED", "REJECTED"));
  check("an accepted quotation cannot be un-accepted", e2?._appCode === 409, JSON.stringify(e2));
  check("and the message says what to do instead",
    /revision/i.test(e2?.message ?? ""), e2?.message ?? "");

  const e3 = refusal(() => assertTransition("ISSUED", "ISSUED"));
  check("issuing twice is refused as already-done, not as illegal",
    e3?._appCode === 409 && /already/i.test(e3.message), e3?.message ?? "");

  check("and the legal move is not refused", refusal(() => assertTransition("ISSUED", "ACCEPTED")) === null, "");
}

sub("E5. expiry is a comparison against the validity date, both ways");
{
  const at = new Date("2026-09-24T10:00:00Z");
  check("a quote valid until yesterday has expired",
    hasExpired({ validUntil: new Date("2026-09-23T10:00:00Z") }, at) === true, "");
  check("one valid until tomorrow has not",
    hasExpired({ validUntil: new Date("2026-09-25T10:00:00Z") }, at) === false, "");
  check("and one with no validity date never expires",
    hasExpired({ validUntil: null }, at) === false, "");
}

// ═══════════════════════════════════════════════════════════════════════════
section("F — PARSING REQUEST INPUT");

sub("F1. amounts arrive as strings and stay exact");
{
  const [l] = parseLineInputs([{ quantity: "2.5", unitPrice: "73.20", description: "x" }]);
  check("2.5 x 73.20 is exactly 183.00 through the parser too",
    money(priceLine(l).gross) === "183.00", money(priceLine(l).gross));
  check("the discount defaults to zero", money(l.discountPercent) === "0.00", "");
}

sub("F2. a missing or unusable amount is refused, naming the line");
{
  const e1 = refusal(() => parseLineInputs([{ unitPrice: "10" }]));
  check("a missing quantity is refused", e1?._appCode === 400, JSON.stringify(e1));
  check("and the message names line 1", /Line 1/.test(e1?.message ?? ""), e1?.message ?? "");

  const e2 = refusal(() => parseLineInputs([{ quantity: "1", unitPrice: "1" }, { quantity: "nonsense", unitPrice: "1" }]));
  check("a non-numeric quantity on the second line names line 2",
    e2?._appCode === 400 && /Line 2/.test(e2.message), e2?.message ?? "");
}

// ═══════════════════════════════════════════════════════════════════════════
section("G — CSV: READING WHAT REAL FILES CONTAIN");

sub("G1. a comma inside a quoted field is not a delimiter");
{
  const rows = parseCsv('companyName,contactName\n"Al Waha Coffee, Jeddah",Sara\n');
  check("two columns, not three", rows[1].length === 2, JSON.stringify(rows[1]));
  check("the comma is part of the name", rows[1][0] === "Al Waha Coffee, Jeddah", rows[1][0]);
}

sub("G2. doubled quotes, embedded newlines, CRLF and the Excel BOM");
{
  const rows = parseCsv('﻿a,b\r\n"say ""hello""","line1\nline2"\r\n');
  check("the BOM does not become part of the first heading", rows[0][0] === "a", JSON.stringify(rows[0]));
  check('"" reads as one quote', rows[1][0] === 'say "hello"', rows[1][0]);
  check("a newline inside quotes does not split the row", rows[1][1] === "line1\nline2", JSON.stringify(rows[1]));
  check("and there are exactly two rows", rows.length === 2, String(rows.length));
}

sub("G3. an empty trailing field is preserved");
{
  const rows = parseCsv("a,b,c\n1,,3\n");
  check("the middle field is empty, not missing", rows[1].length === 3 && rows[1][1] === "", JSON.stringify(rows[1]));
}

// ═══════════════════════════════════════════════════════════════════════════
section("H — CSV: WRITING SOMETHING SAFE TO OPEN");

sub("H1. a formula is neutralised on the way out");
{
  for (const dangerous of ["=1+1", "+1", "-1", "@SUM(A1)", "=HYPERLINK(\"http://x\",\"click\")"]) {
    const out = neutralizeCsvCell(dangerous);
    check(`${dangerous.slice(0, 12)} is prefixed`, out === `'${dangerous}`, out);
  }
}

sub("H2. ordinary text is left exactly alone");
{
  check("a company name is untouched", neutralizeCsvCell("Al Waha") === "Al Waha", "");
  check("Arabic is untouched", neutralizeCsvCell("مقهى الواحة") === "مقهى الواحة", "");
  check("a number is untouched", neutralizeCsvCell("0501234567") === "0501234567", "");
}

sub("H3. the guard round-trips through our own importer");
{
  const original = "=cmd|'/c calc'!A1";
  check("stripped back to exactly what it was",
    stripFormulaGuard(neutralizeCsvCell(original)) === original, "");
  check("and a legitimate leading apostrophe is NOT stripped",
    stripFormulaGuard("'Aroma") === "'Aroma", stripFormulaGuard("'Aroma"));
}

sub("H4. fields that would break the row shape are quoted");
{
  check("a comma is quoted", csvField("a,b") === '"a,b"', csvField("a,b"));
  check("a quote is doubled and quoted", csvField('a"b') === '"a""b"', csvField('a"b'));
  check("a newline is quoted", csvField("a\nb") === '"a\nb"', JSON.stringify(csvField("a\nb")));
  check("plain text is not quoted", csvField("plain") === "plain", csvField("plain"));
}

sub("H5. the document carries a BOM and CRLF endings");
{
  const doc = toCsv(["a"], [["مقهى"]]);
  check("starts with the BOM, so Excel reads Arabic rather than mojibake",
    doc.charCodeAt(0) === 0xfeff, String(doc.charCodeAt(0)));
  check("rows end with CRLF", doc.includes("\r\n"), "");
}

// ═══════════════════════════════════════════════════════════════════════════
section("I — CSV: THE LEAD IMPORTER");

sub("I1. a clean file");
{
  const r = parseLeadCsv("companyName,contactName,phone\nAl Waha,Sara,0501234567\n");
  check("one row read", r.rows.length === 1, JSON.stringify(r));
  check("no problems", r.problems.length === 0, JSON.stringify(r.problems));
  check("the phone came through", r.rows[0].phone === "0501234567", "");
}

sub("I2. human column headings are recognised");
{
  const r = parseLeadCsv("Company Name,Contact Name,Mobile\nAl Waha,Sara,0501234567\n");
  check("'Company Name' maps to companyName", r.rows[0]?.companyName === "Al Waha", JSON.stringify(r));
  check("'Mobile' maps to phone", r.rows[0]?.phone === "0501234567", "");
}

sub("I3. Arabic column headings are recognised");
{
  const r = parseLeadCsv("اسم المنشأة,اسم جهة الاتصال,الهاتف\nمقهى الواحة,سارة,0501234567\n");
  check("the Arabic heading maps", r.rows[0]?.companyName === "مقهى الواحة", JSON.stringify(r));
}

sub("I4. a file with no companyName column is refused as a whole");
{
  const r = parseLeadCsv("name,phone\nAl Waha,0501234567\n");
  check("nothing is imported", r.rows.length === 0, "");
  check("and the message lists the columns it accepts",
    /companyName/.test(r.problems[0]?.message ?? ""), r.problems[0]?.message ?? "");
}

sub("I5. bad rows are reported by the row number the operator sees");
{
  const r = parseLeadCsv(
    "companyName,contactName,email,nextFollowUpAt,source\n" +
    "Good Co,Sara,sara@x.com,2026-10-01,REFERRAL\n" +
    "X,Sara,,,\n" +                       // company name too short
    "Bad Email Co,Sara,not-an-email,,\n" +
    "Bad Date Co,Sara,,when-i-feel-like-it,\n" +
    "Bad Source Co,Sara,,,SMOKE_SIGNAL\n",
  );
  check("only the good row is kept", r.rows.length === 1, JSON.stringify(r.rows));
  check("four rows are reported", r.problems.length === 4, JSON.stringify(r.problems));
  // The header is row 1, so the first data row is row 2 — which is what the spreadsheet
  // shows. Reporting a zero-based index here sends the operator to the wrong line.
  check("the short company name is row 3", r.problems[0].row === 3, JSON.stringify(r.problems[0]));
  check("the bad email is row 4", r.problems[1].row === 4, JSON.stringify(r.problems[1]));
  check("the bad date is row 5", r.problems[2].row === 5, JSON.stringify(r.problems[2]));
  check("the unknown source is row 6", r.problems[3].row === 6, JSON.stringify(r.problems[3]));
  check("and the unknown source is named in the message",
    /SMOKE_SIGNAL/.test(r.problems[3].message), r.problems[3].message);
}

sub("I6. a source is normalised rather than rejected for its spelling");
{
  const r = parseLeadCsv("companyName,contactName,source\nAl Waha,Sara,walk in\n");
  check("'walk in' becomes WALK_IN", r.rows[0]?.source === "WALK_IN", JSON.stringify(r));
}

sub("I7. an unrecognised column is reported, never silently dropped");
{
  const r = parseLeadCsv("companyName,contactName,favourite_colour\nAl Waha,Sara,blue\n");
  check("the row still imports", r.rows.length === 1, "");
  check("and the extra column is named", r.unknownColumns.includes("favourite_colour"), JSON.stringify(r.unknownColumns));
}

sub("I8. a formula in an imported cell is stripped of our own guard, not executed");
{
  const r = parseLeadCsv("companyName,contactName,notes\nAl Waha,Sara,'=SUM(A1)\n");
  check("the guard our exporter added is removed on the way back in",
    r.rows[0]?.notes === "=SUM(A1)", r.rows[0]?.notes ?? "");
}

sub("I9. the row limit is enforced");
{
  const many = "companyName,contactName\n" + "Co,Sara\n".repeat(MAX_IMPORT_ROWS + 1);
  const r = parseLeadCsv(many);
  check("nothing is imported", r.rows.length === 0, String(r.rows.length));
  check("and the message says how many rows the file had",
    new RegExp(String(MAX_IMPORT_ROWS + 1)).test(r.problems[0]?.message ?? ""), r.problems[0]?.message ?? "");

  const exact = "companyName,contactName\n" + "Co,Sara\n".repeat(MAX_IMPORT_ROWS);
  check(`exactly ${MAX_IMPORT_ROWS} rows is accepted`, parseLeadCsv(exact).rows.length === MAX_IMPORT_ROWS, "");
}

sub("I10. an empty file says so rather than importing nothing quietly");
{
  const r = parseLeadCsv("");
  check("reported as empty", /empty/i.test(r.problems[0]?.message ?? ""), JSON.stringify(r.problems));
}

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${"=".repeat(78)}\n  QUOTES & CSV DOMAIN RESULT\n${"=".repeat(78)}`);
console.log(`${results.pass} passed, ${results.fail} failed`);
if (results.failures.length) console.log("FAILURES:\n  - " + results.failures.join("\n  - "));
process.exit(results.fail === 0 ? 0 : 1);
