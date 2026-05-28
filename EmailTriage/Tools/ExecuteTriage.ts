// ~/.claude/skills/EmailTriage/execute-triage.ts
// Usage: bun run execute-triage.ts [--file PATH] [--date YYYY-MM-DD] [--stage N|all] [--dry-run]

import { execSync } from "child_process";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { addJunkSender, addVipSender, initDb, recordEmailAction, recordFollowUp, resolveFollowUp, recordScheduledSend, recordDomainActivity, autoBlockFrequentTrashDomains } from "./Db";
import { createSendPackage } from "./SendLater";
import { stageDraft, getApprovedDrafts, markDraftSent } from "./StagedDrafts";
import { getStageFolderPath } from "./Types";
import type { FunnelStage, AccountAlias } from "./Types";
import { transportFor } from "./Transport";

// Map a stage folder name (e.g. "Stage 1 - VIP") to the canonical FunnelStage key.
// Used by Phase 1 commit 4 Gmail routing: when an action targets a stage, we need
// to derive the FunnelStage so Transport.moveToStage can apply the right Gmail label.
function stageFromFolderName(folderName: string): FunnelStage | null {
  if (folderName.includes("Stage 1")) return "vip";
  if (folderName.includes("Stage 2")) return "action";
  if (folderName.includes("Stage 3")) return "financial";
  if (folderName.includes("Stage 4")) return "informational";
  if (folderName.includes("Stage 5")) return "bulk_dispose";
  if (folderName.includes("Stage 6")) return "auto_processed";
  return null;
}

/** Map CLI stage numbers to FunnelStage values */
const STAGE_NUMBER_MAP: Record<string, FunnelStage> = {
  "1": "vip",
  "2": "action",
  "3": "financial",
  "4": "informational",
  "5": "bulk_dispose",
  "6": "auto_processed",
};

const APPLE_MAIL = `${process.env.HOME}/.claude/skills/AppleMail/Tools/apple-mail.sh`;
// Vault root is loaded from SKILLCUSTOMIZATIONS/EmailTriage/preferences.yaml `vault_root` key
// or EMAILTRIAGE_VAULT_ROOT env var. Falls back to a sample default for tests.
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
const TRIAGE_DIR = VAULT_ROOT ? join(VAULT_ROOT, "Email Triage") : "";
// import.meta.dir is Bun-only and undefined in Next.js/Node.js context; resolved lazily.
// Tools/ now lives one level inside skill root, so go up one level.
function getSkillDir(): string {
  if (import.meta.dir) {
    // Strip /Tools suffix if present
    const dir = import.meta.dir;
    return dir.endsWith("/Tools") ? dir.slice(0, -6) : dir;
  }
  return join((process.env.HOME ?? (() => { throw new Error("HOME env var not set"); })()), ".claude/skills/EmailTriage");
}

/** Resolve triage note path for a given date (YYYY-MM-DD).
 *  Checks canonical name first, falls back to date-only filename. */
function resolveTriageNotePath(date: string): string {
  const MONTHS = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  const [y, m, d] = date.split("-").map(Number);
  const canonical = join(TRIAGE_DIR, `Email Triage -- ${MONTHS[m - 1]} ${d}, ${y}.md`);
  if (existsSync(canonical)) return canonical;
  // Fallback: legacy date-only file
  const legacy = join(TRIAGE_DIR, `${date}.md`);
  if (existsSync(legacy)) return legacy;
  // Return canonical path (will trigger "not found" error downstream)
  return canonical;
}
function getDbPath(): string {
  return join(getSkillDir(), "triage.db");
}

// --- Parsing functions ---

/** Extract numeric email ID from various formats:
 *  - `[87126](message://87126) [i]` -> "87126"
 *  - `[`87126`](message://87126)` -> "87126"
 *  - `` `87126` `` -> "87126"
 *  - `87126` -> "87126" */
function extractIdFromCell(cell: string): string {
  // Link format: [87126](message://...) or [`87126`](message://...)
  const linkMatch = cell.match(/\[`?(\d+)`?\]\(message:/);
  if (linkMatch) return linkMatch[1];
  // Backtick format: `87126`
  const btMatch = cell.match(/`(\d+)`/);
  if (btMatch) return btMatch[1];
  // Plain numeric
  const numMatch = cell.match(/^(\d+)/);
  if (numMatch) return numMatch[1];
  return cell.trim();
}

export function parseActionsCell(actions: string): string[] {
  const trimmed = actions.trim();
  if (trimmed === "") return [];
  return trimmed.split(",").map(s => s.trim().toUpperCase()).filter(s => s.length > 0);
}

export function parseTriageTable(tableText: string): Array<{ id: string; actions: string[]; notes: string }> {
  if (!tableText.trim()) return [];
  const lines = tableText.trim().split("\n");
  const results: Array<{ id: string; actions: string[]; notes: string }> = [];

  // Detect column layout from header row by finding the Action column dynamically
  // Possible layouts:
  //   | ID | Sender | Subject | Actions | Notes |           (old 5-col)
  //   | ID | Sender | Subject | AI Summary | Action |       (6-col without Date)
  //   | ID | Date | Sender | Subject | AI Summary | Action | (7-col with Date)
  let actionCol = 3;
  let notesCol = 4;
  const headerLine = lines.find(l => l.startsWith("|") && /\bID\b/.test(l));
  if (headerLine) {
    const headerCells = headerLine.split("|").slice(1, -1).map(c => c.trim());
    const actionIdx = headerCells.findIndex(c => /^Action/i.test(c));
    if (actionIdx >= 0) {
      actionCol = actionIdx;
      notesCol = actionIdx + 1;
    }
  }

  for (const line of lines) {
    // Skip header row and separator row
    if (!line.startsWith("|")) continue;
    const rawCells = line.split("|");
    const cells = rawCells.slice(1, -1).map(c => c.trim());
    if (cells.length < actionCol + 1) continue;
    // Skip separator row (all dashes)
    if (cells[0].match(/^-+$/)) continue;
    // Skip header row (contains "ID")
    if (cells[0] === "ID") continue;

    const id = extractIdFromCell(cells[0]);
    const actionsStr = cells[actionCol] ?? "";
    const notes = cells[notesCol] ?? "";
    results.push({
      id,
      actions: parseActionsCell(actionsStr),
      notes: notes.trim(),
    });
  }

  return results;
}

/** Parse mini-block format used for VIP and Action stages.
 *  Each block starts with #### `ID` and contains **Action:** [X] and **You:** instructions */
export function parseMiniBlocks(sectionText: string): Array<{ id: string; actions: string[]; notes: string; sender?: string; subject?: string }> {
  if (!sectionText.trim()) return [];
  const results: Array<{ id: string; actions: string[]; notes: string; sender?: string; subject?: string }> = [];

  // Split on #### headers
  const blocks = sectionText.split(/^####\s+/m).filter(b => b.trim());

  for (const block of blocks) {
    // Extract ID and sender from start of block. Supports two formats:
    //   Backtick: `87420` ali@aliabdaal.com
    //   Link:     [87353](message://...) Anand.Shah@osumc.edu
    const backtickMatch = block.match(/^`(\d+)`\s+(\S+)/);
    const linkMatch = block.match(/^\[(\d+)\]\(message:[^\)]+\)\s+(\S+)/);
    const idMatch = backtickMatch ?? linkMatch;
    if (!idMatch) continue;

    const id = idMatch[1];
    const sender = idMatch[2]?.replace(/\s*\[VIP\]/, "") ?? undefined;

    // Extract subject from **Subject** line
    const subjectMatch = block.match(/\*\*([^*]+)\*\*/);
    const subject = subjectMatch ? subjectMatch[1].replace(/\s*\[att\]/, "").trim() : undefined;

    // Extract action from **Action:** [X]
    const actionMatch = block.match(/\*\*Action:\*\*\s*\[([^\]]*)\]/);
    const actionStr = actionMatch ? actionMatch[1] : "";
    const actions = parseActionsCell(actionStr);

    // Extract user instructions from **You:** ...
    const youMatch = block.match(/\*\*You:\*\*\s*(.*?)$/m);
    const notes = youMatch ? youMatch[1].trim() : "";

    results.push({ id, actions, notes, sender, subject });
  }

  return results;
}

