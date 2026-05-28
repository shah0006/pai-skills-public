// Tools/EmailTypes.ts — email-type taxonomy shared types + pure classification.
//
// AD-1: the taxonomy itself lives in the `email_types` DB table (read via
// getEmailTypes in Db.ts). This module holds only the parts that must be
// importable from BOTH the bun/server side AND the web client bundle — so it
// deliberately has NO `bun:sqlite` import. classifyEmailType is pure: the
// caller supplies the types array (fetched once via getEmailTypes or the
// /api/email-types route) and reuses it per email.

export interface EmailType {
  id: number;
  name: string;
  /** Case-insensitive regex source string. */
  detection: string;
  /** 'combined' = test subject + body; 'subject' = test subject only. */
  matchScope: "combined" | "subject";
  /** AI Summary Rubric Part 2 must-surface fields for this type. */
  mustSurface: string | null;
  enabled: boolean;
  sortOrder: number;
  source: string;
}

/**
 * Classify an email into a type name using a supplied taxonomy.
 * Runs each type's detection regex in array order (the caller passes types
 * already sorted by sort_order); first match wins. Returns null when nothing
 * matches. A malformed user-supplied regex is skipped, never thrown — a bad
 * row in the Settings editor must not break classification for every email.
 */
export function classifyEmailType(
  types: EmailType[],
  subject: string,
  body: string,
): string | null {
  const combined = `${subject}\n${body}`;
  for (const t of types) {
    const haystack = t.matchScope === "subject" ? subject : combined;
    let re: RegExp;
    try {
      re = new RegExp(t.detection, "i");
    } catch {
      continue;
    }
    if (re.test(haystack)) return t.name;
  }
  return null;
}
