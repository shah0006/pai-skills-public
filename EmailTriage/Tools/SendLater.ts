// ~/.claude/skills/EmailTriage/send-later.ts
// Scheduled send manager: creates self-contained JSON + launchd plist packages.
// Usage:
//   bun run send-later.ts schedule --to X --subject Y --body Z --send-at "2026-04-07_08:00"
//   bun run send-later.ts catchup [--dry-run]
//   bun run send-later.ts cancel <send-id>
//   bun run send-later.ts list
//   bun run send-later.ts cleanup [--days 30]

import { execSync } from "child_process";
import { join, basename } from "path";
import {
  writeFileSync, readFileSync, existsSync, readdirSync,
  renameSync, mkdirSync, unlinkSync,
} from "fs";

// import.meta.dir is now Tools/. Skill root is one level up.
const SKILL_ROOT = (() => {
  if (import.meta.dir) {
    const dir = import.meta.dir;
    return dir.endsWith("/Tools") ? dir.slice(0, -6) : dir;
  }
  return join(process.env.HOME ?? "~", ".claude/skills/EmailTriage");
})();
const SKILLS_DIR = SKILL_ROOT;  // back-compat alias
const SCHEDULED_DIR = join(SKILL_ROOT, "scheduled");
const SENT_DIR = join(SCHEDULED_DIR, "sent");
const DISPATCHER_SH = join(SKILL_ROOT, "send-dispatcher.sh");
const LAUNCH_AGENTS = join(process.env.HOME ?? "~", "Library/LaunchAgents");
const APPLE_MAIL = join(process.env.HOME ?? "~", ".claude/skills/AppleMail/Tools/apple-mail.sh");

export interface SendPackage {
  id: string;
  recipient: string;
  subject: string;
  body: string;
  account: string;
  inReplyTo?: string;
  sourceEmailId?: string;
  sendAt: string;          // YYYY-MM-DD_HH:MM
  plistLabel: string;
  createdAt: string;
}

function ensureDirs(): void {
  for (const d of [SCHEDULED_DIR, SENT_DIR]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  }
}

function generateId(): string {
  return `send-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

function parseSendAt(sendAt: string): { month: number; day: number; hour: number; minute: number } {
  // Format: YYYY-MM-DD_HH:MM
  const match = sendAt.match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2}):(\d{2})$/);
  if (!match) throw new Error(`Invalid sendAt format: ${sendAt}. Expected YYYY-MM-DD_HH:MM`);
  return {
    month: parseInt(match[2]),
    day: parseInt(match[3]),
    hour: parseInt(match[4]),
    minute: parseInt(match[5]),
  };
}

function buildPlist(label: string, jsonPath: string, sendAt: string): string {
  const { month, day, hour, minute } = parseSendAt(sendAt);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${DISPATCHER_SH}</string>
    <string>${jsonPath}</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Month</key>
    <integer>${month}</integer>
    <key>Day</key>
    <integer>${day}</integer>
    <key>Hour</key>
    <integer>${hour}</integer>
    <key>Minute</key>
    <integer>${minute}</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${SCHEDULED_DIR}/send-dispatcher.log</string>
  <key>StandardErrorPath</key>
  <string>${SCHEDULED_DIR}/send-dispatcher.log</string>
</dict>
</plist>`;
}

export function createSendPackage(opts: {
  recipient: string;
  subject: string;
  body: string;
  account?: string;
  inReplyTo?: string;
  sourceEmailId?: string;
  sendAt: string;
}, scheduledDir?: string, launchAgentsDir?: string): SendPackage {
  const outDir = scheduledDir ?? SCHEDULED_DIR;
  const agentsDir = launchAgentsDir ?? LAUNCH_AGENTS;
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  const id = generateId();
  const label = `com.pai.send.${id}`;
  const jsonPath = join(outDir, `${id}.json`);

  const pkg: SendPackage = {
    id,
    recipient: opts.recipient,
    subject: opts.subject,
    body: opts.body,
    account: opts.account ?? "i",
    inReplyTo: opts.inReplyTo,
    sourceEmailId: opts.sourceEmailId,
    sendAt: opts.sendAt,
    plistLabel: label,
    createdAt: getNow(),
  };

  // Write JSON package
  writeFileSync(jsonPath, JSON.stringify(pkg, null, 2));

  // Write and load launchd plist (skip in test mode / custom dir)
  if (!scheduledDir) {
    const plistContent = buildPlist(label, jsonPath, opts.sendAt);
    const plistPath = join(agentsDir, `${label}.plist`);
    writeFileSync(plistPath, plistContent);
    try {
      execSync(`launchctl load "${plistPath}"`, { stdio: "pipe", timeout: 10_000 });
    } catch {
      // Non-fatal: plist still exists, catchup will handle it
    }
  }

  return pkg;
}

