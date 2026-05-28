import { spawn, spawnSync } from "child_process";
import { APPLE_MAIL_SH, isGmailMessageId, isIcloudMessageId } from "./paths";
import type { FunnelStage } from "../../Tools/Types";
import { getStageFolderPath } from "../../Tools/Types";
import { parseEmailList } from "../../Tools/EmailParser";

const GWS_BIN = process.env.GWS_BIN ?? "gws";

function appleMailScript(): string {
  return process.env.EMAILTRIAGE_APPLE_MAIL_SH ?? APPLE_MAIL_SH;
}

function stripGwsBanner(out: string): string {
  return out.split("\n").filter(l => !l.startsWith("[account:") && !l.startsWith("Using keyring backend:")).join("\n").trim();
}

const ICLOUD_STAGE_SCAN_ORDER: FunnelStage[] = [
  "vip", "action", "financial", "informational", "bulk_dispose", "auto_processed",
];

function icloudStageMailboxFallbacks(): string[] {
  const out: string[] = [];
  for (const stage of ICLOUD_STAGE_SCAN_ORDER) {
    const p = getStageFolderPath(stage, "i");
    if (p) out.push(p);
  }
  return out;
}

function parseAppleMailReadOutput(raw: string): { body: string; subject?: string; from?: string } {
  const lines = raw.split("\n");
  const sepIdx = lines.findIndex((l, i) => i > 0 && l.startsWith("==="));
  const body = sepIdx !== -1 ? lines.slice(sepIdx + 1).join("\n").trim() : raw.trim();
  const headerBlock = sepIdx !== -1 ? lines.slice(0, sepIdx).join("\n") : "";
  const subjectMatch = headerBlock.match(/^Subject:\s*(.+)$/m);
  const fromMatch = headerBlock.match(/^From:\s*(.+)$/m);
  return {
    body,
    subject: subjectMatch?.[1]?.trim(),
    from: fromMatch?.[1]?.trim(),
  };
}

