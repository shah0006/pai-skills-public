// Tools/CrossAccountThreads.ts — Phase 24: cross-account thread merging v0.
//
// Identifies email "threads" that span Gmail + iCloud. Both clients store
// the same conversation as separate emails — this tool finds the matches so
// the user sees them as a single thread instead of duplicate items.
//
// v0 matching strategy (subject-based — fast, no header fetch needed):
//   1. Normalize subjects: strip 'Re:' / 'Fwd:' / whitespace
//   2. Group emails by (normalized_subject) when the group spans >= 2 accounts
//
// v1 would join on RFC822 Message-ID / References / In-Reply-To headers
// (more accurate but requires fetching message bodies for each candidate).
// v0 is the cheap pass that catches the majority of cases.

export interface ThreadEmail {
  emailId: string;
  account: string;  // 'g', 'i', etc.
  subject: string;
  fromAddress: string;
  date: string;
  /** Phase 24 v1: RFC822 Message-ID (or URL-decoded form from a `message://`
   *  link). When present + matching across accounts, this trumps subject-based
   *  matching as ground-truth thread membership. */
  messageId?: string;
}

export interface CrossAccountThread {
  normalizedSubject: string;
  emails: ThreadEmail[];
  accountsTouched: string[];
}

/**
 * Strip thread-prefix noise from a subject so 'Re: Re: Q3 review' matches
 * 'Q3 review' and 'FW: Q3 review'. Also collapses internal whitespace.
 */
export function normalizeSubject(subject: string): string {
  return subject
    .replace(/^(\s*(?:re|fwd?|fw)\s*:\s*)+/i, "")   // strip prefix chains
    .replace(/\[ext(?:ernal)?\]\s*/i, "")            // common '[EXTERNAL]' tag
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function findCrossAccountThreads(emails: ThreadEmail[]): CrossAccountThread[] {
  // Phase 24 v1 layered matching:
  // - Layer 1 (strong): join on Message-ID when present. Same Message-ID
  //   across accounts = ground-truth same conversation (forwarded mail,
  //   mailing list archives, calendar invites cc'd to both accounts).
  // - Layer 2 (weaker, fallback): subject-based join for emails the v1
  //   layer didn't match.
  const claimed = new Set<string>();
  const threads: CrossAccountThread[] = [];

  // ── Layer 1: Message-ID join
  const byMsgId = new Map<string, ThreadEmail[]>();
  for (const email of emails) {
    if (!email.messageId?.trim()) continue;
    const key = email.messageId.trim().toLowerCase();
    const list = byMsgId.get(key) ?? [];
    list.push(email);
    byMsgId.set(key, list);
  }
  for (const [_msgId, list] of byMsgId) {
    const accountsTouched = Array.from(new Set(list.map(e => e.account)));
    if (accountsTouched.length < 2 || list.length < 2) continue;
    list.sort((a, b) => a.date.localeCompare(b.date));
    const normalizedSubject = normalizeSubject(list[0].subject);
    threads.push({ normalizedSubject, emails: list, accountsTouched: accountsTouched.sort() });
    for (const e of list) claimed.add(e.emailId);
  }

  // ── Layer 2: subject join (only for emails not already in a layer-1 thread)
  const bySubject = new Map<string, ThreadEmail[]>();
  for (const email of emails) {
    if (claimed.has(email.emailId)) continue;
    if (!email.subject?.trim()) continue;
    const key = normalizeSubject(email.subject);
    if (key.length < 4) continue;
    const list = bySubject.get(key) ?? [];
    list.push(email);
    bySubject.set(key, list);
  }
  for (const [key, list] of bySubject) {
    const accountsTouched = Array.from(new Set(list.map(e => e.account)));
    if (accountsTouched.length < 2 || list.length < 2) continue;
    list.sort((a, b) => a.date.localeCompare(b.date));
    threads.push({ normalizedSubject: key, emails: list, accountsTouched: accountsTouched.sort() });
  }

  // Sort: largest thread first
  threads.sort((a, b) => b.emails.length - a.emails.length);
  return threads;
}
