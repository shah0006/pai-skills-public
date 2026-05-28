// ~/.claude/skills/EmailTriage/Tools/GenerateTriage.ts
// Usage: bun run Tools/GenerateTriage.ts [--test] [--date YYYY-MM-DD] [--account <alias>] [--force] [--all]
// Fetches emails, classifies with rules + AI, sorts to per-account staging folders, outputs triage note

import { join } from "path";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "fs";
import { execSync, spawnSync } from "child_process";
import type { RawEmail, ClassifiedEmail, TriageSession, FunnelStage, TriageNoteState, BodyInclusion } from "./Types";
import { STAGE_FOLDER_NAMES, FOLDER_STAGE_MAP, getStageFolderPath, resolveAccountAlias } from "./Types";
import type { AccountAlias } from "./Types";
import { classifyEmail } from "./RulesEngine";
import type { ClassificationCache } from "./RulesEngine";
import { parseEmailList, parseInboxTotal } from "./EmailParser";
import { transportFor, GwsGmailTransport } from "./Transport";
import { formatTriageNote, formatDatetime, formatEmailBlock, formatFinancialRow, formatInformationalRow, formatBulkDisposeRow, formatAutoProcessedRow, formatCompactRow, formatCheckboxItem, FINANCIAL_TABLE_HEADER, INFORMATIONAL_TABLE_HEADER, BULK_DISPOSE_TABLE_HEADER, AUTO_PROCESSED_TABLE_HEADER, COMPACT_TABLE_HEADER } from "./TriageFormatter";
import { initDb, runMigration, getKnownSenders, getVipSenders, getJunkSenders, getRoutingRules, recordTriageSession, getOverdueFollowUps, resolveFollowUp, addKnownSender, setReferenceHook } from "./Db";
import { detectUrgentEmails, sendUrgentAlert } from "./AlertSender";
import { runPreCronAuthCheck } from "./PreCronAuthCheck";
import { injectBannerAfterFrontmatter, stripOperationalBanners } from "./Banner";
import { regenerateReference, flushPendingReferences } from "./ReferenceGenerator";
import { batchClassifyEmails, generateContextForEmails, buildReplyDraftPrompt } from "./AiClassifier";
import { sampleRawEmails } from "../tests/fixtures/sample-emails";

// Load API keys from web/.env.local if not already in environment
// (CLI invocation doesn't load Next.js env files automatically)
if (!process.env.ANTHROPIC_API_KEY) {
  try {
    // import.meta.dir is now Tools/, so go up one level to skill root
    const skillRoot = import.meta.dir
      ? join(import.meta.dir, "..")
      : join((process.env.HOME ?? (() => { throw new Error("HOME env var not set"); })()), ".claude/skills/EmailTriage");
    const envPath = join(skillRoot, "web", ".env.local");
    const envContent = readFileSync(envPath, "utf-8");
    for (const line of envContent.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx);
        const val = trimmed.slice(eqIdx + 1);
        if (!process.env[key]) process.env[key] = val;
      }
    }
  } catch { /* .env.local not found — AI features will be unavailable */ }
}

// ─── Email body fetching ───

/** Fetch full email bodies for given IDs (parallel, 3 at a time).
 *  Routes per-id by account alias: "g" goes through GwsGmailTransport; everything else
 *  shells out to apple-mail.sh exactly as before. iCloud path is byte-identical to pre-Phase-1. */
async function fetchEmailBodies(
  ids: string[],
  mailboxMap?: Map<string, string>,
  accountMap?: Map<string, AccountAlias>,
): Promise<Map<string, string>> {
  const bodies = new Map<string, string>();
  if (ids.length === 0) return bodies;
  const gwsTransport = new GwsGmailTransport();

  // Fetch in batches of 3 to avoid overwhelming Mail.app
  const BATCH_SIZE = 3;
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batch = ids.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (id) => {
        const account = accountMap?.get(id);
        if (account === "g") {
          try {
            const { body } = await gwsTransport.read(id);
            // Restore unread state to match the pre-cutover behavior on iCloud (read-then-restore).
            try { await gwsTransport.markRead(id, false); } catch { /* non-fatal */ }
            return { id, body: body.trim() };
          } catch {
            return { id, body: "" };
          }
        }
        try {
          const mailbox = mailboxMap?.get(id);
          const args = ["bash", APPLE_MAIL_SH, "read", id];
          if (mailbox) args.push("--mailbox", mailbox);

          const proc = Bun.spawn(args, {
            stdout: "pipe",
            stderr: "pipe",
          });
          const output = await new Response(proc.stdout).text();
          await proc.exited;

          // Skip error outputs (e.g., "Error: Email ID not found")
          if (output.startsWith("Error:")) return { id, body: "" };

          // Strip header block (everything before the second "===")
          const headerEnd = output.indexOf("===\n", output.indexOf("===\n") + 4);
          const body = headerEnd >= 0 ? output.slice(headerEnd + 4).trim() : output.trim();

          // Restore unread state
          try {
            Bun.spawnSync(["bash", APPLE_MAIL_SH, "mark-unread", id]);
          } catch { /* non-fatal */ }

          return { id, body };
        } catch {
          return { id, body: "" };
        }
      }),
    );
    for (const { id, body } of results) {
      if (body) bodies.set(id, body);
    }
  }
  return bodies;
}

// ─── Body inclusion classification ───

/** Suspicious content patterns (prompt injection, malicious payloads) */
const SUSPICIOUS_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /you\s+are\s+now\s+a?\s*(new|different)\s*(ai|assistant|model)/i,
  /system\s*prompt/i,
  /\[INST\]|\[\/INST\]|<\|im_start\|>/i,
  /act\s+as\s+(a\s+)?(different|new)\s*(ai|assistant)/i,
  /disregard\s+(all\s+)?(prior|previous|above)/i,
  /you\s+must\s+(immediately|now)\s+(send|reply|forward)/i,
];

/** Classify how a body should be rendered in the triage note.
 *  Uses both line count and character count since email bodies from
 *  Apple Mail often have few newlines even for long content. */
function classifyBodyInclusion(body: string): { inclusion: BodyInclusion; rendered: string } {
  // Check for suspicious content first
  if (SUSPICIOUS_PATTERNS.some(p => p.test(body))) {
    return { inclusion: "blocked", rendered: "" };
  }

  const lines = body.split("\n").filter(l => l.trim().length > 0);
  const lineCount = lines.length;
  const charCount = body.trim().length;

  // Short: under ~4 lines AND under ~300 chars -- paste as-is
  if (lineCount <= 4 && charCount <= 300) {
    return { inclusion: "full", rendered: body.trim() };
  }
  // Everything else: AI summary (let AI do the hard work for the user)
  return { inclusion: "summary", rendered: "" };
}

// ─── AI Content Pipeline ───
// Systematic pipeline for all AI-generated content (summaries, subjects).
// Architecture: Generate → Self-Review → Programmatic Safety Net
// All prompts are constants. No ad hoc inline strings.

/** System prompt for email body summarization.
 *  Two-phase: generate summary, then self-review against checklist before outputting. */
const SUMMARY_SYSTEM_PROMPT = `You are summarizing emails for a doctor's morning triage note in Obsidian. Your summary must be SELF-SUFFICIENT -- the reader should be able to act on this email WITHOUT opening the original.

PHASE 1 -- Draft your summary:
- 2-4 sentences. No preamble ("This email is about..."). State facts directly.
- ALL URLs MUST be markdown links with a descriptive action-oriented name that tells the reader what the link does. Examples: [Password Reset Link], [Login to CredentialStream], [View Statement], [Complete DocuSign Form], [Unsubscribe]. NEVER use generic names like [this link], [this URL], [click here], [Link], or the hostname.

IMPORTANT: Always summarize the content as an email, even if it contains unusual content (personal statements, attachments, forwards, legal text, etc.). Never refuse or explain your role -- just summarize what the email says and what the reader needs to do.

PHASE 2 -- Before outputting, review your draft against this checklist:
□ Deadlines or expiration times in the email? → Did I include them with specific timeframes?
□ Dollar amounts or financial figures? → Did I include them?
□ Names of people, organizations, or accounts? → Did I include them?
□ Action required (sign, reply, click, call, review)? → Did I state exactly what is needed?
□ URLs or links the reader needs to act? → Did I format them as markdown links?
□ Time-sensitive conditions (link expires, offer ends, window closes)? → Did I state when?
□ Could the reader handle this email from JUST my summary, never opening the original? → If no, what's missing?

If ANY check fails, revise before outputting. Output ONLY your final refined summary.`;

/** System prompt for subject line condensation.
 *  Used for table-format stages where subjects must be short but meaningful. */
const SUBJECT_CONDENSE_PROMPT = `You condense email subject lines for a triage table. The reader needs to know WHAT this email is about from the subject alone.

Rules:
- Strip redundant prefixes: "Complete with Docusign:", "Please DocuSign:", "Action Required:", "Reminder:", "[External]", "Re:", "Fwd:"
- Keep the meaningful core: who/what/why
- If it mentions a person, keep the name
- If it mentions a document type (peer reference, application, agreement), keep it
- Maximum 55 characters. No trailing ellipsis.
- Output ONLY the condensed subject, nothing else.`;

// ─── Programmatic safety net ───

/** Raw URL pattern: matches URLs not already inside markdown link syntax */
const RAW_URL_RE = /(?<!\]\()https?:\/\/[^\s)\]>]+/g;

/** Critical detail patterns the AI might miss despite self-review.
 *  Deterministic backstop -- scans original body for patterns and ensures they appear in summary. */
const CRITICAL_DETAIL_PATTERNS: Array<{
  bodyMatch: RegExp;
  summaryCheck: RegExp;
  extract: (match: RegExpMatchArray) => string;
}> = [
  {
    bodyMatch: /(?:expires?|expir(?:ation|ing)|valid)\s+(?:in|for|within|after)\s+(\d+)\s*(hours?|days?|minutes?|hrs?)/i,
    summaryCheck: /expir|valid\s+for|within\s+\d/i,
    extract: (m) => `Link expires in ${m[1]} ${m[2].toLowerCase()}.`,
  },
  {
    bodyMatch: /(?:must|need to|required to|please)\s+.*?within\s+(\d+)\s*(hours?|days?|business days?)/i,
    summaryCheck: /within\s+\d/i,
    extract: (m) => `Must be completed within ${m[1]} ${m[2].toLowerCase()}.`,
  },
  {
    bodyMatch: /(?:deadline|due\s+(?:by|date|on)|must\s+(?:be\s+)?(?:completed?|submitted?|returned?)\s+by)\s*:?\s*([A-Z][a-z]+\s+\d{1,2}(?:,?\s+\d{4})?|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)/i,
    summaryCheck: /deadline|due\s+by|due\s+date/i,
    extract: (m) => `Deadline: ${m[1]}.`,
  },
];

/** Programmatic backstop: append critical details the AI missed despite self-review. */
function ensureCriticalDetails(summary: string, originalBody: string): string {
  const missing: string[] = [];
  for (const pattern of CRITICAL_DETAIL_PATTERNS) {
    const bodyHit = originalBody.match(pattern.bodyMatch);
    if (bodyHit && !pattern.summaryCheck.test(summary)) {
      missing.push(pattern.extract(bodyHit));
    }
  }
  if (missing.length === 0) return summary;
  return summary.replace(/\.?\s*$/, ". ") + missing.join(" ");
}

/** Match markdown links: [text](url) -- used to protect them from truncation and double-wrapping. */
const MARKDOWN_LINK_RE = /\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g;

/** Programmatic formatting cleanup applied after all AI processing.
 *  Fixes raw URLs, strips preamble, caps length, cleans markdown artifacts. */
function cleanSummaryFormatting(raw: string, originalBody?: string): string {
  let s = raw.trim();

  // 1. Strip preamble prefixes
  s = s.replace(/^\*?\*?(Summary|Here'?s? (?:a |the )?summary|TL;?DR|Key (?:points?|takeaways?)):?\*?\*?\s*/i, "").trim();

  // 2. Convert raw URLs to markdown links.
  //    First, collect positions of existing markdown links to avoid double-wrapping.
  const protectedRanges: Array<[number, number]> = [];
  let m: RegExpExecArray | null;
  const linkRe = new RegExp(MARKDOWN_LINK_RE.source, "g");
  while ((m = linkRe.exec(s)) !== null) {
    protectedRanges.push([m.index, m.index + m[0].length]);
  }
  // Only wrap URLs that aren't inside an existing markdown link.
  // Use descriptive labels derived from URL path/hostname, never generic "[Link]" or hostname alone.
  s = s.replace(RAW_URL_RE, (url, offset: number) => {
    if (protectedRanges.some(([start, end]) => offset >= start && offset < end)) return url;
    try {
      const parsed = new URL(url);
      const hostname = parsed.hostname.replace(/^www\./, "");
      const path = parsed.pathname.replace(/\/$/, "");
      // Derive descriptive label from URL structure
      if (/resetpassword|reset-password|password.*reset/i.test(path)) return `[Password Reset Link](${url})`;
      if (/login|signin|sign-in|userlogin/i.test(path)) return `[Login Page](${url})`;
      if (/unsubscribe/i.test(path)) return `[Unsubscribe](${url})`;
      if (/docusign|signing/i.test(path) || /docusign/i.test(hostname)) return `[DocuSign Document](${url})`;
      if (/statement|stmt/i.test(path)) return `[View Statement](${url})`;
      if (/invoice/i.test(path)) return `[View Invoice](${url})`;
      if (/receipt|order/i.test(path)) return `[View Receipt](${url})`;
      if (/confirm|verify|activate/i.test(path)) return `[Confirm Account](${url})`;
      // Fallback: use hostname as the service name
      const serviceName = hostname.split(".").slice(0, -1).join(".") || hostname;
      return `[${serviceName}](${url})`;
    } catch {
      return `[External Link](${url})`;
    }
  });

  // 3. Fix generic link labels the AI might have used despite instructions.
  //    Replace [this link], [this URL], [click here], [Link], [here], or bare hostname labels
  //    with descriptive action-oriented labels derived from the URL.
  s = s.replace(/\[(this\s+(?:link|url)|click\s+here|here|link|https?:\/\/[^\]]+)\]\((https?:\/\/[^)]+)\)/gi, (_match, _label, url) => {
    try {
      const parsed = new URL(url);
      const path = parsed.pathname.replace(/\/$/, "");
      if (/resetpassword|reset-password|password.*reset/i.test(path)) return `[Password Reset Link](${url})`;
      if (/login|signin|sign-in|userlogin/i.test(path)) return `[Login Page](${url})`;
      if (/unsubscribe/i.test(path)) return `[Unsubscribe](${url})`;
      if (/docusign|signing/i.test(path) || /docusign/i.test(parsed.hostname)) return `[DocuSign Document](${url})`;
      if (/statement|stmt/i.test(path)) return `[View Statement](${url})`;
      if (/confirm|verify|activate/i.test(path)) return `[Confirm Account](${url})`;
      const hostname = parsed.hostname.replace(/^www\./, "");
      const serviceName = hostname.split(".").slice(0, -1).join(".") || hostname;
      return `[${serviceName}](${url})`;
    } catch {
      return `[External Link](${url})`;
    }
  });

  // 4. Deterministic completeness check
  if (originalBody) {
    s = ensureCriticalDetails(s, originalBody);
  }

  // 4. Collapse to single line
  s = s.replace(/\n+/g, " ").replace(/\s{2,}/g, " ").trim();

  // 5. Cap length -- markdown-link-aware truncation.
  //    Never cut inside a [text](url) link; move cut before the link starts.
  if (s.length > 500) {
    let cut = s.lastIndexOf(".", 497);
    if (cut <= 200) cut = 497;
    // Check if cut falls inside a markdown link; if so, move before the link
    const linkPositions: Array<[number, number]> = [];
    const linkRe2 = new RegExp(MARKDOWN_LINK_RE.source, "g");
    while ((m = linkRe2.exec(s)) !== null) {
      linkPositions.push([m.index, m.index + m[0].length]);
    }
    for (const [start, end] of linkPositions) {
      if (cut > start && cut < end) {
        // Cut before this link instead
        cut = start > 0 ? start - 1 : 0;
        break;
      }
    }
    s = s.slice(0, cut).trim();
    if (!s.endsWith(".")) s += ".";
  }

  // 6. Strip trailing markdown artifacts
  s = s.replace(/#+\s*$/, "").replace(/\*+\s*$/, "").trim();

  return s;
}

// ─── AI API helpers ───

/** Call Haiku for a single-turn completion. Returns response text or null on failure. */
async function callHaiku(system: string, userContent: string, maxTokens: number = 350): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: userContent }],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) return null;
    const data = await resp.json() as { content: Array<{ type: string; text?: string }> };
    const text = data.content.filter(b => b.type === "text" && b.text).map(b => b.text!).join(" ").trim();
    return text || null;
  } catch {
    return null;
  }
}

