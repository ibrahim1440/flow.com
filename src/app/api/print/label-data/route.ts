import { NextResponse } from "@/lib/api-response";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { handlePrismaError } from "@/lib/api-error";
import { buildJob, parseJobRequest, profileSnapshot } from "@/lib/print/server/job";
import { itemRef } from "@/lib/print/server/data";

/**
 * Preview data for the print dialog (B-1): the resolved label content, layout totals and content
 * warnings. Requires labels.print (and cupping access for the Cupping Results template) exactly
 * like a print job. A preview is not audited — except when it returns authorized scorer names
 * (decision 2.1, QA P3-7): then one PREVIEW_NAMED row records who saw which cups' names.
 */
export async function POST(req: Request) {
  const p = await parseJobRequest(req);
  if ("error" in p) return p.error;
  const j = await buildJob(p.parsed);
  if ("error" in j) return j.error;
  const { user, parsed } = p;
  if (parsed.named) {
    try {
      await prisma.printAuditLog.create({
        data: {
          action: "PREVIEW_NAMED",
          actorId: user.id,
          actorName: user.name ?? null,
          templateKey: parsed.template,
          language: parsed.language,
          profileId: parsed.profile.id,
          profileName: parsed.profile.name,
          profile: profileSnapshot(parsed.profile),
          items: parsed.items.map((it) => (it.kind === "cup" ? { kind: "cup", sessionId: it.sessionId, cupId: it.cupId, copies: it.copies, ref: itemRef(it) } : { kind: "product", productId: it.productId, copies: it.copies, ref: itemRef(it) })) as Prisma.InputJsonValue,
          itemCount: parsed.items.length,
          after: { namedScorers: true, presetId: parsed.presetId } as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      return handlePrismaError(err);
    }
  }
  return NextResponse.json({ labels: j.data, totals: j.totals, warnings: j.warnings, maxLabelsPerJob: j.maxLabelsPerJob });
}
