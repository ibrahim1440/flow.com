/**
 * The Arabic counted noun (أبو فهد, D20 review): 1 حبة · 2 حبتين · 3–10 حبات · 11+ حبة (and 0 حبة).
 * `two` is the dual on its own («حبتين», no figure), as it is said.
 */
export function countAr(n: number, one: string, two: string, few: string): string {
  if (n === 2) return two;
  if (n >= 3 && n <= 10) return `${n} ${few}`;
  return `${n} ${one}`;
}
/** «حبة» — the unit the sales screens count in. */
export const unitsAr = (n: number) => countAr(n, "حبة", "حبتين", "حبات");
