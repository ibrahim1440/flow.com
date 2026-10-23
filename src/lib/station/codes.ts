// Workstations W2 — the code alphabet the device code and the activation code share. Client-safe
// (the station's S1 screen generates its device code with it; the server validates with the same).
/** Crockford-like: no 0 / O / 1 / I, so a code read aloud or typed on a tablet is never ambiguous. */
export const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
