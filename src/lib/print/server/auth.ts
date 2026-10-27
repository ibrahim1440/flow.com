/**
 * Server-side authorization for the print subsystem (B-9). Every print API calls one of these
 * before it reads any data; a hidden button is never the security.
 */
import { NextResponse } from "@/lib/api-response";
import { requireAuth, forbidden, adminRoleGate } from "@/lib/auth-server";
import { hasModuleAccess, hasSubPrivilege } from "@/lib/auth";
import type { TemplateKey } from "../templates";
import { documentPrintingDisabledBody, isDocumentPrintingEnabled, isPrintCertified, printNotCertifiedBody } from "../certification";

type User = Awaited<ReturnType<typeof requireAuth>>["user"];

export const canPrint = (u: User) => hasSubPrivilege(u.permissions, "labels", "print");
export const canManageProfiles = (u: User) => u.role === "admin" || hasSubPrivilege(u.permissions, "labels", "profile_manage");
export const canManagePresets = (u: User) => u.role === "admin" || hasSubPrivilege(u.permissions, "labels", "template_manage");
/**
 * Managing profiles / presets: through the sub-privilege, or through the admin role — which is
 * privileged, so that path is exercised by a verified individual (the admin-role gate). Returns
 * the refusal to send, or null.
 */
export async function manageGate(u: User, what: "profiles" | "presets") {
  if (hasSubPrivilege(u.permissions, "labels", what === "profiles" ? "profile_manage" : "template_manage")) return null;
  if (u.role !== "admin") return forbidden();
  return adminRoleGate(u, `print.${what}_manage`);
}
/** An administrator changing someone else's profile / preset: the admin-role gate. */
export async function ownerOverrideGate(u: User, ownerId: string | null, message: string) {
  if (ownerId === u.id) return null;
  if (u.role !== "admin") return forbidden(message);
  return adminRoleGate(u, "print.owner_override");
}
/** Decision 2.1: the separate permission for named scorer attribution (no role bypass). */
export const canNameScorers = (u: User) => hasSubPrivilege(u.permissions, "labels", "cupping_named_scorers");
/** Cupping results are cupping data: printing them also needs the cupping module. */
export const canReadCupping = (u: User) => hasModuleAccess(u.permissions, "cupping");

/**
 * The print certification gate (owner decision on A-8): while PRINT_CERTIFIED is not exactly
 * "true", every endpoint that produces printable label content refuses with 409
 * PRINTING_NOT_CERTIFIED (Arabic and English) before it reads or builds anything. Returns the
 * refusal to send, or null.
 */
export function printCertificationGate(): NextResponse | null {
  if (isPrintCertified()) return null;
  return NextResponse.json(printNotCertifiedBody(), { status: 409 });
}

/**
 * Authentication, then labels.print, then the certification gate — in that order, so 401 / 403
 * keep their meaning, an unauthenticated caller learns nothing, and with the gate off nothing past
 * this point (not even the request body) is read. Used by the label preview, the print job and the
 * batch / lot selector. The template-specific check (cupping module access for Cupping Results)
 * needs the body, so it comes after: see requireTemplateAccess.
 */
export async function requirePrint() {
  const { user, error } = await requireAuth();
  if (error) return { user: null as never, error };
  if (!canPrint(user)) return { user: null as never, error: forbidden() };
  const gated = printCertificationGate();
  if (gated) return { user: null as never, error: gated };
  return { user, error: null };
}

/**
 * Cupping results are cupping data: the Cupping Results template also needs the cupping module. A green lot or a
 * material is inventory data: those two labels also need the inventory module.
 */
export function requireTemplateAccess(user: User, template: TemplateKey): NextResponse | null {
  if (template === "CUPPING_RESULTS" && !canReadCupping(user)) return forbidden();
  if ((template === "GREEN_LOT" || template === "MATERIAL_SHELF") && !hasModuleAccess(user.permissions, "inventory")) return forbidden();
  return null;
}

/** Reading profiles / presets: anyone who prints or manages them. */
export async function requirePrintRead() {
  const { user, error } = await requireAuth();
  if (error) return { user: null as never, error };
  if (!canPrint(user) && !canManageProfiles(user) && !canManagePresets(user)) return { user: null as never, error: forbidden() };
  return { user, error: null };
}

export function badRequest(code: string, message: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error: message, code, ...extra }, { status: 400 });
}

export async function readJson(req: Request): Promise<{ body: Record<string, unknown> | null; error: NextResponse | null }> {
  try {
    const b = await req.json();
    if (!b || typeof b !== "object" || Array.isArray(b)) return { body: null, error: badRequest("INVALID_BODY", "A JSON object is required.") };
    return { body: b as Record<string, unknown>, error: null };
  } catch {
    return { body: null, error: badRequest("INVALID_BODY", "Invalid JSON body.") };
  }
}

/**
 * The document gate (PRINT_DOCUMENTS_ENABLED, or implied by PRINT_CERTIFIED) for the A4 document
 * data endpoints (/api/print/documents/**: roast sheet, delivery note). Called after
 * authentication and the module permission, before the query string is read. Returns the 409
 * refusal to send, or null.
 */
export function documentPrintGate(): NextResponse | null {
  if (isDocumentPrintingEnabled()) return null;
  return NextResponse.json(documentPrintingDisabledBody(), { status: 409 });
}
