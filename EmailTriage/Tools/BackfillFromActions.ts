// Tools/BackfillFromActions.ts
//
// Phase 22 backfill (richer than BackfillDomainActivity which only parses
// stage 5/6 'x' marks). This tool reads the email_actions DB table (which
// records every executed action: archive/trash/reply/etc.) and joins each
// row against the sender index built from the vault's triage notes —
// recovering the (domain, address, action) tuple for emails that were
// processed but never landed in a stage 5/6 table.
//
// Yields ~100+ retroactive rows from the 120 existing email_actions on a
// typical user's DB. Each row is upserted via INSERT OR IGNORE-equivalent
// (delete then insert on composite key) so this is safe to re-run.
//
// Usage: bun Tools/BackfillFromActions.ts [--dry-run]
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";

interface SenderRecord {
  id: string;
  fromAddress: string;
  domain: string;
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

const ACTION_CODE: Record<string, string> = {
  archive: "A",
  trash:   "T",
  reply:   "R",
  defer:   "D",
  keep:    "K",
  junk:    "J",
  unsub:   "U",
  block_sender: "BL",
  approve_sender: "AP",
};

function extractAddress(senderCell: string): string | null {
  const cleaned = senderCell.replace(/\s*`\[NEW\]`/, "").replace(/\s*\[GONE\]/, "").trim();
  const angle = cleaned.match(/<([^>]+@[^>]+)>/);
  if (angle) return angle[1].toLowerCase();
  const plain = cleaned.match(/([\w._%+-]+@[\w.-]+\.[A-Za-z]{2,})/);
  return plain ? plain[1].toLowerCase() : null;
}

function extractDomain(address: string): string {
  const at = address.lastIndexOf("@");
  return at < 0 ? "" : address.slice(at + 1).toLowerCase();
}

/**
 * Walk a triage note line-by-line, harvesting (emailId, fromAddress) tuples
 * from both mini-block sections (#### `id` sender …) and table rows
 * (| id | sender | …). Returns a Map keyed by emailId.
 */
export function buildSenderIndex(noteContent: string): Map<string, SenderRecord> {
  const index = new Map<string, SenderRecord>();
  const lines = noteContent.split("\n");
  for (const line of lines) {
    // Mini-block: "#### [12345](message://x) sender@test [VIP] [i] -- 2026-05-18"
    const mini = line.match(/^####\s+\[?`?(\d{4,})`?\]?(?:\([^)]*\))?\s+([^[\s][^[]*?)(?:\s*\[VIP\])?(?:\s*\[[a-z]\])?\s*--/i);
    if (mini) {
      const id = mini[1];
      const address = extractAddress(mini[2]);
      if (address) {
        index.set(id, { id, fromAddress: address, domain: extractDomain(address) });
      }
      continue;
    }
    // Table row: "| [12345](message://x) [i] | sender@test | Subj | ... |"
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").map(c => c.trim());
    if (cells.length < 3) continue;
    const idCell = cells[1] ?? "";
    const idMatch = idCell.match(/\[`?(\d{4,})`?\]/) ?? idCell.match(/`(\d{4,})`/) ?? idCell.match(/\b(\d{4,})\b/);
    if (!idMatch) continue;
    const id = idMatch[1];
    if (index.has(id)) continue;
    const senderCell = cells[2] ?? "";
    const address = extractAddress(senderCell);
    if (!address) continue;
    index.set(id, { id, fromAddress: address, domain: extractDomain(address) });
  }
  return index;
}

export interface BackfillFromActionsSummary {
  notesScanned: number;
  sendersIndexed: number;
  actionsScanned: number;
  actionsMatched: number;
  rowsInserted: number;
  byAction: Record<string, number>;
}

export function backfillFromActions(options: { dryRun?: boolean; dbPath?: string; vaultRoot?: string } = {}): BackfillFromActionsSummary {
  const summary: BackfillFromActionsSummary = {
    notesScanned: 0, sendersIndexed: 0, actionsScanned: 0,
    actionsMatched: 0, rowsInserted: 0, byAction: {},
  };
  const dbPath = options.dbPath ?? DB_PATH;
  const triageDir = options.vaultRoot ? join(options.vaultRoot, "Email Triage") : TRIAGE_DIR;
  if (!existsSync(triageDir)) {
    throw new Error(`Triage directory not found: ${triageDir}`);
  }

  // 1. Build the sender index across all triage notes (one combined map)
  const senderIndex = new Map<string, SenderRecord>();
  const files = readdirSync(triageDir).filter(f => /^Email Triage -- .+\.md$/.test(f));
  for (const file of files) {
    summary.notesScanned++;
    const filePath = join(triageDir, file);
    const content = readFileSync(filePath, "utf8");
    const noteIndex = buildSenderIndex(content);
    for (const [id, rec] of noteIndex) {
      if (!senderIndex.has(id)) senderIndex.set(id, rec);
    }
  }
  summary.sendersIndexed = senderIndex.size;

  // 2. Walk email_actions; join against sender index; insert into domain_activity
  const db = new Database(dbPath);
  const actions = db.prepare("SELECT email_id, date, action FROM email_actions").all() as Array<{
    email_id: string;
    date: string;
    action: string;
  }>;
  summary.actionsScanned = actions.length;

  if (!options.dryRun) db.exec("BEGIN");
  const insertStmt = db.prepare(
    "INSERT INTO domain_activity (domain, address, triage_date, action_taken, email_id) VALUES (?, ?, ?, ?, ?)"
  );
  const deleteStmt = db.prepare(
    "DELETE FROM domain_activity WHERE email_id = ? AND action_taken = ? AND triage_date = ?"
  );

  for (const a of actions) {
    const sender = senderIndex.get(a.email_id);
    if (!sender) continue;
    summary.actionsMatched++;
    const code = ACTION_CODE[a.action] ?? a.action.toUpperCase();
    summary.byAction[code] = (summary.byAction[code] ?? 0) + 1;
    if (!options.dryRun) {
      deleteStmt.run(a.email_id, code, a.date);
      insertStmt.run(sender.domain, sender.fromAddress, a.date, code, a.email_id);
      summary.rowsInserted++;
    }
  }

  if (!options.dryRun) db.exec("COMMIT");
  db.close();
  return summary;
}

if (import.meta.main) {
  const dryRun = process.argv.includes("--dry-run");
  const summary = backfillFromActions({ dryRun });
  console.log(`Notes scanned:    ${summary.notesScanned}`);
  console.log(`Senders indexed:  ${summary.sendersIndexed} (unique email_id → fromAddress mappings)`);
  console.log(`Actions scanned:  ${summary.actionsScanned} (rows in email_actions)`);
  console.log(`Actions matched:  ${summary.actionsMatched} (had a sender in the note index)`);
  console.log(`Rows inserted:    ${summary.rowsInserted}${dryRun ? " (dry-run)" : ""}`);
  console.log(`By action:        ${JSON.stringify(summary.byAction)}`);
}