/** Parse the new bulk dispose table format with checkbox columns: A, T, U, BD, BS */
export function parseBulkDisposeTable(tableText: string): Array<{ id: string; actionCodes: string[] }> {
  if (!tableText.trim()) return [];
  const results: Array<{ id: string; actionCodes: string[] }> = [];
  const lines = tableText.trim().split("\n");

  for (const line of lines) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map(c => c.trim());
    if (cells.length < 8) continue;
    // Skip header and separator rows
    if (cells[0] === "ID" || cells[0].match(/^-+$/)) continue;

    const id = cells[0];
    const codes: string[] = [];
    // Column indices: 3=A, 4=T, 5=U, 6=BD, 7=BS
    if (cells[3]?.toLowerCase() === "x") codes.push("A");
    if (cells[4]?.toLowerCase() === "x") codes.push("T");
    if (cells[5]?.toLowerCase() === "x") codes.push("U");
    if (cells[6]?.toLowerCase() === "x") codes.push("BD");
    if (cells[7]?.toLowerCase() === "x") codes.push("BS");
    // Default to archive if nothing marked
    if (codes.length === 0) codes.push("A");

    results.push({ id, actionCodes: codes });
  }
  return results;
}

export function parseCheckboxList(listText: string): Array<{ id: string; checked: boolean }> {
  if (!listText.trim()) return [];
  const results: Array<{ id: string; checked: boolean }> = [];
  const regex = /^- \[(x| )\] `(\d+)`/gm;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(listText)) !== null) {
    results.push({
      id: match[2],
      checked: match[1] === "x",
    });
  }
  return results;
}

export function parseInstructions(instructionsText: string): Array<{ type: string; value: string }> {
  if (!instructionsText.trim()) return [];
  const results: Array<{ type: string; value: string }> = [];
  const lines = instructionsText.trim().split("\n");

  for (const line of lines) {
    const trimmed = line.trim();

    // "add @domain.com to junk" or "add domain.com to junk"
    const junkMatch = trimmed.match(/^add\s+@?([a-zA-Z0-9._-]+\.[a-zA-Z]{2,})\s+to\s+junk$/i);
    if (junkMatch) {
      results.push({ type: "add_junk_domain", value: junkMatch[1] });
      continue;
    }

    // "VIP add email@x.com"
    const vipMatch = trimmed.match(/^vip\s+add\s+(\S+@\S+)$/i);
    if (vipMatch) {
      results.push({ type: "add_vip", value: vipMatch[1] });
      continue;
    }
  }

  return results;
}

// --- Execution Plan ---

export interface ActionItem {
  id: string;
  actionCodes: string[];
  replyDraft?: string;
  sender?: string;
  subject?: string;
  notes?: string;               // "You:" instructions from triage note
  account?: AccountAlias;       // Account alias from account-map (e.g., "i", "g")
  funnelStage?: FunnelStage;    // Which stage section this email came from
  source: "table" | "bulk-dispose" | "auto-processed" | "auto-archive" | "auto-trash" | "unsub";
  arrivalTimestamp?: string;    // Parsed from arrival-map frontmatter
}

export interface ExecutionPlan {
  instructions: Array<{ type: string; value: string }>;
  actions: ActionItem[];
  summary: {
    archive: number;
    trash: number;
    reply: number;
    defer: number;
    keep: number;
    junk: number;
    block: number;
    unsub: number;
    approve: number;
    flag: number;
    sendLater: number;
    complexActions: number;
  };
}

function extractSection(noteContent: string, sectionName: string): string {
  // Match ## [x] SectionName or ## [] SectionName or ## SectionName (legacy) until next ## or end
  const escaped = sectionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`^## (?:\\[.?\\] )?${escaped}[^\n]*\n((?:(?!^## ).)*)`, "ms");
  const match = noteContent.match(regex);
  return match ? match[1].trim() : "";
}

/** Check if a stage heading has been reviewed (marked with [x] or [X]) */
function isStageReviewed(noteContent: string, sectionName: string): boolean {
  const escaped = sectionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`^## \\[[xX]\\] ${escaped}`, "m");
  return regex.test(noteContent);
}

/** Check if any stage has a review checkbox (new format detection) */
function hasReviewCheckboxes(noteContent: string): boolean {
  return /^## \[.?\] Stage \d/m.test(noteContent);
}

/** Parse mark-column tables (Stages 4-6 new format).
 *  Finds column headers, identifies which columns are mark columns (single letter or 2-char codes),
 *  and returns rows with the marked action codes. */
export function parseMarkColumnTable(tableText: string): Array<{ id: string; actionCodes: string[]; archiveTo?: string; notes?: string; sender?: string }> {
  if (!tableText.trim()) return [];
  const lines = tableText.trim().split("\n").filter(l => l.startsWith("|"));
  if (lines.length < 3) return []; // Need header + separator + at least one data row

  // Parse header to find column positions
  const headerCells = lines[0].split("|").slice(1, -1).map(c => c.trim());
  const markCodes = new Set(["A", "T", "K", "J", "U", "BD", "BS"]);
  const markColumns: Array<{ index: number; code: string }> = [];
  let archiveToCol = -1;
  let youCol = -1;
  let senderCol = -1;

  for (let i = 0; i < headerCells.length; i++) {
    const h = headerCells[i];
    if (markCodes.has(h)) markColumns.push({ index: i, code: h });
    if (/^Archive To$/i.test(h)) archiveToCol = i;
    if (/^You$/i.test(h)) youCol = i;
    if (/^Sender$/i.test(h)) senderCol = i;
  }

  const results: Array<{ id: string; actionCodes: string[]; archiveTo?: string; notes?: string; sender?: string }> = [];

  for (let lineIdx = 2; lineIdx < lines.length; lineIdx++) {
    const cells = lines[lineIdx].split("|").slice(1, -1).map(c => c.trim());
    if (cells.length < 2) continue;
    if (cells[0].match(/^-+$/)) continue;

    const id = extractIdFromCell(cells[0]);
    const codes: string[] = [];
    for (const mc of markColumns) {
      if (mc.index < cells.length && cells[mc.index]?.toLowerCase() === "x") {
        codes.push(mc.code);
      }
    }

    const archiveTo = archiveToCol >= 0 && archiveToCol < cells.length ? cells[archiveToCol] : undefined;
    const notes = youCol >= 0 && youCol < cells.length ? cells[youCol] : undefined;
    // Extract sender address from Sender column (strip backticks, [NEW] badges, escapes)
    let sender: string | undefined;
    if (senderCol >= 0 && senderCol < cells.length) {
      sender = cells[senderCol]
        .replace(/`\[NEW\]`/g, "")
        .replace(/\\\|/g, "|")
        .trim() || undefined;
    }
    results.push({
      id,
      actionCodes: codes.length > 0 ? codes : ["A"], // Default: archive
      archiveTo: archiveTo && archiveTo !== "--" ? archiveTo : undefined,
      notes: notes?.trim() || undefined,
      sender,
    });
  }

  return results;
}

function extractReplyDrafts(noteContent: string): Map<string, string> {
  const drafts = new Map<string, string>();
  // Match **ID -- sender:** followed by > draft lines
  const regex = /\*\*(\d+)\s*--\s*[^:]+:\*\*\n((?:>\s*.+\n?)+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(noteContent)) !== null) {
    const id = match[1];
    const draftLines = match[2]
      .split("\n")
      .map(l => l.replace(/^>\s?/, "").trim())
      .filter(l => l.length > 0);
    drafts.set(id, draftLines.join("\n"));
  }
  return drafts;
}

