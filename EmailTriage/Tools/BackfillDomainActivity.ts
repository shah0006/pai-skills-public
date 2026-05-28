// Tools/BackfillDomainActivity.ts
//
// Phase 22 v0 backstop — Phase 22 v0 (SenderMemory) reads domain_activity but
// historically the table only got writes via ExecuteTriage. Triage notes in
// the vault encode actions taken weeks before the table existed; this tool
// retroactively populates domain_activity from those notes so SenderMemory
// has signal from day 1 instead of waiting weeks for organic growth.
//
// Scope (deliberately narrow):
//   - Parses Stage 5 (Bulk Dispose) and Stage 6 (Auto-Processed) table rows
//     only — these are the highest-volume sections and have unambiguous
//     'x' marks in named action columns
//   - Skips Stage 1/2 (VIP/Action mini-blocks) and Stage 3/4 (Financial/
//     Informational tables) — those need fuzzier inference from the
//     Execution Log section and aren't worth the complexity for v0
//   - Skips notes with status: pending — those don't reflect executed actions
//
// Idempotent: uses (email_id, action_taken, triage_date) as a dedup key
// (no UNIQUE constraint exists, so we DELETE matching rows before inserting).
//
// Usage: bun Tools/BackfillDomainActivity.ts [--dry-run]
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";

