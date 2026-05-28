// ~/.claude/skills/EmailTriage/unsub-report.ts
// Usage: bun run unsub-report.ts [--date YYYY-MM-DD] [--output PATH]
// Generates a daily unsubscribe and junk sender report

import { join } from "path";
import { mkdirSync, existsSync } from "fs";
import { Database } from "bun:sqlite";
import { initDb } from "./Db";

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

// Tools/ now lives one level inside skill root, so go up one level.
function getSkillDir(): string {
  if (import.meta.dir) {
    const dir = import.meta.dir;
    return dir.endsWith("/Tools") ? dir.slice(0, -6) : dir;
  }
  return join((process.env.HOME ?? (() => { throw new Error("HOME env var not set"); })()), ".claude/skills/EmailTriage");
}

// ─── Types ───

export interface DateRange {
  start: string; // YYYY-MM-DD
  end: string;   // YYYY-MM-DD (same day)
}

export interface JunkDomainEntry {
  domain: string;
  addedAt: string;
}

export interface JunkAddressEntry {
  address: string;
  addedAt: string;
}

export interface UnsubAttempt {
  address: string | null;
  domain: string | null;
  method: string;
  unsubscribedAt: string;
}

export interface RepeatOffender {
  domain: string;
  count: number;
  blockedSince: string;
}

export interface Totals {
  totalJunkDomains: number;
  totalJunkAddresses: number;
  totalUnsubscribed: number;
}

export interface ReportData {
  date: string;
  displayDate: string;
  generatedAt: string;
  newJunkDomains: JunkDomainEntry[];
  newJunkAddresses: JunkAddressEntry[];
  unsubAttempts: UnsubAttempt[];
  repeatOffenders: RepeatOffender[];
  totals: Totals;
}

// ─── Date Range Calculation ───

/**
 * Return a single-day date range for the given YYYY-MM-DD string.
 * start and end are both the same date.
 */
export function getDateRange(dateStr: string): DateRange {
  const match = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error(`Invalid date format: ${dateStr} (expected YYYY-MM-DD)`);
  return { start: dateStr, end: dateStr };
}

/**
 * Format a YYYY-MM-DD string as a human-readable date like "March 27, 2026".
 */
export function formatDisplayDate(dateStr: string): string {
  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  const [yearStr, monthStr, dayStr] = dateStr.split("-");
  const monthIdx = parseInt(monthStr, 10) - 1;
  const day = parseInt(dayStr, 10);
  return `${months[monthIdx]} ${day}, ${yearStr}`;
}

// ─── Database Queries ───

export function getNewJunkDomainsInRange(db: Database, start: string, end: string): JunkDomainEntry[] {
  const rows = db.prepare(`
    SELECT domain, added_at FROM junk_senders
    WHERE domain IS NOT NULL
      AND substr(added_at, 1, 10) >= ?
      AND substr(added_at, 1, 10) <= ?
    ORDER BY added_at ASC
  `).all(start, end) as { domain: string; added_at: string }[];

  return rows.map(r => ({ domain: r.domain, addedAt: r.added_at }));
}

export function getNewJunkAddressesInRange(db: Database, start: string, end: string): JunkAddressEntry[] {
  const rows = db.prepare(`
    SELECT address, added_at FROM junk_senders
    WHERE address IS NOT NULL AND domain IS NULL
      AND substr(added_at, 1, 10) >= ?
      AND substr(added_at, 1, 10) <= ?
    ORDER BY added_at ASC
  `).all(start, end) as { address: string; added_at: string }[];

  return rows.map(r => ({ address: r.address, addedAt: r.added_at }));
}

export function getUnsubscribeAttemptsInRange(db: Database, start: string, end: string): UnsubAttempt[] {
  const rows = db.prepare(`
    SELECT address, domain, method, unsubscribed_at FROM unsubscribed
    WHERE substr(unsubscribed_at, 1, 10) >= ?
      AND substr(unsubscribed_at, 1, 10) <= ?
    ORDER BY unsubscribed_at ASC
  `).all(start, end) as { address: string | null; domain: string | null; method: string; unsubscribed_at: string }[];

  return rows.map(r => ({
    address: r.address,
    domain: r.domain,
    method: r.method,
    unsubscribedAt: r.unsubscribed_at,
  }));
}

export function getRepeatOffenders(db: Database, start: string, end: string): RepeatOffender[] {
  const rows = db.prepare(`
    SELECT js.domain, js.added_at as blocked_since, COUNT(ea.id) as email_count
    FROM email_actions ea
    INNER JOIN junk_senders js ON js.domain IS NOT NULL
      AND ea.notes LIKE '%@' || js.domain || '%'
    WHERE ea.date >= ? AND ea.date <= ?
      AND ea.action IN ('junk', 'block', 'trash')
    GROUP BY js.domain
    ORDER BY email_count DESC
  `).all(start, end) as { domain: string; blocked_since: string; email_count: number }[];

  return rows.map(r => ({
    domain: r.domain,
    count: r.email_count,
    blockedSince: r.blocked_since,
  }));
}

export function getTotals(db: Database): Totals {
  const domains = db.prepare("SELECT COUNT(*) as cnt FROM junk_senders WHERE domain IS NOT NULL").get() as { cnt: number };
  const addresses = db.prepare("SELECT COUNT(*) as cnt FROM junk_senders WHERE address IS NOT NULL AND domain IS NULL").get() as { cnt: number };
  const unsubs = db.prepare("SELECT COUNT(*) as cnt FROM unsubscribed").get() as { cnt: number };

  return {
    totalJunkDomains: domains.cnt,
    totalJunkAddresses: addresses.cnt,
    totalUnsubscribed: unsubs.cnt,
  };
}