export function cancelScheduledSend(sendId: string, scheduledDir?: string, launchAgentsDir?: string): boolean {
  const outDir = scheduledDir ?? SCHEDULED_DIR;
  const agentsDir = launchAgentsDir ?? LAUNCH_AGENTS;
  const jsonPath = join(outDir, `${sendId}.json`);

  if (!existsSync(jsonPath)) return false;

  // Read package to get plist label
  const pkg: SendPackage = JSON.parse(readFileSync(jsonPath, "utf-8"));

  // Unload and remove plist
  if (!scheduledDir) {
    const plistPath = join(agentsDir, `${pkg.plistLabel}.plist`);
    if (existsSync(plistPath)) {
      try {
        execSync(`launchctl unload "${plistPath}"`, { stdio: "pipe", timeout: 10_000 });
      } catch { /* already unloaded */ }
      unlinkSync(plistPath);
    }
  }

  // Remove JSON
  unlinkSync(jsonPath);
  return true;
}

export function listPendingSends(scheduledDir?: string): SendPackage[] {
  const dir = scheduledDir ?? SCHEDULED_DIR;
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter(f => f.startsWith("send-") && f.endsWith(".json") && !f.endsWith(".failed.json"))
    .map(f => {
      try {
        return JSON.parse(readFileSync(join(dir, f), "utf-8")) as SendPackage;
      } catch { return null; }
    })
    .filter((p): p is SendPackage => p !== null)
    .sort((a, b) => a.sendAt.localeCompare(b.sendAt));
}

export function listFailedSends(scheduledDir?: string): SendPackage[] {
  const dir = scheduledDir ?? SCHEDULED_DIR;
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter(f => f.endsWith(".failed.json"))
    .map(f => {
      try {
        return JSON.parse(readFileSync(join(dir, f), "utf-8")) as SendPackage;
      } catch { return null; }
    })
    .filter((p): p is SendPackage => p !== null);
}

export function listSentSends(scheduledDir?: string): SendPackage[] {
  const sentDir = scheduledDir ? join(scheduledDir, "sent") : SENT_DIR;
  if (!existsSync(sentDir)) return [];

  return readdirSync(sentDir)
    .filter(f => f.endsWith(".json"))
    .map(f => {
      try {
        return JSON.parse(readFileSync(join(sentDir, f), "utf-8")) as SendPackage;
      } catch { return null; }
    })
    .filter((p): p is SendPackage => p !== null);
}

export function catchupOverdueSends(scheduledDir?: string, dryRun = false): { sent: string[]; failed: string[] } {
  const dir = scheduledDir ?? SCHEDULED_DIR;
  const sentDir = scheduledDir ? join(dir, "sent") : SENT_DIR;
  if (!existsSync(sentDir)) mkdirSync(sentDir, { recursive: true });

  const now = getNow();
  const pending = listPendingSends(dir);
  const overdue = pending.filter(p => p.sendAt <= now);

  const sent: string[] = [];
  const failed: string[] = [];

  for (const pkg of overdue) {
    const jsonPath = join(dir, `${pkg.id}.json`);

    if (dryRun) {
      console.log(`[DRY RUN] Would send to ${pkg.recipient}: ${pkg.subject}`);
      sent.push(pkg.id);
      continue;
    }

    const success = dispatchSend(pkg);
    if (success) {
      // Move to sent/
      renameSync(jsonPath, join(sentDir, `${pkg.id}.json`));
      // Clean up plist
      cleanupPlist(pkg.plistLabel);
      sent.push(pkg.id);
    } else {
      // Mark as failed
      renameSync(jsonPath, join(dir, `${pkg.id}.failed.json`));
      failed.push(pkg.id);
    }
  }

  return { sent, failed };
}