interface BackfillRow {
  domain: string;
  address: string;
  triageDate: string;
  actionCode: string;
  emailId: string;
  source: string;
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

const MONTHS: Record<string, number> = {
  January: 1, February: 2, March: 3, April: 4, May: 5, June: 6,
  July: 7, August: 8, September: 9, October: 10, November: 11, December: 12,
};

function filenameToDate(filename: string): string | null {
  // "Email Triage -- May 18, 2026.md" → "2026-05-18"
  const m = filename.match(/Email Triage -- (\w+) (\d{1,2}), (\d{4})\.md/);
  if (!m) return null;
  const month = MONTHS[m[1]];
  if (!month) return null;
  return `${m[3]}-${String(month).padStart(2, "0")}-${String(parseInt(m[2], 10)).padStart(2, "0")}`;
}

/**
 * `status: complete` is a user-facing "I'm done reviewing" flag — not a
 * reliable signal that actions were executed. In practice the user often
 * runs triage and execute without ever flipping the status. The 'x' marks
 * in stage 5/6 tables encode the routed action regardless of the status
 * field, so we treat any note with parseable action rows as backfillable.
 * Skip notes only when they're missing the action sections entirely.
 */
function hasActionableSections(content: string): boolean {
  return content.includes("## [] Stage 5: Bulk Dispose") || content.includes("## [] Stage 6: Auto-Processed");
}

function extractDomain(address: string): string {
  const at = address.lastIndexOf("@");
  return at < 0 ? "" : address.slice(at + 1).toLowerCase();
}

/**
 * Parse a Stage 5 (Bulk Dispose) section from a triage note.
 * Columns: ID | Sender | Subject | 📎 | Archive To | A | T | J | U | BD | BS | You
 * Indices (after splitting by '|' and trimming empties): 0=ID, 1=sender,
 * 2=subject, 3=att, 4=folder, 5=A, 6=T, 7=J, 8=U, 9=BD, 10=BS, 11=You
 */
function parseBulkDisposeSection(noteContent: string, triageDate: string): BackfillRow[] {
  const rows: BackfillRow[] = [];
  const sectionMatch = noteContent.match(/## \[\] Stage 5: Bulk Dispose[\s\S]*?(?=\n## )/);
  if (!sectionMatch) return rows;
  for (const line of sectionMatch[0].split("\n")) {
    if (!line.startsWith("|") || line.includes("---") || line.includes("ID |")) continue;
    const cells = line.split("|").map(c => c.trim());
    if (cells.length < 9) continue;
    const idMatch = cells[1].match(/\[`?(\d+)`?\]/) ?? cells[1].match(/`(\d+)`/) ?? cells[1].match(/(\d{4,})/);
    if (!idMatch) continue;
    const emailId = idMatch[1];
    const sender = cells[2].replace(/\s*`\[NEW\]`/, "").replace(/\s*\[GONE\]/, "").trim();
    const addressMatch = sender.match(/<([^>]+@[^>]+)>/) ?? sender.match(/([\S]+@[\S]+)/);
    const address = addressMatch ? addressMatch[1].toLowerCase() : sender.toLowerCase();
    const domain = extractDomain(address);
    if (!domain) continue;
    // Action columns (indices 6=A, 7=T, 8=J, 9=U) — 'x' marks executed action
    let actionCode = "";
    if (cells[6]?.toLowerCase() === "x") actionCode = "A";
    else if (cells[7]?.toLowerCase() === "x") actionCode = "T";
    else if (cells[8]?.toLowerCase() === "x") actionCode = "J";
    else if (cells[9]?.toLowerCase() === "x") actionCode = "U";
    if (!actionCode) continue;
    rows.push({ domain, address, triageDate, actionCode, emailId, source: "stage5" });
  }
  return rows;
}

/**
 * Parse a Stage 6 (Auto-Processed) section from a triage note.
 * Columns: ID | Sender | Subject | 📎 | Rule | Archive To | A | T | K | J | U | BD | BS | You
 * Indices: 0=ID, 1=sender, 2=subject, 3=att, 4=rule, 5=folder, 6=A, 7=T, 8=K, 9=J, 10=U
 */
function parseAutoProcessedSection(noteContent: string, triageDate: string): BackfillRow[] {
  const rows: BackfillRow[] = [];
  const sectionMatch = noteContent.match(/## \[\] Stage 6: Auto-Processed[\s\S]*?(?=\n## |$)/);
  if (!sectionMatch) return rows;
  for (const line of sectionMatch[0].split("\n")) {
    if (!line.startsWith("|") || line.includes("---") || line.includes("ID |")) continue;
    const cells = line.split("|").map(c => c.trim());
    if (cells.length < 10) continue;
    const idMatch = cells[1].match(/\[`?(\d+)`?\]/) ?? cells[1].match(/`(\d+)`/) ?? cells[1].match(/(\d{4,})/);
    if (!idMatch) continue;
    const emailId = idMatch[1];
    const sender = cells[2].replace(/\s*`\[NEW\]`/, "").replace(/\s*\[GONE\]/, "").trim();
    const addressMatch = sender.match(/<([^>]+@[^>]+)>/) ?? sender.match(/([\S]+@[\S]+)/);
    const address = addressMatch ? addressMatch[1].toLowerCase() : sender.toLowerCase();
    const domain = extractDomain(address);
    if (!domain) continue;
    let actionCode = "";
    if (cells[7]?.toLowerCase() === "x") actionCode = "A";
    else if (cells[8]?.toLowerCase() === "x") actionCode = "T";
    else if (cells[9]?.toLowerCase() === "x") actionCode = "K";
    else if (cells[10]?.toLowerCase() === "x") actionCode = "J";
    else if (cells[11]?.toLowerCase() === "x") actionCode = "U";
    if (!actionCode) continue;
    rows.push({ domain, address, triageDate, actionCode, emailId, source: "stage6" });
  }
  return rows;
}

export interface BackfillSummary {
  notesScanned: number;
  notesSkipped: number;
  rowsParsed: number;
  rowsInserted: number;
  byStage: Record<string, number>;
  byAction: Record<string, number>;
}

export function backfillDomainActivity(options: { dryRun?: boolean; dbPath?: string; vaultRoot?: string } = {}): BackfillSummary {
  const summary: BackfillSummary = {
    notesScanned: 0, notesSkipped: 0, rowsParsed: 0, rowsInserted: 0,
    byStage: {}, byAction: {},
  };
  const dbPath = options.dbPath ?? DB_PATH;
  const triageDir = options.vaultRoot ? join(options.vaultRoot, "Email Triage") : TRIAGE_DIR;
  if (!existsSync(triageDir)) {
    throw new Error(`Triage directory not found: ${triageDir}`);
  }
  const files = readdirSync(triageDir).filter(f => /^Email Triage -- .+\.md$/.test(f));

  const allRows: BackfillRow[] = [];
  for (const file of files) {
    summary.notesScanned++;
    const filePath = join(triageDir, file);
    const content = readFileSync(filePath, "utf8");
    const date = filenameToDate(file);
    if (!date) { summary.notesSkipped++; continue; }
    if (!hasActionableSections(content)) { summary.notesSkipped++; continue; }
    const stage5Rows = parseBulkDisposeSection(content, date);
    const stage6Rows = parseAutoProcessedSection(content, date);
    allRows.push(...stage5Rows, ...stage6Rows);
  }

  summary.rowsParsed = allRows.length;
  for (const r of allRows) {
    summary.byStage[r.source] = (summary.byStage[r.source] ?? 0) + 1;
    summary.byAction[r.actionCode] = (summary.byAction[r.actionCode] ?? 0) + 1;
  }

  if (!options.dryRun) {
    const db = new Database(dbPath);
    const insertStmt = db.prepare(
      "INSERT INTO domain_activity (domain, address, triage_date, action_taken, email_id) VALUES (?, ?, ?, ?, ?)"
    );
    // Idempotency: delete any pre-existing rows with the exact same key
    const deleteStmt = db.prepare(
      "DELETE FROM domain_activity WHERE email_id = ? AND action_taken = ? AND triage_date = ?"
    );
    db.exec("BEGIN");
    for (const r of allRows) {
      deleteStmt.run(r.emailId, r.actionCode, r.triageDate);
      insertStmt.run(r.domain, r.address, r.triageDate, r.actionCode, r.emailId);
      summary.rowsInserted++;
    }
    db.exec("COMMIT");
    db.close();
  }

  return summary;
}

if (import.meta.main) {
  const dryRun = process.argv.includes("--dry-run");
  const summary = backfillDomainActivity({ dryRun });
  console.log(`Notes scanned:  ${summary.notesScanned}`);
  console.log(`Notes skipped:  ${summary.notesSkipped} (no date / not complete)`);
  console.log(`Rows parsed:    ${summary.rowsParsed}`);
  console.log(`Rows inserted:  ${summary.rowsInserted}${dryRun ? " (dry-run, no DB writes)" : ""}`);
  console.log(`By stage:       ${JSON.stringify(summary.byStage)}`);
  console.log(`By action:      ${JSON.stringify(summary.byAction)}`);
}
