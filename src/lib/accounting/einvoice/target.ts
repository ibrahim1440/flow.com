// Where a submission may go (stage 6). Pure. Production is never a target: LOCAL_ONLY sends
// nothing; SANDBOX goes only to a local stub (http://localhost or 127.0.0.1) or to ZATCA's
// developer-portal / simulation paths with test credentials from the environment.
export type SubmitTarget = { environment: "LOCAL_ONLY" } | { environment: "SANDBOX"; baseUrl: string; token: string; secret: string };

export function submissionTarget(env: string, vars: Record<string, string | undefined> = process.env): SubmitTarget | { refused: string } {
  if (env !== "SANDBOX") return { environment: "LOCAL_ONLY" };
  const raw = vars.ZATCA_SANDBOX_URL;
  if (!raw) return { refused: "No sandbox URL is configured (ZATCA_SANDBOX_URL)." };
  let u: URL;
  try { u = new URL(raw); } catch { return { refused: "The sandbox URL is not a URL." }; }
  if (/\/e-invoicing\/core/i.test(u.pathname)) return { refused: "That is the production (core) path; this branch never sends to production." };
  const localStub = ["localhost", "127.0.0.1"].includes(u.hostname) && u.protocol === "http:";
  const zatcaTest = u.protocol === "https:" && u.hostname === "gw-fatoora.zatca.gov.sa" && /^\/e-invoicing\/(developer-portal|simulation)(\/|$)/.test(u.pathname);
  if (!localStub && !zatcaTest) return { refused: `Host ${u.host}${u.pathname} is not an allowed test target (a local stub, or ZATCA's developer-portal / simulation paths).` };
  const token = vars.ZATCA_SANDBOX_TOKEN, secret = vars.ZATCA_SANDBOX_SECRET;
  if (!localStub && (!token || !secret)) return { refused: "No test CSID credentials are configured (ZATCA_SANDBOX_TOKEN / ZATCA_SANDBOX_SECRET)." };
  return { environment: "SANDBOX", baseUrl: raw.replace(/\/$/, ""), token: token ?? "local-stub", secret: secret ?? "local-stub" };
}

