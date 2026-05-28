// Tools/SenderMemory.ts — Phase 22 v0 (sender memory).
//
// Read-only aggregation of historical user-decisions per sender / domain,
// sourced from the existing `domain_activity` table. Pure SQL; no LLM calls.
//
// Consumers (web/app/api/sender/[address]/history) surface this into the UI
// so the AiInsightPanel can show "you've archived 23 of 25 emails from this
// sender" instead of treating each email as if seen for the first time.
//
// The action codes match the markdown action codes used in triage notes:
//   A=archive  T=trash  R=reply  D=defer  K=keep  J=junk  U=unsub  BL=block  AP=approve
//
// Sparse data is OK — totalSeen=0 means "no history, treat as first-time
// sender" which is itself a useful signal for the UI.

import type { Database } from "bun:sqlite";

export interface ActionCounts {
  archive: number;
  trash:   number;
  reply:   number;
  defer:   number;
  keep:    number;
  junk:    number;
  unsub:   number;
  block:   number;
  approve: number;
  other:   number;
}

export interface SenderHistory {
  address?: string;
  domain?: string;
  totalSeen: number;
  actions: ActionCounts;
  /** Most-frequent action across totalSeen rows; null when totalSeen === 0. */
  mostCommonAction: keyof ActionCounts | null;
  firstSeen: string | null;
  lastSeen: string | null;
  /** Convenience: totalSeen >= 5 → "frequent" sender (heuristic; tune later). */
  isFrequent: boolean;
  /**
   * Suggestion the UI can render: "archived 23 of last 25 → suggest auto-archive
   * rule". Returns null when totalSeen < 5 or no single action dominates >= 80%.
   */
  suggestion: { kind: "auto-archive" | "auto-trash" | "auto-unsub" | "block"; confidencePct: number } | null;
  /**
   * Phase 22 v1: reply affinity. 0..1 score = replies / (replies + archives +
   * trashes + keeps). Surface in the UI as "📨 You usually reply" badge when
   * affinity >= 0.5 AND replies >= 3. Helps catch should-be-VIP senders that
   * aren't explicitly on the VIP list yet.
   */
  replyAffinity: number;
  /** True when affinity warrants the "📨 You usually reply" hint. */
  isReplyAffinity: boolean;
}

function emptyCounts(): ActionCounts {
  return { archive: 0, trash: 0, reply: 0, defer: 0, keep: 0, junk: 0, unsub: 0, block: 0, approve: 0, other: 0 };
}

function codeToBucket(code: string): keyof ActionCounts {
  switch (code.toUpperCase()) {
    case "A":  return "archive";
    case "T":  return "trash";
    case "R":  return "reply";
    case "D":  return "defer";
    case "K":  return "keep";
    case "J":  return "junk";
    case "U":  return "unsub";
    case "BL": return "block";
    case "AP": return "approve";
    default:   return "other";
  }
}

function suggestionFor(counts: ActionCounts, total: number): SenderHistory["suggestion"] {
  if (total < 5) return null;
  const entries = (Object.entries(counts) as Array<[keyof ActionCounts, number]>)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return null;
  const [topBucket, topCount] = entries[0];
  const pct = (topCount / total) * 100;
  if (pct < 80) return null;
  if (topBucket === "archive") return { kind: "auto-archive", confidencePct: pct };
  if (topBucket === "trash")   return { kind: "auto-trash",   confidencePct: pct };
  if (topBucket === "unsub")   return { kind: "auto-unsub",   confidencePct: pct };
  if (topBucket === "junk" || topBucket === "block") return { kind: "block", confidencePct: pct };
  return null;
}

function mostCommonOf(counts: ActionCounts): keyof ActionCounts | null {
  const entries = (Object.entries(counts) as Array<[keyof ActionCounts, number]>).filter(([, n]) => n > 0);
  if (entries.length === 0) return null;
  entries.sort((a, b) => b[1] - a[1]);
  return entries[0][0];
}

function aggregate(rows: Array<{ action_taken: string | null; triage_date: string }>, key: { address?: string; domain?: string }): SenderHistory {
  const counts = emptyCounts();
  let firstSeen: string | null = null;
  let lastSeen: string | null = null;

  for (const r of rows) {
    if (r.action_taken) counts[codeToBucket(r.action_taken)]++;
    if (!firstSeen || r.triage_date < firstSeen) firstSeen = r.triage_date;
    if (!lastSeen  || r.triage_date > lastSeen)  lastSeen  = r.triage_date;
  }

  const decisionTotal = counts.reply + counts.archive + counts.trash + counts.keep;
  const replyAffinity = decisionTotal > 0 ? counts.reply / decisionTotal : 0;
  const isReplyAffinity = replyAffinity >= 0.5 && counts.reply >= 3;

  return {
    ...key,
    totalSeen: rows.length,
    actions: counts,
    mostCommonAction: mostCommonOf(counts),
    firstSeen, lastSeen,
    isFrequent: rows.length >= 5,
    suggestion: suggestionFor(counts, rows.length),
    replyAffinity,
    isReplyAffinity,
  };
}

/** History keyed by exact email address (case-insensitive). */
export function getSenderHistory(db: Database, address: string): SenderHistory {
  const rows = db.prepare(
    "SELECT action_taken, triage_date FROM domain_activity WHERE LOWER(address) = LOWER(?)"
  ).all(address) as Array<{ action_taken: string | null; triage_date: string }>;
  return aggregate(rows, { address });
}

/** History keyed by domain (case-insensitive). */
export function getDomainHistory(db: Database, domain: string): SenderHistory {
  const rows = db.prepare(
    "SELECT action_taken, triage_date FROM domain_activity WHERE LOWER(domain) = LOWER(?)"
  ).all(domain) as Array<{ action_taken: string | null; triage_date: string }>;
  return aggregate(rows, { domain });
}