function countAction(codes: string[], code: string): boolean {
  return codes.some(c => c === code || c.startsWith(code + ":"));
}

export function buildExecutionPlan(noteContent: string): ExecutionPlan {
  // 0. Parse account-map from YAML frontmatter
  const accountMap = parseAccountMap(noteContent);
  const arrivalMap = parseArrivalMap(noteContent);

  // Detect if this is a new-format note with review checkboxes
  const useReviewGating = hasReviewCheckboxes(noteContent);

  // Helper: map section name prefix to FunnelStage
  const sectionToStage: Record<string, FunnelStage> = {
    "Stage 1: VIP": "vip",
    "Follow-Up Due": "follow_up_due",
    "Stage 2: Action Required": "action",
    "Stage 3: Financial": "financial",
    "Stage 4: Informational": "informational",
    "Stage 5: Bulk Dispose": "bulk_dispose",
    "Stage 6: Auto-Processed": "auto_processed",
  };

  // Helper: enrich an ActionItem with account, funnelStage, and arrivalTimestamp
  function enrichItem(item: ActionItem, stage?: FunnelStage): ActionItem {
    item.account = accountMap.get(item.id) ?? ("i" as AccountAlias);
    const arrival = arrivalMap.get(item.id);
    if (arrival) item.arrivalTimestamp = arrival;
    if (stage) item.funnelStage = stage;
    return item;
  }

  // 1. Parse instructions
  const instructionsSection = extractSection(noteContent, "Instructions");
  // Filter out italic help text lines
  const instructionLines = instructionsSection
    .split("\n")
    .filter(l => !l.startsWith("*") && !l.startsWith(">") && l.trim().length > 0)
    .join("\n");
  const instructions = parseInstructions(instructionLines);

  // 2. Parse action tables
  const allActions: ActionItem[] = [];
  const replyDrafts = extractReplyDrafts(noteContent);

  // Parse mini-block sections (VIP, Follow-Up Due, and Action stages use #### `ID` blocks)
  const miniBlockSections = ["Stage 1: VIP", "Follow-Up Due", "Stage 2: Action Required"];
  for (const sectionPrefix of miniBlockSections) {
    // Skip unreviewed stages if review gating is active
    if (useReviewGating && !isStageReviewed(noteContent, sectionPrefix)) continue;
    const section = extractSection(noteContent, sectionPrefix);
    if (!section) continue;
    const stage = sectionToStage[sectionPrefix];
    const rows = parseMiniBlocks(section);
    for (const row of rows) {
      const item: ActionItem = {
        id: row.id,
        actionCodes: row.actions,
        sender: row.sender,
        subject: row.subject,
        notes: row.notes || undefined,
        source: "table",
      };
      if (replyDrafts.has(row.id)) {
        item.replyDraft = replyDrafts.get(row.id);
      }
      allActions.push(enrichItem(item, stage));
    }
  }

  // Parse Stage 3 Financial (uses table with Action column)
  if (!useReviewGating || isStageReviewed(noteContent, "Stage 3: Financial")) {
    const financialSection = extractSection(noteContent, "Stage 3: Financial");
    if (financialSection) {
      const tableLines = financialSection.split("\n").filter(l => l.startsWith("|"));
      if (tableLines.length > 0) {
        const rows = parseTriageTable(tableLines.join("\n"));
        for (const row of rows) {
          const item: ActionItem = { id: row.id, actionCodes: row.actions, source: "table" };
          if (replyDrafts.has(row.id)) item.replyDraft = replyDrafts.get(row.id);
          allActions.push(enrichItem(item, "financial"));
        }
      }
    }
  }

  // Parse Stage 4 Informational (uses mark-column table with A/T/K)
  if (!useReviewGating || isStageReviewed(noteContent, "Stage 4: Informational")) {
    const infoSection = extractSection(noteContent, "Stage 4: Informational");
    if (infoSection) {
      const tableLines = infoSection.split("\n").filter(l => l.startsWith("|"));
      if (tableLines.length > 0) {
        const items = parseMarkColumnTable(tableLines.join("\n"));
        for (const item of items) {
          allActions.push(enrichItem({ id: item.id, actionCodes: item.actionCodes, source: "table", notes: item.notes, sender: item.sender }, "informational"));
        }
      }
    }
  }

  // Parse legacy table sections (backwards compat)
  const legacySections = ["Action Required", "Review Needed", "Unknown Senders"];
  const existingIds = new Set(allActions.map(a => a.id));
  for (const sectionPrefix of legacySections) {
    const section = extractSection(noteContent, sectionPrefix);
    if (!section) continue;
    const stage = sectionToStage[sectionPrefix];
    const tableLines = section.split("\n").filter(l => l.startsWith("|"));
    if (tableLines.length === 0) continue;
    const rows = parseTriageTable(tableLines.join("\n"));
    for (const row of rows) {
      if (existingIds.has(row.id)) continue;
      const item: ActionItem = { id: row.id, actionCodes: row.actions, source: "table" };
      if (replyDrafts.has(row.id)) item.replyDraft = replyDrafts.get(row.id);
      allActions.push(enrichItem(item, stage));
    }
  }

  // 3. Parse Stages 5-6 (supports both old and new format)

  // Stage 5: Bulk Dispose -- mark-column table (new) or checkbox table (old)
  if (!useReviewGating || isStageReviewed(noteContent, "Stage 5: Bulk Dispose")) {
    const bulkDisposeSection = extractSection(noteContent, "Stage 5: Bulk Dispose");
    if (bulkDisposeSection) {
      const tableLines = bulkDisposeSection.split("\n").filter(l => l.startsWith("|"));
      if (tableLines.length > 0) {
        const items = parseMarkColumnTable(tableLines.join("\n"));
        for (const item of items) {
          allActions.push(enrichItem({ id: item.id, actionCodes: item.actionCodes, source: "bulk-dispose", notes: item.notes, sender: item.sender }, "bulk_dispose"));
        }
      } else {
        // Legacy checkbox list fallback
        const items = parseCheckboxList(bulkDisposeSection);
        for (const item of items) {
          if (item.checked) {
            allActions.push(enrichItem({ id: item.id, actionCodes: ["A"], source: "bulk-dispose" }, "bulk_dispose"));
          }
        }
      }
    }
  }

  // Stage 6: Auto-Processed -- mark-column table (new) or checkbox list (old)
  if (!useReviewGating || isStageReviewed(noteContent, "Stage 6: Auto-Processed")) {
    const autoProcessedSection = extractSection(noteContent, "Stage 6: Auto-Processed");
    if (autoProcessedSection) {
      const tableLines = autoProcessedSection.split("\n").filter(l => l.startsWith("|"));
      if (tableLines.length > 0) {
        // New table format: mark columns determine action
        const items = parseMarkColumnTable(tableLines.join("\n"));
        for (const item of items) {
          allActions.push(enrichItem({ id: item.id, actionCodes: item.actionCodes, source: "auto-processed", notes: item.notes, sender: item.sender }, "auto_processed"));
        }
      } else {
        // Legacy checkbox list fallback
        const items = parseCheckboxList(autoProcessedSection);
        for (const item of items) {
          if (item.checked) {
            const lineMatch = autoProcessedSection.match(new RegExp(`\\[x\\] \`${item.id}\`[^\n]*`));
            const isJunk = lineMatch && /\(junk:/.test(lineMatch[0]);
            allActions.push(enrichItem({
              id: item.id,
              actionCodes: [isJunk ? "T" : "A"],
              source: "auto-processed",
            }, "auto_processed"));
          }
        }
      }
    }
  }

  // Legacy format: Auto-Archive Queue
  const autoArchiveSection = extractSection(noteContent, "Auto-Archive Queue");
  if (autoArchiveSection) {
    const items = parseCheckboxList(autoArchiveSection);
    for (const item of items) {
      if (item.checked) {
        allActions.push({ id: item.id, actionCodes: ["A"], source: "auto-archive" });
      }
    }
  }

  // Legacy format: Auto-Trash Queue
  const autoTrashSection = extractSection(noteContent, "Auto-Trash Queue");
  if (autoTrashSection) {
    const items = parseCheckboxList(autoTrashSection);
    for (const item of items) {
      if (item.checked) {
        allActions.push({ id: item.id, actionCodes: ["T"], source: "auto-trash" });
      }
    }
  }

  // Legacy format: Unsubscribe Queue
  const unsubSection = extractSection(noteContent, "Unsubscribe Queue");
  if (unsubSection) {
    const items = parseCheckboxList(unsubSection);
    for (const item of items) {
      if (item.checked) {
        allActions.push({ id: item.id, actionCodes: ["U"], source: "unsub" });
      }
    }
  }

  // 4. Compute summary
  const summary = {
    archive: 0, trash: 0, reply: 0, defer: 0, keep: 0,
    junk: 0, block: 0, unsub: 0, approve: 0, flag: 0, sendLater: 0,
    complexActions: 0,
  };

  // Count emails with non-empty "You:" instructions as complex actions
  for (const a of allActions) {
    if (a.notes && a.notes.trim().length > 0) {
      summary.complexActions++;
    }
  }

  for (const a of allActions) {
    for (const code of a.actionCodes) {
      if (code === "A") summary.archive++;
      else if (code === "T") summary.trash++;
      else if (code === "R") summary.reply++;
      else if (code === "D") summary.defer++;
      else if (code === "K") summary.keep++;
      else if (code === "J") { summary.junk++; summary.trash++; }
      else if (code === "BL") { summary.block++; summary.trash++; }
      else if (code === "BD") { summary.block++; summary.trash++; }
      else if (code === "BS") { summary.block++; summary.trash++; }
      else if (code === "U") summary.unsub++;
      else if (code === "AP") summary.approve++;
      else if (code.startsWith("SEND_AT:")) summary.sendLater++;
      else if (code.startsWith("FU")) summary.flag++;
    }
  }

  return { instructions, actions: allActions, summary };
}

// --- Execution ---

function runAppleMail(args: string, dryRun: boolean): string {
  const cmd = `"${APPLE_MAIL}" ${args}`;
  if (dryRun) {
    console.log(`[DRY RUN] ${cmd}`);
    return "";
  }
  try {
    return execSync(cmd, { stdio: "pipe", timeout: 30_000 }).toString().trim();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[ERROR] ${cmd}: ${msg}`);
    return "";
  }
}

/** Stage folder names for fallback search (ordered by most common first) */
const ALL_STAGE_FOLDERS = [
  "Stage 5 - Bulk Dispose",
  "Stage 6 - Auto-Processed",
  "Stage 4 - Informational",
  "Stage 2 - Action Required",
  "Stage 1 - VIP",
  "Stage 3 - Financial",
];

/** When a message is not found at the expected location, search all staging folders
 *  for that account. Apple Mail reassigns numeric IDs when messages are moved,
 *  and the triage note may have stale IDs despite the generator's reconciliation step.
 *  Returns the working --mailbox argument, or empty string if not found anywhere. */
function findMessageInStagingFolders(emailId: string, account: AccountAlias): string {
  for (const folder of ALL_STAGE_FOLDERS) {
    try {
      const result = execSync(
        `"${APPLE_MAIL}" list --mailbox "${folder}" 500`,
        { stdio: "pipe", timeout: 15_000 },
      ).toString();
      // Check if this ID appears in the listing
      if (result.includes(`ID:${emailId} `)) {
        console.log(`  [FALLBACK] Found ${emailId} in ${folder}`);
        return ` --mailbox "${folder}"`;
      }
    } catch { /* folder may not exist or be empty */ }
  }
  // Also check inbox as last resort
  try {
    const result = execSync(
      `"${APPLE_MAIL}" list "${account}" 500`,
      { stdio: "pipe", timeout: 15_000 },
    ).toString();
    if (result.includes(`ID:${emailId} `)) {
      console.log(`  [FALLBACK] Found ${emailId} in ${account} inbox`);
      return "";  // No --mailbox needed for inbox (default)
    }
  } catch { /* inbox check failed */ }
  return "";
}

/** Run an apple-mail.sh command with fallback: if the message is not found at the
 *  expected mailbox, search all staging folders for that account and retry.
 *
 *  Phase 1 commit 4 Gmail routing: when item.account === "g", dispatch via the
 *  GwsGmailTransport instead of apple-mail.sh. After Phase 1 ships, the Gmail
 *  account is removed from Mail.app, so apple-mail.sh would fail anyway.
 *  Supported Gmail actions: archive, trash, mark-read, mark-unread, move (when
 *  target mailbox is a Stage folder). Unsupported: move (non-Stage targets like
 *  "Later"), flag — these warn and skip on Gmail (apple-mail.sh path stays for
 *  iCloud and other accounts).
 */
async function runAppleMailWithFallback(
  action: string,
  emailId: string,
  mb: string,
  item: ActionItem,
  dryRun: boolean,
  extraArgs: string = "",
): Promise<string> {
  // Gmail routing via Transport (Phase 1 commit 4)
  if (item.account === "g") {
    if (dryRun) {
      console.log(`[DRY RUN] gws transport ${action} ${emailId}${extraArgs}${mb}`);
      return "";
    }
    try {
      const transport = transportFor("g");
      switch (action) {
        case "archive":
          await transport.archive(emailId);
          return "";
        case "trash":
          await transport.trash(emailId);
          return "";
        case "mark-read":
          await transport.markRead(emailId, true);
          return "";
        case "mark-unread":
          await transport.markRead(emailId, false);
          return "";
        case "move": {
          // Parse target mailbox from extraArgs (e.g. ' "Later"') or mb (' --mailbox "Stage 1 - VIP"').
          // For Stage targets, use Transport.moveToStage. For non-Stage (Later, Junk, etc.),
          // skip with warning until a future commit extends the interface.
          const stageMatch = mb.match(/--mailbox "([^"]+)"/);
          if (stageMatch) {
            const stage = stageFromFolderName(stageMatch[1]);
            if (stage) {
              await transport.moveToStage(emailId, stage);
              return "";
            }
          }
          console.warn(`  [SKIP-GMAIL] move ${emailId} to "${extraArgs.trim() || mb.trim()}" — non-stage targets not yet supported on Gmail (Phase 1 commit 4 limitation)`);
          return "";
        }
        case "flag":
          console.warn(`  [SKIP-GMAIL] flag ${emailId} — flag not yet supported on Gmail Transport (Phase 1 commit 4 limitation; use star/label in a later phase)`);
          return "";
        default:
          console.warn(`  [SKIP-GMAIL] action "${action}" on ${emailId} — not yet routed via Transport (Phase 1 commit 4 limitation)`);
          return "";
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`  [GMAIL-ERROR] ${action} ${emailId}: ${msg}`);
      return "";
    }
  }

  // iCloud + other accounts: existing apple-mail.sh path (literally untouched per design Q1=C single-writer-per-account)
  const result = runAppleMail(`${action} ${emailId}${extraArgs}${mb}`, dryRun);
  if (dryRun) return result;

  // Check if the command returned a "not found" error or was empty (exception in runAppleMail)
  const isError = result === "" || result.includes("not found") || result.includes("Error:");
  if (isError) {
    const account = item.account ?? ("i" as AccountAlias);
    console.log(`  [RETRY] ${emailId} not found at expected location, searching staging folders for account ${account}…`);
    const fallbackMb = findMessageInStagingFolders(emailId, account);
    if (fallbackMb) {
      return runAppleMail(`${action} ${emailId}${extraArgs}${fallbackMb}`, dryRun);
    }
    console.error(`  [FAIL] ${emailId} not found in any staging folder or inbox for account ${account}`);
  }
  return result;
}

/** Parse the account-map from YAML frontmatter: "id:alias,id:alias,..."
 *  Handles both quoted and unquoted YAML values. */
export function parseAccountMap(noteContent: string): Map<string, AccountAlias> {
  // Try quoted format first: account-map: "87446:i,87445:i,..."
  let match = noteContent.match(/^account-map:\s*"([^"]*)"/m);
  // Fallback to unquoted format: account-map: 87446:i,87445:i,...
  if (!match) match = noteContent.match(/^account-map:\s*([^\n]+)/m);
  if (!match) return new Map();
  const map = new Map<string, AccountAlias>();
  for (const pair of match[1].split(",")) {
    const [id, acct] = pair.split(":");
    if (id && acct) map.set(id.trim(), acct.trim() as AccountAlias);
  }
  return map;
}

/** Parse the arrival-map from YAML frontmatter: "id:timestamp,id:timestamp,..."
 *  Timestamps contain colons (e.g., YYYY-MM-DD_HH:MM). Splitting must be done on the FIRST colon only.
 *  Handles both quoted and unquoted YAML values. */
export function parseArrivalMap(noteContent: string): Map<string, string> {
  // Try quoted format first: arrival-map: "87446:2026-03-12_08:15,..."
  let match = noteContent.match(/^arrival-map:\s*"([^"]*)"/m);
  // Fallback to unquoted format
  if (!match) match = noteContent.match(/^arrival-map:\s*([^\n]+)/m);
  if (!match) return new Map();
  const map = new Map<string, string>();
  for (const pair of match[1].split(",")) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx > 0) {
      const id = trimmed.slice(0, colonIdx).trim();
      const timestamp = trimmed.slice(colonIdx + 1).trim();
      if (id && timestamp) map.set(id, timestamp);
    }
  }
  return map;
}


/** Resolve the --mailbox argument for an email in a per-account stage folder.
 *  apple-mail.sh --mailbox requires folder name WITHOUT account prefix.
 *  getStageFolderPath returns "i/Stages/Stage 1 - VIP" -- we strip the "i/" prefix. */
function resolveMailbox(item: ActionItem): string {
  if (!item.funnelStage || !item.account) return "";
  const fullPath = getStageFolderPath(item.funnelStage, item.account);
  if (!fullPath) return "";
  // Strip account prefix (e.g. "i/" or "g/") for --mailbox flag compatibility
  const slashIdx = fullPath.indexOf("/");
  const mailboxName = slashIdx >= 0 ? fullPath.slice(slashIdx + 1) : fullPath;
  return ` --mailbox "${mailboxName}"`;
}

/** Extract email address from sender string ("Name <email@dom.com>" or "email@dom.com")
 *  and return { address, domain } or null if no email found. */
function extractSenderDomain(sender: string | undefined): { address: string; domain: string } | null {
  if (!sender) return null;
  // Handle "Name <email@domain.com>" format
  const angleMatch = sender.match(/<([^>]+)>/);
  const email = angleMatch ? angleMatch[1].trim() : sender.trim();
  const atIdx = email.lastIndexOf("@");
  if (atIdx < 0) return null;
  const address = email.toLowerCase();
  const domain = address.slice(atIdx + 1);
  return { address, domain };
}

async function executeAction(
  item: ActionItem,
  db: any,
  dryRun: boolean,
): Promise<void> {
  const mb = resolveMailbox(item);
  const senderInfo = extractSenderDomain(item.sender);
  const triageDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());

  for (const code of item.actionCodes) {
    switch (code) {
      case "A":
        await runAppleMailWithFallback("archive", item.id, mb, item, dryRun);
        if (!dryRun) {
          recordEmailAction(db, item.id, "archive");
          if (senderInfo) recordDomainActivity(db, senderInfo.domain, senderInfo.address, triageDate, "A", item.id, item.arrivalTimestamp);
          resolveFollowUp(db, item.id);
        }
        break;
      case "T":
        await runAppleMailWithFallback("trash", item.id, mb, item, dryRun);
        if (!dryRun) {
          recordEmailAction(db, item.id, "trash");
          if (senderInfo) recordDomainActivity(db, senderInfo.domain, senderInfo.address, triageDate, "T", item.id, item.arrivalTimestamp);
        }
        break;
      case "R":
        if (item.replyDraft && !dryRun) {
          // Stage draft to vault for review instead of sending directly (Phase 15.4)
          const acctAlias = item.account?.startsWith("g") ? "g" : "i";
          stageDraft({
            emailId: item.id,
            to: item.sender ?? "",
            subject: item.subject ?? "",
            inReplyTo: undefined,
            account: acctAlias,
            body: item.replyDraft,
            stagedAt: new Date().toISOString(),
          });
          recordEmailAction(db, item.id, "reply");
          if (senderInfo) recordDomainActivity(db, senderInfo.domain, senderInfo.address, triageDate, "R", item.id, item.arrivalTimestamp);
          resolveFollowUp(db, item.id);
        } else if (!dryRun) {
          recordEmailAction(db, item.id, "reply");
          if (senderInfo) recordDomainActivity(db, senderInfo.domain, senderInfo.address, triageDate, "R", item.id, item.arrivalTimestamp);
          resolveFollowUp(db, item.id);
        }
        break;
      case "D":
        await runAppleMailWithFallback("move", item.id, mb, item, dryRun, ' "Later"');
        if (!dryRun) {
          recordEmailAction(db, item.id, "defer");
          if (senderInfo) recordDomainActivity(db, senderInfo.domain, senderInfo.address, triageDate, "D", item.id, item.arrivalTimestamp);
        }
        break;
      case "K":
        // No-op — leave in stage folder
        if (!dryRun) {
          recordEmailAction(db, item.id, "keep");
          if (senderInfo) recordDomainActivity(db, senderInfo.domain, senderInfo.address, triageDate, "K", item.id, item.arrivalTimestamp);
        }
        break;
      case "J":
        await runAppleMailWithFallback("trash", item.id, mb, item, dryRun);
        if (!dryRun) {
          recordEmailAction(db, item.id, "junk");
          if (senderInfo) recordDomainActivity(db, senderInfo.domain, senderInfo.address, triageDate, "J", item.id, item.arrivalTimestamp);
        }
        break;
      case "BL":
        await runAppleMailWithFallback("trash", item.id, mb, item, dryRun);
        if (!dryRun) {
          const blAddress = item.sender?.toLowerCase();
          if (blAddress) {
            addJunkSender(db, { address: blAddress, reason: `blocked sender via triage BL on ${item.id}` });
            recordEmailAction(db, item.id, "block_sender", undefined, `Blocked sender: ${blAddress}`);
            if (senderInfo) recordDomainActivity(db, senderInfo.domain, senderInfo.address, triageDate, "BL", item.id, item.arrivalTimestamp);
          } else {
            console.error(`[WARN] BL for ${item.id}: no sender address available`);
            recordEmailAction(db, item.id, "block");
          }
        }
        break;
      case "U":
        // Unsubscribe handled separately via unsubscribe.ts
        if (!dryRun) {
          recordEmailAction(db, item.id, "unsub");
          if (senderInfo) recordDomainActivity(db, senderInfo.domain, senderInfo.address, triageDate, "U", item.id, item.arrivalTimestamp);
        }
        break;
      case "AP":
        await runAppleMailWithFallback("mark-read", item.id, mb, item, dryRun);
        if (!dryRun) {
          recordEmailAction(db, item.id, "approve");
          if (senderInfo) recordDomainActivity(db, senderInfo.domain, senderInfo.address, triageDate, "AP", item.id, item.arrivalTimestamp);
        }
        break;
      case "BD":
        await runAppleMailWithFallback("trash", item.id, mb, item, dryRun);
        if (!dryRun) {
          // Extract domain from sender address (e.g. "aliabdaal.com" from "ali@aliabdaal.com")
          const bdDomain = item.sender?.includes("@") ? item.sender.split("@")[1]?.toLowerCase() : undefined;
          if (bdDomain) {
            addJunkSender(db, { domain: bdDomain, reason: `blocked domain via triage BD on ${item.id}` });
            recordEmailAction(db, item.id, "block_domain", undefined, `Blocked domain: ${bdDomain}`);
            if (senderInfo) recordDomainActivity(db, senderInfo.domain, senderInfo.address, triageDate, "BD", item.id, item.arrivalTimestamp);
          } else {
            console.error(`[WARN] BD for ${item.id}: no sender address available to extract domain`);
            recordEmailAction(db, item.id, "block");
          }
        }
        break;
      case "BS":
        await runAppleMailWithFallback("trash", item.id, mb, item, dryRun);
        if (!dryRun) {
          const bsAddress = item.sender?.toLowerCase();
          if (bsAddress) {
            addJunkSender(db, { address: bsAddress, reason: `blocked sender via triage BS on ${item.id}` });
            recordEmailAction(db, item.id, "block_sender", undefined, `Blocked sender: ${bsAddress}`);
            if (senderInfo) recordDomainActivity(db, senderInfo.domain, senderInfo.address, triageDate, "BS", item.id, item.arrivalTimestamp);
          } else {
            console.error(`[WARN] BS for ${item.id}: no sender address available`);
            recordEmailAction(db, item.id, "block");
          }
        }
        break;
      default:
        if (code.startsWith("SEND_AT:")) {
          const sendAt = code.replace("SEND_AT:", "");
          if (item.replyDraft && item.sender && item.subject) {
            if (!dryRun) {
              const pkg = createSendPackage({
                recipient: item.sender,
                subject: `Re: ${item.subject}`,
                body: item.replyDraft,
                account: item.account ?? "i",
                sourceEmailId: item.id,
                sendAt,
              });
              recordScheduledSend(db, {
                emailId: item.id,
                sendAt,
                replyContent: item.replyDraft,
                recipient: item.sender,
                subject: `Re: ${item.subject}`,
                account: item.account,
                jsonPath: `scheduled/${pkg.id}.json`,
              });
              recordEmailAction(db, item.id, "send_later", undefined, `Scheduled for ${sendAt}`);
            } else {
              console.log(`[DRY RUN] Schedule send for ${item.id} at ${sendAt}`);
            }
          } else {
            console.error(`[WARN] SEND_AT for ${item.id}: missing reply draft, sender, or subject`);
          }
        } else if (code.startsWith("FU")) {
          await runAppleMailWithFallback("flag", item.id, mb, item, dryRun);
          const dateMatch = code.match(/^FU:(.+)$/);
          const fuDate = dateMatch ? dateMatch[1] : undefined;
          if (!dryRun) {
            recordEmailAction(db, item.id, "flag", undefined, fuDate);
            if (fuDate && item.sender) {
              const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
              recordFollowUp(db, {
                emailId: item.id,
                followUpDate: fuDate,
                sender: item.sender,
                subject: item.subject ?? "(no subject)",
                originalDate: today,
              });
            }
          }
        }
        break;
    }
  }
}

function executeInstructions(
  instructions: Array<{ type: string; value: string }>,
  db: any,
  dryRun: boolean,
): void {
  for (const inst of instructions) {
    if (dryRun) {
      console.log(`[DRY RUN] Instruction: ${inst.type} -> ${inst.value}`);
      continue;
    }
    switch (inst.type) {
      case "add_junk_domain":
        addJunkSender(db, { domain: inst.value, reason: "manual instruction" });
        break;
      case "add_vip":
        addVipSender(db, inst.value);
        break;
    }
  }
}

/** Build a structured "Complex Actions Pending" section for emails with "You:" instructions.
 *  This section is appended to the execution log so PAI can parse it and dispatch
 *  background agents for each complex action. */
function buildComplexActionsSection(plan: ExecutionPlan): string {
  const complexItems = plan.actions.filter(a => a.notes && a.notes.trim().length > 0);
  if (complexItems.length === 0) return "";

  let section = "\n### Complex Actions Pending\n";
  section += `*${complexItems.length} email(s) require background agent processing:*\n\n`;

  for (const item of complexItems) {
    const stageName = item.funnelStage ?? "unknown";
    const acct = item.account ?? "i";
    section += `- **${item.id}** | ${item.sender ?? "(unknown sender)"} | ${item.subject ?? "(no subject)"}\n`;
    section += `  - Stage: ${stageName} | Account: ${acct}\n`;
    section += `  - Instruction: ${item.notes}\n`;
  }

  return section;
}

function updateTriageNote(filePath: string, plan: ExecutionPlan): void {
  let content = readFileSync(filePath, "utf-8");

  // Update status in frontmatter
  content = content.replace(/^status:\s*pending$/m, "status: complete");
  content = content.replace(/^processed_at:.*$/m, `processed_at: "${new Date().toISOString()}"`);

  // Update Execution Log with per-stage breakdown
  const s = plan.summary;
  const complexNote = s.complexActions > 0 ? `  |  Complex: ${s.complexActions} pending` : "";

  // Build per-stage breakdown from actions
  const stageLabels: Record<string, string> = {
    vip: "Stage 1 (VIP)",
    action: "Stage 2 (Action)",
    financial: "Stage 3 (Financial)",
    informational: "Stage 4 (Informational)",
    bulk_dispose: "Stage 5 (Bulk Dispose)",
    auto_processed: "Stage 6 (Auto-Processed)",
    follow_up_due: "Follow-Up Due",
  };
  const stageCounts: Record<string, Record<string, number>> = {};
  for (const action of plan.actions) {
    const stage = action.funnelStage ?? "unknown";
    if (!stageCounts[stage]) stageCounts[stage] = {};
    for (const code of action.actionCodes) {
      const label =
        code === "A" ? "archive" : code === "T" ? "trash" : code === "R" ? "reply" :
        code === "U" ? "unsub" : code === "BD" || code === "BS" ? "block" :
        code === "K" ? "keep" : code === "J" ? "junk" : code === "F" ? "flag" :
        code === "D" ? "defer" : code;
      stageCounts[stage][label] = (stageCounts[stage][label] ?? 0) + 1;
    }
  }

  // Order stages by their natural funnel order
  const stageOrder = ["vip", "follow_up_due", "action", "financial", "informational", "bulk_dispose", "auto_processed"];
  const stageLines: string[] = [];
  for (const stageKey of stageOrder) {
    const counts = stageCounts[stageKey];
    if (!counts) continue;
    const label = stageLabels[stageKey] ?? stageKey;
    const parts = Object.entries(counts).map(([k, v]) => `${k}: ${v}`);
    stageLines.push(`\t- ${label}: ${parts.join(", ")}`);
  }
  // Include any unknown-stage actions
  if (stageCounts["unknown"]) {
    const parts = Object.entries(stageCounts["unknown"]).map(([k, v]) => `${k}: ${v}`);
    stageLines.push(`\t- Other: ${parts.join(", ")}`);
  }

  const stageBreakdown = stageLines.length > 0 ? "\n" + stageLines.join("\n") : "";

  const logEntry = `- Archived: ${s.archive}  |  Trashed: ${s.trash}  |  Replied: ${s.reply}  |  Unsubscribed: ${s.unsub}  |  Blocked: ${s.block}${complexNote}${stageBreakdown}
- Processed at: ${new Date().toISOString()}
- Duration: --`;

  content = content.replace(
    /- Archived: --\s*\|.*\r?\n- Processed at: --\r?\n- Duration: --/,
    logEntry,
  );

  // Append Complex Actions Pending section after the execution log
  const complexSection = buildComplexActionsSection(plan);
  if (complexSection) {
    // Insert before the end of the execution log section (before next ## or end of file)
    const execLogIdx = content.indexOf("## Execution Log");
    if (execLogIdx >= 0) {
      // Find the next ## heading after Execution Log, or end of file
      const afterExecLog = content.indexOf("\n## ", execLogIdx + 1);
      if (afterExecLog >= 0) {
        content = content.slice(0, afterExecLog) + "\n" + complexSection + content.slice(afterExecLog);
      } else {
        // Execution Log is the last section -- append at end
        content = content.trimEnd() + "\n" + complexSection;
      }
    }
  }

  // Post-processing cleanup: collapse processed stage tables and update headings
  content = collapseProcessedStages(content, plan);

  writeFileSync(filePath, content);
}

/** Collapse processed stage sections: replace [x] with checkmark emoji,
 *  replace the table with a one-line summary, and list complex actions if any. */
function collapseProcessedStages(content: string, plan: ExecutionPlan): string {
  // Build per-stage action counts from the plan
  const stageCounts: Record<string, Record<string, number>> = {};
  const stageComplexItems: Record<string, ActionItem[]> = {};
  for (const action of plan.actions) {
    const stage = action.funnelStage ?? "unknown";
    if (!stageCounts[stage]) stageCounts[stage] = {};
    if (!stageComplexItems[stage]) stageComplexItems[stage] = [];
    if (action.notes && action.notes.trim().length > 0) {
      stageComplexItems[stage].push(action);
    }
    for (const code of action.actionCodes) {
      const label =
        code === "A" ? "Archived" : code === "T" ? "Trashed" : code === "R" ? "Replied" :
        code === "U" ? "Unsub" : code === "BD" || code === "BS" ? "Blocked" :
        code === "K" ? "Kept" : code === "J" ? "Junked" : code === "F" ? "Flagged" :
        code === "D" ? "Deferred" : code === "AP" ? "Approved" : code;
      stageCounts[stage][label] = (stageCounts[stage][label] ?? 0) + 1;
    }
  }

  // Map FunnelStage keys to the section heading prefix used in the note
  const stageHeadingPrefixes: Record<string, string> = {
    vip: "Stage 1: VIP",
    follow_up_due: "Follow-Up Due",
    action: "Stage 2: Action Required",
    financial: "Stage 3: Financial",
    informational: "Stage 4: Informational",
    bulk_dispose: "Stage 5: Bulk Dispose",
    auto_processed: "Stage 6: Auto-Processed",
  };

  for (const [stageKey, counts] of Object.entries(stageCounts)) {
    const headingPrefix = stageHeadingPrefixes[stageKey];
    if (!headingPrefix) continue;

    // Match the full heading line: ## [x] Stage N: Name (count)
    const escapedPrefix = headingPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const headingRegex = new RegExp(`^(## )\\[[xX]\\] (${escapedPrefix}[^\\n]*)$`, "m");
    const headingMatch = content.match(headingRegex);
    if (!headingMatch) continue;

    // Replace [x] with checkmark emoji in the heading
    content = content.replace(headingRegex, "$1\u2705 $2");

    // Now collapse the table content for this section.
    // Find the section body start (after the heading line) and end (next ## or EOF)
    const updatedHeadingRegex = new RegExp(`^## \u2705 ${escapedPrefix}[^\\n]*\\n`, "m");
    const sectionStart = content.match(updatedHeadingRegex);
    if (!sectionStart || sectionStart.index === undefined) continue;

    const bodyStart = sectionStart.index + sectionStart[0].length;
    const nextHeadingIdx = content.indexOf("\n## ", bodyStart);
    const bodyEnd = nextHeadingIdx >= 0 ? nextHeadingIdx : content.length;

    // Build summary line
    const summaryParts = Object.entries(counts).map(([k, v]) => `${k}: ${v}`);
    let replacement = summaryParts.join(" | ") + "\n";

    // Add complex actions list if any exist for this stage
    const complexItems = stageComplexItems[stageKey] ?? [];
    if (complexItems.length > 0) {
      replacement += "\n**Complex Actions Pending:**\n";
      for (const item of complexItems) {
        replacement += `- ${item.id} (${item.sender ?? "unknown"}): ${item.notes}\n`;
      }
    }

    content = content.slice(0, bodyStart) + replacement + content.slice(bodyEnd);
  }

  return content;
}


/**
 * applyActions — run executeAction across a typed list of ActionItems, no
 * markdown-note parsing required. This is the entry point /api/execute uses
 * so the web UI can POST a structured payload and have the actions actually
 * fire against Mail.app + the DB.
 *
 * Codified 2026-05-19 after UX-12: /api/execute was calling only
 * buildExecutionPlan, so the UI's Process Marked button built a plan but
 * never executed it. Every Mail.app side-effect was a no-op while the UI
 * optimistically removed rows.
 *
 * Returns a summary derived from what was actually run.
 */
export async function applyActions(
  actions: ActionItem[],
  opts: { dryRun?: boolean } = {},
): Promise<ExecutionPlan["summary"] & { total: number; errors: string[] }> {
  const dryRun = opts.dryRun === true;
  const db = dryRun ? null : initDb(getDbPath());
  const summary = {
    archive: 0, trash: 0, reply: 0, defer: 0, keep: 0,
    junk: 0, block: 0, unsub: 0, approve: 0, flag: 0, sendLater: 0,
    complexActions: 0,
  };
  const errors: string[] = [];

  for (const item of actions) {
    try {
      await executeAction(item, db, dryRun);
      // Count by primary action code (first one wins)
      for (const code of item.actionCodes) {
        if (code === "A") summary.archive++;
        else if (code === "T") summary.trash++;
        else if (code === "R") summary.reply++;
        else if (code === "D") summary.defer++;
        else if (code === "K") summary.keep++;
        else if (code === "J") { summary.junk++; summary.trash++; }
        else if (code === "BL" || code === "BD" || code === "BS") { summary.block++; summary.trash++; }
        else if (code === "U") summary.unsub++;
        else if (code === "AP") summary.approve++;
        else if (code.startsWith("SEND_AT:")) summary.sendLater++;
        else if (code.startsWith("FU")) summary.flag++;
      }
      if (item.notes && item.notes.trim().length > 0) summary.complexActions++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${item.id}: ${msg}`);
    }
  }

  return { ...summary, total: actions.length, errors };
}

function printSummary(plan: ExecutionPlan): void {
  const s = plan.summary;
  const complexNote = s.complexActions > 0 ? ` | Complex Actions: ${s.complexActions} pending` : "";
  console.log(
    `Archived: ${s.archive} | Trashed: ${s.trash} | Replied: ${s.reply} | ` +
    `Deferred: ${s.defer} | Kept: ${s.keep} | Junk: ${s.junk} | ` +
    `Blocked: ${s.block} | Unsubscribed: ${s.unsub} | Approved: ${s.approve} | ` +
    `Flagged: ${s.flag} | Send Later: ${s.sendLater}${complexNote}`,
  );
}

/** Check inbox after execution and report completeness */
export function checkInboxCompleteness(
  remainingTotal: number,
  arrivedDuringProcessing: number,
): { remaining: number; message: string } {
  if (remainingTotal === 0) {
    return { remaining: 0, message: "Inbox zero achieved. 0 emails remain." };
  }
  const preTriage = Math.max(0, remainingTotal - arrivedDuringProcessing);
  return {
    remaining: remainingTotal,
    message: `Warning: ${remainingTotal} emails still in inbox (${preTriage} pre-triage, ${arrivedDuringProcessing} arrived during processing). Re-run /generate-email-triage to catch remaining.`,
  };
}

/** Count emails in current inbox */
function getInboxState(): { total: number; ids: Array<{ id: string }> } {
  try {
    const output = execSync(`bash "${APPLE_MAIL}" list 500`, {
      encoding: "utf-8",
      timeout: 90_000,
    });
    const lines = output.split("\n").filter(l => l.startsWith("ID:"));
    const ids = lines.map(line => {
      const idMatch = line.match(/^ID:(\d+)/);
      return { id: idMatch?.[1] ?? "" };
    }).filter(e => e.id);
    return { total: ids.length, ids };
  } catch {
    return { total: -1, ids: [] };
  }
}

// --- Main ---

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  let filePath: string | undefined;

  const fileIdx = args.indexOf("--file");
  if (fileIdx !== -1 && args[fileIdx + 1]) {
    filePath = args[fileIdx + 1];
  }

  // Support --date YYYY-MM-DD (documented in SKILL.md)
  if (!filePath) {
    const dateIdx = args.indexOf("--date");
    if (dateIdx !== -1 && args[dateIdx + 1]) {
      filePath = resolveTriageNotePath(args[dateIdx + 1]);
    }
  }

  if (!filePath) {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
    filePath = resolveTriageNotePath(today);
  }

  if (!existsSync(filePath)) {
    console.error(`Triage note not found: ${filePath}`);
    process.exit(1);
  }

  // Parse --stage flag: number (1-6), "all", or omitted (default: review-gated)
  let stageFilter: FunnelStage | "all" | undefined;
  const stageIdx = args.indexOf("--stage");
  if (stageIdx !== -1 && args[stageIdx + 1]) {
    const stageArg = args[stageIdx + 1].toLowerCase();
    if (stageArg === "all") {
      stageFilter = "all";
    } else if (STAGE_NUMBER_MAP[stageArg]) {
      stageFilter = STAGE_NUMBER_MAP[stageArg];
    } else {
      console.error(`Invalid --stage value: "${args[stageIdx + 1]}". Use 1-6 or "all".`);
      process.exit(1);
    }
  }

  const noteContent = readFileSync(filePath, "utf-8");
  const plan = buildExecutionPlan(noteContent);

  // Apply --stage filter: restrict actions to the specified stage
  if (stageFilter && stageFilter !== "all") {
    plan.actions = plan.actions.filter(a => a.funnelStage === stageFilter);
    // Recalculate summary for filtered actions
    plan.summary = { archive: 0, trash: 0, reply: 0, defer: 0, keep: 0, junk: 0, block: 0, unsub: 0, approve: 0, flag: 0, sendLater: 0, complexActions: 0 };
    for (const a of plan.actions) {
      if (a.notes && a.notes.trim().length > 0) plan.summary.complexActions++;
      for (const code of a.actionCodes) {
        if (code === "A") plan.summary.archive++;
        else if (code === "T") plan.summary.trash++;
        else if (code === "R") plan.summary.reply++;
        else if (code === "D") plan.summary.defer++;
        else if (code === "K") plan.summary.keep++;
        else if (code === "J") { plan.summary.junk++; plan.summary.trash++; }
        else if (code === "BL" || code === "BD" || code === "BS") { plan.summary.block++; plan.summary.trash++; }
        else if (code === "U") plan.summary.unsub++;
        else if (code === "AP") plan.summary.approve++;
        else if (code.startsWith("SEND_AT:")) plan.summary.sendLater++;
        else if (code.startsWith("FU")) plan.summary.flag++;
      }
    }
  }

  const stageLabel = stageFilter ? (stageFilter === "all" ? " (all stages)" : ` (stage: ${stageFilter})`) : "";
  console.log(dryRun ? "=== DRY RUN ===" : "=== EXECUTING TRIAGE ===");
  console.log(`Instructions: ${plan.instructions.length}${stageLabel}`);
  console.log(`Actions: ${plan.actions.length}${stageLabel}`);

  const db = dryRun ? null : initDb(getDbPath());

  // Execute instructions first
  executeInstructions(plan.instructions, db, dryRun);

  // Process approved drafts from Staged/ folder (Phase 15.4)
  if (!dryRun) {
    const approved = getApprovedDrafts();
    if (approved.length > 0) {
      console.log(`\nSending ${approved.length} approved draft(s)...`);
      for (const draft of approved) {
        try {
          if (draft.account === "g") {
            // Phase 1 commit 4: Gmail send goes through GwsGmailTransport
            const transport = transportFor("g");
            await transport.send({ to: draft.to, subject: draft.subject, body: draft.body });
          } else {
            const acct = "";
            const escaped = draft.body.replace(/"/g, '\\"').replace(/\n/g, "\\n");
            runAppleMail(`reply ${draft.emailId} "${escaped}" ${acct}`, false);
          }
          markDraftSent(draft.emailId);
          console.log(`  Sent: ${draft.to} -- ${draft.subject}`);
        } catch (e) {
          console.error(`  Failed to send draft for ${draft.emailId}: ${e}`);
        }
      }
    }
  }

  // Execute email actions
  for (const item of plan.actions) {
    await executeAction(item, db, dryRun);
  }

  // Auto-block domains that exceed trash frequency threshold
  if (!dryRun && db) {
    const newlyBlocked = autoBlockFrequentTrashDomains(db);
    if (newlyBlocked.length > 0) {
      console.log(`\n=== AUTO-BLOCKED DOMAINS ===`);
      for (const domain of newlyBlocked) {
        console.log(`  ${domain} (auto-blocked: exceeded trash threshold)`);
      }
      console.log(`=== END AUTO-BLOCKED (${newlyBlocked.length} domains) ===\n`);
    }
  }

  // Update note
  if (!dryRun) {
    updateTriageNote(filePath, plan);
  }

  printSummary(plan);

  // Phase 2: Output complex actions for background dispatch
  const complexItems = plan.actions.filter(a => a.notes && a.notes.trim().length > 0);
  if (complexItems.length > 0) {
    console.log("\n=== COMPLEX ACTIONS PENDING ===");
    console.log(`${complexItems.length} email(s) require background agent processing:\n`);
    for (const item of complexItems) {
      console.log(`EMAIL_ID: ${item.id}`);
      console.log(`  SENDER: ${item.sender ?? "(unknown)"}`);
      console.log(`  SUBJECT: ${item.subject ?? "(no subject)"}`);
      console.log(`  STAGE: ${item.funnelStage ?? "unknown"}`);
      console.log(`  ACCOUNT: ${item.account ?? "i"}`);
      console.log(`  INSTRUCTION: ${item.notes}`);
      console.log("");
    }
    console.log("=== END COMPLEX ACTIONS ===");
    console.log("Dispatch these as background agents via /superpowers:dispatching-parallel-agents");
  }

  // Post-execution completeness check
  if (!dryRun) {
    console.log("\n--- Completeness Check ---");
    const postState = getInboxState();
    if (postState.total >= 0) {
      // Estimate new arrivals: emails with IDs higher than the max ID in the triage note
      const triageIds = plan.actions.map(a => parseInt(a.id, 10)).filter(n => !isNaN(n));
      const maxTriageId = triageIds.length > 0 ? Math.max(...triageIds) : 0;
      const newArrivals = postState.ids.filter(e => parseInt(e.id, 10) > maxTriageId).length;

      const result = checkInboxCompleteness(postState.total, newArrivals);
      console.log(result.message);
    } else {
      console.log("Warning: Could not check inbox state after execution.");
    }
  }

  if (db) db.close();
}

if (import.meta.main) {
  main().catch(e => {
    console.error(e);
    process.exit(1);
  });
}