// apple-mail.sh `read` and `mark-unread` do NOT accept the account-alias-prefixed
// unified path (e.g. "i/Stages/Stage 5 - Bulk Dispose"); they expect the bare
// mailbox name ("Stages/Stage 5 - Bulk Dispose"). `list` and `move` DO accept the
// unified form. Strip the leading "<alias>/" segment before passing to read/mark-unread.
function stripAccountAlias(mailbox: string): string {
  return mailbox.replace(/^[a-z]\//, "");
}

function runAppleMailRead(id: string, mailbox?: string): { ok: true; raw: string } | { ok: false; err: string } {
  const script = appleMailScript();
  const args = [script, "read", id];
  if (mailbox) args.push("--mailbox", stripAccountAlias(mailbox));
  const r = spawnSync("bash", args, { encoding: "utf8", timeout: 45_000 });
  if (r.status !== 0) {
    const msg = ((r.stderr ?? "") + (r.stdout ?? "")).trim() || `apple-mail read failed (${r.status})`;
    return { ok: false, err: msg };
  }
  // apple-mail.sh exits 0 even on "not found" / "mailbox not found"; inspect stdout for an Error: prefix.
  const raw = (r.stdout ?? "").toString();
  const firstLines = raw.split("\n").slice(0, 2).join("\n");
  if (/^\s*Error:/m.test(firstLines)) {
    return { ok: false, err: raw.trim().split("\n")[0] };
  }
  return { ok: true, raw };
}

function runAppleMailMarkUnread(id: string, mailbox?: string): void {
  const script = appleMailScript();
  const args = [script, "mark-unread", id];
  if (mailbox) args.push("--mailbox", stripAccountAlias(mailbox));
  try {
    spawnSync("bash", args, { encoding: "utf8", timeout: 8_000 });
  } catch { /* best-effort */ }
}

function runAppleMailList(mailbox: string): string {
  const script = appleMailScript();
  const args = [script, "list", stripAccountAlias(mailbox), "500"];
  const r = spawnSync("bash", args, { encoding: "utf8", timeout: 30_000 });
  return r.stdout ?? "";
}

function cleanString(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function resolveShiftedIcloudId(mailbox: string, subject: string, fromAddress: string): string | null {
  try {
    const output = runAppleMailList(mailbox);
    const emails = parseEmailList(output);
    const cleanTargetSubj = cleanString(subject);
    const cleanTargetFrom = cleanString(fromAddress);

    for (const email of emails) {
      const cleanEmailFrom = cleanString(email.fromAddress);
      if (cleanEmailFrom === cleanTargetFrom || cleanTargetFrom.includes(cleanEmailFrom) || cleanEmailFrom.includes(cleanTargetFrom)) {
        const cleanEmailSubj = cleanString(email.subject);
        if (cleanEmailSubj === cleanTargetSubj || cleanEmailSubj.includes(cleanTargetSubj) || cleanTargetSubj.includes(cleanEmailSubj)) {
          return email.id;
        }
      }
    }
  } catch (e) {
    console.error("[resolveShiftedIcloudId] error:", e);
  }
  return null;
}

export interface ReadEmailBodyOptions {
  /** Unified path for apple-mail.sh, e.g. `i/Stages/Stage 5 - Bulk Dispose` */
  mailbox?: string;
  subject?: string;
  from?: string;
}

export function readEmailBody(id: string, opts?: ReadEmailBodyOptions): { body: string; subject?: string; from?: string; resolvedId?: string } {
  if (isGmailMessageId(id)) {
    const result = spawnSync(
      GWS_BIN,
      ["gmail", "+read", "--id", id, "--format", "json"],
      { encoding: "utf8", timeout: 45_000 },
    );
    if (result.status !== 0) {
      throw new Error((result.stderr ?? "").toString() || `gws read failed for ${id}`);
    }
    const json = JSON.parse(stripGwsBanner((result.stdout ?? "").toString())) as {
      body?: string;
      body_text?: string;
      body_html?: string;
      subject?: string;
      from?: string | { name?: string; email?: string };
      headers?: Record<string, string>;
    };
    const headers = json.headers ?? {};
    const fromVal = json.from;
    const fromStr = typeof fromVal === "string"
      ? fromVal
      : fromVal && typeof fromVal === "object"
        ? (fromVal.name ? `${fromVal.name} <${fromVal.email}>` : fromVal.email)
        : undefined;

    return {
      body: (json.body ?? json.body_text ?? json.body_html ?? "").trim(),
      subject: json.subject ?? headers.Subject ?? headers.subject,
      from: fromStr ?? headers.From ?? headers.from,
    };
  }

  if (!isIcloudMessageId(id)) {
    throw new Error(`Unrecognized email id format: ${id}`);
  }

  const preferred = opts?.mailbox?.trim() || undefined;
  const tryMailboxes = preferred
    ? [preferred, ...icloudStageMailboxFallbacks().filter((m) => m !== preferred)]
    : [...icloudStageMailboxFallbacks()];

  let lastErr = "Email read failed";
  for (const box of tryMailboxes) {
    const r = runAppleMailRead(id, box);
    if (r.ok) {
      runAppleMailMarkUnread(id, box);
      return parseAppleMailReadOutput(r.raw);
    }
    lastErr = r.err;
  }

  const bare = runAppleMailRead(id);
  if (bare.ok) {
    runAppleMailMarkUnread(id);
    return parseAppleMailReadOutput(bare.raw);
  }

  // Fallback: If direct lookup failed and we have subject and from, attempt dynamic ID shift recovery
  if (isIcloudMessageId(id) && preferred && opts?.subject && opts?.from) {
    const resolvedId = resolveShiftedIcloudId(preferred, opts.subject, opts.from);
    if (resolvedId && resolvedId !== id) {
      const tryResolvedMailboxes = [preferred, ...icloudStageMailboxFallbacks().filter((m) => m !== preferred)];
      for (const box of tryResolvedMailboxes) {
        const r = runAppleMailRead(resolvedId, box);
        if (r.ok) {
          runAppleMailMarkUnread(resolvedId, box);
          const parsed = parseAppleMailReadOutput(r.raw);
          return {
            ...parsed,
            resolvedId,
          };
        }
      }
      const bareResolved = runAppleMailRead(resolvedId);
      if (bareResolved.ok) {
        runAppleMailMarkUnread(resolvedId);
        const parsed = parseAppleMailReadOutput(bareResolved.raw);
        return {
          ...parsed,
          resolvedId,
        };
      }
    }
  }

  throw new Error(lastErr);
}

// ─── Async variants (Phase 30 optimization pass) ───
// `readEmailBody` is fully synchronous (spawnSync). The batch route declares a
// BATCH_SIZE concurrency window but a sync map can never honor it — every read
// blocks. `readEmailBodyAsync` mirrors the sync logic exactly (same fallback
// order, same outputs) over async `spawn`, so the batch route can run a window
// of reads truly concurrently. Parse/format helpers are shared — only the
// process spawns change — keeping behavior identical.

interface AsyncSpawnResult { status: number | null; stdout: string; stderr: string; }

function spawnAsync(cmd: string, args: string[], timeoutMs: number): Promise<AsyncSpawnResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(cmd, args);
    const finish = (status: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      finish(null);
    }, timeoutMs);
    child.stdout?.on("data", (d) => { stdout += d.toString(); });
    child.stderr?.on("data", (d) => { stderr += d.toString(); });
    child.on("close", (code) => finish(code));
    child.on("error", () => finish(1));
  });
}

