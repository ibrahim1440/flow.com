import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { requireSub } from "@/lib/auth-server";
import { runAutomationDispatch } from "@/lib/automation/dispatcher";

/**
 * Run the dispatcher: process pending events, raise due tasks, send what is due.
 *
 * Called by a scheduler with `Authorization: Bearer <CRON_SECRET>` (Vercel Cron sends exactly
 * that header, and calls with GET), or by a signed-in user from the message log. Events are
 * normally processed right after the request that raised them; this route is what retries
 * failures, sends delayed steps and notices tasks falling due when nobody is using the system.
 */
export const maxDuration = 60;

function cronAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16) return false;
  const header = request.headers.get("authorization") ?? "";
  const expected = Buffer.from(`Bearer ${secret}`);
  const given = Buffer.from(header);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

async function handle(request: Request) {
  const byCron = cronAuthorized(request);
  if (!byCron) {
    const { error } = await requireSub("automation", "manage_messages");
    if (error) return error;
  }
  const report = await runAutomationDispatch({ budgetMs: byCron ? 45_000 : 20_000, maxSends: byCron ? 20 : 10 });
  return NextResponse.json(report);
}

export const GET = handle;
export const POST = handle;
