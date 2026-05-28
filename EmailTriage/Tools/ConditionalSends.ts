// Tools/ConditionalSends.ts — Phase 21: conditional follow-up sends.
//
// "Follow up in 3 days if no response" — registers a scheduled send AND a
// conditional gate. On the trigger date, before the send fires, a checker
// looks for inbound emails from the recipient since the original outbound
// message. If found → cancel; otherwise → let SendLater send it.
//
// Storage: a JSON registry at <skill_root>/conditional-sends.json (separate
// from scheduled_sends DB table to avoid schema migration). The registry
// pairs the conditional with the scheduled_sends.id from SendLater so
// cancellation routes through the existing dispatcher.
//
// CLI:
//   bun Tools/ConditionalSends.ts register \
//     --recipient X --subject Y --body Z \
//     --original-sent-at "2026-05-19_10:00" \
//     --follow-up-at "2026-05-22_10:00"
//   bun Tools/ConditionalSends.ts check [--dry-run]    # runs from cron
//   bun Tools/ConditionalSends.ts list

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
// Bun is the runtime; the global is available at runtime but TS doesn't always
// declare it when 'bun-types' isn't in the per-file scope. Declared explicitly
// here to keep the file self-contained.
declare const Bun: { spawn(args: string[], opts?: { stdout?: string; stderr?: string }): { stdout: ReadableStream; stderr: ReadableStream; exited: Promise<number> } };

const SKILL_ROOT = join(process.env.HOME ?? "", ".claude/skills/EmailTriage");
const REGISTRY_PATH = join(SKILL_ROOT, "conditional-sends.json");

export interface ConditionalEntry {
  /** Caller-provided id; may match scheduled_sends.id when integrated with SendLater. */
  id: string;
  recipient: string;
  /** ISO date string — when the original message was sent. */
  originalSentAt: string;
  /** ISO date string — when the follow-up should fire if not cancelled. */
  followUpSendAt: string;
  /** True after the conditional check decided the recipient replied in time. */
  cancelled?: boolean;
  /** Why cancelled: 'recipient_replied' | 'manual'. */
  cancelReason?: string;
  /** Free-form context the user can add for clarity. */
  notes?: string;
}

export interface Registry {
  entries: ConditionalEntry[];
}

export function loadRegistry(path: string = REGISTRY_PATH): Registry {
  if (!existsSync(path)) return { entries: [] };
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Registry;
  } catch {
    return { entries: [] };
  }
}

export function saveRegistry(reg: Registry, path: string = REGISTRY_PATH): void {
  writeFileSync(path, JSON.stringify(reg, null, 2), "utf8");
}

export function registerConditional(entry: ConditionalEntry, path: string = REGISTRY_PATH): void {
  const reg = loadRegistry(path);
  // Replace if same id, else append
  const idx = reg.entries.findIndex(e => e.id === entry.id);
  if (idx >= 0) reg.entries[idx] = entry;
  else reg.entries.push(entry);
  saveRegistry(reg, path);
}

export function cancelConditional(id: string, reason: string, path: string = REGISTRY_PATH): boolean {
  const reg = loadRegistry(path);
  const entry = reg.entries.find(e => e.id === id);
  if (!entry || entry.cancelled) return false;
  entry.cancelled = true;
  entry.cancelReason = reason;
  saveRegistry(reg, path);
  return true;
}

/**
 * Decide whether each pending conditional should fire or be cancelled.
 * Takes a `replyChecker` so the actual mailbox query is injectable —
 * production hooks to `apple-mail.sh search` / `gws gmail search`; tests
 * pass a deterministic stub.
 */
export interface CheckOptions {
  /** When checking conditionals, the 'now' anchor — defaults to system clock. */
  now?: Date;
  /** Stub-injectable: returns true iff the recipient sent a reply since `since`. */
  replyChecker: (recipient: string, since: string) => Promise<boolean>;
  path?: string;
}

export interface CheckResult {
  decided: Array<{ id: string; recipient: string; action: "fire" | "cancel"; reason: string }>;
  pending: number;     // future conditionals not yet at follow-up date
  alreadyCancelled: number;
}