async function runAppleMailReadAsync(id: string, mailbox?: string): Promise<{ ok: true; raw: string } | { ok: false; err: string }> {
  const script = appleMailScript();
  const args = [script, "read", id];
  if (mailbox) args.push("--mailbox", stripAccountAlias(mailbox));
  const r = await spawnAsync("bash", args, 45_000);
  if (r.status !== 0) {
    const msg = (r.stderr + r.stdout).trim() || `apple-mail read failed (${r.status})`;
    return { ok: false, err: msg };
  }
  const raw = r.stdout;
  const firstLines = raw.split("\n").slice(0, 2).join("\n");
  if (/^\s*Error:/m.test(firstLines)) {
    return { ok: false, err: raw.trim().split("\n")[0] };
  }
  return { ok: true, raw };
}

async function runAppleMailMarkUnreadAsync(id: string, mailbox?: string): Promise<void> {
  const script = appleMailScript();
  const args = [script, "mark-unread", id];
  if (mailbox) args.push("--mailbox", stripAccountAlias(mailbox));
  try { await spawnAsync("bash", args, 8_000); } catch { /* best-effort */ }
}

export async function readEmailBodyAsync(id: string, opts?: ReadEmailBodyOptions): Promise<{ body: string; subject?: string; from?: string }> {
  if (isGmailMessageId(id)) {
    const result = await spawnAsync(GWS_BIN, ["gmail", "+read", "--id", id, "--format", "json"], 45_000);
    if (result.status !== 0) {
      throw new Error(result.stderr || `gws read failed for ${id}`);
    }
    const json = JSON.parse(stripGwsBanner(result.stdout)) as {
      body?: string;
      body_text?: string;
      body_html?: string;
      subject?: string;
      from?: string | { name?: string; email?: string };
      headers?: Record<string, string>;
    };
    const headers = json.headers ?? {};
    const fromVal = json.from;
    const fromStr = typeof fromVal === "string"
      ? fromVal
      : fromVal && typeof fromVal === "object"
        ? (fromVal.name ? `${fromVal.name} <${fromVal.email}>` : fromVal.email)
        : undefined;

    return {
      body: (json.body ?? json.body_text ?? json.body_html ?? "").trim(),
      subject: json.subject ?? headers.Subject ?? headers.subject,
      from: fromStr ?? headers.From ?? headers.from,
    };
  }

  if (!isIcloudMessageId(id)) {
    throw new Error(`Unrecognized email id format: ${id}`);
  }

  const preferred = opts?.mailbox?.trim() || undefined;
  const tryMailboxes = preferred
    ? [preferred, ...icloudStageMailboxFallbacks().filter((m) => m !== preferred)]
    : [...icloudStageMailboxFallbacks()];

  let lastErr = "Email read failed";
  for (const box of tryMailboxes) {
    const r = await runAppleMailReadAsync(id, box);
    if (r.ok) {
      await runAppleMailMarkUnreadAsync(id, box);
      return parseAppleMailReadOutput(r.raw);
    }
    lastErr = r.err;
  }

  const bare = await runAppleMailReadAsync(id);
  if (bare.ok) {
    await runAppleMailMarkUnreadAsync(id);
    return parseAppleMailReadOutput(bare.raw);
  }

  throw new Error(lastErr);
}
