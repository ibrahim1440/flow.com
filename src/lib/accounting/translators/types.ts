import type { EngineLine } from "../posting";

export type Translation =
  | { skip: string }
  | {
      skip?: undefined;
      entryDate: Date;
      description: string;
      sourceModule: string;
      sourceDocumentId: string;
      lines: EngineLine[];
      /** Anything besides the policy itself that must be approved before this posts. */
      alsoUnapproved: string[];
    };
