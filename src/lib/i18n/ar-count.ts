// Abu Fahd R2 (low): an Arabic count with the noun in agreement — «ثانية واحدة», «ثانيتين», «3 ثوانٍ», «22 ثانية» — never
// «22 ثواني». Pure and client-safe. Forms: one (1), two (2), few (3–10: plural), many (11+ and 0: singular accusative-free form).
export type ArNoun = { one: string; two: string; few: string; many: string };

export const AR_SECONDS: ArNoun = { one: "ثانية واحدة", two: "ثانيتين", few: "ثوانٍ", many: "ثانية" };
export const AR_MINUTES: ArNoun = { one: "دقيقة واحدة", two: "دقيقتين", few: "دقائق", many: "دقيقة" };

/** "n noun" in agreement: 1 → «ثانية واحدة», 2 → «ثانيتين», 3–10 → «3 ثوانٍ», otherwise «22 ثانية». */
export function arCount(n: number, w: ArNoun): string {
  const k = Math.abs(Math.trunc(n));
  if (k === 1) return w.one;
  if (k === 2) return w.two;
  const tail = k % 100;
  if (tail >= 3 && tail <= 10) return `${n} ${w.few}`;
  return `${n} ${w.many}`;
}
