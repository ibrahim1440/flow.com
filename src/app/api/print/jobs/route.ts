import { NextResponse } from "next/server";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { handlePrismaError } from "@/lib/api-error";
import { buildJob, parseJobRequest, profileSnapshot } from "@/lib/print/server/job";
import { itemRef } from "@/lib/print/server/data";

/**
 * An authorized print job (B-9). Re-checks permissions, re-resolves every value from the records,
 * re-computes the layout totals and the job cap on the server, appends one PrintAuditLog row
 * (who, template, items, copies, profile — references and counts only, never label text, scores
 * or notes) and returns the content the client renders for window.print().
 *
 * The audit records that the application authorized the job. Whether the operating system's print
 * dialog was then completed, cancelled or saved to PDF cannot be known by a web page.
 */
export async function POST(req: Request) {
  const p = await parseJobRequest(req);
  if ("error" in p) return p.error;
  const j = await buildJob(p.parsed);
  if ("error" in j) return j.error;
  const { user, parsed } = p;
  if (j.blocked.length) {
    return NextResponse.json({ error: "This label size cannot print the pre-policy caveat legibly; choose a larger profile.", code: "PRINT_BLOCKED", warnings: j.blocked }, { status: 409 });
  }
  const warningCodes = [...new Set([...j.warnings.map((w) => w.code), ...parsed.clientWarnings])];
  try {
    const row = await prisma.printAuditLog.create({
      data: {
        action: "PRINT_JOB",
        actorId: user.id,
        actorName: user.name ?? null,
        templateKey: parsed.template,
        language: parsed.language,
        profileId: parsed.profile.id,
        profileName: parsed.profile.name,
        profile: profileSnapshot(parsed.profile),
        items: parsed.items.map((it) => (it.kind === "product"
          ? { kind: "product", productId: it.productId, batchId: it.batchId ?? null, lotId: it.lotId ?? null, copies: it.copies, ref: itemRef(it) }
          : { kind: "cup", sessionId: it.sessionId, cupId: it.cupId, copies: it.copies, ref: itemRef(it) })) as Prisma.InputJsonValue,
        itemCount: parsed.items.length,
        copiesTotal: j.totals.labels,
        totalLabels: j.totals.labels,
        totalPages: j.totals.pages,
        startSlot: parsed.startSlot,
        warnings: warningCodes as Prisma.InputJsonValue,
        // Job options: the fields shown, and the notes mode with whether it overrides the template default.
        after: {
          fieldsShown: parsed.fields.filter((f) => f.show).map((f) => f.key),
          notesLines: parsed.notesLines,
          // Derived on the server from the printed fields and the applied preset / template default.
          notesMode: parsed.options.notesMode,
          notesModeDefault: parsed.options.notesModeDefault,
          notesModeOverridden: parsed.options.notesModeOverridden,
          ...(parsed.options.clientClaim ? { notesModeClientClaim: parsed.options.clientClaim } : {}),
          // Decision 2.1: whether this job printed named scorers, and through which preset.
          namedScorers: parsed.named,
          namedScorersRequestedButRefused: parsed.namedIgnored,
          presetId: parsed.presetId,
        } as Prisma.InputJsonValue,
      },
      select: { id: true, createdAt: true },
    });
    return NextResponse.json({ jobId: row.id, createdAt: row.createdAt, labels: j.data, totals: j.totals, warnings: j.warnings }, { status: 201 });
  } catch (err) {
    return handlePrismaError(err);
  }
}