export async function checkPendingConditionals(opts: CheckOptions): Promise<CheckResult> {
  const reg = loadRegistry(opts.path ?? REGISTRY_PATH);
  const now = opts.now ?? new Date();
  const result: CheckResult = { decided: [], pending: 0, alreadyCancelled: 0 };

  for (const entry of reg.entries) {
    if (entry.cancelled) { result.alreadyCancelled++; continue; }
    const followUpDate = new Date(entry.followUpSendAt.replace("_", "T"));
    if (followUpDate > now) { result.pending++; continue; }

    // Conditional is ripe — check if recipient replied since the original send
    const replied = await opts.replyChecker(entry.recipient, entry.originalSentAt);
    if (replied) {
      entry.cancelled = true;
      entry.cancelReason = "recipient_replied";
      result.decided.push({ id: entry.id, recipient: entry.recipient, action: "cancel", reason: "recipient replied" });
    } else {
      result.decided.push({ id: entry.id, recipient: entry.recipient, action: "fire", reason: "no reply in window" });
    }
  }

  // Persist any cancellations
  if (result.decided.some(d => d.action === "cancel")) {
    saveRegistry(reg, opts.path ?? REGISTRY_PATH);
  }
  return result;
}

// ─── CLI ─────────────────────────────────────────────────────────────────

/**
 * Production reply-checker. Asks apple-mail.sh search for any email from
 * the recipient since the original send time. Returns true if found.
 * Falls back to false (cautious — better to fire a follow-up the user
 * doesn't need than to silently skip one they did need).
 */
async function defaultReplyChecker(recipient: string, since: string): Promise<boolean> {
  const APPLE_MAIL_SH = join(process.env.HOME ?? "", ".claude/skills/AppleMail/Tools/apple-mail.sh");
  if (!existsSync(APPLE_MAIL_SH)) {
    console.warn(`[conditional-sends] apple-mail.sh missing at ${APPLE_MAIL_SH} — defaulting to 'no reply' (will fire follow-up)`);
    return false;
  }
  try {
    // apple-mail.sh search returns lines of matched messages. Empty stdout means no matches.
    const sinceDate = since.split("_")[0];  // strip time, since search takes YYYY-MM-DD
    const proc = Bun.spawn(["bash", APPLE_MAIL_SH, "search", `from:${recipient} after:${sinceDate}`, "--mailbox", "all"], {
      stdout: "pipe", stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    // Any non-empty output (excluding the header line) = a match
    const lines = out.split("\n").filter(l => l.trim() && !l.startsWith("[") && !l.startsWith("Account:"));
    return lines.length > 0;
  } catch (err) {
    console.warn(`[conditional-sends] apple-mail.sh search failed for ${recipient}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

if (import.meta.main) {
  const cmd = process.argv[2];
  if (cmd === "list") {
    const reg = loadRegistry();
    for (const e of reg.entries) {
      const status = e.cancelled ? `cancelled (${e.cancelReason})` : "pending";
      console.log(`  ${e.id.padEnd(20)} → ${e.recipient.padEnd(40)} fire at ${e.followUpSendAt} [${status}]`);
    }
    console.log(`Total: ${reg.entries.length}`);
  } else if (cmd === "check") {
    const dryRun = process.argv.includes("--dry-run");
    const result = await checkPendingConditionals({ replyChecker: defaultReplyChecker });
    console.log(`Pending (not yet ripe): ${result.pending}`);
    console.log(`Already cancelled:      ${result.alreadyCancelled}`);
    console.log(`Decided:                ${result.decided.length}`);
    for (const d of result.decided) {
      console.log(`  ${d.action.toUpperCase()}  ${d.recipient.padEnd(40)} (${d.reason})`);
    }
    if (dryRun) console.log("(dry-run — no SendLater calls made)");
  } else if (cmd === "register") {
    const arg = (flag: string) => {
      const i = process.argv.indexOf(flag);
      return i >= 0 ? process.argv[i + 1] : undefined;
    };
    const id = arg("--id") ?? String(Date.now());
    const recipient = arg("--recipient");
    const originalSentAt = arg("--original-sent-at");
    const followUpSendAt = arg("--follow-up-at");
    if (!recipient || !originalSentAt || !followUpSendAt) {
      console.error("required: --recipient X --original-sent-at YYYY-MM-DD_HH:MM --follow-up-at YYYY-MM-DD_HH:MM");
      process.exit(2);
    }
    registerConditional({ id, recipient, originalSentAt, followUpSendAt, notes: arg("--notes") });
    console.log(`Registered conditional ${id}`);
  } else {
    console.log("Usage: bun Tools/ConditionalSends.ts [list | register | check]");
  }
}