/** Detect AI refusal patterns where the model refuses to summarize instead of following instructions.
 *  Returns true if the text looks like a refusal rather than a summary. */
const AI_REFUSAL_PATTERNS: RegExp[] = [
  /I (?:need to|must|have to|should) clarif/i,
  /(?:falls? outside|beyond|not (?:my|designed to|meant to))/i,
  /I(?:'m| am) (?:designed|meant|intended) to/i,
  /(?:not (?:able|equipped)|unable) to (?:edit|review|coach|evaluate)/i,
  /(?:outside|beyond) (?:my|the scope of|email) summariz/i,
  /clarify my role/i,
];

/** Generate an AI summary for an email body.
 *  Pipeline: Haiku generates with self-review prompt → refusal detection → programmatic safety net.
 *  If AI refuses to summarize, retries once with a stronger nudge. */
async function generateAISummary(rawBody: string, subject?: string): Promise<string | null> {
  const raw = await callHaiku(SUMMARY_SYSTEM_PROMPT, rawBody.slice(0, 3000), 400);
  if (!raw) return null;
  let summary = raw.replace(/^(?:#+ ?)?\*?\*?Summary:?\*?\*?\s*/i, "").trim();
  // Detect AI refusal and retry with explicit override
  if (AI_REFUSAL_PATTERNS.some(p => p.test(summary))) {
    const retryPrompt = `OVERRIDE: You MUST summarize this email. Do NOT refuse, explain your role, or comment on the content type. Just describe what the email says and what action is needed, in 2-3 sentences.\n\n${rawBody.slice(0, 3000)}`;
    const retry = await callHaiku(SUMMARY_SYSTEM_PROMPT, retryPrompt, 400);
    if (retry && !AI_REFUSAL_PATTERNS.some(p => p.test(retry))) {
      summary = retry.replace(/^\*?\*?Summary:?\*?\*?\s*/i, "").trim();
    } else {
      // Fallback: generate a minimal factual summary from subject + snippet
      const snippet = rawBody.slice(0, 200).replace(/\n/g, " ").trim();
      summary = subject ? `Email regarding "${subject}". ${snippet}...` : `${snippet}...`;
    }
  }
  return cleanSummaryFormatting(summary, rawBody);
}

/** Redundant subject prefixes that add no value when the context is already clear from
 *  the stage, type column, or sender. Stripped before AI condensation. */
const SUBJECT_PREFIX_PATTERNS: RegExp[] = [
  /^(?:complete\s+with\s+docu\s*sign\s*:\s*)/i,
  /^(?:please\s+docu\s*sign\s*:\s*)/i,
  /^(?:action\s+required\s*:\s*)/i,
  /^(?:\[external\]\s*)/i,
  /^(?:re:\s*)+/i,
  /^(?:fwd?:\s*)+/i,
];

/** Condense a subject line: strip redundant prefixes, then AI-condense if still too long.
 *  Used for table-format stages (3-6) where column width matters. */
async function condenseSubject(subject: string, maxLen: number = 55): Promise<string> {
  let s = subject;
  for (const p of SUBJECT_PREFIX_PATTERNS) {
    s = s.replace(p, "").trim();
  }
  if (s.length <= maxLen) return s;
  // AI condensation for subjects still too long after prefix stripping
  const condensed = await callHaiku(SUBJECT_CONDENSE_PROMPT, `Original: "${s}"\nCondense to ≤${maxLen} characters.`, 80);
  if (condensed && condensed.length <= maxLen + 5) return condensed.slice(0, maxLen);
  // Fallback: truncate at word boundary
  const words = s.split(/\s+/);
  let result = "";
  for (const w of words) {
    if ((result + " " + w).trim().length > maxLen - 3) break;
    result = (result + " " + w).trim();
  }
  return result + "...";
}

// CONDENSE_BATCH_V1
/** Batch-condense subjects for all table-format emails (stages 3-6).
 *  Two passes: (1) strip redundant prefixes from ALL subjects, (2) one-shot
 *  AI-condense for all subjects still too long via a single Haiku call.
 *  Modifies email.subject in place. Run before formatting. */
async function condenseTableSubjects(emails: ClassifiedEmail[]): Promise<void> {
  const TABLE_STAGES: FunnelStage[] = ["financial", "informational", "bulk_dispose", "auto_processed"];
  const tableEmails = emails.filter(e => TABLE_STAGES.includes(e.funnelStage));

  // Pass 1: Strip redundant prefixes from ALL table subjects (no API call needed)
  for (const email of tableEmails) {
    for (const p of SUBJECT_PREFIX_PATTERNS) {
      email.subject = email.subject.replace(p, "").trim();
    }
  }

  // Pass 2: AI-condense subjects still over 55 chars after prefix stripping.
  // OLD: per-email Haiku call in batches of 5 (~14s for 100+ subjects).
  // NEW: one Haiku call for all long subjects, returning JSON array. If the
  //      batch call fails or produces an unparseable response, fall back to
  //      word-boundary truncation (no per-email API fallback to keep this fast).
  const MAX_LEN = 55;
  const needsCondensing = tableEmails.filter(e => e.subject.length > MAX_LEN);
  if (needsCondensing.length === 0) return;

  const items = needsCondensing.map((e, i) => ({ idx: i, subject: e.subject }));
  const prompt = `Condense each subject to <= ${MAX_LEN} characters while preserving meaning (sender/topic/action). Return ONLY a JSON array of objects with idx and condensed fields, no prose, no code fences. Example: [{"idx":0,"condensed":"..."}]\n\nSubjects:\n${JSON.stringify(items)}`;

  let parsed: Array<{ idx: number; condensed: string }> | null = null;
  try {
    const response = await callHaiku(SUBJECT_CONDENSE_PROMPT, prompt, Math.min(1024, items.length * 30 + 200));
    if (response) {
      // Strip code fences if present
      let cleaned = response.trim();
      cleaned = cleaned.replace(/^\`\`\`(?:json)?\s*\n?/m, "").replace(/\n?\`\`\`\s*$/m, "").trim();
      // Try to extract JSON array if wrapped in prose
      const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
      if (jsonMatch) cleaned = jsonMatch[0];
      const arr = JSON.parse(cleaned);
      if (Array.isArray(arr)) parsed = arr.filter((x: any) => typeof x.idx === "number" && typeof x.condensed === "string");
    }
  } catch { /* fall through to word-truncation fallback */ }

  for (let i = 0; i < needsCondensing.length; i++) {
    const email = needsCondensing[i];
    const match = parsed?.find(p => p.idx === i);
    if (match && match.condensed.length <= MAX_LEN + 5) {
      email.subject = match.condensed.slice(0, MAX_LEN);
      continue;
    }
    // Fallback: word-boundary truncation
    const words = email.subject.split(/\s+/);
    let result = "";
    for (const w of words) {
      if ((result + " " + w).trim().length > MAX_LEN - 3) break;
      result = (result + " " + w).trim();
    }
    email.subject = result + "...";
  }
}

// ─── Archive folder suggestion ───
// Per plan: "Archive To: mail folder path (e.g. i/Financial). Must match an existing folder."
// Suggestions are deterministic where possible, AI-assisted for ambiguous cases.

/** Archive folder mapping rules. Two types:
 *  - Mail folders: prefixed with account alias (i/, g/) at render time
 *  - Disk paths: start with ~/ or / -- used for financial documents that need disk filing
 *  Per plan line 262: "Mail folder paths start with account alias (i/, g/);
 *  disk paths start with ~/, /, or anything else." */
// ─── Valid archive mail folders ───
// Discovered from Apple Mail mailbox hierarchy (2026-04-05).
// Only suggest archive destinations that actually exist. Never auto-create folders.
// Update this registry if mail folders are added or renamed.
const VALID_MAIL_FOLDERS: Record<string, string[]> = {
  i: [
    "Personal/Financial", "Personal/Financial/Receipts",
    "Personal/Financial/Reimbursement", "Personal/Financial/DLAK",
    "Personal/Financial/Investments",
    "Personal/Disability", "Personal/Disability/Ameritas", "Personal/Disability/Berkshire",
    "Personal/SimplicityHealth",
    "Personal/Subscriptions",
    "Personal/Subscriptions/Alo", "Personal/Subscriptions/Amboss",
    "Personal/Subscriptions/BaleDoneen", "Personal/Subscriptions/BASB",
    "Personal/Subscriptions/Goldie", "Personal/Subscriptions/Keyboard Maestro",
    "Personal/Subscriptions/Kittleson", "Personal/Subscriptions/Medium",
    "Personal/Subscriptions/Michele Torti", "Personal/Subscriptions/Miessler",
    "Personal/Subscriptions/Mindvalley", "Personal/Subscriptions/Nate",
    "Personal/Subscriptions/News Society", "Personal/Subscriptions/NLA",
    "Personal/Subscriptions/Oberg", "Personal/Subscriptions/Obsidian",
    "Personal/Subscriptions/OpenAI", "Personal/Subscriptions/Ottomator",
    "Personal/Subscriptions/Productivity Game", "Personal/Subscriptions/Scispace",
    "Personal/Subscriptions/Sebastian", "Personal/Subscriptions/ShortForm",
    "Personal/Subscriptions/Stackskills", "Personal/Subscriptions/SystemSculpt",
    "Personal/Subscriptions/Windsurf", "Personal/Subscriptions/Yang",
    "Personal/Home", "Personal/Home/Family",
    "Work/Evicore", "Work/Job Search", "Work/Job Search/MRIOA", "Work/Kayur",
    "Blocked", "Later", "zzUnsubscribe",
  ],
  g: [
    "Personal/Financial", "Personal/Financial/Receipts",
    "Personal/Health", "Personal/Health/Simplicity Health",
    "Personal/Subscriptions", "Personal/Subscriptions/Cursor",
    "Work/Medical Education", "Work/Medical Education/NLA",
    "Blocked", "Later",
  ],
};

/** Check if a mail folder exists in the given account. Case-insensitive. */
function isValidMailFolder(acct: string, folderPath: string): boolean {
  const folders = VALID_MAIL_FOLDERS[acct];
  if (!folders) return false;
  return folders.some(f => f.toLowerCase() === folderPath.toLowerCase());
}

/** Resolve a short folder name (from routing rules DB) to a full valid mail folder path.
 *  e.g. "Amboss" → "Personal/Subscriptions/Amboss", "Yang" → "Personal/Subscriptions/Yang".
 *  Returns the full path (without account prefix) if a unique match is found, null otherwise. */
function resolveMailFolder(acct: string, shortName: string): string | null {
  const folders = VALID_MAIL_FOLDERS[acct];
  if (!folders) return null;
  const lower = shortName.toLowerCase();
  // Exact match first
  const exact = folders.find(f => f.toLowerCase() === lower);
  if (exact) return exact;
  // Suffix match: folder ends with /shortName
  const suffixMatches = folders.filter(f => f.toLowerCase().endsWith("/" + lower));
  if (suffixMatches.length === 1) return suffixMatches[0];
  return null;
}

// ─── Archive folder suggestion map ───
// Maps email metadata patterns to mail folder paths. Only non-financial items get
// folder suggestions; financial items use You column for document handling (per plan).
// Folder names must match entries in VALID_MAIL_FOLDERS above.
const ARCHIVE_FOLDER_MAP: Array<{ match: RegExp; field: "domain" | "subject"; folder: string }> = [
  // Medical education (exists in Gmail as Work/Medical Education)
  { match: /cme|continuing\s+medical|medical\s+education|echo\s+education/i, field: "subject", folder: "Work/Medical Education" },
  { match: /nla|national\s+lipid/i, field: "subject", folder: "Work/Medical Education/NLA" },
  { match: /webinar|course|conference|symposium/i, field: "subject", folder: "Work/Medical Education" },
  { match: /credentialing|privileges|peer\s+ref/i, field: "subject", folder: "Work/Job Search/MRIOA" },
  // Medical education domains
  { match: /mayoclinic\.org$/i, field: "domain", folder: "Work/Medical Education" },
  { match: /education\..*\.org$/i, field: "domain", folder: "Work/Medical Education" },
  { match: /\.edu$/i, field: "domain", folder: "Work/Medical Education" },
];

/** Suggest an archive mail folder based on email metadata.
 *  Only suggests folders that actually exist (validated against VALID_MAIL_FOLDERS).
 *  Financial emails get no folder suggestion -- they use the You column for document handling.
 *  Returns null if no valid folder exists for this email's account (→ default to Trash). */
function suggestArchiveFolder(email: ClassifiedEmail): string | null {
  const acct = email.account?.toLowerCase().startsWith("g") ? "g" : "i";
  // Check routing rule folder first (already set by rules engine)
  if (email.folder) return email.folder;
  // Financial emails: no archive folder -- processed via You column, then trashed (per plan)
  if (email.funnelStage === "financial") return null;
  // Try deterministic mapping, validate each match against actual folders
  for (const rule of ARCHIVE_FOLDER_MAP) {
    const value = rule.field === "domain" ? email.fromDomain : email.subject;
    if (rule.match.test(value)) {
      if (isValidMailFolder(acct, rule.folder)) {
        return `${acct}/${rule.folder}`;
      }
      // Folder doesn't exist in this account -- skip, don't suggest creating it
      continue;
    }
  }
  return null;
}

/** Apply archive folder suggestions to all emails that don't already have one.
 *  Also validates existing folders (from routing rules) against VALID_MAIL_FOLDERS.
 *  Run after classification and financial metadata extraction, before formatting. */
function applyArchiveFolderSuggestions(emails: ClassifiedEmail[]): void {
  for (const email of emails) {
    // Validate existing folder (may come from routing rules or DB)
    if (email.folder) {
      const acct = email.account?.toLowerCase().startsWith("g") ? "g" : "i";
      const folderPath = email.folder.replace(/^[ig]\//, "");
      if (!isValidMailFolder(acct, folderPath)) {
        // Try resolving short DB name to full mail folder path
        const resolved = resolveMailFolder(acct, folderPath);
        if (resolved) {
          email.folder = `${acct}/${resolved}`;
        } else {
          email.folder = null; // Truly invalid -- clear it
        }
      } else if (!email.folder.match(/^[ig]\//)) {
        // Valid path but missing account prefix -- add it
        email.folder = `${acct}/${folderPath}`;
      }
    }
    if (!email.folder) {
      email.folder = suggestArchiveFolder(email);
    }
  }
}

// ─── Financial metadata extraction ───

/** Pattern-match sender domain/subject to extract financial Type */
const FINANCIAL_TYPE_PATTERNS: Array<{ pattern: RegExp; field: "domain" | "subject"; type: string }> = [
  // Domain-based
  { pattern: /docusign\.(net|com)$/i, field: "domain", type: "DocuSign" },
  { pattern: /stripe\.com$/i, field: "domain", type: "Receipt" },
  { pattern: /paypal\.com$/i, field: "domain", type: "Receipt" },
  { pattern: /venmo\.com$/i, field: "domain", type: "Receipt" },
  { pattern: /square\.com$/i, field: "domain", type: "Receipt" },
  { pattern: /intuit\.com$/i, field: "domain", type: "Invoice" },
  { pattern: /turbotax\.com$/i, field: "domain", type: "Tax" },
  // Subject-based
  { pattern: /\b(statement|stmt)\b/i, field: "subject", type: "Statement" },
  { pattern: /\b(EOB|explanation\s+of\s+benefits?|claims?\s+processed|we\s+processed\s+your\s+claims?)\b/i, field: "subject", type: "EOB" },
  { pattern: /\b(receipt|order\s+confirm|payment\s+confirm|purchase\s+confirm)\b/i, field: "subject", type: "Receipt" },
  { pattern: /\b(invoice|billing)\b/i, field: "subject", type: "Invoice" },
  { pattern: /\b(1099|W-2|W2|tax\s+form|tax\s+document)\b/i, field: "subject", type: "Tax" },
  { pattern: /\blicense\s*(key|code|activation)\b/i, field: "subject", type: "License" },
];

/**
 * Phase 28: is this email a receipt or financial document? True when any
 * FINANCIAL_TYPE_PATTERN matches the sender domain or the subject. This is the
 * detector that drives `financialType`; it is independent of the funnel stage,
 * so a receipt is recognized even when VIP routing placed it in Stage 1.
 */
export function isReceiptOrFinancial(email: ClassifiedEmail): boolean {
  for (const { pattern, field } of FINANCIAL_TYPE_PATTERNS) {
    const text = field === "domain" ? email.fromDomain : email.subject;
    if (pattern.test(text)) return true;
  }
  return false;
}

/**
 * Phase 28: should this email get financial-metadata extraction?
 * Stage 3 (financial) emails always do; additionally ANY receipt/financial
 * email does, regardless of funnel stage — so a VIP-sender receipt gets the
 * same Type/Vendor/Amount treatment instead of being skipped because VIP
 * routing placed it in Stage 1 rather than Stage 3.
 */
export function shouldExtractFinancial(email: ClassifiedEmail): boolean {
  return email.funnelStage === "financial" || isReceiptOrFinancial(email);
}

/** Extract financial metadata (Type, Vendor, Amount). Phase 28: run for any
 *  email where shouldExtractFinancial is true, not only Stage 3. */
export function extractFinancialMetadata(email: ClassifiedEmail): void {
  // Type detection
  if (!email.financialType) {
    for (const { pattern, field, type } of FINANCIAL_TYPE_PATTERNS) {
      const text = field === "domain" ? email.fromDomain : email.subject;
      if (pattern.test(text)) {
        email.financialType = type;
        break;
      }
    }
  }

  // Vendor extraction from sender name (part before <email>)
  if (!email.financialVendor) {
    const namePart = email.from.split("<")[0].trim();
    if (namePart && namePart !== email.fromAddress) {
      email.financialVendor = namePart;
    } else {
      // Fallback: humanize the domain (e.g. "cigna.com" -> "Cigna")
      const domainBase = email.fromDomain.split(".")[0];
      if (domainBase) {
        email.financialVendor = domainBase.charAt(0).toUpperCase() + domainBase.slice(1);
      }
    }
  }

  // Amount extraction from subject + snippet via regex
  if (!email.financialAmount) {
    const amountMatch = (email.subject + " " + email.snippet).match(/\$[\d,]+\.?\d*/);
    if (amountMatch) {
      email.financialAmount = amountMatch[0];
    }
  }
}

/** Generate reply drafts for emails using direct Anthropic API (parallel) */
async function generateDraftsForEmails(
  emails: RawEmail[],
  emailBodies: Map<string, string>,
): Promise<Map<string, string>> {
  const API_URL = "https://api.anthropic.com/v1/messages";
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return new Map();

  const results = await Promise.all(
    emails.map(async (email) => {
      try {
        const body = emailBodies.get(email.id);
        const prompt = buildReplyDraftPrompt(email, body);

        const response = await fetch(API_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: "claude-sonnet-4-6",
            max_tokens: 512,
            system: "You are a professional email assistant. Write concise reply drafts.",
            messages: [{ role: "user", content: prompt }],
          }),
          signal: AbortSignal.timeout(60_000),
        });

        if (!response.ok) return { id: email.id, draft: "" };

        const data = await response.json() as {
          content: Array<{ type: string; text?: string }>;
        };
        const draft = data.content
          .filter((b) => b.type === "text" && b.text)
          .map((b) => b.text!)
          .join("\n")
          .trim();

        return { id: email.id, draft };
      } catch {
        return { id: email.id, draft: "" };
      }
    }),
  );

  const drafts = new Map<string, string>();
  for (const { id, draft } of results) {
    if (draft) drafts.set(id, draft);
  }
  return drafts;
}

// ─── Message-ID fetching (for message:// links in triage notes) ───

/** Default path to Apple Mail's Envelope Index SQLite database.
 *  Exposed so tests can override with a fixture DB. */
export const ENVELOPE_INDEX_PATH =
  ((process.env.HOME ?? (() => { throw new Error("HOME env var not set"); })())) +
  "/Library/Mail/V10/MailData/Envelope Index";

/** Strip RFC 2822 angle brackets from a Message-ID so output matches
 *  AppleScript's `message id` property (which AppleScript strips). */
function stripAngleBrackets(msgId: string): string {
  const trimmed = msgId.trim();
  if (trimmed.startsWith("<") && trimmed.endsWith(">")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** Query Apple Mail's Envelope Index SQLite DB for Message-IDs.
 *  Returns Map<numericId, messageId>. Throws on DB errors so the caller
 *  can fall back to AppleScript.
 *
 *  `messages.ROWID` is the same integer Apple Mail's AppleScript `id`
 *  property returns (covers every mailbox in every account -- inbox,
 *  Junk, Stages/*, etc. -- with a single indexed lookup). The RFC 2822
 *  Message-ID lives on `message_global_data.message_id_header`, joined
 *  via `messages.global_message_id`. It's stored WITH angle brackets;
 *  we strip them so the result matches what AppleScript returns and
 *  what triage-formatter.mailLink() expects (it re-wraps in %3C/%3E). */
export function fetchMessageIdsFromEnvelopeIndex(
  numericIds: string[],
  dbPath: string = ENVELOPE_INDEX_PATH,
): Map<string, string> {
  const results = new Map<string, string>();
  if (numericIds.length === 0) return results;

  // Lazy-load bun:sqlite so non-Bun contexts (Next.js) don't trip on it.
  const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
  const db = new Database(dbPath, { readonly: true });
  try {
    // Chunk to stay under SQLite's variable limit (999 on older builds,
    // 32k on SQLite 3.32+). 500 is a safe middle ground.
    const CHUNK = 500;
    for (let i = 0; i < numericIds.length; i += CHUNK) {
      const chunk = numericIds.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => "?").join(",");
      const sql = `
        SELECT m.ROWID AS numId, mgd.message_id_header AS msgId
        FROM messages m
        LEFT JOIN message_global_data mgd ON m.global_message_id = mgd.ROWID
        WHERE m.ROWID IN (${placeholders})
          AND mgd.message_id_header IS NOT NULL
      `;
      const rows = db.prepare(sql).all(...chunk.map(n => Number(n))) as Array<{
        numId: number;
        msgId: string | null;
      }>;
      for (const row of rows) {
        if (row.msgId) {
          results.set(String(row.numId), stripAngleBrackets(row.msgId));
        }
      }
    }
  } finally {
    db.close();
  }
  return results;
}

/** Fetch RFC 2822 Message-IDs from Apple Mail for given numeric IDs.
 *
 *  Primary path: read directly from Apple Mail's Envelope Index SQLite
 *  (`~/Library/Mail/V10/MailData/Envelope Index`). A single indexed query
 *  covers every mailbox in every account, eliminating the O(N × accounts
 *  × mailboxes) scan and per-account mailbox-naming gotchas (iCloud
 *  "INBOX" vs Gmail "inbox") that caused the AppleScript approach to
 *  silently drop most rows.
 *
 *  Fallback: batched AppleScript (original implementation), retained for
 *  the edge case where the Envelope Index is unreadable.
 *
 *  @param numericIds - Apple Mail numeric IDs (AppleScript `id` property)
 *  @param mailboxMap - Unused by the SQLite path (kept for API compat). */
// FETCHMESSAGEIDS_V2_MAILBOX_SCAN
// Rewritten to iterate each relevant mailbox ONCE and look up numeric IDs in a
// locally-built set. Old version did O(N_ids * N_accounts * N_mailboxes) nested
// lookups which scaled poorly (27s+ for 150 IDs). New version is O(sum of mailbox
// sizes) which is typically dominated by inbox size (~500 msgs) regardless of N_ids.
export async function fetchMessageIds(
  numericIds: string[],
  mailboxMap?: Map<string, string>,
): Promise<Map<string, string>> {
  if (numericIds.length === 0) return new Map();

  // Primary: SQLite Envelope Index (fast, complete, no AppleScript timeouts).
  // Covers every mailbox in every account via a single indexed lookup on
  // messages.ROWID, which eliminates the per-account mailbox-naming gotchas
  // (iCloud "INBOX" vs Gmail "inbox") that caused earlier AppleScript
  // approaches to silently drop most rows.
  try {
    const sqliteResults = fetchMessageIdsFromEnvelopeIndex(numericIds);
    if (sqliteResults.size < numericIds.length) {
      console.warn(
        `[fetchMessageIds] WARN: Envelope Index returned Message-IDs for ` +
        `${sqliteResults.size}/${numericIds.length} emails ` +
        `(${numericIds.length - sqliteResults.size} missing). ` +
        `Missing rows will render as bare IDs (not clickable).`
      );
    }
    return sqliteResults;
  } catch (err) {
    console.warn(
      `[fetchMessageIds] Envelope Index unavailable ` +
      `(${(err as Error).message}); falling back to AppleScript batch.`
    );
  }

  const results = new Map<string, string>();
  // Strategy: group IDs by the mailbox we know (for staged emails); unknown IDs
  // default to "inbox". Build one AppleScript that iterates each mailbox once,
  // walks its messages, and emits "numericId<TAB>messageId" for matches.

  // Partition IDs: those with a known custom mailbox, and the rest (inbox).
  const byMailbox = new Map<string, Set<string>>();
  for (const id of numericIds) {
    const mb = mailboxMap?.get(id);
    const key = mb ?? "__INBOX__";
    let set = byMailbox.get(key);
    if (!set) { set = new Set(); byMailbox.set(key, set); }
    set.add(id);
  }

  // AppleScript note: `id` on a Mail message is a numeric id (Integer).
  // Building a string-form lookup set in AppleScript is clunky; instead we
  // materialize the candidate list as a comma-delimited string and use
  // `repeat with m in messages` then a membership check against a parsed set.
  // We construct one `tell` block per mailbox and concatenate.

  const blocks: string[] = [];
  let blockIdx = 0;
  for (const [mailbox, idSet] of byMailbox) {
    const ids = Array.from(idSet);
    // Build AppleScript list of integer IDs as a comma-separated string. We
    // use a linear scan with `repeat with i from 1 to count of ids` inside
    // AppleScript and test each message.id numerically.
    const listLiteral = ids.map(id => id).join(", ");
    const mbSelector = mailbox === "__INBOX__"
      ? `inbox of acct`
      : `mailbox "${mailbox}" of acct`;
    const mbBlockId = `mb${blockIdx++}`;
    blocks.push(`-- mailbox: ${mailbox} (${ids.length} ids)
    set targetIds_${mbBlockId} to {${listLiteral}}
    repeat with acct in every account
      try
        set mbRef to ${mbSelector}
        set msgs to every message of mbRef
        repeat with m in msgs
          set mid to (id of m) as string
          repeat with tid in targetIds_${mbBlockId}
            if (tid as string) = mid then
              try
                set msgId to message id of m
                set output to output & mid & tab & msgId & linefeed
              end try
              exit repeat
            end if
          end repeat
        end repeat
      end try
    end repeat`);
  }

  const script = `tell application "Mail"
  set output to ""
${blocks.join("\n")}
  return output
end tell`;

  try {
    const tmpScript = "/tmp/fetch-message-ids.scpt";
    writeFileSync(tmpScript, script);
    // Generous timeout that scales with total mailbox count, not id count.
    const timeoutMs = 60_000 + byMailbox.size * 15_000;
    const output = execSync(`osascript "${tmpScript}"`, {
      encoding: "utf-8",
      timeout: timeoutMs,
    }).trim();

    for (const line of output.split("\n")) {
      const sep = line.indexOf("\t");
      if (sep > 0) {
        const numId = line.slice(0, sep).trim();
        const msgId = line.slice(sep + 1).trim();
        if (numId && msgId) results.set(numId, msgId);
      }
    }
  } catch { /* Mail.app unavailable or script error — return whatever we got */ }

  if (results.size < numericIds.length) {
    console.warn(`[fetchMessageIds] WARN: ${numericIds.length - results.size} of ${numericIds.length} emails missing Message-IDs`);
  }

  return results;
}

import type { Database } from "bun:sqlite";

// VAULT_ROOT is loaded from SKILLCUSTOMIZATIONS or env var; falls back to empty.
function getVaultRoot(): string {
  if (process.env.EMAILTRIAGE_VAULT_ROOT) return process.env.EMAILTRIAGE_VAULT_ROOT;
  try {
    const home = process.env.HOME;
    if (!home) return "";
    const fs = require("fs");
    const prefs = join(home, ".claude/PAI/USER/SKILLCUSTOMIZATIONS/EmailTriage/preferences.yaml");
    if (!fs.existsSync(prefs)) return "";
    const raw = fs.readFileSync(prefs, "utf8");
    const m = raw.match(/^\s*vault_root\s*:\s*["']?([^"'#\n]+?)["']?\s*(?:#.*)?$/m);
    return m ? m[1].trim() : "";
  } catch { return ""; }
}
const VAULT_ROOT = getVaultRoot();
// import.meta.dir is Bun-only and undefined in Next.js/Turbopack context;
// resolved lazily at call time to avoid module-level evaluation issues.
// Tools/ now lives one level inside skill root, so go up one level.
function getSkillDir(): string {
  if (import.meta.dir) {
    const dir = import.meta.dir;
    return dir.endsWith("/Tools") ? dir.slice(0, -6) : dir;
  }
  return join((process.env.HOME ?? (() => { throw new Error("HOME env var not set"); })()), ".claude/skills/EmailTriage");
}
const APPLE_MAIL_SH = join(process.env.HOME ?? "~", ".claude/skills/AppleMail/Tools/apple-mail.sh");

// ─── Exported helpers (testable) ───

export function estimateMinutes(emails: ClassifiedEmail[]): number {
  let total = 0;
  for (const e of emails) {
    switch (e.funnelStage) {
      case "vip":
        total += 2;
        break;
      case "follow_up_due":
        total += 2;
        break;
      case "action":
        total += 2;
        break;
      case "financial":
        total += 0.5;
        break;
      case "informational":
        total += 0.5;
        break;
      // bulk_dispose, auto_processed = 0
    }
  }
  return Math.ceil(total);
}

/** Canonical file name for a triage note: "Email Triage -- Month Day, Year.md"
 *  Always use this format directly. Never create date-only files (YYYY-MM-DD.md)
 *  that depend on Obsidian's auto-rename -- that causes duplicates and inconsistency. */
export function getOutputPath(date: string, outputDir?: string): string {
  // Live-evaluate vault root so tests can set EMAILTRIAGE_VAULT_ROOT before each call.
  const vaultRoot = getVaultRoot();
  const dir = outputDir ?? join(vaultRoot, "Email Triage");
  const [y, m, d] = date.split("-").map(Number);
  const months = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  const canonicalPath = join(dir, `Email Triage -- ${months[m - 1]} ${d}, ${y}.md`);

  // Also check for a legacy date-only file and prefer the canonical path
  // (the old file will be orphaned and can be cleaned up)
  if (existsSync(canonicalPath)) return canonicalPath;

  // Fallback: if a date-only file exists from a previous version, use canonical path
  // so the next write goes to the correct name
  const legacyPath = join(dir, `${date}.md`);
  if (existsSync(legacyPath)) {
    // Rename legacy file to canonical name
    try {
      const { renameSync } = require("fs");
      renameSync(legacyPath, canonicalPath);
    } catch { /* non-fatal -- just write to canonical path */ }
  }

  return canonicalPath;
}

export function buildTriageSession(
  emails: ClassifiedEmail[],
  date: string,
  inboxTotal: number | null = null,
  accountFilter?: AccountAlias,
  banner?: string,
): TriageSession {
  return {
    date,
    generatedAt: new Date().toISOString(),
    total: emails.length,
    inboxTotal,
    unread: emails.filter((e) => !e.isRead).length,
    emails,
    estimatedMinutes: estimateMinutes(emails),
    accountFilter,
    banner,
  };
}

export function buildClassificationCache(db: Database): ClassificationCache {
  const junk = getJunkSenders(db);
  return {
    vipSenders: getVipSenders(db),
    junkAddresses: junk.addresses,
    junkDomains: junk.domains,
    routingRules: getRoutingRules(db),
    knownSenders: getKnownSenders(db),
  };
}

export async function fetchEmails(
  testMode: boolean,
  accountFilter?: AccountAlias,
  fetchAll?: boolean,
): Promise<{ emails: RawEmail[]; inboxTotal: number | null }> {
  if (testMode) {
    return { emails: sampleRawEmails, inboxTotal: sampleRawEmails.length };
  }

  // Phase 1: Gmail fetches MUST go through GwsGmailTransport so that email.id is the
  // Gmail-side ID expected by GwsGmailTransport.moveToStage. If we fetched Gmail through
  // apple-mail.sh, email.id would be Mail.app's local Apple-numeric ID (e.g. 97121), which
  // gws would silently reject — the move/archive would no-op and the email would stay in
  // INBOX while the doc rendered it as staged. So:
  //   accountFilter === "g"        → gws only
  //   accountFilter === "i"        → apple-mail.sh only
  //   accountFilter undefined (ALL) → gws + apple-mail.sh (iCloud only, excluding Gmail)
  if (accountFilter === "g") {
    const gws = new GwsGmailTransport();
    const emails = await gws.list({ limit: 500, mailbox: "INBOX" });
    return { emails, inboxTotal: emails.length };
  }

  // Live mode: scoped to iCloud (or another non-Gmail account) via apple-mail.sh.
  const iCloudListArg = accountFilter ?? "i";
  const output = execSync(`bash "${APPLE_MAIL_SH}" list ${iCloudListArg} 500`, {
    encoding: "utf-8",
    timeout: 90_000,
  });
  const appleEmails = parseEmailList(output);
  const appleInboxTotal = parseInboxTotal(output);

  if (accountFilter) {
    return { emails: appleEmails, inboxTotal: appleInboxTotal };
  }

  // accountFilter undefined → ALL accounts. Merge gws Gmail fetch so Gmail emails get
  // Gmail-side IDs (not Mail.app's Apple-numeric IDs from the IMAP cache).
  const gwsTransport = new GwsGmailTransport();
  const gmailEmails = await gwsTransport.list({ limit: 500, mailbox: "INBOX" });
  const mergedEmails = [...appleEmails.filter(e => resolveAccountAlias(e.account ?? "iCloud") !== "g"), ...gmailEmails];
  const inboxTotal = (appleInboxTotal ?? 0) + gmailEmails.length;
  return { emails: mergedEmails, inboxTotal };
}

// ─── Staging folder reader ───

export interface StagedEmail {
  raw: RawEmail;
  funnelStage: FunnelStage;
  stageFolderPath: string;  // e.g. "g/Stages/Stage 5 - Bulk Dispose"
}

const ACTIVE_ACCOUNTS: AccountAlias[] = ['i', 'g'];

// STAGED_SINGLE_OSA_V2
/** Fetch emails already sorted into per-account staging folders.
 *  V2 implementation: single AppleScript that enumerates all stage folders
 *  across all active accounts. Apple Mail's AppleScript engine is single-threaded
 *  internally; concurrent osascript processes cause lock contention and slow
 *  things down significantly. One script, one process, one walk -- stable and fast.
 *
 *  Output format per message (tab-separated, one per line):
 *    ACCOUNT\tFOLDER\tID\tREAD\tFLAGGED\tHAS_ATT\tDATE\tSENDER\tSUBJECT\tACCT_NAME
 *  Folder boundary rows emit "===FOLDER\tACCOUNT\tFOLDER" markers. */
export async function fetchStagedEmails(
  accountFilter?: AccountAlias,
  onProgress?: ProgressCallback,
): Promise<StagedEmail[]> {
  const progress = onProgress ?? (() => {});
  const staged: StagedEmail[] = [];
  const accounts = accountFilter ? [accountFilter] : ACTIVE_ACCOUNTS;

  // Phase 1: Gmail staged emails come from gws (Stages/Stage N labels), not Mail.app folders.
  // Run this BEFORE the osascript so that even if Mail.app is unavailable we still get Gmail.
  if (accounts.includes("g")) {
    const gws = new GwsGmailTransport();
    for (const [folderName, stage] of Object.entries(FOLDER_STAGE_MAP)) {
      try {
        const emails = await gws.list({ limit: 500, mailbox: `Stages/${folderName}` });
        const path = `g/Stages/${folderName}`;
        for (const email of emails) {
          staged.push({ raw: email, funnelStage: stage, stageFolderPath: path });
        }
      } catch { /* label may not exist yet -- skip */ }
    }
  }

  // Mail.app accounts only past this point -- Gmail post-cutover is no longer in Mail.app.
  const mailAppAccounts = accounts.filter(a => a !== "g");
  if (mailAppAccounts.length === 0) {
    if (staged.length > 0) progress("staged", `Found ${staged.length} emails in staging folders`);
    return staged;
  }

  // Map account alias -> Apple Mail account name (matches apple-mail.sh resolve_path)
  const acctName: Record<string, string> = { i: "iCloud", g: "Google" };

  // Build AppleScript that iterates every (account, stageFolder) pair in a single tell.
  const blocks: string[] = [];
  for (const alias of mailAppAccounts) {
    const aName = acctName[alias] ?? alias;
    for (const [folderName, _stage] of Object.entries(FOLDER_STAGE_MAP)) {
      // Each folder: try/catch to tolerate missing folders; emit messages.
      blocks.push(`try
      set acct to account "${aName}"
      set mb to mailbox "Stages/${folderName}" of acct
      set msgs to messages of mb
      repeat with m in msgs
        try
          set mid to (id of m) as string
          set rs to "[ ]"
          if read status of m then set rs to "[READ]"
          set fm to "   "
          try
            if flagged status of m then set fm to "[F]"
          end try
          set am to "   "
          try
            if (count of mail attachments of m) > 0 then set am to "[A]"
          end try
          set dm to (date received of m) as string
          set sm to sender of m
          set sbj to subject of m
          set output to output & "${alias}" & tab & "${folderName}" & tab & "ID:" & mid & " " & rs & " " & fm & " " & am & " | " & dm & " | " & sm & " | " & sbj & " | ACCT:${aName}" & linefeed
        end try
      end repeat
    end try`);
    }
  }

  const script = `tell application "Mail"
  if not running then launch
  set output to ""
${blocks.join("\n")}
  return output
end tell`;

  try {
    const tmpScript = "/tmp/fetch-staged-emails.scpt";
    writeFileSync(tmpScript, script);
    const output = execSync(`osascript "${tmpScript}"`, {
      encoding: "utf-8",
      timeout: 120_000,
    });

    // Parse tab-separated output: alias\tfolderName\tparseable-row
    // Reconstruct parseEmailList-compatible blocks per folder so we can reuse the parser.
    const linesByFolder = new Map<string, string[]>();
    for (const line of output.split("\n")) {
      if (!line.trim()) continue;
      const firstTab = line.indexOf("\t");
      const secondTab = line.indexOf("\t", firstTab + 1);
      if (firstTab < 0 || secondTab < 0) continue;
      const alias = line.slice(0, firstTab);
      const folderName = line.slice(firstTab + 1, secondTab);
      const row = line.slice(secondTab + 1);
      const key = `${alias}|${folderName}`;
      let arr = linesByFolder.get(key);
      if (!arr) { arr = []; linesByFolder.set(key, arr); }
      arr.push(row);
    }

    for (const [key, rows] of linesByFolder) {
      const [alias, folderName] = key.split("|");
      const stage = FOLDER_STAGE_MAP[folderName];
      if (!stage) continue;
      // parseEmailList expects a header block + rows; synthesize minimal header so parser works
      const header = `Mailbox: ${alias}/Stages/${folderName} (${rows.length} total)
======================================
`;
      const emails = parseEmailList(header + rows.join("\n"));
      const path = `${alias}/Stages/${folderName}`;
      for (const email of emails) {
        staged.push({ raw: email, funnelStage: stage, stageFolderPath: path });
      }
    }
  } catch {
    // Fallback: per-folder serial calls via apple-mail.sh (original behaviour, Mail.app accounts only).
    // Gmail was already harvested above via gws -- do not re-shell for "g".
    for (const alias of mailAppAccounts) {
      for (const [folderName, stage] of Object.entries(FOLDER_STAGE_MAP)) {
        const p = `${alias}/Stages/${folderName}`;
        try {
          const out = execSync(`bash "${APPLE_MAIL_SH}" list "${p}" 500`, {
            encoding: "utf-8",
            timeout: 30_000,
          });
          for (const email of parseEmailList(out)) {
            staged.push({ raw: email, funnelStage: stage, stageFolderPath: p });
          }
        } catch { /* skip */ }
      }
    }
  }

  // Dedup by message id. Gmail labels are non-exclusive: a message carrying two
  // `Stages/*` labels is listed once per label by the gws block above, which put
  // the same email into `staged` twice and surfaced it as a duplicate row in the
  // triage note. iCloud folders are exclusive so this only bites Gmail, but the
  // dedup is account-agnostic for safety. FOLDER_STAGE_MAP iterates Stage 1→6, so
  // keep-first means the highest-priority stage wins when an email is multi-labeled
  // (better to surface a mislabeled email as VIP for review than auto-trash it).
  const seenIds = new Set<string>();
  const deduped: StagedEmail[] = [];
  for (const s of staged) {
    if (seenIds.has(s.raw.id)) continue;
    seenIds.add(s.raw.id);
    deduped.push(s);
  }
  const dropped = staged.length - deduped.length;

  if (deduped.length > 0) {
    progress(
      "staged",
      dropped > 0
        ? `Found ${deduped.length} emails in staging folders (${dropped} duplicate label hit${dropped === 1 ? "" : "s"} dropped)`
        : `Found ${deduped.length} emails in staging folders`,
    );
  }
  return deduped;
}

// ─── Follow-up reply check ───

/** Check if a reply was sent to a given sender after a certain date.
 *  Phase 1: searches BOTH transports' sent folders. The follow_ups DB schema does not carry
 *  the account alias for the original message, so we cannot dispatch on origin-account. We OR
 *  the two results -- a reply via either account counts. iCloud sent search continues to use
 *  apple-mail.sh; Gmail sent search uses the gws messages.list query API directly (Transport
 *  interface intentionally has no search() method to keep it minimal). */
export function checkReplySent(sender: string, sinceDate: string): boolean {
  let any = false;
  try {
    const output = execSync(
      `bash "${APPLE_MAIL_SH}" search "to:${sender}" --mailbox sent --after "${sinceDate}"`,
      { encoding: "utf-8", timeout: 15_000 },
    );
    const lines = output.trim().split("\n").filter(l => l.trim() && !l.startsWith("==="));
    if (lines.length > 0) any = true;
  } catch { /* iCloud search failed -- continue to Gmail */ }
  if (!any) {
    try {
      const q = `in:sent to:${sender} after:${sinceDate}`;
      const result = spawnSync(
        process.env.GWS_BIN ?? "gws",
        ["gmail", "users", "messages", "list", "--params", JSON.stringify({ userId: "me", q, maxResults: 1 })],
        { encoding: "utf8", timeout: 15_000 },
      );
      if (result.status === 0) {
        const out = (result.stdout ?? "").toString();
        // Strip banner lines (matches Transport.ts stripBanner pattern)
        const stripped = out.split("\n").filter(line => !line.startsWith("[account:") && !line.startsWith("Using keyring backend:")).join("\n").trim();
        try {
          const json = JSON.parse(stripped) as { messages?: unknown[]; resultSizeEstimate?: number };
          if ((json.messages?.length ?? 0) > 0 || (json.resultSizeEstimate ?? 0) > 0) any = true;
        } catch { /* unparseable -- fall through */ }
      }
    } catch { /* Gmail search failed -- safer to assume no reply (resurface) */ }
  }
  return any;
}

// ─── Per-account stage folder management ───

/** Ensure per-account stage folders exist in Apple Mail (idempotent).
 *  Uses spawnSync intentionally -- must complete before sorting begins.
 *  Phase 1: Gmail account "g" is skipped here because Gmail labels auto-create on first
 *  apply via gws Labels.ts, and the Stages/* hierarchy already exists on the live Gmail account
 *  (verified at OBSERVE 2026-05-07; see Phase 1 Design F1). */
function ensureStageFolders(): void {
  const stages: FunnelStage[] = ['vip', 'action', 'financial', 'informational', 'bulk_dispose', 'auto_processed'];
  for (const account of ACTIVE_ACCOUNTS) {
    if (account === "g") continue;
    for (const stage of stages) {
      const path = getStageFolderPath(stage, account);
      if (!path) continue;
      try {
        const result = Bun.spawnSync(["bash", APPLE_MAIL_SH, "create-mailbox", path]);
        if (result.exitCode !== 0) {
          console.warn(`[WARN] create-mailbox ${path} exited with code ${result.exitCode}`);
        }
      } catch { /* idempotent -- folder may already exist */ }
    }
  }
}

/** Move classified emails from inbox to per-account stage folders.
 *  Classification metadata stays in memory -- no DB persistence needed. */
async function sortToStageFolders(
  classified: ClassifiedEmail[],
  onProgress?: ProgressCallback,
): Promise<{ sorted: number; errors: number }> {
  const progress = onProgress ?? (() => {});
  let sorted = 0;
  let errors = 0;

  const BATCH_SIZE = 5;
  let iCloudSorted = 0;
  for (let i = 0; i < classified.length; i += BATCH_SIZE) {
    const batch = classified.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (email) => {
        const rawAlias = resolveAccountAlias(email.account ?? "iCloud");
        if (!rawAlias) {
          console.warn(`[WARN] Unknown account "${email.account}" for email ${email.id} -- defaulting to iCloud`);
        }
        const accountAlias = rawAlias ?? "i";
        const folder = getStageFolderPath(email.funnelStage, accountAlias);
        if (!folder) return { ok: true, skipped: true, account: accountAlias as AccountAlias };

        // Phase 1: Gmail moves go through GwsGmailTransport.moveToStage (Stages/Stage N label
        // apply + INBOX removal); iCloud and other accounts keep apple-mail.sh path unchanged.
        if (accountAlias === "g") {
          try {
            await transportFor("g").moveToStage(email.id, email.funnelStage);
            return { ok: true, skipped: false, account: accountAlias };
          } catch {
            return { ok: false, skipped: false, account: accountAlias };
          }
        }

        try {
          const proc = Bun.spawn(["bash", APPLE_MAIL_SH, "move", email.id, folder], {
            stdout: "pipe",
            stderr: "pipe",
          });
          const exitCode = await proc.exited;
          return { ok: exitCode === 0, skipped: false, account: accountAlias };
        } catch {
          return { ok: false, skipped: false, account: accountAlias };
        }
      }),
    );

    for (const r of results) {
      if (r.skipped) continue;
      if (r.ok) {
        sorted++;
        if (r.account === "i") iCloudSorted++;
      } else {
        errors++;
      }
    }
  }

  progress("sort", `Sorted ${sorted} emails to per-account stage folders${errors > 0 ? ` (${errors} errors)` : ""}`);

  // Mark all staged iCloud-account emails as unread so they show badge counts in Mail.app sidebar.
  // Phase 1: only fire when at least one iCloud email was sorted -- a Gmail-only run does not
  // touch Mail.app at all and the osascript would silently no-op (Gmail account post-cutover
  // is no longer configured in Mail.app).
  if (iCloudSorted > 0) {
    try {
      execSync(`osascript -e '
tell application "Mail"
  try
    set acct to account "iCloud"
    set stagesBox to mailbox "Stages" of acct
    repeat with b in (every mailbox of stagesBox)
      repeat with m in (every message of b)
        set read status of m to false
      end repeat
    end repeat
  end try
end tell'`, { timeout: 15_000 });
    } catch { /* non-critical */ }
  }

  // Trigger Apple Mail sync so IMAP changes are reflected in UI -- iCloud only post-cutover.
  if (iCloudSorted > 0) {
    try {
      execSync('osascript -e \'tell application "Mail" to check for new mail\'', { timeout: 10_000 });
    } catch { /* non-critical */ }
  }

  return { sorted, errors };
}

/** After sorting emails to staging folders, Apple Mail reassigns numeric IDs.
 *  This function re-reads staging folders, matches old IDs to new IDs by subject+sender,
 *  and returns a mapping of oldId -> newId for triage note reconciliation. */
async function buildPostSortIdMap(
  classified: ClassifiedEmail[],
  onProgress?: ProgressCallback,
): Promise<Map<string, string>> {
  const progress = onProgress ?? (() => {});
  const idMap = new Map<string, string>();
  if (classified.length === 0) return idMap;

  // Build a lookup key from subject + sender + date. Date is included to disambiguate
  // duplicate-subject emails from the same sender in the same stage (e.g. two appointment
  // reminders from a dental office — both VIP, identical subject, different times). Without
  // the date, Map.set overwrites and one of the IDs never gets reconciled, leaving the doc
  // with stale pre-sort numeric IDs that 500 in the UI's /api/email/<id> calls.
  const emailsByKey = new Map<string, { oldId: string; account: AccountAlias; stage: FunnelStage }>();
  for (const email of classified) {
    const alias = resolveAccountAlias(email.account ?? "iCloud") ?? "i";
    const key = `${alias}|${email.funnelStage}|${email.fromAddress.toLowerCase()}|${email.subject.trim().toLowerCase()}|${email.date}`;
    emailsByKey.set(key, { oldId: email.id, account: alias, stage: email.funnelStage });
  }

  // Re-read each staging folder to discover new IDs.
  // Phase 1: Gmail message IDs are stable across label-apply (the Gmail API never reassigns
  // the message id), so we only need to reconcile iCloud-bucket folders. Skipping "g" prefixes
  // here both avoids needless gws calls and avoids leaking Mail.app folder semantics into Gmail.
  const foldersToCheck = new Set<string>();
  for (const email of classified) {
    const alias = resolveAccountAlias(email.account ?? "iCloud") ?? "i";
    if (alias === "g") continue;
    const folder = getStageFolderPath(email.funnelStage, alias);
    if (folder) foldersToCheck.add(folder);
  }

  for (const folder of foldersToCheck) {
    // Phase 1 commit 4: Gmail message IDs are stable across label apply, no reconciliation needed.
    if (folder.startsWith("g/")) continue;
    try {
      const output = execSync(`bash "${APPLE_MAIL_SH}" list "${folder}" 500`, {
        encoding: "utf-8",
        timeout: 30_000,
      });
      const emails = parseEmailList(output);
      for (const email of emails) {
        const alias = folder.startsWith("g") ? "g" : "i";
        const folderName = folder.split("/").pop() ?? "";
        const stage = FOLDER_STAGE_MAP[folderName];
        if (!stage) continue;
        const key = `${alias}|${stage}|${email.fromAddress.toLowerCase()}|${email.subject.trim().toLowerCase()}|${email.date}`;
        const original = emailsByKey.get(key);
        if (original && original.oldId !== email.id) {
          idMap.set(original.oldId, email.id);
        }
      }
    } catch { /* folder read failed -- skip */ }
  }

  if (idMap.size > 0) {
    progress("reconcile", `Reconciled ${idMap.size} ID(s) changed by Apple Mail move`);
  }
  return idMap;
}

/** Update the triage note file in-place, replacing old email IDs with new post-sort IDs.
 *  Handles all ID formats: link format, backtick format, table cell format, and account-map. */
function reconcileTriageNoteIds(notePath: string, idMap: Map<string, string>): void {
  if (idMap.size === 0) return;
  let content = readFileSync(notePath, "utf-8");

  for (const [oldId, newId] of idMap) {
    // 1. Link format: [87446](message://...) -- replace just the display ID, keep the message:// URL
    content = content.replace(
      new RegExp(`\\[${oldId}\\](\\(message://[^)]+\\))`, "g"),
      `[${newId}]$1`,
    );
    // 2. Backtick format in headers: `87446`
    content = content.replace(
      new RegExp("(?<=^####\\s.*)\\`" + oldId + "\\`", "gm"),
      "`" + newId + "`",
    );
    // 3. Table cell format: "87446 [i]" or "87446 [g]" at start of table cell
    //    Also handles format: "| 87446 [i] |"
    content = content.replace(
      new RegExp(`(\\|\\s*)${oldId}(\\s+\\[)`, "g"),
      `$1${newId}$2`,
    );
    // 4. Account-map in YAML: "87446:i" -> "newId:i"
    content = content.replace(
      new RegExp(`${oldId}:`, "g"),
      `${newId}:`,
    );
  }

  writeFileSync(notePath, content);
}

// ─── Main orchestrator ───

export type ProgressCallback = (step: string, detail?: string) => void;

export interface GenerateOptions {
  testMode: boolean;
  date: string;
  outputDir?: string;
  dbPath?: string;
  skipAI?: boolean; // Skip AI classification (for test mode)
  accountFilter?: AccountAlias; // Filter to single account (e.g., "i" for iCloud only)
  force?: boolean; // Force full regeneration even if note exists
  fetchAll?: boolean; // Deprecated: all inbox messages are now always fetched
  onProgress?: ProgressCallback;
}

// ─── Incremental merge helpers ───

/** Parse an existing triage note to extract known IDs and user decisions. */
export function parseExistingNote(content: string): TriageNoteState {
  const knownIds = new Set<string>();
  const decisions = new Map<string, { action: string; archiveTo?: string; you?: string }>();

  // Extract IDs from mini-blocks: #### `ID` or #### [ID](message://...)
  for (const match of content.matchAll(/####\s+(?:\[`?(\d+)`?\]|\[(\d+)\]|`(\d+)`)/g)) {
    const id = match[1] ?? match[2] ?? match[3];
    if (id) knownIds.add(id);
  }

  // Extract IDs from table rows: | ID [i] | ... | or | [ID](message://...) [g] | ...
  // Require 4+ digits to avoid matching overview table counts (e.g. | VIP | 1 | |)
  for (const match of content.matchAll(/\|\s*(?:\[`?(\d+)`?\]\([^)]*\)|`?(\d+)`?)(?:\s*\[[a-z]\])?\s*\|/g)) {
    const id = match[1] ?? match[2];
    if (id && id.length >= 4) knownIds.add(id);
  }

  // Extract IDs from checkbox items: - [x] `ID` or - [ ] `ID` or - [x] [ID](...)
  for (const match of content.matchAll(/-\s*\[[x ]\]\s*(?:\[`?(\d+)`?\]\([^)]*\)|`(\d+)`)/g)) {
    const id = match[1] ?? match[2];
    if (id) knownIds.add(id);
  }

  // Extract user decisions from mini-blocks: **Action:** [X]  **You:** instructions
  for (const match of content.matchAll(/####\s+(?:\[`?(\d+)`?\]|\[(\d+)\]|`(\d+)`)[\s\S]*?\*\*Action:\*\*\s*\[([^\]]*)\]\s*\*\*You:\*\*\s*(.*)/gm)) {
    const id = match[1] ?? match[2] ?? match[3];
    const action = (match[4] ?? "").trim();
    const you = (match[5] ?? "").trim();
    if (id && action) decisions.set(id, { action, you: you || undefined });
  }

  // Extract Instructions section content
  let instructionsContent = "";
  const instrMatch = content.match(/## Instructions\n([\s\S]*?)(?=\n## )/);
  if (instrMatch) {
    // Filter out the default help text lines
    instructionsContent = instrMatch[1]
      .split("\n")
      .filter(l => !l.startsWith("*") && !l.startsWith(">") && l.trim().length > 0)
      .join("\n")
      .trim();
  }

  // Extract Execution Log if present
  let executionLog: string | undefined;
  const logMatch = content.match(/## Execution Log\n([\s\S]*?)$/);
  if (logMatch) {
    const logContent = logMatch[1].trim();
    // Only preserve if it has been filled in (not default dashes)
    if (!logContent.includes("Archived: --") || logContent.includes("Processed at: 20")) {
      executionLog = logContent;
    }
  }

  return { knownIds, decisions, instructionsContent, executionLog };
}

/** Count actual non-[GONE] entries in a stage section.
 *  Works for both mini-block stages (#### `ID`) and table stages (| ID |).
 *  Returns the count of entries that are NOT marked [GONE]. */
function countStageEntries(content: string, headingPattern: RegExp): number {
  const headingMatch = content.match(headingPattern);
  if (!headingMatch) return 0;

  const headingIdx = content.indexOf(headingMatch[0]);
  const sectionStart = headingIdx + headingMatch[0].length;
  const nextSectionMatch = content.slice(sectionStart).match(/\n## /);
  const sectionEnd = nextSectionMatch ? sectionStart + nextSectionMatch.index! : content.length;
  const section = content.slice(sectionStart, sectionEnd);

  let count = 0;
  // Count mini-block entries: #### `ID` or #### [ID](...)
  for (const m of section.matchAll(/####\s+(?:\[`?\d+`?\]\([^)]*\)|`\d+`)(.*)$/gm)) {
    if (!m[1].includes("[GONE]")) count++;
  }
  // Count table row entries: | ID | or | [ID](...) | (but not header/separator rows)
  for (const m of section.matchAll(/^\|[^|]*\|(.+)$/gm)) {
    const firstCell = m[0].split("|")[1]?.trim() ?? "";
    // Skip header rows (no digits) and separator rows (---)
    if (/---/.test(firstCell) || !/\d/.test(firstCell)) continue;
    if (m[0].includes("[GONE]")) continue;
    count++;
  }
  // Count checkbox entries: - [x] `ID` or - [ ] [ID](...)
  for (const m of section.matchAll(/^-\s*\[[x ]\]\s*(?:\[`?\d+`?\]\([^)]*\)|`\d+`)(.*)$/gm)) {
    if (!m[1].includes("[GONE]")) count++;
  }
  return count;
}

/** Merge new classified emails into existing note content.
 *  Preserves user decisions, instructions, and execution log from existing note.
 *  New emails are inserted at the top of their respective stage sections.
 *  Emails no longer in inbox get a [GONE] indicator. */
/**
 * Reconcile the `> N VIP | N Action | N Financial | N Info | N Bulk | N Auto-processed`
 * summary line under the H1 against the actual section heading counts. Counted
 * by re-running the section heading regexes against the live content — never
 * trusts the existing summary line. See Bug B (Changelog 2026-05-18).
 */
function reconcileStageSummary(content: string): string {
  const patterns: Record<string, RegExp> = {
    vip:              /## \[.?\] Stage 1: VIP \((\d+)\)/,
    follow_up_due:    /## \[.?\] Follow-Up Due \((\d+)\)/,
    action:           /## \[.?\] Stage 2: Action Required \((\d+)\)/,
    financial:        /## \[.?\] Stage 3: Financial & Documents \((\d+)\)/,
    informational:    /## \[.?\] Stage 4: Informational \((\d+)\)/,
    bulk_dispose:     /## \[.?\] Stage 5: Bulk Dispose \((\d+)\)/,
    auto_processed:   /## \[.?\] Stage 6: Auto-Processed \((\d+)\)/,
  };
  const counts: Record<string, number> = {};
  for (const [key, pat] of Object.entries(patterns)) {
    const m = content.match(pat);
    counts[key] = m ? parseInt(m[1], 10) : 0;
  }
  const summaryParts = [
    `${counts.vip} VIP`,
    `${counts.action} Action`,
    `${counts.financial} Financial`,
    `${counts.informational} Info`,
    `${counts.bulk_dispose} Bulk`,
    `${counts.auto_processed} Auto-processed`,
  ];
  if (counts.follow_up_due > 0) summaryParts.push(`${counts.follow_up_due} Follow-up Due`);
  const newSummaryLine = `> ${summaryParts.join(" | ")}`;
  return content.replace(
    /^> \d+ VIP \| \d+ Action \| \d+ Financial \| \d+ Info \| \d+ Bulk \| \d+ Auto-processed(?: \| \d+ Follow-up Due)?$/m,
    newSummaryLine,
  );
}

export function mergeIntoExistingNote(
  existingContent: string,
  newEmails: ClassifiedEmail[],
  goneIds: Set<string>,
  updatedAt: string,
): string {
  let content = existingContent;

  // Sanitize: strip any [GONE] markers from the Triage Overview table.
  // [GONE] must only appear on individual email rows, never on overview summary rows.
  const overviewMatch = content.match(/## Triage Overview\n([\s\S]*?)(?=\n## )/);
  if (overviewMatch) {
    const cleanedOverview = overviewMatch[0].replace(/ \[GONE\]/g, "");
    content = content.replace(overviewMatch[0], cleanedOverview);
  }

  // Mark [GONE] emails (IDs in note but no longer in inbox)
  // Split content at the first stage heading (## [) to avoid applying table-row
  // regex to the Triage Overview summary table. The overview has rows like
  // "| VIP | 1 | |" which must never get [GONE] markers.
  const stageHeadingIdx = content.search(/\n## \[/);
  const preStages = stageHeadingIdx >= 0 ? content.slice(0, stageHeadingIdx + 1) : "";
  let stageContent = stageHeadingIdx >= 0 ? content.slice(stageHeadingIdx + 1) : content;

  for (const id of goneIds) {
    // Match mini-block headers: #### `ID` ... or #### [ID](...)
    stageContent = stageContent.replace(
      new RegExp(`(#### (?:\\[\`?${id}\`?\\]\\([^)]*\\)|\`${id}\`))(.*?)(\n)`, "g"),
      (_, prefix, rest, nl) => rest.includes("[GONE]") ? `${prefix}${rest}${nl}` : `${prefix}${rest} [GONE]${nl}`,
    );
    // Match table rows: | ID [i] | or | [ID](...) [g] |
    stageContent = stageContent.replace(
      new RegExp(`^(\\| (?:\\[\`?${id}\`?\\]\\([^)]*\\)|\`?${id}\`?)(?:\\s*\\[[a-z]\\])? \\|)(.*?\n)`, "gm"),
      (full, cell, rest) => rest.includes("[GONE]") ? full : `${cell.replace(" |", " [GONE] |")}${rest}`,
    );
    // Match checkbox items: - [x] `ID` or - [ ] `ID` or - [x] [ID](...)
    stageContent = stageContent.replace(
      new RegExp(`(- \\[[x ]\\] (?:\\[\`?${id}\`?\\]\\([^)]*\\)|\`${id}\`))(.*)(\n)`, "g"),
      (_, prefix, rest, nl) => rest.includes("[GONE]") ? `${prefix}${rest}${nl}` : `${prefix}${rest} [GONE]${nl}`,
    );
  }

  // Rejoin: pre-stages (includes overview) + stage sections (with [GONE] markers)
  content = stageHeadingIdx >= 0 ? preStages + stageContent : stageContent;

  if (newEmails.length === 0) {
    // No new emails -- just update the summary timestamp and reconcile the
    // stage summary line (Bug B fix: re-classification can shift counts
    // without adding emails, leaving the human-readable header stale).
    const genTime = formatDatetime(new Date(updatedAt));
    const origGenMatch = content.match(/Generated: (\S+)/);
    const origGenTime = origGenMatch ? origGenMatch[1] : genTime;
    content = content.replace(
      /Generated: [^\n]+/,
      `Generated: ${origGenTime} | Updated: ${genTime} (+0 new)`,
    );
    content = reconcileStageSummary(content);
    return content;
  }

  // Dedup guard: filter out any emails whose IDs are already in the note
  // (belt-and-suspenders -- caller should have filtered, but format mismatches can slip through)
  // Require 4+ digits to avoid matching overview table counts (e.g. | VIP | 1 | |)
  const existingIds = new Set<string>();
  for (const m of content.matchAll(/(?:####\s+(?:\[`?|`)(\d+)(?:`?\]|\`))|(?:\|\s*(?:\[`?)?(\d+)(?:`?\])?(?:\([^)]*\))?(?:\s*\[[a-z]\])?\s*\|)|(?:-\s*\[[x ]\]\s*(?:\[`?(\d+)`?\]\([^)]*\)|`(\d+)`))/g)) {
    const id = m[1] ?? m[2] ?? m[3] ?? m[4];
    if (id && id.length >= 4) existingIds.add(id);
  }
  let dedupedEmails = newEmails.filter(e => !existingIds.has(e.id));
  if (dedupedEmails.length === 0 && goneIds.size === 0) return content;

  // Group new emails by funnel stage
  const byStage = new Map<FunnelStage, ClassifiedEmail[]>();
  for (const email of dedupedEmails) {
    const list = byStage.get(email.funnelStage) ?? [];
    list.push(email);
    byStage.set(email.funnelStage, list);
  }

  // Stage section patterns: heading regex -> how to format new items
  const stageConfigs: Array<{
    stage: FunnelStage;
    headingPattern: RegExp;
    format: (emails: ClassifiedEmail[]) => string;
    insertMode: "after-description" | "after-table-header";
  }> = [
    {
      stage: "vip",
      headingPattern: /## \[.?\] Stage 1: VIP \((\d+)\)/,
      format: (emails) => emails.map(e => formatEmailBlock(e, "R")).join("\n"),
      insertMode: "after-description",
    },
    {
      stage: "follow_up_due",
      headingPattern: /## \[.?\] Follow-Up Due \((\d+)\)/,
      format: (emails) => emails.map(e => formatEmailBlock(e, "R")).join("\n"),
      insertMode: "after-description",
    },
    {
      stage: "action",
      headingPattern: /## \[.?\] Stage 2: Action Required \((\d+)\)/,
      format: (emails) => emails.map(e => formatEmailBlock(e, "R")).join("\n"),
      insertMode: "after-description",
    },
    {
      stage: "financial",
      headingPattern: /## \[.?\] Stage 3: Financial & Documents \((\d+)\)/,
      format: (emails) => emails.map(e => formatFinancialRow(e)).join("\n"),
      insertMode: "after-table-header",
    },
    {
      stage: "informational",
      headingPattern: /## \[.?\] Stage 4: Informational \((\d+)\)/,
      format: (emails) => emails.map(e => formatInformationalRow(e)).join("\n"),
      insertMode: "after-table-header",
    },
    {
      stage: "bulk_dispose",
      headingPattern: /## \[.?\] Stage 5: Bulk Dispose \((\d+)\)/,
      format: (emails) => emails.map(e => formatBulkDisposeRow(e)).join("\n"),
      insertMode: "after-table-header",
    },
    {
      stage: "auto_processed",
      headingPattern: /## \[.?\] Stage 6: Auto-Processed \((\d+)\)/,
      format: (emails) => emails.map(e => formatAutoProcessedRow(e)).join("\n"),
      insertMode: "after-table-header",
    },
  ];

  for (const config of stageConfigs) {
    const stageEmails = byStage.get(config.stage);
    if (!stageEmails || stageEmails.length === 0) continue;

    const headingMatch = content.match(config.headingPattern);
    if (!headingMatch) {
      // Section doesn't exist (e.g., Follow-Up Due) -- skip for now
      // TODO: create section if needed
      continue;
    }

    // Stage heading counts will be reconciled after all insertions (see below)

    // Find the insertion point
    const headingIdx = content.indexOf(headingMatch[0]);
    const sectionStart = headingIdx + headingMatch[0].length;

    // Find the next ## heading (section boundary)
    const nextSectionMatch = content.slice(sectionStart).match(/\n## /);
    const sectionEnd = nextSectionMatch ? sectionStart + nextSectionMatch.index! : content.length;
    const sectionContent = content.slice(sectionStart, sectionEnd);

    const newContent = config.format(stageEmails);

    if (config.insertMode === "after-table-header") {
      // Find the table separator row (| --- | ... |)
      const sepMatch = sectionContent.match(/(\| ---[^\n]*\n)/);
      if (sepMatch) {
        // Insert after separator row
        const insertPos = sectionStart + sepMatch.index! + sepMatch[0].length;
        content = content.slice(0, insertPos) + newContent + "\n" + content.slice(insertPos);
      } else if (sectionContent.includes("*None*")) {
        // Section had no items -- replace *None* with table + rows
        const noneIdx = sectionStart + sectionContent.indexOf("*None*");
        const stageHeaders: Record<string, string> = {
          financial: FINANCIAL_TABLE_HEADER,
          informational: INFORMATIONAL_TABLE_HEADER,
          bulk_dispose: BULK_DISPOSE_TABLE_HEADER,
          auto_processed: AUTO_PROCESSED_TABLE_HEADER,
        };
        const tableHeader = stageHeaders[config.stage] ?? FINANCIAL_TABLE_HEADER;
        content = content.slice(0, noneIdx) + tableHeader + "\n" + newContent + "\n" + content.slice(noneIdx + "*None*\n".length);
      }
    } else {
      // after-description: insert after the first *italic* description line
      const descMatch = sectionContent.match(/(\*[^*]+\*\n)/);
      if (descMatch) {
        const insertPos = sectionStart + descMatch.index! + descMatch[0].length;
        content = content.slice(0, insertPos) + newContent + "\n" + content.slice(insertPos);
      }
    }
  }

  // Reconcile all counts from actual content (not blind increments)
  // Stage heading counts
  for (const config of stageConfigs) {
    const hm = content.match(config.headingPattern);
    if (!hm) continue;
    const actualCount = countStageEntries(content, config.headingPattern);
    const oldCountStr = hm[1];
    content = content.replace(hm[0], hm[0].replace(`(${oldCountStr})`, `(${actualCount})`));
  }

  // Bug B fix: reconcile the stage-summary line in the header block.
  content = reconcileStageSummary(content);

  // Frontmatter totals -- count all non-[GONE] entries across all stages
  const reviewStageConfigs = stageConfigs.filter(c =>
    (["vip", "follow_up_due", "action", "financial", "informational"] as FunnelStage[]).includes(c.stage));
  const autoStageConfigs = stageConfigs.filter(c =>
    (["bulk_dispose", "auto_processed"] as FunnelStage[]).includes(c.stage));

  const reviewCount = reviewStageConfigs.reduce((sum, c) => sum + countStageEntries(content, c.headingPattern), 0);
  const autoCount = autoStageConfigs.reduce((sum, c) => sum + countStageEntries(content, c.headingPattern), 0);
  const totalCount = reviewCount + autoCount;

  content = content.replace(/^total: \d+/m, `total: ${totalCount}`);
  content = content.replace(/^review-count: \d+/m, `review-count: ${reviewCount}`);
  content = content.replace(/^auto-count: \d+/m, `auto-count: ${autoCount}`);

  // Unread: increment by newly added unread emails (can't reconcile from content)
  const unreadNew = dedupedEmails.filter(e => !e.isRead).length;
  if (unreadNew > 0) {
    content = content.replace(/^unread: (\d+)/m, (_, old) => `unread: ${parseInt(old, 10) + unreadNew}`);
  }

  // Append new email IDs to account-map
  const newMapEntries = dedupedEmails
    .map(e => `${e.id}:${resolveAccountAlias(e.account ?? "iCloud") ?? "i"}`)
    .join(",");
  content = content.replace(/^(account-map: ")([^"]*)"$/m, `$1$2,${newMapEntries}"`);

  // Update modified timestamp
  const modifiedTime = new Date().toISOString().replace(/\.\d+Z$/, "");
  content = content.replace(/^modified: .+$/m, `modified: ${modifiedTime}`);

  // Update summary line with merge annotation
  const genTime = formatDatetime(new Date(updatedAt));
  const origGenMatch = content.match(/Generated: (\S+)/);
  const origGenTime = origGenMatch ? origGenMatch[1] : genTime;
  content = content.replace(
    /Generated: [^\n]+/,
    `Generated: ${origGenTime} | Updated: ${genTime} (+${dedupedEmails.length} new)`,
  );

  return content;
}

export interface GenerateResult {
  session: TriageSession;
  outputPath: string;
  markdown: string;
}

export async function generateTriage(options: GenerateOptions): Promise<GenerateResult> {
  const { testMode, date, outputDir, dbPath, skipAI, accountFilter, force, fetchAll, onProgress } = options;
  const progress = onProgress ?? (() => {});
  const startTime = Date.now();

  // Phase timing instrumentation. Captures wall-clock duration per phase
  // so regressions are detectable in the triage note frontmatter.
  const phaseTimings: Record<string, number> = {};
  const phase = async <T>(name: string, fn: () => Promise<T> | T): Promise<T> => {
    const t0 = Date.now();
    try {
      return await fn();
    } finally {
      const dt = Date.now() - t0;
      phaseTimings[name] = (phaseTimings[name] ?? 0) + dt;
      progress("phase-timing", `${name}=${dt}ms`);
      if (process.env.EMAILTRIAGE_PROFILE === "1") {
        console.error(`[phase] ${name}=${dt}ms`);
      }
    }
  };

  // 0. Check for existing note (incremental mode)
  const outDir = outputDir ?? join(VAULT_ROOT, "Email Triage");
  const outPath = getOutputPath(date, outputDir);
  let existingNote: string | undefined;
  let existingState: TriageNoteState | undefined;
  if (!force && existsSync(outPath)) {
    existingNote = readFileSync(outPath, "utf-8");
    existingState = parseExistingNote(existingNote);
    progress("incremental", `Found existing note with ${existingState.knownIds.size} emails`);
  }

  // 0b. Pre-cron Gmail auth (Phase 2) — skip Gmail half on failure
  let skipGmail = false;
  let operationalBanner: string | undefined;
  if (!testMode) {
    const pre = runPreCronAuthCheck();
    operationalBanner = pre.banner;
    if (!pre.gmailOk) {
      skipGmail = true;
      progress("precron", "Gmail auth failed — skipping Gmail half");
      if (accountFilter === "g") {
        const session = buildTriageSession([], date, 0, "g", operationalBanner);
        let markdown = formatTriageNote(session);
        if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
        await Bun.write(outPath, markdown);
        progress("done", "Gmail-only run skipped — auth failure banner written");
        return { session, outputPath: outPath, markdown };
      }
    }
  }

  const effectiveAccountFilter: AccountAlias | undefined =
    skipGmail && !accountFilter ? "i" : accountFilter;

  // 1. Fetch emails from inbox (optionally filtered by account)
  const filterLabel = effectiveAccountFilter ? ` (account: ${effectiveAccountFilter})` : "";
  progress("fetch", `Fetching emails from Apple Mail${filterLabel}…`);
  const { emails: rawEmails, inboxTotal } = await phase("fetch", () =>
    fetchEmails(testMode, effectiveAccountFilter, fetchAll));

  // 1a. Fetch emails already in staging folders (live mode only).
  //     These were sorted by a previous triage run and should appear in the note
  //     at their existing stage without re-classification or re-sorting.
  let stagedEmails: StagedEmail[] = [];
  const stagedIds = new Set<string>();
  if (!testMode) {
    progress("staged", "Checking staging folders for previously sorted emails…");
    stagedEmails = await phase("staged", () => fetchStagedEmails(effectiveAccountFilter, onProgress));
    for (const s of stagedEmails) stagedIds.add(s.raw.id);
  }

  // 1b. Delta detection: only process new emails in incremental mode
  //     Staged emails count as "known" -- they shouldn't appear as "gone"
  let emailsToProcess: RawEmail[];
  let goneIds = new Set<string>();
  if (existingState && !force) {
    const fetchedIds = new Set([...rawEmails.map(e => e.id), ...stagedIds]);
    emailsToProcess = rawEmails.filter(e => !existingState!.knownIds.has(e.id) && !stagedIds.has(e.id));
    goneIds = new Set([...existingState.knownIds].filter(id => !fetchedIds.has(id)));
    progress("incremental", `Incremental: ${emailsToProcess.length} new, ${stagedEmails.length} staged, ${goneIds.size} gone`);
  } else {
    // In full generation, exclude inbox emails already in staging folders (avoid duplicates)
    emailsToProcess = rawEmails.filter(e => !stagedIds.has(e.id));
    progress("fetch", `${force ? "Force regeneration" : "Full generation"}: ${emailsToProcess.length} inbox + ${stagedEmails.length} staged${filterLabel}`);
  }

  // 2. Load DB and build classification cache
  progress("rules", "Loading rules and known senders from database…");
  const skillDir = getSkillDir();
  const db = initDb(dbPath ?? join(skillDir, "triage.db"));
  // Seeds (rules.yaml, junk-senders.yaml) live under <skill-root>/References/
  runMigration(db, join(skillDir, "References"));
  // Wire reference auto-regeneration hook (only in production, not testMode)
  if (!testMode) {
    setReferenceHook((hookDb, type) => regenerateReference(hookDb, type));
  }
  const cache = buildClassificationCache(db);

  // 3. Classify only new/unprocessed emails with rules engine (deterministic pass)
  //    Cache loaded BEFORE upsert so first-time senders are correctly flagged as unknown
  progress("classify", `Classifying ${emailsToProcess.length} emails with rules…`);
  const classified: ClassifiedEmail[] = await phase("rules", () => emailsToProcess.map((email) =>
    classifyEmail(email, cache),
  ));

  // 4. Populate known_senders table (Phase 13.5)
  //    Upsert AFTER classification so isUnknownSender reflects pre-run state.
  //    Future runs will see these senders as known.
  for (const email of emailsToProcess) {
    addKnownSender(db, email.fromAddress.toLowerCase());
  }

  // 5. AI classification for all emails that weren't matched by rules
  //    (priority === "unknown" means no rule matched)
  const needsAI = classified.filter(e => e.matchedRule === null);

  if (needsAI.length > 0 && !skipAI && !testMode) {
    progress("ai", `AI classifying ${needsAI.length} emails…`);
    // Extract raw emails for AI batch call
    const rawForAI = needsAI.map(c => emailsToProcess.find(r => r.id === c.id)!).filter(Boolean);

    // First pass: classify (no bodies needed — uses subject/snippet)
    const aiResults = await phase("ai", () => batchClassifyEmails(rawForAI));

    // Lazy drafts (Opt 3): skip body fetch and draft generation during triage note generation.
    // Drafts are generated on demand in Web UI or during /process-email execution.

    // Apply AI results back to classified emails (classification only, no drafts)
    for (const email of classified) {
      if (email.matchedRule !== null) continue; // Skip rule-matched
      const aiResult = aiResults.get(email.id);
      if (aiResult) {
        email.aiActionType = aiResult.aiActionType;
        email.funnelStage = aiResult.funnelStage;
        email.priority = aiResult.priority;
        email.matchedRule = `ai:${aiResult.aiActionType}`;
        email.aiSummary = aiResult.reason;
        if (aiResult.isUnsub) {
          email.priority = "unsub";
        }
      }
    }
  } else if (testMode || skipAI) {
    // In test mode without AI, assign funnel stages based on priority for unmatched emails
    for (const email of classified) {
      if (email.matchedRule === null) {
        // Default unmatched emails to informational in test mode
        email.funnelStage = "informational";
        email.priority = "review";
        email.matchedRule = "default";
      }
    }
  }

  // Phase 24 v1 — opt-in autopilot pre-marking via EMAILTRIAGE_AUTOPILOT=1
  // env var. When enabled, post-classification we run scanForAutonomousActions
  // and override the funnelStage/priority for high-confidence historical
  // matches (e.g. AI said "review", history says "trashed 12 of 12 times"
  // → autopilot picks trash). Multi-layered safety boundaries enforced
  // inside scanForAutonomousActions (no VIP override, only A/T/U).
  if (process.env.EMAILTRIAGE_AUTOPILOT === "1" && !testMode) {
    try {
      const { scanForAutonomousActions } = await import("./AutonomousActions");
      const { Database: SqliteDb } = await import("bun:sqlite");
      const apDb = new SqliteDb(dbPath ?? join(skillDir, "triage.db"));
      const apInputs = classified.map(e => ({
        emailId: e.id,
        fromAddress: e.fromAddress,
        fromDomain: e.fromDomain,
        isVip: e.isVip,
        funnelStage: e.funnelStage,
      }));
      const scan = scanForAutonomousActions(apDb, apInputs);
      apDb.close();
      const recsById = new Map(scan.recommendations.map(r => [r.emailId, r]));
      for (const email of classified) {
        const rec = recsById.get(email.id);
        if (!rec) continue;
        // Map action code → funnelStage / priority
        if (rec.action === "T") { email.funnelStage = "auto_processed"; email.priority = "trash"; }
        else if (rec.action === "A") { email.funnelStage = "auto_processed"; email.priority = "archive"; }
        else if (rec.action === "U") { email.priority = "unsub"; }
        email.matchedRule = `autopilot:${rec.basis.slice(0, 60)}`;
      }
      progress("classify", `Autopilot pre-marked ${scan.recommendations.length} emails`);
    } catch (err) {
      console.warn(`[generate-triage] autopilot failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  progress("classify", `Rules matched ${classified.filter(e => e.matchedRule !== null).length} of ${classified.length}`);

  // 5b. Fetch bodies for VIP and Action emails (Stages 1-2) and classify inclusion
  const bodyStages: FunnelStage[] = ["vip", "action"];
  const needsBodies = classified.filter(e => bodyStages.includes(e.funnelStage));
  if (needsBodies.length > 0 && !testMode) {
    progress("bodies", `Fetching bodies for ${needsBodies.length} VIP/Action emails…`);
    const bodyIds = needsBodies.map(e => e.id);
    const bodyAccountMap = new Map<string, AccountAlias>();
    for (const e of needsBodies) {
      const a = resolveAccountAlias(e.account ?? "iCloud") ?? "i";
      bodyAccountMap.set(e.id, a);
    }
    const bodies = await phase("bodies", () => fetchEmailBodies(bodyIds, undefined, bodyAccountMap));

    for (const email of needsBodies) {
      const rawBody = bodies.get(email.id);
      if (!rawBody) continue;
      const { inclusion, rendered } = classifyBodyInclusion(rawBody);
      email.bodyInclusion = inclusion;

      if (inclusion === "full" || inclusion === "truncated") {
        email.body = rendered;
      } else if (inclusion === "summary") {
        const summary = await generateAISummary(rawBody, email.subject);
        if (summary) email.body = summary;
        if (!email.body) email.body = "(Body too long for inline display -- click ID link to view in Apple Mail)";
      } else if (inclusion === "blocked") {
        email.body = "[SECURITY: suspicious content detected -- review in Apple Mail only]";
      }
    }
    progress("bodies", `Processed ${bodies.size} bodies`);
  }

  // 5b2. Extract financial metadata — Stage 3 emails AND any receipt/financial
  // email regardless of stage (Phase 28: a VIP-sender receipt gets the
  // Type/Vendor/Amount treatment, not skipped because VIP routing put it in
  // Stage 1 instead of Stage 3).
  for (const email of classified) {
    if (shouldExtractFinancial(email)) extractFinancialMetadata(email);
  }

  // 5c. Resurface overdue follow-ups
  const overdueFollowUps = getOverdueFollowUps(db, date);
  if (overdueFollowUps.length > 0) {
    progress("followups", `Found ${overdueFollowUps.length} overdue follow-ups, checking for replies…`);
    for (const fu of overdueFollowUps) {
      // In live mode, check if a reply was already sent via Apple Mail
      const replySent = !testMode && checkReplySent(fu.sender, fu.originalDate);
      if (replySent) {
        // Mark as resolved — reply was sent
        resolveFollowUp(db, fu.emailId);
        continue;
      }
      // Create a synthetic ClassifiedEmail for the follow-up
      const syntheticEmail: ClassifiedEmail = {
        id: fu.emailId,
        subject: fu.subject,
        from: `${fu.sender} <${fu.sender}>`,
        fromAddress: fu.sender,
        fromDomain: fu.sender.split("@")[1] ?? "",
        date: fu.originalDate,
        isRead: true,
        hasAttachment: false,
        snippet: "",
        account: "iCloud",
        priority: "action",
        funnelStage: "follow_up_due",
        matchedRule: `follow-up:${fu.followUpDate}`,
        folder: null,
        replyDraft: null,
        isVip: false,
        isJunk: false,
        isUnknownSender: false,
        aiSummary: `Follow-up due ${fu.followUpDate} -- no reply detected`,
      };
      classified.push(syntheticEmail);
    }
  }

  // 5d. (Message-ID fetch moved to after staged merge -- see step 5f below)

  // 5e. Convert staged emails to ClassifiedEmail and merge.
  //      Re-classify through rules engine to recover original rule (junk, routing, etc.)
  //      but keep the authoritative funnelStage from the staging folder.
  // Track emails whose physical folder needs to change because re-classification
  // disagrees with the staging folder they currently live in (Bug A fix —
  // previously the doc rendered the new classification but the physical mailbox
  // stayed in the old folder, so the doc and the mailbox state could disagree).
  const needsRestaging: Array<{ id: string; account: string; currentStage: FunnelStage; newStage: FunnelStage }> = [];

  const stagedClassified: ClassifiedEmail[] = stagedEmails.map(s => {
    const reclassified = classifyEmail(s.raw, cache);
    // If rules engine matched a deterministic rule, trust it over the staging folder.
    // Staging folder authority only applies when no rule matched (AI-classified or user-placed).
    const ruleMatched = reclassified.matchedRule !== null;
    const funnelStage = ruleMatched ? reclassified.funnelStage : s.funnelStage;
    // Re-staging needed when a deterministic rule re-classifies an already-
    // staged email into a different stage — most importantly VIP, which must
    // physically land in Stage 1 - VIP regardless of any secondary tag.
    if (ruleMatched && funnelStage !== s.funnelStage && reclassified.account) {
      needsRestaging.push({
        id: reclassified.id,
        account: reclassified.account,
        currentStage: s.funnelStage,
        newStage: funnelStage,
      });
    }
    return {
      ...reclassified,
      funnelStage,
      matchedRule: reclassified.matchedRule ?? `staged:${s.stageFolderPath}`,
      isVip: funnelStage === "vip",
    };
  });
  const finalEmails = [...classified, ...stagedClassified];

  // PARALLEL_MSGIDS_REFINE_V1
  // 5f/5g/5h combined: kick off three independent I/O-bound tasks in parallel
  //   A. fetchMessageIds (Apple Mail scan) -- no dep on email metadata beyond ids
  //   B. fetchEmailBodies for staged VIP/Action + body inclusion classification
  //   C. condenseTableSubjects + applyArchiveFolderSuggestions (AI batch)
  // All three run concurrently; the slowest determines wall time.
  // Extract financial metadata is sync and happens inline (cheap).

  // Phase 28: same stage-independent gate for staged emails.
  for (const email of stagedClassified) {
    if (shouldExtractFinancial(email)) extractFinancialMetadata(email);
  }

  const stagedNeedsBodies = stagedClassified.filter(e => bodyStages.includes(e.funnelStage));

  // Task A: Message-IDs
  const taskMsgIds = (async () => {
    if (testMode) return;
    // Phase 1: GwsGmailTransport.list already populates RawEmail.messageId from the API
    // response, so Gmail emails do not need the Mail.app Envelope-Index probe (and would
    // not be found there post-cutover anyway). Restrict the lookup to non-Gmail IDs and
    // preserve any pre-populated value when assigning back.
    const mailAppEmails = finalEmails.filter(e => (resolveAccountAlias(e.account ?? "iCloud") ?? "i") !== "g");
    const allIds = mailAppEmails.map(e => e.id);
    const msgIdMailboxMap = new Map<string, string>();
    for (const s of stagedEmails) {
      const alias = resolveAccountAlias(s.raw.account ?? "iCloud") ?? "i";
      if (alias === "g") continue;
      const path = s.stageFolderPath;
      const stripped = path.includes("/") ? path.slice(path.indexOf("/") + 1) : path;
      msgIdMailboxMap.set(s.raw.id, stripped);
    }
    progress("messageids", `Fetching Message-IDs for ${allIds.length} emails…`);
    const messageIds = allIds.length > 0
      ? await phase("messageids", () => fetchMessageIds(allIds, msgIdMailboxMap))
      : new Map<string, string>();
    for (const email of finalEmails) {
      if (email.messageId) continue;  // already populated (e.g. from GwsGmailTransport.list)
      const msgId = messageIds.get(email.id);
      if (msgId) email.messageId = msgId;
    }
    progress("messageids", `Got ${messageIds.size} Message-IDs`);
  })();

  // Task B: staged bodies
  const taskStagedBodies = (async () => {
    if (testMode || stagedNeedsBodies.length === 0) return;
    progress("bodies", `Fetching bodies for ${stagedNeedsBodies.length} staged VIP/Action emails…`);
    const stagedMailboxMap = new Map<string, string>();
    for (const email of stagedNeedsBodies) {
      const staged = stagedEmails.find(s => s.raw.id === email.id);
      if (staged) {
        const path = staged.stageFolderPath;
        const stripped = path.includes("/") ? path.slice(path.indexOf("/") + 1) : path;
        stagedMailboxMap.set(email.id, stripped);
      }
    }
    const stagedBodyIds = stagedNeedsBodies.map(e => e.id);
    const stagedAccountMap = new Map<string, AccountAlias>();
    for (const e of stagedNeedsBodies) {
      const a = resolveAccountAlias(e.account ?? "iCloud") ?? "i";
      stagedAccountMap.set(e.id, a);
    }
    const stagedBodies = await phase("bodies-staged", () => fetchEmailBodies(stagedBodyIds, stagedMailboxMap, stagedAccountMap));

    for (const email of stagedNeedsBodies) {
      const rawBody = stagedBodies.get(email.id);
      if (!rawBody) continue;
      const { inclusion, rendered } = classifyBodyInclusion(rawBody);
      email.bodyInclusion = inclusion;

      if (inclusion === "full" || inclusion === "truncated") {
        email.body = rendered;
      } else if (inclusion === "summary") {
        const summary = await generateAISummary(rawBody, email.subject);
        if (summary) email.body = summary;
        if (!email.body) email.body = "(Body too long for inline display -- click ID link to view in Apple Mail)";
      } else if (inclusion === "blocked") {
        email.body = "[SECURITY: suspicious content detected -- review in Apple Mail only]";
      }
    }
    progress("bodies", `Processed ${stagedBodies.size} staged bodies`);
  })();

  // Task C: refinement (subjects + archive folders)
  const allEmailsForRefinement = [...finalEmails];
  const taskRefine = (async () => {
    progress("refine", "Refining subjects and suggesting archive folders…");
    await phase("refine", async () => {
      await condenseTableSubjects(allEmailsForRefinement);
      applyArchiveFolderSuggestions(allEmailsForRefinement);
    });
  })();

  await Promise.all([taskMsgIds, taskStagedBodies, taskRefine]);

  // 6. Build session and format markdown FIRST (Opt 4: write note before sort)
  let markdown: string;
  let session: TriageSession;

  if (existingNote && existingState && !force) {
    // Incremental mode: merge new emails into existing note
    progress("write", `Merging ${finalEmails.length} new emails into existing note…`);
    session = buildTriageSession(finalEmails, date, inboxTotal, accountFilter, operationalBanner);
    markdown = mergeIntoExistingNote(existingNote, finalEmails, goneIds, new Date().toISOString());
    if (operationalBanner) {
      markdown = injectBannerAfterFrontmatter(stripOperationalBanners(markdown), operationalBanner);
    }
  } else {
    // Full generation mode
    progress("write", "Building triage note…");
    session = buildTriageSession(finalEmails, date, inboxTotal, accountFilter, operationalBanner);
    markdown = formatTriageNote(session);
  }

  // 6b. Inject generation timing into markdown
  const durationMs = Date.now() - startTime;
  const durationSec = Math.round(durationMs / 1000);
  // Replace existing generation-time if present, otherwise insert after status
  if (/^generation-time:/m.test(markdown)) {
    markdown = markdown.replace(/^generation-time:.*$/m, `generation-time: ${durationSec}s`);
  } else {
    markdown = markdown.replace(/^(status: pending)$/m, `$1\ngeneration-time: ${durationSec}s`);
  }
  // Inject per-phase timings so regressions are detectable in future runs
  const phaseTimingStr = Object.entries(phaseTimings)
    .sort((a, b) => b[1] - a[1])
    .map(([name, ms]) => `${name}=${Math.round(ms / 100) / 10}s`)
    .join(",");
  if (/^phase-timings:/m.test(markdown)) {
    markdown = markdown.replace(/^phase-timings:.*$/m, `phase-timings: ${phaseTimingStr}`);
  } else {
    markdown = markdown.replace(/^(generation-time: [^\n]+)$/m, `$1\nphase-timings: ${phaseTimingStr}`);
  }
  // Replace or append Gen time in header (avoid accumulation on re-runs)
  if (/Gen time: \d+s/.test(markdown)) {
    markdown = markdown.replace(/Gen time: \d+s/, `Gen time: ${durationSec}s`);
  } else {
    markdown = markdown.replace(/(Generated: [^\n]+)/, `$1 | Gen time: ${durationSec}s`);
  }

  // 7. Write to output immediately (before sorting -- user sees note faster)
  if (!existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true });
  }
  // Ensure Reference/ and Staged/ subfolders exist (Phase 15.1)
  for (const sub of ["Reference", "Staged", "Staged/Sent"]) {
    const subPath = join(outDir, sub);
    if (!existsSync(subPath)) mkdirSync(subPath, { recursive: true });
  }
  await Bun.write(outPath, markdown);

  // 7b. Optional Slack/Discord notification (Phase 23). Fires only if
  //     SLACK_WEBHOOK_URL or DISCORD_WEBHOOK_URL is set in the environment.
  //     Silent no-op otherwise. Wrapped in try/catch — webhook failure
  //     must not abort the triage write.
  if (!testMode && (process.env.SLACK_WEBHOOK_URL || process.env.DISCORD_WEBHOOK_URL)) {
    try {
      const { postToSlack, formatTriageSummary } = await import("./SlackBridge");
      const vipCount = finalEmails.filter(e => e.funnelStage === "vip").length;
      const toProcess = finalEmails.filter(e => ["vip", "action", "financial", "informational", "follow_up_due"].includes(e.funnelStage)).length;
      const automated = finalEmails.length - toProcess;
      const text = formatTriageSummary({
        date,
        total: finalEmails.length,
        toProcess,
        automated,
        vip: vipCount,
      });
      await postToSlack({ text });
    } catch (err) {
      console.warn(`[generate-triage] Slack notification failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 8. Sort to per-account stage folders AFTER note is written (live mode only)
  //    Only sort NEW emails -- already-sorted emails from existing note are skipped (Task E).
  if (!testMode) {
    progress("sort", "Ensuring per-account stage folders exist…");
    ensureStageFolders();

    progress("sort", `Sorting ${classified.length} new emails to per-account stage folders…`);
    const { sorted, errors } = await phase("sort", () => sortToStageFolders(classified, onProgress));
    progress("sort", `Sorted ${sorted} emails${errors > 0 ? ` (${errors} errors)` : ""}`);

    // Bug A fix: re-stage already-staged emails whose deterministic classification
    // changed (most commonly: VIP added after the email was already in Stage 2/3).
    // Without this, the doc's Stage 1 — VIP section would show emails that
    // physically still live in their old Stage 2/3 folders.
    if (needsRestaging.length > 0) {
      progress("sort", `Re-staging ${needsRestaging.length} reclassified emails (e.g. VIP-promoted)…`);
      let restaged = 0;
      let restageErrors = 0;
      for (const r of needsRestaging) {
        const accountAlias = resolveAccountAlias(r.account);
        if (!accountAlias) { restageErrors++; continue; }
        try {
          if (accountAlias === "g") {
            await transportFor("g").moveToStage(r.id, r.newStage);
            restaged++;
          } else {
            // iCloud / Mail.app path: apple-mail.sh move <id> <destFolder> --mailbox <srcFolder>
            // Already-staged emails live in their currentStage folder, NOT INBOX
            // (which is apple-mail.sh move's default source). Without --mailbox the
            // move would silently fail because find_msg searches the wrong mailbox.
            const destFolder = getStageFolderPath(r.newStage, accountAlias);
            if (!destFolder) { restageErrors++; continue; }
            const srcFolder = getStageFolderPath(r.currentStage, accountAlias);
            const args = ["bash", APPLE_MAIL_SH, "move", r.id, destFolder];
            if (srcFolder) args.push("--mailbox", srcFolder);
            const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
            const exitCode = await proc.exited;
            if (exitCode === 0) restaged++; else restageErrors++;
          }
        } catch {
          restageErrors++;
        }
      }
      progress("sort", `Re-staged ${restaged} emails${restageErrors > 0 ? ` (${restageErrors} errors)` : ""}`);
    }

    // 8b. Reconcile IDs: Apple Mail reassigns numeric IDs when moving messages.
    //     Re-read staging folders, match by subject+sender, update the triage note in-place.
    if (sorted > 0) {
      progress("reconcile", "Reconciling post-sort IDs…");
      const idMap = await phase("reconcile", () => buildPostSortIdMap(classified, onProgress));
      if (idMap.size > 0) {
        reconcileTriageNoteIds(outPath, idMap);
        progress("reconcile", `Updated ${idMap.size} ID(s) in triage note`);
      }
    }
  }

  // 9. Record session in DB (with deduplication -- Task D)
  const archived = finalEmails.filter((e) => e.priority === "archive").length;
  const trashed = finalEmails.filter((e) => e.priority === "trash").length;
  const existingSession = db.prepare("SELECT id FROM triage_history WHERE date = ?").get(date) as { id: number } | null;
  if (existingSession) {
    // Update existing session record instead of inserting duplicate
    db.prepare("UPDATE triage_history SET total = total + ?, archived = archived + ?, trashed = trashed + ? WHERE date = ?")
      .run(finalEmails.length, archived, trashed, date);
  } else {
    recordTriageSession(db, {
      date,
      total: session.total,
      archived,
      trashed,
      replied: 0,
      durationSec: 0,
    });
  }

  // 9b. Flush any pending reference file updates (only writes if data changed this run)
  const refsUpdated = flushPendingReferences(db);
  if (refsUpdated > 0) {
    progress("reference", `Updated ${refsUpdated} reference file(s)`);
  }

  db.close();

  // 10. Check for urgent emails and send iMessage alert (Phase 15.3)
  if (!testMode) {
    const urgentItems = detectUrgentEmails(finalEmails, date);
    if (urgentItems.length > 0) {
      sendUrgentAlert(urgentItems);
    }
  }

  const modeLabel = existingState && !force ? `Incremental update — +${finalEmails.length} new` : `Complete — ${session.total} emails`;
  progress("done", `${modeLabel}, ~${session.estimatedMinutes} min review`);
  return { session, outputPath: outPath, markdown };
}

// ─── CLI entry point ───

async function main() {
  const args = process.argv.slice(2);
  const testMode = args.includes("--test");
  const skipAI = args.includes("--skip-ai");
  const force = args.includes("--force");
  const fetchAll = true; // Always fetch all inbox messages -- read msgs still need triage (was: unread-only opt)

  let date = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
  const dateIdx = args.indexOf("--date");
  if (dateIdx !== -1 && args[dateIdx + 1]) {
    date = args[dateIdx + 1];
  }

  // Parse --account flag (e.g., --account i, --account g)
  let accountFilter: AccountAlias | undefined;
  const acctIdx = args.indexOf("--account");
  if (acctIdx !== -1 && args[acctIdx + 1]) {
    const alias = resolveAccountAlias(args[acctIdx + 1]);
    if (!alias) {
      console.error(`Unknown account alias: "${args[acctIdx + 1]}". Use i (iCloud), g (Gmail), etc.`);
      process.exit(1);
    }
    accountFilter = alias;
  }

  const cliStart = Date.now();
  const result = await generateTriage({ testMode, date, skipAI, accountFilter, force, fetchAll });
  const cliDuration = Math.round((Date.now() - cliStart) / 1000);

  console.log(`\u2713 Triage note written to ${result.outputPath}`);
  console.log(
    `  ${result.session.total} emails | ${result.session.unread} unread | ~${result.session.estimatedMinutes} min review | Generated in ${cliDuration}s`,
  );

  // Funnel stage summary
  const stages: Record<string, number> = {};
  for (const e of result.session.emails) {
    stages[e.funnelStage] = (stages[e.funnelStage] ?? 0) + 1;
  }

  const stageOrder: FunnelStage[] = ["vip", "follow_up_due", "action", "financial", "informational", "bulk_dispose", "auto_processed"];
  const summary = stageOrder
    .filter(s => (stages[s] ?? 0) > 0)
    .map(s => `${s}: ${stages[s]}`)
    .join(" | ");

  console.log(`  ${summary}`);
}

if (import.meta.main) {
  main();
}
