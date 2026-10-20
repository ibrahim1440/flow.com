import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { greenRefusal, pickGreenLot, type GreenLot, type GreenPick } from "@/lib/green-source";

type Db = Prisma.TransactionClient | typeof prisma;

const LOT_SELECT = {
  id: true, serialNumber: true, beanType: true, beanTypeAr: true, country: true, countryAr: true,
  quantityKg: true, isActive: true, receivedDate: true, createdAt: true,
} as const;

export type GreenSourceFacts = {
  productId: string | null;
  productNameEn: string | null;
  productNameAr: string | null;
  /** The product's expected roast loss, percent (CoffeeProduct.expectedRoastLoss, default 15). */
  expectedRoastLoss: number;
  defaultLot: GreenLot | null;
  /** Active lots of the default lot's beanType + country, the default included, FIFO order not applied. */
  candidates: GreenLot[];
};

/**
 * The facts the automatic green-lot choice is made from, for a stock roast (`productId`) or an
 * order-backed one (`orderItemId`). The product's default lot first; a legacy order line whose
 * product names none falls back to the lot the line itself recorded at order time.
 */
export async function greenSourceFacts(db: Db, args: { productId?: string | null; orderItemId?: string | null }): Promise<GreenSourceFacts | null> {
  let productId = args.productId ?? null;
  let lineLotId: string | null = null;
  if (args.orderItemId) {
    const line = await db.orderItem.findUnique({
      where: { id: args.orderItemId },
      select: { productId: true, greenBeanId: true, productSku: { select: { productId: true } } },
    });
    if (!line) return null;
    productId = line.productSku?.productId ?? line.productId ?? null;
    lineLotId = line.greenBeanId;
  }
  const product = productId
    ? await db.coffeeProduct.findUnique({
        where: { id: productId },
        select: { id: true, productNameEn: true, productNameAr: true, expectedRoastLoss: true, defaultGreenBeanId: true },
      })
    : null;
  if (args.productId && !product) return null;

  const defaultId = product?.defaultGreenBeanId ?? lineLotId;
  const defaultLot = defaultId ? await db.greenBean.findUnique({ where: { id: defaultId }, select: LOT_SELECT }) : null;
  const candidates = defaultLot
    ? await db.greenBean.findMany({
        where: {
          isActive: true,
          beanType: { equals: defaultLot.beanType, mode: "insensitive" },
          country: { equals: defaultLot.country, mode: "insensitive" },
        },
        select: LOT_SELECT,
        orderBy: [{ receivedDate: "asc" }, { createdAt: "asc" }],
        take: 50,
      })
    : [];
  return {
    productId: product?.id ?? null,
    productNameEn: product?.productNameEn ?? null,
    productNameAr: product?.productNameAr ?? null,
    expectedRoastLoss: product?.expectedRoastLoss ?? 15,
    defaultLot,
    candidates,
  };
}

/**
 * Resolve the lot for `kg` of green coffee, or throw the 409 refusal (Arabic message, English
 * errorEn, code GREEN_SOURCE_UNAVAILABLE). Read inside the roast transaction; the decrement that
 * follows stays the atomic `quantityKg >= kg` update, so a lot drained in between still refuses.
 */
export async function resolveGreenLot(db: Db, args: { productId?: string | null; orderItemId?: string | null }, kg: number): Promise<Extract<GreenPick, { ok: true }>> {
  const facts = await greenSourceFacts(db, args);
  const pick = pickGreenLot(facts?.defaultLot ?? null, facts?.candidates ?? [], kg);
  if (!pick.ok) {
    const msg = greenRefusal(pick, kg);
    throw { _appCode: 409, message: msg.ar, errorEn: msg.en, code: "GREEN_SOURCE_UNAVAILABLE" };
  }
  return pick;
}
