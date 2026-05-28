// Tools/VipSla.ts — Phase 24: per-sender SLA enforcement.
//
// Walks recent triage notes for emails classified as VIP that have no
// recorded action in email_actions within an SLA window (default 24h).
// Returns an overdue list + can dispatch a Pulse notification (POST
// localhost:31337/notify) and write a banner that GenerateTriage can
// inject into tomorrow's note.
//
// CLI usage:
//   bun Tools/VipSla.ts                  # check today, default 24h SLA
//   bun Tools/VipSla.ts --sla 48         # 48h SLA
//   bun Tools/VipSla.ts --dry-run        # don't notify or write banner
//   bun Tools/VipSla.ts --json           # JSON output for piping

import { Database } from "bun:sqlite";
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";

interface OverdueVip {
  emailId: string;
  fromAddress: string;
  subject: string;
  firstSeenDate: string;
  hoursOverdue: number;
}

const VAULT_ROOT = (() => {
  if (process.env.EMAILTRIAGE_VAULT_ROOT) return process.env.EMAILTRIAGE_VAULT_ROOT;
  const home = process.env.HOME;
  if (!home) return "";
  const prefs = join(home, ".claude/PAI/USER/SKILLCUSTOMIZATIONS/EmailTriage/preferences.yaml");
  if (!existsSync(prefs)) return "";
  const raw = readFileSync(prefs, "utf8");
  const m = raw.match(/^\s*vault_root\s*:\s*["']?([^"'#\n]+?)["']?\s*(?:#.*)?$/m);
  return m ? m[1].trim() : "";
})();

const TRIAGE_DIR = join(VAULT_ROOT, "Email Triage");
const SKILL_ROOT = join(process.env.HOME ?? "", ".claude/skills/EmailTriage");
const DB_PATH = join(SKILL_ROOT, "triage.db");
const BANNER_PATH = join(SKILL_ROOT, "tmp", "vip-sla-banner.txt");
const PAI_NOTIFY_URL = process.env.PAI_NOTIFY_URL ?? "http://localhost:31337/notify";

const MONTHS: Record<string, number> = {
  January: 1, February: 2, March: 3, April: 4, May: 5, June: 6,
  July: 7, August: 8, September: 9, October: 10, November: 11, December: 12,
};

function filenameToDate(filename: string): string | null {
  const m = filename.match(/Email Triage -- (\w+) (\d{1,2}), (\d{4})\.md/);
  if (!m) return null;
  const month = MONTHS[m[1]];
  if (!month) return null;
  return `${m[3]}-${String(month).padStart(2, "0")}-${String(parseInt(m[2], 10)).padStart(2, "0")}`;
}

/**
 * Walks a triage note's Stage 1 (VIP) section. Returns each VIP entry as
 * { emailId, fromAddress, subject }. Tolerates both mini-block (####) and
 * table-row formats.
 */
export function extractVipEntries(noteContent: string): Array<{ emailId: string; fromAddress: string; subject: string }> {
  const out: Array<{ emailId: string; fromAddress: string; subject: string }> = [];
  const sectionMatch = noteContent.match(/## \[\] Stage 1: VIP[\s\S]*?(?=\n## )/);
  if (!sectionMatch) return out;
  const lines = sectionMatch[0].split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Mini-block: #### [id](message://...) sender@addr [VIP] [i] -- date
    const mini = line.match(/^####\s+\[`?(\d+)`?\]\([^)]*\)\s+(\S+@\S+)/);
    if (mini) {
      const subject = (lines[i + 1] ?? "").replace(/^\*\*/, "").replace(/\*\*$/, "").trim();
      out.push({ emailId: mini[1], fromAddress: mini[2].toLowerCase(), subject });
      continue;
    }
    // Table row
    if (line.startsWith("|") && !line.includes("---") && !line.includes("ID |")) {
      const cells = line.split("|").map(c => c.trim());
      if (cells.length >= 4) {
        const idMatch = cells[1].match(/\[`?(\d+)`?\]/) ?? cells[1].match(/(\d{4,})/);
        const addrMatch = cells[2].match(/<([^>]+)>/) ?? cells[2].match(/(\S+@\S+)/);
        if (idMatch && addrMatch) {
          out.push({
            emailId: idMatch[1],
            fromAddress: addrMatch[1].toLowerCase(),
            subject: cells[3] ?? "",
          });
        }
      }
    }
  }
  return out;
}

export interface SlaCheckOptions {
  slaHours?: number;
  dbPath?: string;
  vaultRoot?: string;
  /** ISO date string ('now') to evaluate against — defaults to system clock. */
  now?: Date;
}

export interface SlaCheckResult {
  overdue: OverdueVip[];
  totalVipsTracked: number;
  slaHours: number;
}

export function checkVipSla(options: SlaCheckOptions = {}): SlaCheckResult {
  const slaHours = options.slaHours ?? 24;
  const dbPath = options.dbPath ?? DB_PATH;
  const triageDir = options.vaultRoot ? join(options.vaultRoot, "Email Triage") : TRIAGE_DIR;
  const now = options.now ?? new Date();
  if (!existsSync(triageDir)) return { overdue: [], totalVipsTracked: 0, slaHours };

  const files = readdirSync(triageDir).filter(f => /^Email Triage -- .+\.md$/.test(f));
  // Aggregate VIPs across all available notes (most recent firstSeen wins
  // doesn't apply — we want oldest firstSeen so overdue calculation reflects
  // the actual time the VIP was first surfaced).
  const vipFirstSeen = new Map<string, { fromAddress: string; subject: string; firstSeenDate: string }>();
  for (const file of files) {
    const date = filenameToDate(file);
    if (!date) continue;
    const content = readFileSync(join(triageDir, file), "utf8");
    const entries = extractVipEntries(content);
    for (const e of entries) {
      const existing = vipFirstSeen.get(e.emailId);
      if (!existing || date < existing.firstSeenDate) {
        vipFirstSeen.set(e.emailId, { fromAddress: e.fromAddress, subject: e.subject, firstSeenDate: date });
      }
    }
  }

  // Cross-ref against email_actions: VIPs WITH an action in any direction (reply,
  // archive, trash, etc.) are no longer overdue. The SLA target is 'human
  // acknowledgement', not 'human reply' — clearing the email by any means
  // counts as acknowledged.
  const db = new Database(dbPath);
  const acted = new Set<string>(
    (db.prepare("SELECT DISTINCT email_id FROM email_actions").all() as { email_id: string }[])
      .map(r => r.email_id),
  );
  db.close();

  const overdue: OverdueVip[] = [];
  for (const [emailId, info] of vipFirstSeen) {
    if (acted.has(emailId)) continue;
    const [y, m, d] = info.firstSeenDate.split("-").map(Number);
    const seenAt = new Date(y, m - 1, d, 9, 0, 0); // morning-of-triage anchor (9am local)
    const ageMs = now.getTime() - seenAt.getTime();
    const ageHours = ageMs / 3_600_000;
    if (ageHours >= slaHours) {
      overdue.push({
        emailId,
        fromAddress: info.fromAddress,
        subject: info.subject,
        firstSeenDate: info.firstSeenDate,
        hoursOverdue: Math.round(ageHours - slaHours),
      });
    }
  }

  // Sort: most overdue first
  overdue.sort((a, b) => b.hoursOverdue - a.hoursOverdue);
  return { overdue, totalVipsTracked: vipFirstSeen.size, slaHours };
}

export function formatSlaBanner(result: SlaCheckResult): string | undefined {
  if (result.overdue.length === 0) return undefined;
  const lines = [
    `> [!warning] VIP SLA breach — ${result.overdue.length} unacknowledged VIP email(s) past ${result.slaHours}h`,
  ];
  for (const v of result.overdue.slice(0, 10)) {
    lines.push(`> - \`${v.emailId}\` ${v.fromAddress} — "${v.subject.slice(0, 60)}" (+${v.hoursOverdue}h overdue)`);
  }
  if (result.overdue.length > 10) {
    lines.push(`> - …and ${result.overdue.length - 10} more`);
  }
  return lines.join("\n");
}

async function notifyPulse(message: string): Promise<boolean> {
  try {
    const res = await fetch(PAI_NOTIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, voice_enabled: false }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const json = argv.includes("--json");
  const slaIdx = argv.indexOf("--sla");
  const slaHours = slaIdx >= 0 ? parseInt(argv[slaIdx + 1] ?? "24", 10) : 24;

  const result = checkVipSla({ slaHours });
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  }

  console.log(`Tracked VIPs: ${result.totalVipsTracked}`);
  console.log(`SLA window: ${result.slaHours}h`);
  console.log(`Overdue: ${result.overdue.length}`);
  for (const v of result.overdue) {
    console.log(`  +${v.hoursOverdue}h  ${v.fromAddress.padEnd(40)} "${v.subject.slice(0, 60)}"`);
  }

  if (!dryRun && result.overdue.length > 0) {
    const banner = formatSlaBanner(result);
    if (banner) {
      if (!existsSync(join(SKILL_ROOT, "tmp"))) mkdirSync(join(SKILL_ROOT, "tmp"), { recursive: true });
      writeFileSync(BANNER_PATH, banner, "utf8");
      console.log(`Banner written to ${BANNER_PATH}`);
    }
    await notifyPulse(`VIP SLA: ${result.overdue.length} unacknowledged VIP email${result.overdue.length === 1 ? "" : "s"} past ${result.slaHours}h`);
  }
}
