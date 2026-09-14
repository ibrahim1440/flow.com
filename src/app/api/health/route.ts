import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

/**
 * GET /api/health — liveness for an external uptime checker.
 *
 * There was nothing like this. If the deployment started returning 500s, or the database
 * became unreachable, the way anyone found out was a member of staff telephoning to say the
 * screen was broken. A check that can be polled from outside turns that into an alert.
 *
 * ── Deliberately unauthenticated ───────────────────────────────────────────
 * An uptime monitor holds no session, and a check that needs a login proves only that the
 * login flow works for the one account whose credentials the monitor is carrying around.
 * The trade is that this endpoint is world-readable, so it says as little as it possibly
 * can: two states, no host, no database name, no version, no counts, no error text. A
 * caller learns exactly what a caller could learn anyway by timing an ordinary page.
 *
 * ── Bounded, read-only, no transaction ─────────────────────────────────────
 * `SELECT 1` on a pooled connection, raced against a timeout. The race matters: the pool
 * waits up to five seconds for a connection and a hung network read can wait far longer,
 * and a health check that hangs is indistinguishable to a monitor from one that is merely
 * slow — it holds the monitor's own request open and delays the alert it exists to raise.
 * Failing fast and loudly is the whole point of the endpoint.
 */

export const dynamic = "force-dynamic";
export const revalidate = 0;

/** Comfortably above a normal round trip on this deployment (~167 ms), far below a hang. */
const HEALTH_TIMEOUT_MS = 3000;

const NO_STORE = {
  "Cache-Control": "no-store, no-cache, must-revalidate",
} as const;

export async function GET() {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const probe = prisma.$queryRaw`SELECT 1`;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("health probe timed out")), HEALTH_TIMEOUT_MS);
    });

    await Promise.race([probe, timeout]);
    return NextResponse.json({ status: "ok" }, { status: 200, headers: NO_STORE });
  } catch (err) {
    // Logged with detail for whoever is on the other end of the alert; the response carries
    // none of it. A connection error can contain the host, the user and occasionally the
    // password, and this endpoint is public.
    console.error("[health] database probe failed:", err);
    return NextResponse.json({ status: "unavailable" }, { status: 503, headers: NO_STORE });
  } finally {
    if (timer) clearTimeout(timer);
  }
}
