export const VALID_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  "Pending QC":         ["Passed", "Rejected", "Blended"],
  "Passed":             ["Partially Packaged", "Packaged", "Blended"],
  "Partially Packaged": ["Partially Packaged", "Packaged"],
  "Rejected":           [],
  "Packaged":           [],
  "Blended":            [],
};

export function isValidTransition(from: string, to: string): boolean {
  return (VALID_TRANSITIONS[from] ?? []).includes(to);
}
