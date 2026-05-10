import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { hashSync } from "bcryptjs";

const url = process.env.DATABASE_URL || "file:./prisma/dev.db";

function createClient() {
  if (url.startsWith("postgresql://") || url.startsWith("postgres://")) {
    const { Pool } = require("pg");
    const { PrismaPg } = require("@prisma/adapter-pg");
    return new PrismaClient({ adapter: new PrismaPg(new Pool({ connectionString: url })) });
  }
  const path = require("path");
  const { PrismaLibSql } = require("@prisma/adapter-libsql");
  const resolved = url.startsWith("file:./") || url.startsWith("file:../")
    ? `file:${path.resolve(url.slice(5))}` : url || `file:${path.resolve("prisma/dev.db")}`;
  return new PrismaClient({ adapter: new PrismaLibSql({ url: resolved }) });
}

const prisma = createClient();

async function main() {
  // Employees
  const employees = [
    { name: "Admin", pin: hashSync("1234", 10), role: "admin" },
    { name: "Ibrahim (Inventory)", pin: hashSync("2345", 10), role: "inventory" },
    { name: "Ahmed (Roaster)", pin: hashSync("3456", 10), role: "roasting" },
    { name: "Khalid (QC)", pin: hashSync("4567", 10), role: "qc" },
    { name: "Omar (Dispatch)", pin: hashSync("5678", 10), role: "dispatch" },
  ];
  for (const e of employees) {
    await prisma.employee.create({ data: e });
  }

  // Customers (from B2B tracking)
  const customerNames = [
    { name: "منصور عبدالله الشمري" },
    { name: "مقهى ذهب", nameAr: "مقهى ذهب" },
    { name: "تقاطع ١٠", nameAr: "تقاطع ١٠" },
    { name: "Allan 100 Street Coffee" },
    { name: "مقهى اورب", nameAr: "مقهى اورب" },
    { name: "سعد مشعان العتيبي" },
    { name: "مقهى مرفأ", nameAr: "مقهى مرفأ" },
    { name: "غصين البن", nameAr: "غصين البن" },
    { name: "عبدالاله ظافر العمري" },
    { name: "مقهى رواية", nameAr: "مقهى رواية" },
    { name: "عبدالعزيز ذياب" },
    { name: "مطعم قلعة الزعفران" },
    { name: "قطفة الربيع", nameAr: "قطفة الربيع" },
    { name: "أسس المخبوزات (كوي)" },
    { name: "حمد الشيخ (لوفت)" },
    { name: "مخرج ٢٠", nameAr: "مخرج ٢٠" },
    { name: "مختبر القهوة", nameAr: "مختبر القهوة" },
    { name: "مقهى براوني", nameAr: "مقهى براوني" },
    { name: "روززيت", nameAr: "روززيت" },
  ];
  const customers: Record<string, string> = {};
  for (const c of customerNames) {
    const created = await prisma.customer.create({ data: c });
    customers[c.name] = created.id;
  }

  // Green Beans (inventory)
  const beans = [
    { serialNumber: "GB-001", beanType: "Ethiopia Guji", country: "Ethiopia", region: "Guji Shakiso", variety: "Serto", process: "Natural", altitude: "1800 - 2100", quantityKg: 150 },
    { serialNumber: "GB-002", beanType: "Colombia Huila", country: "Colombia", region: "Huila", variety: "Arabica", process: "Natural", altitude: "1600 - 1900", quantityKg: 200 },
    { serialNumber: "GB-003", beanType: "Brazil Mogiana", country: "Brazil", region: "Mogiana", variety: "Bourbon", process: "Natural", altitude: "1200", quantityKg: 300 },
    { serialNumber: "GB-004", beanType: "Guatemala Antigua", country: "Guatemala", region: "Antigua", variety: "Bourbon", process: "Washed", altitude: "1600 - 1800", quantityKg: 100 },
    { serialNumber: "GB-005", beanType: "Rwanda Baho", country: "Rwanda", region: "Baho", variety: "Bourbon", process: "Washed", altitude: "1700 - 2000", quantityKg: 80 },
    { serialNumber: "GB-006", beanType: "Colombia Tolima", country: "Colombia", region: "Tolima", variety: "Caturra", process: "Washed", altitude: "1900", quantityKg: 250 },
    { serialNumber: "GB-007", beanType: "Nicaragua El Suyatal", country: "Nicaragua", region: "Nueva Segovia", variety: "Caturra", process: "Natural", altitude: "1200 - 1500", quantityKg: 120 },
    { serialNumber: "GB-008", beanType: "Indonesia Wanoja", country: "Indonesia", region: "Wanoja", variety: "Typica", process: "Anaerobic", altitude: "1300 - 1500", quantityKg: 60 },
    { serialNumber: "GB-009", beanType: "Ethiopia Buku", country: "Ethiopia", region: "Hambella Buku", variety: "Heirloom", process: "Natural", altitude: "1900 - 2350", quantityKg: 180 },
    { serialNumber: "GB-010", beanType: "Colombia Lacima", country: "Colombia", region: "Cauca", variety: "Arabica", process: "Natural", altitude: "1700 - 1750", quantityKg: 140 },
    { serialNumber: "GB-011", beanType: "Uganda Mugisi", country: "Uganda", region: "Mugisi", variety: "Arabica", process: "Natural", altitude: "1800", quantityKg: 70 },
    { serialNumber: "GB-012", beanType: "Guatemala Wycan", country: "Guatemala", region: "Wycan", variety: "Bourbon", process: "Washed", altitude: "1600 - 1800", quantityKg: 90 },
    { serialNumber: "GB-013", beanType: "Colombia La Presa", country: "Colombia", region: "Quindio", variety: "Castillo", process: "Natural", altitude: "1700 - 1900", quantityKg: 110 },
    { serialNumber: "GB-014", beanType: "Indonesia Peach", country: "Indonesia", region: "Quindio", variety: "Castillo", process: "Innoculated", altitude: "1400 - 1450", quantityKg: 45 },
  ];
  const beanMap: Record<string, string> = {};
  for (const b of beans) {
    const created = await prisma.greenBean.create({ data: b });
    beanMap[b.beanType] = created.id;
  }

  // Helper to find closest bean
  function findBean(name: string): string | undefined {
    const lower = name.toLowerCase();
    for (const [key, id] of Object.entries(beanMap)) {
      if (key.toLowerCase().includes(lower) || lower.includes(key.toLowerCase())) return id;
    }
    return undefined;
  }

  // Orders from B2B 2025 data
  const ordersData = [
    { num: 1, customer: "منصور عبدالله الشمري", qNum: "QU-0028", qDate: "2025-01-01", items: [
      { bean: "كولمبيا ويلا", qty: 3, prodStatus: "Completed", delStatus: "Delivered", delQty: 3 },
      { bean: "اثيوبي قوجي", qty: 3, prodStatus: "Completed", delStatus: "Delivered", delQty: 3 },
      { bean: "برازيل موجيانا", qty: 4, prodStatus: "Completed", delStatus: "Delivered", delQty: 4 },
    ], payment: "Paid" },
    { num: 2, customer: "مقهى ذهب", qNum: "QU-0029", qDate: "2025-01-01", items: [
      { bean: "اثيوبي قوجي", qty: 20, prodStatus: "Completed", delStatus: "Delivered", delQty: 20 },
      { bean: "برازيل موجيانا", qty: 20, prodStatus: "Completed", delStatus: "Delivered", delQty: 20 },
    ], payment: "Not Paid" },
    { num: 3, customer: "تقاطع ١٠", qNum: "QU-0030", qDate: "2025-01-02", items: [
      { bean: "كولمبيا ويلا", qty: 50, prodStatus: "Completed", delStatus: "Delivered", delQty: 50 },
    ], payment: "Paid" },
    { num: 4, customer: "Allan 100 Street Coffee", qNum: "QU-0032", qDate: "2025-01-02", items: [
      { bean: "برازيل موجيانا", qty: 10, prodStatus: "Completed", delStatus: "Delivered", delQty: 10 },
    ], payment: "Paid" },
    { num: 5, customer: "مقهى اورب", qNum: "QU-0031", qDate: "2025-01-02", items: [
      { bean: "غواتيمالا انتيجوا", qty: 39, prodStatus: "Completed", delStatus: "Delivered", delQty: 39 },
    ], payment: "Not Paid" },
    { num: 6, customer: "سعد مشعان العتيبي", qNum: "QU-0034", qDate: "2025-01-02", items: [
      { bean: "كولمبيا ويلا", qty: 30, prodStatus: "Completed", delStatus: "Delivered", delQty: 30 },
      { bean: "غواتيمالا انتيجوا", qty: 18, prodStatus: "Completed", delStatus: "Delivered", delQty: 18 },
    ], payment: "Paid" },
    { num: 7, customer: "مقهى مرفأ", qNum: "QU-0035", qDate: "2025-01-04", items: [
      { bean: "كولمبيا ويلا", qty: 20, prodStatus: "Completed", delStatus: "Delivered", delQty: 20 },
      { bean: "اثيوبي قوجي", qty: 20, prodStatus: "Completed", delStatus: "Delivered", delQty: 20 },
    ], payment: "Paid" },
    { num: 8, customer: "تقاطع ١٠", qNum: "QU-0033", qDate: "2025-01-06", items: [
      { bean: "كولمبيا ويلا", qty: 4, prodStatus: "Completed", delStatus: "Delivered", delQty: 4 },
    ], payment: "Paid" },
    { num: 9, customer: "تقاطع ١٠", qNum: "QU-0038", qDate: "2025-01-16", items: [
      { bean: "كولمبيا ويلا", qty: 50, prodStatus: "Completed", delStatus: "Delivered", delQty: 50 },
    ], payment: "Paid" },
    { num: 10, customer: "غصين البن", qNum: "QU-0039", qDate: "2025-01-19", items: [
      { bean: "كولمبيا ويلا", qty: 10, prodStatus: "Completed", delStatus: "Delivered", delQty: 10 },
    ], payment: "Paid" },
    { num: 11, customer: "سعد مشعان العتيبي", qNum: "QU-0040", qDate: "2025-01-20", items: [
      { bean: "رواندا باهو", qty: 14, prodStatus: "Completed", delStatus: "Delivered", delQty: 14 },
      { bean: "غواتيمالا انتيجوا", qty: 10, prodStatus: "Completed", delStatus: "Delivered", delQty: 10 },
      { bean: "اثيوبي قوجي", qty: 30, prodStatus: "Completed", delStatus: "Delivered", delQty: 30 },
      { bean: "اثيوبي قوجي", qty: 5, prodStatus: "Completed", delStatus: "Delivered", delQty: 5 },
    ], payment: "Paid" },
    { num: 12, customer: "غصين البن", qNum: "QU-0041", qDate: "2025-01-21", items: [
      { bean: "كولمبيا ويلا", qty: 60, prodStatus: "Completed", delStatus: "Delivered", delQty: 60 },
    ], payment: "Paid" },
    { num: 13, customer: "تقاطع ١٠", qNum: "QU-0043", qDate: "2025-01-26", items: [
      { bean: "كولمبيا ويلا", qty: 50, prodStatus: "Completed", delStatus: "Delivered", delQty: 50 },
    ], payment: "Paid" },
    { num: 14, customer: "سعد مشعان العتيبي", qNum: "QU-0045", qDate: "2025-01-27", items: [
      { bean: "اثيوبي قوجي", qty: 50, prodStatus: "Completed", delStatus: "Delivered", delQty: 50 },
    ], payment: "Partial Paid" },
    { num: 15, customer: "عبدالاله ظافر العمري", qNum: "QU-0046", qDate: "2025-01-28", items: [
      { bean: "رواندا باهو", qty: 15, prodStatus: "Completed", delStatus: "Delivered", delQty: 15 },
    ], payment: "Paid" },
    { num: 16, customer: "عبدالاله ظافر العمري", qNum: "QU-0047", qDate: "2025-01-31", items: [
      { bean: "رواندا باهو", qty: 2, prodStatus: "Completed", delStatus: "Delivered", delQty: 2 },
    ], payment: "Not Paid" },
    { num: 17, customer: "مقهى رواية", qNum: "QTE16", qDate: "2025-08-14", items: [
      { bean: "اثيوبي قوجي", qty: 30, prodStatus: "Completed", delStatus: "Delivered", delQty: 30 },
      { bean: "اندونيسيا", qty: 10, prodStatus: "Completed", delStatus: "Delivered", delQty: 10 },
      { bean: "نيكارجو", qty: 10, prodStatus: "Completed", delStatus: "Delivered", delQty: 10 },
    ], payment: "Not Paid" },
    { num: 18, customer: "مقهى اورب", qNum: "QTE17", qDate: "2025-08-14", items: [
      { bean: "قواتيمالا", qty: 200, prodStatus: "Completed", delStatus: "Partial Delivered", delQty: 60, remaining: 140 },
    ], payment: "Paid" },
  ];

  // 2024 orders
  const orders2024 = [
    { num: 100, customer: "عبدالعزيز ذياب", qNum: "QU24-001", qDate: "2024-11-30", items: [
      { bean: "رواندا باهو", qty: 10, prodStatus: "Completed", delStatus: "Delivered", delQty: 10 },
      { bean: "برازيل فالكاو", qty: 10, prodStatus: "Completed", delStatus: "Delivered", delQty: 10 },
      { bean: "كولمبيا ويلا", qty: 10, prodStatus: "Completed", delStatus: "Delivered", delQty: 10 },
    ], payment: "Paid" },
    { num: 101, customer: "مقهى ذهب", qNum: "QU24-002", qDate: "2024-11-27", items: [
      { bean: "اثيوبي قوجي", qty: 30, prodStatus: "Completed", delStatus: "Delivered", delQty: 30 },
    ], payment: "Paid" },
    { num: 102, customer: "مقهى اورب", qNum: "QU24-004", qDate: "2024-11-23", items: [
      { bean: "اثيوبي قوجي", qty: 100, prodStatus: "Completed", delStatus: "Delivered", delQty: 100 },
      { bean: "غواتيمالا انتيجوا", qty: 100, prodStatus: "Completed", delStatus: "Delivered", delQty: 100 },
    ], payment: "Paid" },
    { num: 103, customer: "تقاطع ١٠", qNum: "QU24-009", qDate: "2024-11-25", items: [
      { bean: "كولمبيا ويلا", qty: 30, prodStatus: "Completed", delStatus: "Delivered", delQty: 30 },
    ], payment: "Paid" },
    { num: 104, customer: "مقهى مرفأ", qNum: "QU24-006", qDate: "2024-11-27", items: [
      { bean: "برازيل موجيانا", qty: 50, prodStatus: "Completed", delStatus: "Delivered", delQty: 50 },
      { bean: "اثيوبي قوجي", qty: 20, prodStatus: "Completed", delStatus: "Delivered", delQty: 20 },
      { bean: "كولمبيا ويلا", qty: 20, prodStatus: "Completed", delStatus: "Delivered", delQty: 20 },
    ], payment: "Paid" },
    { num: 105, customer: "غصين البن", qNum: "QU24-012", qDate: "2024-09-30", items: [
      { bean: "كولمبيا ويلا", qty: 59, prodStatus: "Completed", delStatus: "Delivered", delQty: 59 },
    ], payment: "Paid" },
    { num: 106, customer: "تقاطع ١٠", qNum: "QU24-013", qDate: "2024-12-09", items: [
      { bean: "كولمبيا ويلا", qty: 20, prodStatus: "Completed", delStatus: "Delivered", delQty: 20 },
    ], payment: "Paid" },
    { num: 107, customer: "غصين البن", qNum: "QU24-014", qDate: "2024-12-09", items: [
      { bean: "كولمبيا ويلا", qty: 60, prodStatus: "Completed", delStatus: "Delivered", delQty: 60 },
    ], payment: "Paid" },
    { num: 108, customer: "سعد مشعان العتيبي", qNum: "QU24-018", qDate: "2024-12-17", items: [
      { bean: "اثيوبي قوجي", qty: 50, prodStatus: "Completed", delStatus: "Delivered", delQty: 50 },
    ], payment: "Paid" },
    { num: 109, customer: "مقهى براوني", qNum: "QU24-021", qDate: "2024-12-24", items: [
      { bean: "برازيل موجيانا", qty: 40, prodStatus: "Completed", delStatus: "Delivered", delQty: 40 },
    ], payment: "Paid" },
    { num: 110, customer: "أسس المخبوزات (كوي)", qNum: "QU24-007", qDate: "2024-12-05", items: [
      { bean: "برازيل موجيانا", qty: 200, prodStatus: "Completed", delStatus: "Delivered", delQty: 200 },
    ], payment: "Paid" },
  ];

  const allOrders = [...ordersData, ...orders2024];
  let batchCounter = 1;

  for (const o of allOrders) {
    const custId = customers[o.customer];
    if (!custId) continue;

    const order = await prisma.order.create({
      data: {
        orderNumber: o.num,
        customerId: custId,
        quotationNumber: o.qNum,
        quotationSentDate: new Date(o.qDate),
        approvalStatus: "Yes",
        approvalDate: new Date(o.qDate),
        paymentStatus: o.payment,
        vatInvoiceStatus: "Not Yet",
      },
    });

    for (const item of o.items) {
      const greenBeanId = findBean(item.bean);
      const orderItem = await prisma.orderItem.create({
        data: {
          orderId: order.id,
          greenBeanId: greenBeanId || null,
          beanTypeName: item.bean,
          quantityKg: item.qty,
          productionStatus: item.prodStatus,
          deliveryStatus: item.delStatus,
          deliveredQty: item.delQty,
          remainingQty: (item as { remaining?: number }).remaining || 0,
        },
      });

      if (item.prodStatus === "Completed") {
        const batchNum = `B-${o.qDate.replace(/-/g, "")}-${String(batchCounter++).padStart(4, "0")}`;
        const roasted = item.qty * 0.85;
        const waste = item.qty * 0.15;

        await prisma.roastingBatch.create({
          data: {
            orderItemId: orderItem.id,
            batchNumber: batchNum,
            date: new Date(o.qDate),
            greenBeanId: greenBeanId || null,
            greenBeanQuantity: item.qty,
            roastedBeanQuantity: parseFloat(roasted.toFixed(2)),
            wasteQuantity: parseFloat(waste.toFixed(2)),
            bags3kg: Math.floor(roasted / 3),
            bags1kg: Math.floor((roasted % 3) / 1),
            bags250g: 0,
            bags150g: 0,
            samplesGrams: 50,
          },
        });
      }

      if (item.delStatus === "Delivered" || item.delStatus === "Partial Delivered") {
        await prisma.delivery.create({
          data: {
            orderItemId: orderItem.id,
            date: new Date(o.qDate),
            quantityKg: item.delQty,
            deliveryType: item.delStatus === "Delivered" ? "full" : "partial",
          },
        });
      }
    }
  }

  // QC Records - from the Quality Control Excel
  const qcData = [
    { date: "2026-03-10", origin: "Nicaragua", processing: "Natural", sn: "100320260102", onProfile: true, remarks: "shorten the roasting time" },
    { date: "2026-03-10", origin: "Ethiopia Buku", processing: "Natural", sn: "100320260304", onProfile: true, remarks: "On Profile" },
    { date: "2026-03-10", origin: "Colombia Tolima", processing: "Washed", sn: "100320260506", onProfile: true, remarks: "On Profile" },
    { date: "2026-03-10", origin: "Melon", processing: "Innoculated", sn: "1003202601", onProfile: true, remarks: "On Profile" },
    { date: "2026-02-22", origin: "Ethiopia Buku", processing: "Natural", sn: "2202202601", onProfile: true, remarks: "Jasmine, Blueberry, Mandarin, Earl Grey Tea" },
    { date: "2026-02-24", origin: "Brazil Mogiana", processing: "Natural", sn: "2402202601", onProfile: true, remarks: "Milk Chocolate, Caramel, Nuts" },
    { date: "2026-03-02", origin: "Indonesia Wanoja", processing: "Natural", sn: "203202601", onProfile: true, remarks: "Good / subject for improvement" },
    { date: "2026-03-02", origin: "Colombia Lacima", processing: "Natural", sn: "203202601", onProfile: false, underDev: true, remarks: "roasted a bit light" },
    { date: "2026-04-01", origin: "Colombia La Presa", processing: "Natural", sn: "10420260102", onProfile: true, color: 67, remarks: "On Profile" },
    { date: "2026-04-04", origin: "Indonesia Peach", processing: "Innoculation", sn: "404202601", onProfile: true, color: 65, remarks: "On Profile" },
    { date: "2026-04-04", origin: "Ethiopia Buku", processing: "Natural", sn: "40420260102", onProfile: false, overDev: true, color: 65, remarks: "Roasted dark, Flavors" },
    { date: "2026-04-11", origin: "Brazil Mogiana", processing: "Natural", sn: "110420260102", onProfile: true, color: 76, remarks: "On Profile" },
    { date: "2026-04-11", origin: "Ethiopia Guji", processing: "Natural", sn: "1104202601", onProfile: true, color: 91, remarks: "On Profile" },
  ];

  const firstBatch = await prisma.roastingBatch.findFirst();
  if (firstBatch) {
    for (const qc of qcData) {
      await prisma.qcRecord.create({
        data: {
          batchId: firstBatch.id,
          date: new Date(qc.date),
          coffeeOrigin: qc.origin,
          processing: qc.processing,
          serialNumber: qc.sn,
          onProfile: qc.onProfile,
          underDeveloped: (qc as { underDev?: boolean }).underDev || false,
          overDeveloped: (qc as { overDev?: boolean }).overDev || false,
          color: qc.color || null,
          remarks: qc.remarks,
        },
      });
    }
  }

  // Coffee Products (sticker data from Excel)
  const products = [
    { productNameEn: "Ethiopia Hambella Guji", productNameAr: "اثيوبيا همبيلا قوجي", countryEn: "Ethiopia", countryAr: "اثيوبيا", regionEn: "Hambella", regionAr: "همبيلا", varietyEn: "Heirloom", varietyAr: "هيرليوم", processEn: "Natural", processAr: "مجففة", altitude: "1900 - 2350", cupNotesEn: "Berries, Citrus, Jasmine, Vanilla", cupNotesAr: "فانيليا - ياسمين - حمضيات - توت", roastPathEn: "Espresso, Filter", roastPathAr: "إسبريسو - تقطير" },
    { productNameEn: "Saba", productNameAr: "سبآ", countryEn: "Yemen", countryAr: "اليمن", regionEn: "Harez", regionAr: "حراز", varietyEn: "Typica", varietyAr: "تبيكا", processEn: "Anaerobic", processAr: "لاهوائي", altitude: "2100 - 2300", cupNotesEn: "Tropical Fruits, Candy, Roseberry", cupNotesAr: "فراولة - كاندي - فواكه استوائية", roastPathEn: "Espresso, Filter", roastPathAr: "إسبريسو - تقطير" },
    { productNameEn: "Indonesia Wanoja", productNameAr: "اندونيسيا وانوجا", countryEn: "Indonesia", countryAr: "اندونيسيا", regionEn: "Wanoja", regionAr: "وانوجا", varietyEn: "Typica", varietyAr: "تبيكا", processEn: "Anaerobic", processAr: "لاهوائي", altitude: "1300 - 1500", cupNotesEn: "Apricot, Chocolate", cupNotesAr: "تشوكولاته ـ مشمش", roastPathEn: "Espresso, Filter", roastPathAr: "إسبريسو - تقطير" },
    { productNameEn: "Brazil Mogiana", productNameAr: "برازيل موجيانا", countryEn: "Brazil", countryAr: "برازيل", regionEn: "Mogiana", regionAr: "موجيانا", varietyEn: "Bourbon", varietyAr: "بورون", processEn: "Natural", processAr: "مجففه", altitude: "1200", cupNotesEn: "Cocoa, Black Honey", cupNotesAr: "كاكاو - عسل اسود", roastPathEn: "Espresso", roastPathAr: "اسبريسوا" },
    { productNameEn: "Colombia Tulima", productNameAr: "كولومبيا توليما", countryEn: "Colombia", countryAr: "كولومبيا", regionEn: "Tulima", regionAr: "توليما", varietyEn: "Caturra, Castillo, Typica", varietyAr: "كاتورا - كاستيو تبيكا", processEn: "Washed", processAr: "مغسوله", altitude: "1900", cupNotesEn: "Roasted Nut, Caramel, Citrus", cupNotesAr: "مكسرات محمصة - كراميل - حمضيات", roastPathEn: "Espresso, Filter", roastPathAr: "إسبريسو - تقطير" },
    { productNameEn: "Hiqbah Blend", productNameAr: "حقبة بلند", countryEn: "Colombia, Brazil, Guatemala", countryAr: "برازيل - كولومبيا - غواتيملا", regionEn: "Tulima, Cauca, Mogiana, Wycan", regionAr: "توليما - موجيانا - وايكان", varietyEn: "Mixed", varietyAr: "مزيج", processEn: "Washed, Natural", processAr: "مغسوله - مجففة", altitude: "1200 - 1900", cupNotesEn: "Fig Jam, Kiwi, Raspberry, Dark Chocolate, Nuts", cupNotesAr: "كيوي - دارك توشوكلاته - فراوله", roastPathEn: "Espresso", roastPathAr: "اسبريسوا" },
    { productNameEn: "Nicaragua El Suyatal", productNameAr: "نيكارجوا ال سويتال", countryEn: "Nicaragua", countryAr: "نيكارجوا", regionEn: "Nueva Segovia", regionAr: "نويفا سيجوفيا", varietyEn: "Caturra", varietyAr: "كاتورا", processEn: "Natural", processAr: "مجففة", altitude: "1200 - 1500", cupNotesEn: "Green Apple, Chocolate", cupNotesAr: "تفاح اخضر ـ شوكلاته", roastPathEn: "Espresso, Filter", roastPathAr: "إسبريسو - تقطير" },
    { productNameEn: "Colombia La Versa", productNameAr: "كولومبيا لافريسا", countryEn: "Colombia", countryAr: "كولومبيا", regionEn: "Coendia", regionAr: "كويندو", varietyEn: "Castillo", varietyAr: "كاستيلو", processEn: "Natural", processAr: "مجففة", altitude: "1700 - 1900", cupNotesEn: "Strawberry, Orange, Plum", cupNotesAr: "فراولة ـ برتقال - ليمون", roastPathEn: "Espresso, Filter", roastPathAr: "إسبريسو - تقطير" },
    { productNameEn: "Ethiopia Chelechele", productNameAr: "اثيوبيا شيشيلي", countryEn: "Ethiopia", countryAr: "اثيوبيا", regionEn: "Chelechele", regionAr: "شيلشلي", varietyEn: "Heirloom", varietyAr: "هيرليوم", processEn: "Natural", processAr: "مجففة", altitude: "1900 - 2200", cupNotesEn: "Peach, Flowers, Sweets", cupNotesAr: "حلاوة - زهور - خوخ", roastPathEn: "Espresso, Filter", roastPathAr: "إسبريسو - تقطير" },
    { productNameEn: "Ethiopia Hambella Buku", productNameAr: "اثيوبيا همبيلا بوكو", countryEn: "Ethiopia", countryAr: "اثيوبيا", regionEn: "Guji", regionAr: "قوجي", varietyEn: "Heirloom", varietyAr: "هيرلوم", processEn: "Natural", processAr: "مجففة", altitude: "1900 - 2350", cupNotesEn: "Cranberry, Lemon, Chocolate", cupNotesAr: "شوكلاته - ليمون - توت بري", roastPathEn: "Espresso, Filter", roastPathAr: "إسبريسو - تقطير" },
    { productNameEn: "Uganda Mugisi", productNameAr: "اوغندا موجيسي", countryEn: "Uganda", countryAr: "اواغندا", regionEn: "Mugisi", regionAr: "موجيسي", varietyEn: "Arabica", varietyAr: "ارابيكا", processEn: "Natural", processAr: "مجففة", altitude: "1800", cupNotesEn: "Dark Chocolate, Berries, Citrus", cupNotesAr: "شوكلاته داكنه - توت - حمضيات", roastPathEn: "Espresso, Filter", roastPathAr: "تقطير - اسبريسو ا" },
    { productNameEn: "Colombia Lacima", productNameAr: "كولومبيا لاسيما", countryEn: "Colombia", countryAr: "كولومبيا", regionEn: "Cauca", regionAr: "كاوكا", varietyEn: "Arabica", varietyAr: "ارابيكا", processEn: "Natural", processAr: "مجففة", altitude: "1700 - 1750", cupNotesEn: "Raisin, Berry, Pear", cupNotesAr: "زبيب - توت - كمثرى", roastPathEn: "Espresso, Filter", roastPathAr: "اسبريسوا - تقطير" },
    { productNameEn: "Guatemala Wycan", productNameAr: "غواتيمالا وايكان", countryEn: "Guatemala", countryAr: "غواتيمالا", regionEn: "Wycan", regionAr: "وايكان", varietyEn: "Bourbon", varietyAr: "بورون", processEn: "Washed", processAr: "مغسولة", altitude: "1600 - 1800", cupNotesEn: "Peanuts, Chocolate, Almonds", cupNotesAr: "مكسرات - شوكلاته - لوز", roastPathEn: "Espresso, Filter", roastPathAr: "اسربيسوا - تقطير" },
    { productNameEn: "Colombia Huila Pinas", productNameAr: "كولومبيا ويلا بيناس", countryEn: "Colombia", countryAr: "كولومبيا", regionEn: "Huila", regionAr: "ويلا", varietyEn: "Arabica", varietyAr: "ارابيكا", processEn: "Natural", processAr: "مجففة", altitude: "1600 - 1900", cupNotesEn: "Wine, Apple, Orange", cupNotesAr: "واين - تفاح - برتقال", roastPathEn: "Espresso, Filter", roastPathAr: "اسبريسوا - تقطير" },
    { productNameEn: "Colombia Peches", productNameAr: "كولومبيا خوخ", countryEn: "Colombia", countryAr: "كولومبيا", regionEn: "Quindio", regionAr: "كويندو", varietyEn: "Castillo", varietyAr: "كاستيلو", processEn: "Aerobic", processAr: "ارابيكا", altitude: "1400 - 1450", cupNotesEn: "Peaches", cupNotesAr: "خوخ", roastPathEn: "Filter", roastPathAr: "تقطير" },
    { productNameEn: "Colombia Melon", productNameAr: "كولومبيا شمام", countryEn: "Colombia", countryAr: "كولومبيا", regionEn: "Quindia", regionAr: "كويندو", varietyEn: "Castillo", varietyAr: "كاستيلو", processEn: "Washed", processAr: "مغسولة", altitude: "1900 - 1950", cupNotesEn: "Melon", cupNotesAr: "شمام", roastPathEn: "Espresso, Filter", roastPathAr: "تقطير - اسبريسوا" },
    { productNameEn: "Colombia Lemon", productNameAr: "كولومبيا ليمون", countryEn: "Colombia", countryAr: "كولومبيا", regionEn: "Quindia", regionAr: "كويندو", varietyEn: "Castillo", varietyAr: "كاستيلو", processEn: "Washed", processAr: "مغسولة", altitude: "1900 - 1950", cupNotesEn: "Lemon, Blossom", cupNotesAr: "ليمون", roastPathEn: "Espresso, Filter", roastPathAr: "إسبريسو - تقطير" },
  ];

  for (const p of products) {
    await prisma.coffeeProduct.create({ data: p });
  }

  console.log("Seed completed successfully!");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
