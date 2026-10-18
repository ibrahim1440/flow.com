// One bcrypt comparison, always (re-test AUTH-C). A missing account, or a stored value that is
// not a bcrypt hash (a placeholder), costs exactly what a wrong secret costs — the answer's
// timing never tells an unknown username from a known one. Pure: no Next.js, no database.
import { compare, hashSync } from "bcryptjs";

const DUMMY = hashSync("no-such-account", 10);
const BCRYPT = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

/** A full, well-formed bcrypt hash (60 characters) — the only stored value verifySecret can ever accept. */
export const isBcryptHash = (stored: string | null | undefined): stored is string => typeof stored === "string" && BCRYPT.test(stored);

/** True only when `stored` is a real bcrypt hash of `input`. */
export async function verifySecret(input: string, stored: string | null | undefined): Promise<boolean> {
  const real = isBcryptHash(stored);
  const ok = await compare(input, real ? stored : DUMMY);
  return real && ok;
}
