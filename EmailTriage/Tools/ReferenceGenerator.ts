// reference-generator.ts -- Generate human-readable reference files from the database
// Files are written to Email Triage/Reference/ in the vault.
// Auto-updated files regenerate when underlying data changes.
// Known Senders is generated on explicit request only (too large for auto-update).

import type { Database } from "bun:sqlite";
import { writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const VAULT_ROOT = (function(){
  if (process.env.EMAILTRIAGE_VAULT_ROOT) return process.env.EMAILTRIAGE_VAULT_ROOT;
  try {
    const home = process.env.HOME;
    if (!home) return "";
    const fs = require("fs");
    const path = require("path");
    const prefs = path.join(home, ".claude/PAI/USER/SKILLCUSTOMIZATIONS/EmailTriage/preferences.yaml");
    if (!fs.existsSync(prefs)) return "";
    const raw = fs.readFileSync(prefs, "utf8");
    const m = raw.match(/^\s*vault_root\s*:\s*["']?([^"'#\n]+?)["']?\s*(?:#.*)?\$/m);
    return m ? m[1].trim() : "";
  } catch { return ""; }
})();
const REFERENCE_DIR = join(VAULT_ROOT, "Email Triage/Reference");

function ensureDir(): void {
  if (!existsSync(REFERENCE_DIR)) mkdirSync(REFERENCE_DIR, { recursive: true });
}

function frontmatter(title: string, description: string): string {
  return `---\ntitle: "${title}"\ndescription: "${description}"\nauto-generated: true\nlast-updated: "${new Date().toISOString().slice(0, 16).replace('T', '_')}"\n---\n`;
}

// ── VIP Senders ──

export function generateVipReference(db: Database, dir?: string): string {
  const outDir = dir ?? REFERENCE_DIR;
  ensureDir();
  const rows = db.prepare(
    "SELECT address, name, account, added_at FROM vip_senders ORDER BY name, address"
  ).all() as { address: string; name: string | null; account: string | null; added_at: string | null }[];

  let md = frontmatter("VIP Senders", "High-priority senders who always appear in Stage 1");
  md += "# VIP Senders\n\n";
  md += `> ${rows.length} VIP sender${rows.length !== 1 ? "s" : ""} registered\n\n`;

  if (rows.length === 0) {
    md += "*No VIP senders configured.*\n";
  } else {
    md += "| Name | Address | Account | Date Added |\n| --- | --- | --- | --- |\n";
    for (const r of rows) {
      md += `| ${r.name ?? "--"} | ${r.address} | ${r.account ?? "--"} | ${r.added_at ?? "--"} |\n`;
    }
  }

  const outPath = join(outDir, "VIP Senders.md");
  writeFileSync(outPath, md);
  return outPath;
}

// ── Routing Rules ──

export function generateRoutingRulesReference(db: Database, dir?: string): string {
  const outDir = dir ?? REFERENCE_DIR;
  ensureDir();
  const rows = db.prepare(
    "SELECT id, rule_type, match_value, action, folder, source, added_at FROM routing_rules ORDER BY folder, rule_type, match_value"
  ).all() as { id: number; rule_type: string; match_value: string; action: string; folder: string | null; source: string | null; added_at: string | null }[];

  let md = frontmatter("Routing Rules", "Email routing rules by sender, domain, and subject");
  md += "# Routing Rules\n\n";
  md += `> ${rows.length} rule${rows.length !== 1 ? "s" : ""} active\n\n`;

  if (rows.length === 0) {
    md += "*No routing rules configured.*\n";
  } else {
    // Group by destination folder
    const grouped = new Map<string, typeof rows>();
    for (const r of rows) {
      const key = r.folder ?? "(no folder)";
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(r);
    }

    for (const [folder, rules] of grouped) {
      md += `### ${folder}\n\n`;
      md += "| Type | Match | Action | Source | Added |\n| --- | --- | --- | --- | --- |\n";
      for (const r of rules) {
        md += `| ${r.rule_type} | ${r.match_value} | ${r.action} | ${r.source ?? "--"} | ${r.added_at ?? "--"} |\n`;
      }
      md += "\n";
    }
  }

  const outPath = join(outDir, "Routing Rules.md");
  writeFileSync(outPath, md);
  return outPath;
}

// ── Junk Blocklist ──

export function generateJunkReference(db: Database, dir?: string): string {
  const outDir = dir ?? REFERENCE_DIR;
  ensureDir();
  const rows = db.prepare(
    "SELECT address, domain, reason, added_at FROM junk_senders ORDER BY added_at DESC"
  ).all() as { address: string | null; domain: string | null; reason: string | null; added_at: string | null }[];

  const addresses = rows.filter(r => r.address);
  const domains = rows.filter(r => r.domain && !r.address);

  let md = frontmatter("Junk Blocklist", "Blocked addresses and domains");
  md += "# Junk Blocklist\n\n";
  md += `> ${addresses.length} blocked address${addresses.length !== 1 ? "es" : ""}, ${domains.length} blocked domain${domains.length !== 1 ? "s" : ""}\n\n`;

  md += "## Blocked Addresses\n\n";
  if (addresses.length === 0) {
    md += "*None.*\n\n";
  } else {
    md += "| Address | Reason | Date |\n| --- | --- | --- |\n";
    for (const r of addresses) {
      md += `| ${r.address} | ${r.reason ?? "--"} | ${r.added_at ?? "--"} |\n`;
    }
    md += "\n";
  }

  md += "## Blocked Domains\n\n";
  if (domains.length === 0) {
    md += "*None.*\n\n";
  } else {
    md += "| Domain | Reason | Date |\n| --- | --- | --- |\n";
    for (const r of domains) {
      md += `| ${r.domain} | ${r.reason ?? "--"} | ${r.added_at ?? "--"} |\n`;
    }
    md += "\n";
  }

  const outPath = join(outDir, "Junk Blocklist.md");
  writeFileSync(outPath, md);
  return outPath;
}

// ── Unsubscribe History ──

export function generateUnsubscribeReference(db: Database, dir?: string): string {
  const outDir = dir ?? REFERENCE_DIR;
  ensureDir();
  const rows = db.prepare(
    "SELECT address, domain, method, unsubscribed_at FROM unsubscribed ORDER BY unsubscribed_at DESC"
  ).all() as { address: string | null; domain: string | null; method: string | null; unsubscribed_at: string | null }[];

  let md = frontmatter("Unsubscribe History", "Record of all unsubscribed addresses and domains");
  md += "# Unsubscribe History\n\n";
  md += `> ${rows.length} unsubscribe action${rows.length !== 1 ? "s" : ""} recorded\n\n`;

  if (rows.length === 0) {
    md += "*No unsubscribes recorded.*\n";
  } else {
    md += "| Address/Domain | Method | Date |\n| --- | --- | --- |\n";
    for (const r of rows) {
      const target = r.address ?? r.domain ?? "--";
      md += `| ${target} | ${r.method ?? "--"} | ${r.unsubscribed_at ?? "--"} |\n`;
    }
  }

  const outPath = join(outDir, "Unsubscribe History.md");
  writeFileSync(outPath, md);
  return outPath;
}

// ── Follow-ups ──

export function generateFollowUpsReference(db: Database, dir?: string): string {
  const outDir = dir ?? REFERENCE_DIR;
  ensureDir();
  const pending = db.prepare(
    "SELECT email_id, sender, subject, follow_up_date, original_date FROM follow_ups WHERE resolved = 0 ORDER BY follow_up_date"
  ).all() as { email_id: string; sender: string; subject: string; follow_up_date: string; original_date: string }[];

  const resolved = db.prepare(
    "SELECT email_id, sender, subject, follow_up_date, created_at FROM follow_ups WHERE resolved = 1 ORDER BY created_at DESC LIMIT 50"
  ).all() as { email_id: string; sender: string; subject: string; follow_up_date: string; created_at: string }[];

  const today = new Date().toISOString().slice(0, 10);

  let md = frontmatter("Follow-ups", "Open and resolved follow-up reminders");
  md += "# Follow-ups\n\n";
  md += `> ${pending.length} pending, ${resolved.length} recently resolved\n\n`;

  md += "## Pending\n\n";
  if (pending.length === 0) {
    md += "*No pending follow-ups.*\n\n";
  } else {
    md += "| Sender | Subject | Due Date | Status |\n| --- | --- | --- | --- |\n";
    for (const r of pending) {
      const dueDate = r.follow_up_date;
      const isOverdue = dueDate <= today;
      const status = isOverdue ? "**OVERDUE**" : `${Math.ceil((new Date(dueDate).getTime() - new Date(today).getTime()) / 86400000)} days`;
      md += `| ${r.sender} | ${r.subject} | ${dueDate} | ${status} |\n`;
    }
    md += "\n";
  }

  md += "## Recently Resolved\n\n";
  if (resolved.length === 0) {
    md += "*None.*\n\n";
  } else {
    md += "| Sender | Subject | Due Date | Resolved |\n| --- | --- | --- | --- |\n";
    for (const r of resolved) {
      md += `| ${r.sender} | ${r.subject} | ${r.follow_up_date} | ${r.created_at} |\n`;
    }
    md += "\n";
  }

  const outPath = join(outDir, "Follow-ups.md");
  writeFileSync(outPath, md);
  return outPath;
}

// ── Known Senders (on-demand only) ──

export function generateKnownSendersReference(db: Database, dir?: string): string {
  const outDir = dir ?? REFERENCE_DIR;
  ensureDir();
  const rows = db.prepare(
    "SELECT address, first_seen, last_seen, times_seen FROM known_senders ORDER BY times_seen DESC"
  ).all() as { address: string; first_seen: string; last_seen: string; times_seen: number }[];

  let md = frontmatter("Known Senders", "All senders seen, sorted by frequency");
  md += "# Known Senders\n\n";
  md += `> ${rows.length} unique sender${rows.length !== 1 ? "s" : ""} recorded\n\n`;

  if (rows.length === 0) {
    md += "*No senders recorded yet.*\n";
  } else {
    md += "| Address | First Seen | Last Seen | Times Seen |\n| --- | --- | --- | --- |\n";
    for (const r of rows) {
      md += `| ${r.address} | ${r.first_seen} | ${r.last_seen} | ${r.times_seen} |\n`;
    }
  }

  const outPath = join(outDir, "Known Senders.md");
  writeFileSync(outPath, md);
  return outPath;
}

// ── Change-driven regeneration ──
// References only update when underlying data changes (new rules, VIP additions, etc.).
// The hook collects which types changed; flushPendingReferences() writes them before DB close.

type ReferenceType = "vip" | "routing" | "junk" | "unsubscribe" | "followups";

const pendingRegens = new Set<ReferenceType>();

/** Mark a reference type as needing regeneration. Called by DB hooks when data changes.
 *  Does NOT write immediately -- call flushPendingReferences() before db.close(). */
export function regenerateReference(_db: Database, type: ReferenceType, _dir?: string): void {
  pendingRegens.add(type);
}

/** Write all pending reference files. Call once before db.close().
 *  Only writes files for types that actually changed during this run. */
export function flushPendingReferences(db: Database, dir?: string): number {
  if (pendingRegens.size === 0) return 0;
  for (const t of pendingRegens) {
    switch (t) {
      case "vip": generateVipReference(db, dir); break;
      case "routing": generateRoutingRulesReference(db, dir); break;
      case "junk": generateJunkReference(db, dir); break;
      case "unsubscribe": generateUnsubscribeReference(db, dir); break;
      case "followups": generateFollowUpsReference(db, dir); break;
    }
  }
  const count = pendingRegens.size;
  pendingRegens.clear();
  return count;
}

// ── Generate all auto-updated references at once ──

export function generateAllReferences(db: Database, dir?: string): string[] {
  return [
    generateVipReference(db, dir),
    generateRoutingRulesReference(db, dir),
    generateJunkReference(db, dir),
    generateUnsubscribeReference(db, dir),
    generateFollowUpsReference(db, dir),
  ];
}
