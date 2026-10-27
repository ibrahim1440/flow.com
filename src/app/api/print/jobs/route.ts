import { NextResponse } from "@/lib/api-response";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { handlePrismaError } from "@/lib/api-error";
import { auditItem, buildJob, parseJobRequest, profileSnapshot } from "@/lib/print/server/job";
import { extractIp, hashRateLimitKey } from "@/lib/rate-limit";

/**
 * An authorized print job (B-9). Re-checks permissions, re-resolves every value from the records,
 * re-computes the layout totals and the job cap on the server, appends one PrintAuditLog row
 * (who, template, items, copies, profile — references and counts only, never label text, scores
 * or notes) and returns the content the client renders for window.print(). The same transaction appends one row to
 * the person audit (AuthAuditLog «LABELS_PRINTED»: who, when, which lots / items by their label code and sack, how
 * many labels) — the reprint history of a lot (20261114090000_green_lot_labels).
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
    const row = await prisma.$transaction(async (tx) => {
    const created = await tx.printAuditLog.create({
      data: {
        action: "PRINT_JOB",
        actorId: user.id,
        actorName: user.name ?? null,
        templateKey: parsed.template,
        language: parsed.language,
        profileId: parsed.profile.id,
        profileName: parsed.profile.name,
        profile: profileSnapshot(parsed.profile),
        items: parsed.items.map(auditItem) as Prisma.InputJsonValue,
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
    // The person audit (append-only: insert only). Label codes, sack numbers and counts — no label text, no price.
    const codeOf = new Map(j.data.map((d) => [d.ref, d.kind === "green" || d.kind === "material" ? d.code : null]));
    const items = parsed.items.map((it) => ({ ...auditItem(it), code: codeOf.get(auditItem(it).ref) ?? undefined }));
    await tx.authAuditLog.create({
      data: {
        userId: user.id, action: "LABELS_PRINTED", result: "SUCCESS", sourceInterface: "WEB",
        ipHash: hashRateLimitKey(extractIp(req)), userAgent: req.headers.get("user-agent")?.slice(0, 300) ?? null,
        metadata: { jobId: created.id, template: parsed.template, totalLabels: j.totals.labels, totalPages: j.totals.pages, profileName: parsed.profile.name, items: items.slice(0, 200) } as Prisma.InputJsonValue,
      },
    });
    return created;
    });
    return NextResponse.json({ jobId: row.id, createdAt: row.createdAt, labels: j.data, totals: j.totals, warnings: j.warnings }, { status: 201 });
  } catch (err) {
    return handlePrismaError(err);
  }
}
