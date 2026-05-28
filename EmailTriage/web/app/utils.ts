// Pure utility functions for the triage UI

import type { EmailPriority } from "../../Tools/Types";

/**
 * Returns the CSS color variable for a given email priority.
 */
export function priorityColor(priority: EmailPriority): string {
  switch (priority) {
    case "action":
      return "var(--warning)";
    case "review":
      return "var(--accent)";
    case "trash":
      return "var(--danger)";
    case "unsub":
      return "var(--danger)";
    case "archive":
      return "var(--muted)";
    case "unknown":
      return "var(--muted)";
    default:
      return "var(--muted)";
  }
}

/**
 * Truncates a string to maxLen characters, appending ellipsis if truncated.
 */
export function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen).trimEnd() + "\u2026";
}

/**
 * Extracts the display name from a "Name <email>" string.
 * Falls back to the full string if no angle-bracket pattern found.
 */
export function extractSenderName(from: string): string {
  const match = from.match(/^(.+?)\s*<[^>]+>$/);
  if (match) return match[1].trim();
  return from;
}

/**
 * UX-3 (Phase 27.3) heuristic — does the subject line already convey the full
 * ask, making an AI summary redundant?
 *
 * This is one of the three AND-conditions gating AI-summary auto-generation.
 * It is deliberately conservative: a false negative just costs one cheap Haiku
 * call, while a false positive robs the reader of a useful summary. So it only
 * returns true in the clear case — a long, self-contained subject that already
 * carries the concrete specifics (a date or a time), typical of appointment and
 * notification emails whose body is boilerplate.
 */
export function subjectConveysFullAsk(subject: string, body: string): boolean {
  const s = subject.trim();
  if (s.length < 60) return false; // short subjects rarely carry the whole ask

  const hasDate = /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{1,2}|\b\d{1,2}\/\d{1,2}|\b(?:mon|tue|wed|thu|fri|sat|sun)\w*day\b/i.test(s);
  const hasTime = /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i.test(s);
  if (!hasDate && !hasTime) return false;

  // If the body is substantially longer than the subject it probably adds
  // detail worth summarizing — don't skip.
  const bodyWords = body.trim().split(/\s+/).filter(Boolean).length;
  const subjectWords = s.split(/\s+/).filter(Boolean).length;
  return bodyWords <= subjectWords * 4;
}

/**
 * Maps an action code letter to its full action label.
 */
export function actionLabel(code: string): string {
  const labels: Record<string, string> = {
    A: "Archive",
    T: "Trash",
    R: "Reply",
    D: "Defer",
    U: "Unsub",
    K: "Keep",
    J: "Junk",
    BL: "Block",
    AP: "Approve",
    BD: "Block Domain",
    BS: "Block Sender",
    FU: "Follow-up",
  };
  return labels[code] ?? code;
}

/**
 * Formats a date string relative to now for email list display.
 * Same-day: "2h", "45m" | This week: "Mon", "Tue" | Older: "Feb 19"
 * Input: apple-mail date string like "Mar 1" or "Feb 19" or ISO-like string.
 */
