// TriageNoteParser.ts — Extract per-message stage + account from triage markdown

import { type AccountAlias, type FunnelStage, FOLDER_STAGE_MAP, resolveAccountAlias } from "./Types";

export interface ParsedNoteEntry {
  id: string;
  stage: FunnelStage;
  account?: AccountAlias;
}

const STAGE_HEADER_PATTERNS: Array<{ pattern: RegExp; stage: FunnelStage }> = [
  { pattern: /Stage 1:\s*VIP/i, stage: "vip" },
  { pattern: /Follow-Up Due/i, stage: "follow_up_due" },
  { pattern: /Stage 2:\s*Action/i, stage: "action" },
  { pattern: /Stage 3:/i, stage: "financial" },
  { pattern: /Stage 4:/i, stage: "informational" },
  { pattern: /Stage 5:\s*Bulk/i, stage: "bulk_dispose" },
  { pattern: /Stage 6:/i, stage: "auto_processed" },
];

/** Parse account-map frontmatter: "id:alias,id:alias" */
export function parseAccountMap(content: string): Map<string, AccountAlias> {
  const map = new Map<string, AccountAlias>();
  const m = content.match(/^account-map:\s*"?([^"\n]+)"?/m);
  if (!m) return map;
  for (const part of m[1].split(",")) {
    const [id, aliasRaw] = part.trim().split(":");
    if (!id || !aliasRaw) continue;
    const alias = resolveAccountAlias(aliasRaw.trim());
    if (alias) map.set(id.trim(), alias);
  }
  return map;
}

function extractIdFromCell(cell: string): string | null {
  const linked = cell.match(/\[`?([a-zA-Z0-9]+)`?\]\([^)]*\)/);
  if (linked) return linked[1];
  const backtick = cell.match(/`([a-zA-Z0-9]+)`/);
  if (backtick) return backtick[1];
  const plain = cell.match(/\b([a-f0-9]{12,}|[0-9]{4,6})\b/i);
  return plain ? plain[1] : null;
}

function extractAccountBadge(cell: string): AccountAlias | undefined {
  const badge = cell.match(/\[([igyhap])\]/i);
  return badge ? (resolveAccountAlias(badge[1]) ?? undefined) : undefined;
}

/**
 * Walk note sections and return expected funnel stage per message id.
 * Supports iCloud numeric ids and Gmail hex ids.
 */
export function parseTriageNoteStages(content: string): Map<string, ParsedNoteEntry> {
  const accountMap = parseAccountMap(content);
  const entries = new Map<string, ParsedNoteEntry>();
  const lines = content.split("\n");
  let currentStage: FunnelStage | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith("## ")) {
      if (line.includes("Execution Log") || line.includes("Already Processed")) {
        currentStage = null;
        continue;
      }
      for (const { pattern, stage } of STAGE_HEADER_PATTERNS) {
        if (pattern.test(line) && !line.includes("~~")) {
          currentStage = stage;
          break;
        }
      }
      continue;
    }

    if (!currentStage || line.includes("[GONE]")) continue;

    if (line.startsWith("####")) {
      const id = extractIdFromCell(line);
      if (!id) continue;
      const account = extractAccountBadge(line) ?? accountMap.get(id);
      entries.set(id, { id, stage: currentStage, account });
      continue;
    }

    if (line.startsWith("|") && !line.includes("---")) {
      const cells = line.split("|").map(c => c.trim());
      const idCell = cells[1] ?? "";
      if (!idCell || /^(ID|Sender|Stage)/i.test(idCell)) continue;
      const id = extractIdFromCell(idCell);
      if (!id) continue;
      const account = extractAccountBadge(idCell) ?? accountMap.get(id);
      entries.set(id, { id, stage: currentStage, account });
      continue;
    }

    if (line.match(/^-\s*\[[x ]\]/)) {
      const id = extractIdFromCell(line);
      if (!id) continue;
      const account = extractAccountBadge(line) ?? accountMap.get(id);
      entries.set(id, { id, stage: currentStage, account });
    }
  }

  return entries;
}

/** Map Gmail label name (Stages/Stage N - …) to funnel stage. */
export function stageFromGmailLabel(label: string): FunnelStage | null {
  const normalized = label.replace(/^Stages\//, "").trim();
  return FOLDER_STAGE_MAP[normalized] ?? null;
}
