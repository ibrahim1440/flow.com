import "server-only";

/**
 * The WhatsApp server client (Evolution API 2.x), for exactly one instance.
 *
 * ── What this can do, and what it deliberately cannot ──
 * Five calls: ask for a QR or pairing code, read the connection state, send a text, log the
 * phone out, restart. There is no call to delete or create an instance and there must never
 * be one: deleting the instance is irreversible on the server side and the number cannot be
 * recreated from here. The key is also scoped to this one instance on the server.
 *
 * ── The key never leaves the server ──
 * It is read from the environment here and sent only in the `apikey` header of a server-side
 * request. No result, error or log line produced below contains it, and nothing under a
 * "use client" boundary imports this module (enforced by `server-only`).
 */

export type WhatsAppConfig = { baseUrl: string; instance: string; apiKey: string };

export type ConfigResult = { ok: true; config: WhatsAppConfig } | { ok: false; reason: string };

/** Names the problem, never any part of the value — safe to show an administrator. */
export function whatsappConfig(env: Record<string, string | undefined> = process.env): ConfigResult {
  const url = env.WHATSAPP_API_URL?.trim();
  const instance = env.WHATSAPP_INSTANCE?.trim();
  const apiKey = env.WHATSAPP_API_KEY?.trim();
  if (!url || !instance || !apiKey) {
    return { ok: false, reason: "WhatsApp is not configured on this deployment (WHATSAPP_API_URL, WHATSAPP_INSTANCE, WHATSAPP_API_KEY)." };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "WHATSAPP_API_URL is not a valid URL." };
  }
  const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) {
    return { ok: false, reason: "WHATSAPP_API_URL must use https." };
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(instance)) return { ok: false, reason: "WHATSAPP_INSTANCE is not a valid instance name." };
  if (apiKey.length < 16) return { ok: false, reason: "WHATSAPP_API_KEY is too short to be a real key." };
  return { ok: true, config: { baseUrl: parsed.origin, instance, apiKey } };
}

export type ConnectionState = "open" | "connecting" | "close" | "unknown";

export type CallFailure = {
  ok: false;
  /** HTTP status, or null when the server could not be reached. */
  status: number | null;
  error: string;
  /** Worth trying again later: unreachable, timed out, rate-limited, a server error, or a rejected key. */
  transient: boolean;
};

const TIMEOUT_MS = 15_000;

function isTransient(status: number | null): boolean {
  return status === null || status === 401 || status === 403 || status === 408 || status === 425 || status === 429 || status >= 500;
}

/** The server's own message, flattened and truncated. Never echoes request headers. */
function describe(body: unknown, status: number): string {
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    const response = b.response as Record<string, unknown> | undefined;
    const msg = response?.message ?? b.message ?? b.error;
    if (Array.isArray(msg)) {
      const first = msg[0] as Record<string, unknown> | string | undefined;
      if (first && typeof first === "object" && first.exists === false) return "This number is not on WhatsApp.";
      return msg.map((m) => (typeof m === "string" ? m : JSON.stringify(m))).join("; ").slice(0, 300);
    }
    if (typeof msg === "string") return msg.slice(0, 300);
  }
  return `WhatsApp server answered HTTP ${status}.`;
}

async function call(
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
  env?: Record<string, string | undefined>,
): Promise<{ ok: true; status: number; body: unknown } | CallFailure> {
  const cfg = whatsappConfig(env);
  if (!cfg.ok) return { ok: false, status: null, error: cfg.reason, transient: false };
  const { baseUrl, apiKey } = cfg.config;
  try {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { apikey: apiKey, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const parsed = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, status: res.status, error: describe(parsed, res.status), transient: isTransient(res.status) };
    return { ok: true, status: res.status, body: parsed };
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    return {
      ok: false,
      status: null,
      error: timedOut ? "The WhatsApp server did not answer in time." : "The WhatsApp server could not be reached.",
      transient: true,
    };
  }
}

const inst = (env?: Record<string, string | undefined>) => {
  const cfg = whatsappConfig(env);
  return cfg.ok ? encodeURIComponent(cfg.config.instance) : "";
};

function readState(body: unknown): ConnectionState {
  const state = (body as { instance?: { state?: unknown } } | null)?.instance?.state;
  return state === "open" || state === "connecting" || state === "close" ? state : "unknown";
}

export async function getConnectionState(): Promise<{ ok: true; state: ConnectionState } | CallFailure> {
  const r = await call("GET", `/instance/connectionState/${inst()}`);
  return r.ok ? { ok: true, state: readState(r.body) } : r;
}

export type ConnectResult =
  | { ok: true; connected: true }
  | { ok: true; connected: false; qr: string | null; pairingCode: string | null };

/**
 * Start (or continue) linking a phone. Without a number the server answers with a QR image
 * (a data:image/png URL) that expires in about a minute; with one it answers with a pairing
 * code to type into WhatsApp on that phone. Already linked: says so.
 */
export async function connect(number?: string): Promise<ConnectResult | CallFailure> {
  const query = number ? `?number=${encodeURIComponent(number)}` : "";
  const r = await call("GET", `/instance/connect/${inst()}${query}`);
  if (!r.ok) return r;
  if (readState(r.body) === "open") return { ok: true, connected: true };
  const b = (r.body ?? {}) as { base64?: unknown; pairingCode?: unknown };
  const qr = typeof b.base64 === "string" && b.base64.startsWith("data:image/") ? b.base64 : null;
  const pairingCode = typeof b.pairingCode === "string" && b.pairingCode ? b.pairingCode : null;
  return { ok: true, connected: false, qr, pairingCode };
}

export async function sendText(number: string, text: string): Promise<{ ok: true; messageId: string | null } | CallFailure> {
  const r = await call("POST", `/message/sendText/${inst()}`, { number, text });
  if (!r.ok) return r;
  const id = (r.body as { key?: { id?: unknown } } | null)?.key?.id;
  return { ok: true, messageId: typeof id === "string" ? id : null };
}

/** Unlink the current phone. Linking another one starts again from connect(). */
export async function logout(): Promise<{ ok: true } | CallFailure> {
  const r = await call("DELETE", `/instance/logout/${inst()}`);
  return r.ok ? { ok: true } : r;
}

export async function restart(): Promise<{ ok: true } | CallFailure> {
  const r = await call("POST", `/instance/restart/${inst()}`);
  return r.ok ? { ok: true } : r;
}