export function formatRelativeDate(dateStr: string): string {
  if (!dateStr) return "";

  const now = new Date();
  const currentYear = now.getFullYear();
  let parsed: Date | null = null;

  // Normalize Apple Mail long format: "Sunday, March 1, 2026 at 12:04 PM"
  // Strip weekday prefix and "at HH:MM AM/PM" suffix, then parse
  let normalized = dateStr
    .replace(/^[A-Za-z]+,\s*/, "")          // strip leading "Sunday, "
    .replace(/\s+at\s+\d+:\d+\s*[AP]M/i, "") // strip " at 12:04 PM"
    .trim();

  // Try normalized string first
  const attempt1 = new Date(normalized);
  if (!isNaN(attempt1.getTime())) {
    parsed = attempt1;
  } else {
    // Try appending current year for short formats like "Mar 1"
    const attempt2 = new Date(`${normalized}, ${currentYear}`);
    if (!isNaN(attempt2.getTime())) {
      parsed = attempt2;
    } else {
      // Last resort: try original string
      const attempt3 = new Date(dateStr);
      if (!isNaN(attempt3.getTime())) parsed = attempt3;
    }
  }

  if (!parsed) return dateStr.slice(0, 6); // truncate unrecognized formats

  // Clamp to >= 0 — future-dated emails (drafts, scheduled sends, fixtures)
  // would otherwise render negative minutes.
  const diffMs = Math.max(0, now.getTime() - parsed.getTime());
  const diffMin = Math.floor(diffMs / 60_000);
  const diffHr = Math.floor(diffMs / 3_600_000);
  const diffDay = Math.floor(diffMs / 86_400_000);

  if (diffMin < 60) return `${diffMin}m`;
  if (diffHr < 24) return `${diffHr}h`;
  if (diffDay < 7) {
    return parsed.toLocaleDateString("en-US", { weekday: "short" });
  }
  return parsed.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// ─── Prompt injection detection (client-side pre-scan) ───

/**
 * Client-side injection pattern check — same patterns as server but run
 * on the snippet/body before displaying the injection warning badge.
 * This is a best-effort UI hint; the server does the authoritative check.
 */
const CLIENT_INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?(previous|above|prior|earlier)\s+instructions?/i,
  /disregard\s+(all\s+)?(previous|above|prior|earlier)/i,
  /new\s+instruction[s:]|updated?\s+instruction[s:]/i,
  /system\s*prompt|system\s*message/i,
  /you\s+are\s+now\s+(a|an)\s+/i,
  /act\s+as\s+(a|an)\s+/i,
  /output\s+(only|exactly|the\s+following)/i,
  /instead\s*(,\s*)?(reply|send|forward|email|output)/i,
  /you\s+must\s+(immediately|now)\s+(send|reply|forward)/i,
];

/** Returns true if the text contains patterns associated with prompt injection. */
export function hasInjectionContent(text: string): boolean {
  return CLIENT_INJECTION_PATTERNS.some((p) => p.test(text));
}

// ─── Suspicious sender detection ───

/**
 * Brand keywords mapped to their legitimate sending domain patterns.
 * If a display name contains a brand but the actual domain doesn't match → suspicious.
 */
const BRAND_DOMAIN_MAP: Array<[string, RegExp]> = [
  ["usps",        /(^|\.)usps\.(com|gov)$/i],
  ["paypal",      /(^|\.)paypal\.com$/i],
  ["capital one", /(^|\.)capitalone\.com$/i],
  ["amazon",      /(^|\.)amazon\.(com|co\.\w+)$/i],
  ["apple",       /(^|\.)apple\.com$|(^|\.)icloud\.com$/i],
  ["microsoft",   /(^|\.)microsoft\.com$|(^|\.)outlook\.com$|(^|\.)live\.com$/i],
  ["google",      /(^|\.)google\.com$|(^|\.)gmail\.com$/i],
  ["linkedin",    /(^|\.)linkedin\.com$/i],
  ["zoom",        /(^|\.)zoom\.us$/i],
  ["citi",        /(^|\.)citi(bank|group)?\.com$/i],
  ["irs",         /(^|\.)irs\.gov$/i],
  ["chase",       /(^|\.)chase\.com$/i],
  ["wellsfargo",  /(^|\.)wellsfargo\.com$/i],
  ["fedex",       /(^|\.)fedex\.com$/i],
  ["ups",         /(^|\.)ups\.com$/i],
];

/** Returns true if the sender appears to impersonate a known brand from an unexpected domain. */
export function isSuspiciousSender(from: string): boolean {
  const emailMatch = from.match(/<([^>]+)>/) ?? from.match(/(\S+@\S+)/);
  if (!emailMatch) return false;
  const email = (emailMatch[1] ?? emailMatch[0]).toLowerCase();
  const domain = email.split("@")[1] ?? "";
  // Display name is everything before the < or the full string if no angle brackets
  const displayName = (from.split("<")[0] ?? from).toLowerCase();
  for (const [brand, domainPattern] of BRAND_DOMAIN_MAP) {
    if (displayName.includes(brand) && !domainPattern.test(domain)) return true;
  }
  return false;
}

/**
 * Formats a date string for display in the header.
 * Input: "2026-03-01" → "March 1, 2026"
 */
export function formatHeaderDate(dateStr: string): string {
  const [year, month, day] = dateStr.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return date.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}
