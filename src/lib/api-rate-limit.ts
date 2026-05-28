import { prisma } from "@/lib/db";
import { hashRateLimitKey } from "@/lib/rate-limit";

const PRUNE_AFTER_MS = 60 * 60 * 1000;

export async function checkAndRecordRateLimit(options: {
  scope: string;
  key: string;
  limit: number;
  windowMs: number;
}): Promise<{ limited: boolean; remaining: number }> {
  const scope = options.scope.trim();
  const key = options.key.trim();
  const { limit, windowMs } = options;

  if (limit <= 0 || windowMs <= 0 || !scope || !key) {
    return { limited: true, remaining: 0 };
  }

  const keyHash = hashRateLimitKey(key);
  const now = Date.now();
  const windowStart = new Date(now - windowMs);
  const pruneOlderThan = new Date(now - PRUNE_AFTER_MS);

  await prisma.rateLimit.deleteMany({
    where: { createdAt: { lt: pruneOlderThan } },
  });

  const count = await prisma.rateLimit.count({
    where: { scope, keyHash, createdAt: { gte: windowStart } },
  });

  if (count >= limit) {
    return { limited: true, remaining: 0 };
  }

  await prisma.rateLimit.create({ data: { scope, keyHash } });

  return { limited: false, remaining: limit - count - 1 };
}
