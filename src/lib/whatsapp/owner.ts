/**
 * The number of the phone linked to the WhatsApp instance, read from the Evolution API's
 * instance listing (GET /instance/fetchInstances?instanceName=…). Pure, so it is unit-tested.
 *
 * Evolution 2.x answers an array of instances whose `ownerJid` is "<digits>@s.whatsapp.net"
 * once a phone is linked (null before); 1.x nested it as `instance.owner`. A multi-device JID can
 * carry a device suffix after a colon ("<digits>:<device>@s.whatsapp.net"). Only the instance asked for is read.
 */
export function linkedNumberFrom(body: unknown, instance: string): string | null {
  const list = Array.isArray(body) ? body : body ? [body] : [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const it = raw as Record<string, unknown>;
    const nested = (it.instance && typeof it.instance === "object" ? it.instance : {}) as Record<string, unknown>;
    const name = it.name ?? it.instanceName ?? nested.instanceName ?? nested.name;
    if (typeof name === "string" && name !== instance) continue;
    const jid = it.ownerJid ?? it.owner ?? nested.ownerJid ?? nested.owner;
    if (typeof jid !== "string" || !jid) continue;
    const digits = jid.split("@")[0].split(":")[0].replace(/\D/g, "");
    if (/^\d{8,15}$/.test(digits)) return digits;
  }
  return null;
}