// ─── Report Generation ───

export function generateReport(data: ReportData): string {
  const lines: string[] = [];

  // YAML frontmatter
  lines.push("---");
  lines.push(`date: ${data.generatedAt}`);
  lines.push("document-type: unsub-report");
  lines.push(`report-date: ${data.date}`);
  lines.push("---");

  // Title
  lines.push(`# Unsubscribe Report - ${data.displayDate}`);

  // Summary table
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push("| Metric | Count |");
  lines.push("| --- | --- |");
  lines.push(`| New junk domains added | ${data.newJunkDomains.length} |`);
  lines.push(`| New junk addresses added | ${data.newJunkAddresses.length} |`);
  lines.push(`| Unsubscribe attempts | ${data.unsubAttempts.length} |`);
  lines.push(`| Repeat offenders | ${data.repeatOffenders.length} |`);

  // New Junk Domains
  lines.push("");
  lines.push("## New Junk Domains Today");
  if (data.newJunkDomains.length === 0) {
    lines.push("*None today*");
  } else {
    for (const d of data.newJunkDomains) {
      lines.push(`- ${d.domain} (added ${d.addedAt})`);
    }
  }

  // New Junk Addresses
  lines.push("");
  lines.push("## New Junk Addresses Today");
  if (data.newJunkAddresses.length === 0) {
    lines.push("*None today*");
  } else {
    for (const a of data.newJunkAddresses) {
      lines.push(`- ${a.address} (added ${a.addedAt})`);
    }
  }

  // Repeat Offenders
  lines.push("");
  lines.push("## Repeat Offenders");
  lines.push("*Domains that keep sending despite unsubscribe/block*");
  if (data.repeatOffenders.length === 0) {
    lines.push("*None today*");
  } else {
    for (const r of data.repeatOffenders) {
      lines.push(`- ${r.domain} (${r.count} emails today, blocked since ${r.blockedSince})`);
    }
  }

  // Totals
  lines.push("");
  lines.push("## Totals");
  lines.push(`- Total junk domains: ${data.totals.totalJunkDomains}`);
  lines.push(`- Total junk addresses: ${data.totals.totalJunkAddresses}`);
  lines.push(`- Total confirmed unsubscribes: ${data.totals.totalUnsubscribed}`);
  lines.push("");

  return lines.join("\n");
}

// ─── Current Date Calculation ───

function getTodayDate(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function getNowTimestamp(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const h = String(now.getHours()).padStart(2, "0");
  const min = String(now.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${d}_${h}:${min}`;
}

// ─── Main Orchestrator ───

export async function generateUnsubReport(options: {
  date?: string;
  outputDir?: string;
  dbPath?: string;
}): Promise<{ reportPath: string; data: ReportData }> {
  const date = options.date ?? getTodayDate();
  const range = getDateRange(date);
  const skillDir = getSkillDir();
  const db = initDb(options.dbPath ?? join(skillDir, "triage.db"));

  const newJunkDomains = getNewJunkDomainsInRange(db, range.start, range.end);
  const newJunkAddresses = getNewJunkAddressesInRange(db, range.start, range.end);
  const unsubAttempts = getUnsubscribeAttemptsInRange(db, range.start, range.end);
  const repeatOffenders = getRepeatOffenders(db, range.start, range.end);
  const totals = getTotals(db);

  db.close();

  const data: ReportData = {
    date,
    displayDate: formatDisplayDate(date),
    generatedAt: getNowTimestamp(),
    newJunkDomains,
    newJunkAddresses,
    unsubAttempts,
    repeatOffenders,
    totals,
  };

  const reportMd = generateReport(data);

  // Write report
  const outDir = options.outputDir ?? join(VAULT_ROOT, "Email Triage", "Reports");
  if (!existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true });
  }
  const reportPath = join(outDir, `${date}-unsub-report.md`);
  await Bun.write(reportPath, reportMd);

  return { reportPath, data };
}

// ─── CLI entry point ───

async function main() {
  const args = process.argv.slice(2);

  let date: string | undefined;
  const dateIdx = args.indexOf("--date");
  if (dateIdx !== -1 && args[dateIdx + 1]) {
    date = args[dateIdx + 1];
  }

  let outputDir: string | undefined;
  const outIdx = args.indexOf("--output");
  if (outIdx !== -1 && args[outIdx + 1]) {
    outputDir = args[outIdx + 1];
  }

  const { reportPath, data } = await generateUnsubReport({ date, outputDir });

  console.log(`\u2713 Unsubscribe report written to ${reportPath}`);
  console.log(`  ${data.displayDate}`);
  console.log(`  New junk domains: ${data.newJunkDomains.length} | New junk addresses: ${data.newJunkAddresses.length}`);
  console.log(`  Unsubscribe attempts: ${data.unsubAttempts.length} | Repeat offenders: ${data.repeatOffenders.length}`);
  console.log(`  Totals: ${data.totals.totalJunkDomains} domains, ${data.totals.totalJunkAddresses} addresses, ${data.totals.totalUnsubscribed} unsubscribed`);
}

if (import.meta.main) {
  main();
}