function dispatchSend(pkg: SendPackage): boolean {
  const escapedSubject = pkg.subject.replace(/"/g, '\\"');
  const escapedBody = pkg.body.replace(/"/g, '\\"');
  const cmd = `bash "${APPLE_MAIL}" send --to "${pkg.recipient}" --subject "${escapedSubject}" --body "${escapedBody}" --account "${pkg.account}"`;

  try {
    execSync(cmd, { stdio: "pipe", timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

function cleanupPlist(label: string): void {
  const plistPath = join(LAUNCH_AGENTS, `${label}.plist`);
  if (existsSync(plistPath)) {
    try { execSync(`launchctl unload "${plistPath}"`, { stdio: "pipe", timeout: 10_000 }); } catch {}
    try { unlinkSync(plistPath); } catch {}
  }
}

export function cleanupOldSent(days = 30, scheduledDir?: string): number {
  const sentDir = scheduledDir ? join(scheduledDir, "sent") : SENT_DIR;
  if (!existsSync(sentDir)) return 0;

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString().slice(0, 10).replace(/-/g, "-");

  let removed = 0;
  for (const f of readdirSync(sentDir).filter(f => f.endsWith(".json"))) {
    try {
      const pkg: SendPackage = JSON.parse(readFileSync(join(sentDir, f), "utf-8"));
      if (pkg.createdAt < cutoffStr) {
        unlinkSync(join(sentDir, f));
        removed++;
      }
    } catch { /* skip unparseable */ }
  }
  return removed;
}

function getNow(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}_${hours}:${minutes}`;
}

// --- CLI Entry Point ---

async function main() {
  ensureDirs();
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case "schedule": {
      const to = getArg(args, "--to");
      const subject = getArg(args, "--subject");
      const body = getArg(args, "--body");
      const sendAt = getArg(args, "--send-at");
      const account = getArg(args, "--account") ?? "i";
      const inReplyTo = getArg(args, "--in-reply-to");
      const emailId = getArg(args, "--email-id");

      if (!to || !subject || !body || !sendAt) {
        console.error("Usage: send-later.ts schedule --to X --subject Y --body Z --send-at YYYY-MM-DD_HH:MM");
        process.exit(1);
      }

      const pkg = createSendPackage({
        recipient: to, subject, body, account, inReplyTo,
        sourceEmailId: emailId, sendAt,
      });
      console.log(`Scheduled send ${pkg.id} to ${pkg.recipient} at ${pkg.sendAt}`);
      break;
    }

    case "catchup": {
      const dryRun = args.includes("--dry-run");
      console.log(`[send-later] ${dryRun ? "DRY RUN " : ""}Checking for overdue sends...`);
      const result = catchupOverdueSends(undefined, dryRun);
      console.log(`[send-later] Sent: ${result.sent.length}, Failed: ${result.failed.length}`);
      break;
    }

    case "cancel": {
      const sendId = args[1];
      if (!sendId) { console.error("Usage: send-later.ts cancel <send-id>"); process.exit(1); }
      const ok = cancelScheduledSend(sendId);
      console.log(ok ? `Cancelled ${sendId}` : `Send ${sendId} not found`);
      break;
    }

    case "list": {
      const pending = listPendingSends();
      const failed = listFailedSends();
      if (pending.length === 0 && failed.length === 0) {
        console.log("No pending or failed sends.");
        break;
      }
      for (const p of pending) {
        console.log(`[PENDING] ${p.id}  to:${p.recipient}  at:${p.sendAt}  subj:${p.subject}`);
      }
      for (const f of failed) {
        console.log(`[FAILED]  ${f.id}  to:${f.recipient}  subj:${f.subject}`);
      }
      break;
    }

    case "cleanup": {
      const daysArg = getArg(args, "--days");
      const days = daysArg ? parseInt(daysArg) : 30;
      const removed = cleanupOldSent(days);
      console.log(`Cleaned up ${removed} sent package(s) older than ${days} days`);
      break;
    }

    default:
      console.error("Usage: send-later.ts <schedule|catchup|cancel|list|cleanup>");
      process.exit(1);
  }
}

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

if (import.meta.main) {
  main().catch(e => {
    console.error(e);
    process.exit(1);
  });
}
