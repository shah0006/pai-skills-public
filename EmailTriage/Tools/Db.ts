// ~/.claude/skills/EmailTriage/Tools/Db.ts
// SQLite database layer for EmailTriage sender classification and history

import { Database } from "bun:sqlite";
import { readFileSync, existsSync, renameSync } from "fs";
import { join, dirname } from "path";
import yaml from "js-yaml";
import type { EmailType } from "./EmailTypes";

// import.meta.dir is Bun-only; resolved at call time to avoid Next.js/Turbopack module-eval issues.
// Now that this file lives at Tools/Db.ts, the SKILL ROOT is the parent dir.
// triage.db lives at <skill-root>/triage.db; schema.sql lives at <skill-root>/References/schema.sql.
function getSkillRoot(): string {
  if (import.meta.dir) {
    // Tools/ → parent
    return dirname(import.meta.dir);
  }
  return join((process.env.HOME ?? (() => { throw new Error("HOME env var not set"); })()), ".claude/skills/EmailTriage");
}

export function initDb(dbPath?: string): Database {
  const root = getSkillRoot();
  const resolvedPath = dbPath ?? join(root, "triage.db");
  const db = new Database(resolvedPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  const schema = readFileSync(join(root, "References", "schema.sql"), "utf-8");
  db.exec(schema);
  return db;
}

// --- Reference file regeneration hook ---
// Set by generate-triage.ts at runtime to trigger reference file regeneration.
// Avoids circular imports and keeps tests clean (hook is null by default).
type ReferenceHook = (db: Database, type: "vip" | "routing" | "junk" | "unsubscribe" | "followups") => void;
let _referenceHook: ReferenceHook | null = null;

export function setReferenceHook(hook: ReferenceHook | null): void {
  _referenceHook = hook;
}

// --- VIP Senders ---

export function addVipSender(db: Database, address: string, name?: string): void {
  db.prepare("INSERT OR IGNORE INTO vip_senders (address, name) VALUES (?, ?)").run(address, name ?? null);
  _referenceHook?.(db, "vip");
}

export function isVipSender(db: Database, address: string): boolean {
  const row = db.prepare("SELECT 1 FROM vip_senders WHERE address = ?").get(address);
  return row !== null;
}

/** Remove a VIP sender by address (Phase 29 Settings). */
export function removeVipSender(db: Database, address: string): void {
  db.prepare("DELETE FROM vip_senders WHERE address = ?").run(address);
  _referenceHook?.(db, "vip");
}

// --- Junk Senders ---

export function addJunkSender(db: Database, entry: { address?: string; domain?: string; reason?: string }): void {
  db.prepare("INSERT INTO junk_senders (address, domain, reason) VALUES (?, ?, ?)")
    .run(entry.address ?? null, entry.domain ?? null, entry.reason ?? null);
  _referenceHook?.(db, "junk");
}

export function isJunkSender(db: Database, address: string, domain: string): boolean {
  const byAddress = db.prepare("SELECT 1 FROM junk_senders WHERE address = ?").get(address);
  if (byAddress) return true;
  const byDomain = db.prepare("SELECT 1 FROM junk_senders WHERE domain = ?").get(domain);
  return byDomain !== null;
}

/** Remove a junk sender by row id (Phase 29 Settings). */
export function removeJunkSender(db: Database, id: number): void {
  db.prepare("DELETE FROM junk_senders WHERE id = ?").run(id);
  _referenceHook?.(db, "junk");
}

// --- Known Senders ---

export function addKnownSender(db: Database, address: string): void {
  db.prepare(`
    INSERT INTO known_senders (address) VALUES (?)
    ON CONFLICT(address) DO UPDATE SET last_seen = strftime('%Y-%m-%d_%H:%M', 'now'), times_seen = times_seen + 1
  `).run(address);
}

export function isKnownSender(db: Database, address: string): boolean {
  const row = db.prepare("SELECT 1 FROM known_senders WHERE address = ?").get(address);
  return row !== null;
}

export function getKnownSenders(db: Database): Set<string> {
  const rows = db.prepare("SELECT address FROM known_senders").all() as { address: string }[];
  return new Set(rows.map(r => r.address));
}

// --- Unsubscribed ---

export function addUnsubscribed(db: Database, entry: { address?: string; domain?: string; method: string }): void {
  db.prepare("INSERT INTO unsubscribed (address, domain, method) VALUES (?, ?, ?)")
    .run(entry.address ?? null, entry.domain ?? null, entry.method);
}

export function isUnsubscribed(db: Database, address: string, domain: string): boolean {
  const byAddress = db.prepare("SELECT 1 FROM unsubscribed WHERE address = ?").get(address);
  if (byAddress) return true;
  const byDomain = db.prepare("SELECT 1 FROM unsubscribed WHERE domain = ?").get(domain);
  return byDomain !== null;
}

// --- Triage History ---

export function recordTriageSession(db: Database, session: {
  date: string;
  total: number;
  archived: number;
  trashed: number;
  replied: number;
  durationSec: number;
  unsubscribed?: number;
  blocked?: number;
}): void {
  db.prepare(`
    INSERT INTO triage_history (date, total, archived, trashed, replied, unsubscribed, blocked, duration_sec)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    session.date, session.total, session.archived, session.trashed,
    session.replied, session.unsubscribed ?? 0, session.blocked ?? 0, session.durationSec
  );
}

export function getRecentHistory(db: Database, days: number): any[] {
  return db.prepare(`
    SELECT * FROM triage_history
    ORDER BY date DESC
    LIMIT ?
  `).all(days) as any[];
}

// --- Email Actions ---

export function recordEmailAction(db: Database, emailId: string, action: string, folder?: string, notes?: string): void {
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
  db.prepare("INSERT INTO email_actions (email_id, date, action, folder, notes) VALUES (?, ?, ?, ?, ?)")
    .run(emailId, date, action, folder ?? null, notes ?? null);
}

// --- Reconciliation log (Phase 2) ---

export type ReconciliationConflictType = "stage_mismatch" | "read_mismatch" | "drift_remote_new";

export function logReconciliation(
  db: Database,
  entry: {
    account: string;
    emailId: string;
    conflictType: ReconciliationConflictType;
    sqliteValue?: string;
    remoteValue?: string;
    resolution?: string;
    detail?: string;
  },
): void {
  db.prepare(`
    INSERT INTO reconciliation_log (account, email_id, conflict_type, sqlite_value, remote_value, resolution, detail)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.account,
    entry.emailId,
    entry.conflictType,
    entry.sqliteValue ?? null,
    entry.remoteValue ?? null,
    entry.resolution ?? null,
    entry.detail ?? null,
  );
}

export function getRecentReconciliation(db: Database, limit = 50): Array<{
  emailId: string;
  conflictType: string;
  sqliteValue: string | null;
  remoteValue: string | null;
  resolution: string | null;
}> {
  return (db.prepare(`
    SELECT email_id, conflict_type, sqlite_value, remote_value, resolution
    FROM reconciliation_log
    ORDER BY id DESC
    LIMIT ?
  `).all(limit) as Array<{
    email_id: string;
    conflict_type: string;
    sqlite_value: string | null;
    remote_value: string | null;
    resolution: string | null;
  }>).map(r => ({
    emailId: r.email_id,
    conflictType: r.conflict_type,
    sqliteValue: r.sqlite_value,
    remoteValue: r.remote_value,
    resolution: r.resolution,
  }));
}

// --- Follow-Ups ---

export function recordFollowUp(db: Database, entry: {
  emailId: string;
  followUpDate: string;
  sender: string;
  subject: string;
  originalDate: string;
}): void {
  db.prepare(`
    INSERT INTO follow_ups (email_id, follow_up_date, sender, subject, original_date)
    VALUES (?, ?, ?, ?, ?)
  `).run(entry.emailId, entry.followUpDate, entry.sender, entry.subject, entry.originalDate);
  _referenceHook?.(db, "followups");
}

export function getOverdueFollowUps(db: Database, today: string): Array<{
  emailId: string;
  originalDate: string;
  followUpDate: string;
  sender: string;
  subject: string;
}> {
  // Return follow-ups where:
  // 1. follow_up_date <= today
  // 2. Not resolved
  // 3. No 'reply' action exists in email_actions for the same email_id
  const rows = db.prepare(`
    SELECT f.email_id, f.original_date, f.follow_up_date, f.sender, f.subject
    FROM follow_ups f
    WHERE f.follow_up_date <= ?
      AND f.resolved = 0
      AND NOT EXISTS (
        SELECT 1 FROM email_actions ea
        WHERE ea.email_id = f.email_id AND ea.action = 'reply'
      )
    ORDER BY f.follow_up_date ASC
  `).all(today) as Array<{
    email_id: string;
    original_date: string;
    follow_up_date: string;
    sender: string;
    subject: string;
  }>;

  return rows.map(r => ({
    emailId: r.email_id,
    originalDate: r.original_date,
    followUpDate: r.follow_up_date,
    sender: r.sender,
    subject: r.subject,
  }));
}

export function resolveFollowUp(db: Database, emailId: string): void {
  db.prepare("UPDATE follow_ups SET resolved = 1 WHERE email_id = ?").run(emailId);
  _referenceHook?.(db, "followups");
}

// --- Scheduled Sends ---

export function recordScheduledSend(db: Database, entry: {
  emailId: string;
  sendAt: string;
  replyContent: string;
  recipient: string;
  subject: string;
  account?: string;
  jsonPath?: string;
  plistPath?: string;
}): void {
  db.prepare(`
    INSERT INTO scheduled_sends (email_id, send_at, reply_content, recipient, subject, account, json_path, plist_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(entry.emailId, entry.sendAt, entry.replyContent, entry.recipient, entry.subject,
    entry.account ?? null, entry.jsonPath ?? null, entry.plistPath ?? null);
}

export function getDueSends(db: Database, now: string): Array<{
  id: number;
  emailId: string;
  sendAt: string;
  replyContent: string;
  recipient: string;
  subject: string;
}> {
  const rows = db.prepare(`
    SELECT id, email_id, send_at, reply_content, recipient, subject
    FROM scheduled_sends
    WHERE status = 'pending' AND send_at <= ?
    ORDER BY send_at ASC
  `).all(now) as Array<{
    id: number;
    email_id: string;
    send_at: string;
    reply_content: string;
    recipient: string;
    subject: string;
  }>;

  return rows.map(r => ({
    id: r.id,
    emailId: r.email_id,
    sendAt: r.send_at,
    replyContent: r.reply_content,
    recipient: r.recipient,
    subject: r.subject,
  }));
}

export function markSendComplete(db: Database, id: number): void {
  const now = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date()).replace(" ", "_");
  db.prepare("UPDATE scheduled_sends SET status = 'sent', sent_at = ? WHERE id = ?").run(now, id);
}

export function markSendFailed(db: Database, id: number): void {
  db.prepare("UPDATE scheduled_sends SET status = 'failed' WHERE id = ?").run(id);
}

// --- Domain Activity ---

const SAFELIST_DOMAINS = new Set([
  "gmail.com", "yahoo.com", "icloud.com", "me.com",
  "hotmail.com", "outlook.com", "aol.com", "protonmail.com",
]);

export function recordDomainActivity(
  db: Database,
  domain: string,
  address: string | undefined,
  triageDate: string,
  action: string,
  emailId: string,
  arrivalTimestamp?: string | null,
): void {
  db.prepare(
    "INSERT INTO domain_activity (domain, address, triage_date, action_taken, email_id, arrival_timestamp) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(domain, address ?? null, triageDate, action, emailId, arrivalTimestamp ?? null);
}

export function getDomainFrequencyStats(db: Database, daysBack: number = 30): Array<{
  domain: string;
  trashCount: number;
  totalCount: number;
  actions: string;
}> {
  const rows = db.prepare(`
    SELECT domain,
           SUM(CASE WHEN action_taken = 'T' THEN 1 ELSE 0 END) AS trash_count,
           COUNT(*) AS total_count,
           GROUP_CONCAT(DISTINCT action_taken) AS actions
    FROM domain_activity
    WHERE triage_date >= date('now', '-' || ? || ' days')
    GROUP BY domain
    ORDER BY trash_count DESC, total_count DESC
    LIMIT 20
  `).all(daysBack) as Array<{
    domain: string;
    trash_count: number;
    total_count: number;
    actions: string;
  }>;

  return rows.map(r => ({
    domain: r.domain,
    trashCount: r.trash_count,
    totalCount: r.total_count,
    actions: r.actions,
  }));
}

export function autoBlockFrequentTrashDomains(
  db: Database,
  threshold: number = 5,
  daysBack: number = 30,
): string[] {
  // Find domains with threshold+ trash actions in the window
  const frequentTrashers = db.prepare(`
    SELECT domain, COUNT(*) AS trash_count
    FROM domain_activity
    WHERE action_taken = 'T'
      AND triage_date >= date('now', '-' || ? || ' days')
    GROUP BY domain
    HAVING trash_count >= ?
  `).all(daysBack, threshold) as Array<{ domain: string; trash_count: number }>;

  const newlyBlocked: string[] = [];

  for (const row of frequentTrashers) {
    const domain = row.domain.toLowerCase();

    // Skip safelist domains (major email providers)
    if (SAFELIST_DOMAINS.has(domain)) continue;

    // Skip domains already in junk_senders
    const alreadyJunk = db.prepare(
      "SELECT 1 FROM junk_senders WHERE domain = ?"
    ).get(domain);
    if (alreadyJunk) continue;

    // Skip domains that have VIP senders
    const hasVip = db.prepare(
      "SELECT 1 FROM vip_senders WHERE LOWER(address) LIKE ?"
    ).get(`%@${domain}`);
    if (hasVip) continue;

    // Skip domains that have ever had a "keep" (K) or "reply" (R) action
    const hasKeepOrReply = db.prepare(
      "SELECT 1 FROM domain_activity WHERE domain = ? AND action_taken IN ('K', 'R') LIMIT 1"
    ).get(domain);
    if (hasKeepOrReply) continue;

    // Auto-block this domain
    addJunkSender(db, {
      domain,
      reason: `auto-blocked: trashed ${row.trash_count} times in last ${daysBack} days`,
    });
    newlyBlocked.push(domain);
  }

  return newlyBlocked;
}

// --- Routing Rules ---

export interface RoutingRuleRow {
  id: number;
  ruleType: string;
  matchValue: string;
  action: string;
  folder: string | null;
  stop: boolean;
  addedAt: string;
  source: string;
}

export function getRoutingRules(db: Database, type?: string): RoutingRuleRow[] {
  const query = type
    ? "SELECT * FROM routing_rules WHERE rule_type = ? ORDER BY id"
    : "SELECT * FROM routing_rules ORDER BY id";
  const rows = (type ? db.prepare(query).all(type) : db.prepare(query).all()) as Record<string, any>[];
  return rows.map(r => ({
    id: r.id,
    ruleType: r.rule_type,
    matchValue: r.match_value,
    action: r.action,
    folder: r.folder,
    stop: !!r.stop,
    addedAt: r.added_at,
    source: r.source,
  }));
}

export function addRoutingRule(db: Database, rule: {
  ruleType: string;
  matchValue: string;
  action: string;
  folder?: string;
  stop?: boolean;
  source?: string;
}): number {
  const result = db.prepare(`
    INSERT INTO routing_rules (rule_type, match_value, action, folder, stop, source)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    rule.ruleType, rule.matchValue, rule.action,
    rule.folder ?? null, rule.stop !== false ? 1 : 0, rule.source ?? "manual"
  );
  _referenceHook?.(db, "routing");
  return Number(result.lastInsertRowid);
}

/** Update a routing rule's editable fields by id (Phase 29 Settings). */
export function updateRoutingRule(db: Database, id: number, fields: {
  ruleType?: string;
  matchValue?: string;
  action?: string;
  folder?: string | null;
  stop?: boolean;
}): void {
  const sets: string[] = [];
  const vals: (string | number | null)[] = [];
  if (fields.ruleType !== undefined) { sets.push("rule_type = ?"); vals.push(fields.ruleType); }
  if (fields.matchValue !== undefined) { sets.push("match_value = ?"); vals.push(fields.matchValue); }
  if (fields.action !== undefined) { sets.push("action = ?"); vals.push(fields.action); }
  if (fields.folder !== undefined) { sets.push("folder = ?"); vals.push(fields.folder); }
  if (fields.stop !== undefined) { sets.push("stop = ?"); vals.push(fields.stop ? 1 : 0); }
  if (sets.length === 0) return;
  vals.push(id);
  db.prepare(`UPDATE routing_rules SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  _referenceHook?.(db, "routing");
}

export function removeRoutingRule(db: Database, id: number): void {
  db.prepare("DELETE FROM routing_rules WHERE id = ?").run(id);
  _referenceHook?.(db, "routing");
}

// --- Bulk queries (for rules engine caching) ---

export function getVipSenders(db: Database): Set<string> {
  const rows = db.prepare("SELECT address FROM vip_senders").all() as { address: string }[];
  return new Set(rows.map(r => r.address.toLowerCase()));
}

export function getJunkSenders(db: Database): { addresses: Set<string>; domains: Set<string> } {
  const rows = db.prepare("SELECT address, domain FROM junk_senders").all() as { address: string | null; domain: string | null }[];
  const addresses = new Set<string>();
  const domains = new Set<string>();
  for (const r of rows) {
    if (r.address) addresses.add(r.address.toLowerCase());
    if (r.domain) domains.add(r.domain.toLowerCase());
  }
  return { addresses, domains };
}

/** Junk-sender rows with ids — for the Phase 29 Settings panel (delete by id). */
export function getJunkSenderRows(db: Database): Array<{ id: number; address: string | null; domain: string | null; reason: string | null }> {
  return db.prepare("SELECT id, address, domain, reason FROM junk_senders ORDER BY id").all() as
    Array<{ id: number; address: string | null; domain: string | null; reason: string | null }>;
}

// --- Unsubscribe (alias for addUnsubscribed with clearer name) ---

export function recordUnsubscribe(db: Database, address: string | null, domain: string | null, method: string): void {
  db.prepare("INSERT INTO unsubscribed (address, domain, method) VALUES (?, ?, ?)")
    .run(address, domain, method);
  _referenceHook?.(db, "unsubscribe");
}

// --- Triage Review Time ---

export function updateTriageReviewTime(db: Database, date: string, processedAt: string): void {
  // Get the generated_at for this date's triage
  const row = db.prepare(
    "SELECT id, generated_at FROM triage_history WHERE date = ? ORDER BY id DESC LIMIT 1"
  ).get(date) as { id: number; generated_at: string | null } | null;
  if (!row) return;

  let durationSec: number | null = null;
  if (row.generated_at) {
    // Parse vault-standard datetime: YYYY-MM-DD_HH:MM
    const genTime = new Date(row.generated_at.replace("_", "T") + ":00");
    const procTime = new Date(processedAt.replace("_", "T") + ":00");
    durationSec = Math.round((procTime.getTime() - genTime.getTime()) / 1000);
    if (durationSec < 0) durationSec = null;
  }

  db.prepare(
    "UPDATE triage_history SET processed_at = ?, review_duration_sec = ? WHERE id = ?"
  ).run(processedAt, durationSec, row.id);
}

// --- Migration ---

const MIGRATION_TABLES = new Set(["vip_senders", "junk_senders", "triage_history", "scheduled_sends", "domain_activity"]);

function hasColumn(db: Database, table: string, column: string): boolean {
  if (!MIGRATION_TABLES.has(table)) throw new Error(`hasColumn: invalid table "${table}"`);
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return cols.some(c => c.name === column);
}

export function runMigration(db: Database, dir?: string): void {
  // dir is the directory containing rules.yaml(.seed) and junk-senders.yaml(.seed)
  // Default: <skill-root>/References/
  dir = dir ?? join(getSkillRoot(), "References");

  // Track which YAML files to rename AFTER successful commit
  const filesToRename: Array<{ from: string; to: string }> = [];

  db.exec("BEGIN TRANSACTION");
  try {
    // 1. CREATE TABLE IF NOT EXISTS for routing_rules (safe if already exists via schema.sql)
    db.exec(`
      CREATE TABLE IF NOT EXISTS routing_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rule_type TEXT NOT NULL,
        match_value TEXT NOT NULL,
        action TEXT NOT NULL,
        folder TEXT,
        stop INTEGER DEFAULT 1,
        added_at TEXT DEFAULT (strftime('%Y-%m-%d_%H:%M', 'now')),
        source TEXT DEFAULT 'manual'
      );
    `);

    // 1b. CREATE TABLE IF NOT EXISTS for email_types (AD-1; safe if already exists via schema.sql)
    db.exec(`
      CREATE TABLE IF NOT EXISTS email_types (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        detection TEXT NOT NULL,
        match_scope TEXT NOT NULL DEFAULT 'combined',
        must_surface TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        sort_order INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL DEFAULT 'manual',
        added_at TEXT DEFAULT (strftime('%Y-%m-%d_%H:%M', 'now'))
      );
    `);

    // 1c. CREATE TABLE IF NOT EXISTS for settings (Phase 29; safe if already exists via schema.sql)
    db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at TEXT DEFAULT (strftime('%Y-%m-%d_%H:%M', 'now'))
      );
    `);

    // 2. ALTER TABLE for new columns (idempotent -- check existence first)
    if (!hasColumn(db, "vip_senders", "account")) {
      db.exec("ALTER TABLE vip_senders ADD COLUMN account TEXT");
    }
    if (!hasColumn(db, "junk_senders", "account")) {
      db.exec("ALTER TABLE junk_senders ADD COLUMN account TEXT");
    }
    if (!hasColumn(db, "triage_history", "generated_at")) {
      db.exec("ALTER TABLE triage_history ADD COLUMN generated_at TEXT");
    }
    if (!hasColumn(db, "triage_history", "processed_at")) {
      db.exec("ALTER TABLE triage_history ADD COLUMN processed_at TEXT");
    }
    if (!hasColumn(db, "triage_history", "review_duration_sec")) {
      db.exec("ALTER TABLE triage_history ADD COLUMN review_duration_sec INTEGER");
    }
    if (!hasColumn(db, "scheduled_sends", "account")) {
      db.exec("ALTER TABLE scheduled_sends ADD COLUMN account TEXT");
    }
    if (!hasColumn(db, "scheduled_sends", "json_path")) {
      db.exec("ALTER TABLE scheduled_sends ADD COLUMN json_path TEXT");
    }
    if (!hasColumn(db, "scheduled_sends", "plist_path")) {
      db.exec("ALTER TABLE scheduled_sends ADD COLUMN plist_path TEXT");
    }
    if (!hasColumn(db, "domain_activity", "arrival_timestamp")) {
      db.exec("ALTER TABLE domain_activity ADD COLUMN arrival_timestamp TEXT");
    }

    // 2b. Drop deprecated staged_emails table (classification data now stays in memory)
    db.exec("DROP TABLE IF EXISTS staged_emails");

    // 3. Create indexes (IF NOT EXISTS -- safe to run multiple times)
    db.exec("CREATE INDEX IF NOT EXISTS idx_junk_address ON junk_senders(address)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_junk_domain ON junk_senders(domain)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_routing_match ON routing_rules(rule_type, match_value)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_email_types_enabled ON email_types(enabled, sort_order)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_known_address ON known_senders(address)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_followup_date ON follow_ups(follow_up_date, resolved)");

    // 4. Seed from YAML files (check .yaml first, fall back to .yaml.seed for fresh DBs)
    const rulesPathYaml = join(dir, "rules.yaml");
    const rulesPathSeed = join(dir, "rules.yaml.seed");
    const junkPathYaml = join(dir, "junk-senders.yaml");
    const junkPathSeed = join(dir, "junk-senders.yaml.seed");
    const rulesPath = existsSync(rulesPathYaml) ? rulesPathYaml : (existsSync(rulesPathSeed) ? rulesPathSeed : null);
    const junkPath = existsSync(junkPathYaml) ? junkPathYaml : (existsSync(junkPathSeed) ? junkPathSeed : null);

    if (rulesPath) {
      const rulesData = yaml.load(readFileSync(rulesPath, "utf-8")) as any;

      // Seed VIP senders
      if (Array.isArray(rulesData?.vip_senders)) {
        const stmt = db.prepare("INSERT OR IGNORE INTO vip_senders (address) VALUES (?)");
        for (const addr of rulesData.vip_senders) {
          if (typeof addr === "string") stmt.run(addr);
        }
      }

      // Seed sender rules
      if (Array.isArray(rulesData?.sender_rules)) {
        const stmt = db.prepare(`
          INSERT INTO routing_rules (rule_type, match_value, action, folder, stop, source)
          SELECT ?, ?, ?, ?, ?, 'seed'
          WHERE NOT EXISTS (SELECT 1 FROM routing_rules WHERE rule_type = ? AND match_value = ? AND source = 'seed')
        `);
        for (const rule of rulesData.sender_rules) {
          const matchVal = rule.match?.from || rule.match?.from_domain || rule.match?.domain;
          const ruleType = rule.match?.from ? "sender" : "domain";
          if (matchVal) {
            stmt.run(ruleType, matchVal, rule.action ?? "archive", rule.folder ?? null, rule.stop !== false ? 1 : 0, ruleType, matchVal);
          }
        }
      }

      // Seed domain rules
      if (Array.isArray(rulesData?.domain_rules)) {
        const stmt = db.prepare(`
          INSERT INTO routing_rules (rule_type, match_value, action, folder, stop, source)
          SELECT ?, ?, ?, ?, ?, 'seed'
          WHERE NOT EXISTS (SELECT 1 FROM routing_rules WHERE rule_type = ? AND match_value = ? AND source = 'seed')
        `);
        for (const rule of rulesData.domain_rules) {
          if (rule.match?.from_domain) {
            stmt.run("domain", rule.match.from_domain, rule.action ?? "archive", rule.folder ?? null, rule.stop !== false ? 1 : 0, "domain", rule.match.from_domain);
          }
        }
      }

      // Seed subject rules
      if (Array.isArray(rulesData?.subject_rules)) {
        const stmt = db.prepare(`
          INSERT INTO routing_rules (rule_type, match_value, action, folder, stop, source)
          SELECT ?, ?, ?, ?, ?, 'seed'
          WHERE NOT EXISTS (SELECT 1 FROM routing_rules WHERE rule_type = ? AND match_value = ? AND source = 'seed')
        `);
        for (const rule of rulesData.subject_rules) {
          if (rule.match?.subject_contains) {
            stmt.run("subject", rule.match.subject_contains, rule.action ?? "archive", rule.folder ?? null, rule.stop !== false ? 1 : 0, "subject", rule.match.subject_contains);
          }
        }
      }

      if (rulesPath === rulesPathYaml) {
        filesToRename.push({ from: rulesPath, to: rulesPath + ".seed" });
      }
    }

    if (junkPath) {
      const junkData = yaml.load(readFileSync(junkPath, "utf-8")) as any;

      // Seed junk by address
      if (Array.isArray(junkData?.by_address)) {
        const stmt = db.prepare(`
          INSERT INTO junk_senders (address, reason)
          SELECT ?, 'seed'
          WHERE NOT EXISTS (SELECT 1 FROM junk_senders WHERE address = ?)
        `);
        for (const addr of junkData.by_address) {
          if (typeof addr === "string") stmt.run(addr, addr);
        }
      }

      // Seed junk by domain
      if (Array.isArray(junkData?.by_domain)) {
        const stmt = db.prepare(`
          INSERT INTO junk_senders (domain, reason)
          SELECT ?, 'seed'
          WHERE NOT EXISTS (SELECT 1 FROM junk_senders WHERE domain = ?)
        `);
        for (const domain of junkData.by_domain) {
          if (typeof domain === "string") stmt.run(domain, domain);
        }
      }

      if (junkPath === junkPathYaml) {
        filesToRename.push({ from: junkPath, to: junkPath + ".seed" });
      }
    }

    // Seed email_types (AD-1). Check .yaml first, fall back to .yaml.seed.
    // Idempotent: WHERE NOT EXISTS keyed on the unique `name`.
    const emailTypesYaml = join(dir, "email-types.yaml");
    const emailTypesSeed = join(dir, "email-types.yaml.seed");
    const emailTypesPath = existsSync(emailTypesYaml)
      ? emailTypesYaml
      : (existsSync(emailTypesSeed) ? emailTypesSeed : null);

    if (emailTypesPath) {
      const etData = yaml.load(readFileSync(emailTypesPath, "utf-8")) as any;
      if (Array.isArray(etData?.email_types)) {
        const stmt = db.prepare(`
          INSERT INTO email_types (name, detection, match_scope, must_surface, sort_order, source)
          SELECT ?, ?, ?, ?, ?, 'seed'
          WHERE NOT EXISTS (SELECT 1 FROM email_types WHERE name = ?)
        `);
        for (const t of etData.email_types) {
          if (t && typeof t.name === "string" && typeof t.detection === "string") {
            const scope = t.match_scope === "subject" ? "subject" : "combined";
            stmt.run(t.name, t.detection, scope, t.must_surface ?? null, t.sort_order ?? 0, t.name);
          }
        }
      }
      if (emailTypesPath === emailTypesYaml) {
        filesToRename.push({ from: emailTypesPath, to: emailTypesPath + ".seed" });
      }
    }

    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }

  // Rename YAML files to .seed AFTER successful commit
  // This way, if DB transaction fails, YAML files remain untouched
  for (const { from, to } of filesToRename) {
    renameSync(from, to);
  }
}

// ─── Settings (Phase 29) ───
// Per-user key/value configuration. Read with a default; written by the
// Settings UI's API routes.

/** Read one setting. Returns `fallback` (default null) when the key is unset. */
export function getSetting(db: Database, key: string, fallback: string | null = null): string | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string | null } | undefined;
  return row ? row.value : fallback;
}

/** Write one setting (upsert). */
export function setSetting(db: Database, key: string, value: string): void {
  db.prepare(`
    INSERT INTO settings (key, value, updated_at)
    VALUES (?, ?, strftime('%Y-%m-%d_%H:%M', 'now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value);
}

/** Read every setting as a plain object. */
export function getAllSettings(db: Database): Record<string, string | null> {
  const rows = db.prepare("SELECT key, value FROM settings").all() as { key: string; value: string | null }[];
  const out: Record<string, string | null> = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

// ─── Email-type taxonomy (AD-1) ───
// The email_types table is the single source of truth for the email-type
// taxonomy. The classifier and the AI-summary prompt both derive from it.
// The EmailType shape and the pure classifier live in Tools/EmailTypes.ts
// (DB-free, so the web client can import them); getEmailTypes is the DB read.

interface EmailTypeRow {
  id: number;
  name: string;
  detection: string;
  match_scope: string;
  must_surface: string | null;
  enabled: number;
  sort_order: number;
  source: string;
}

/**
 * Read the email-type taxonomy from the database.
 * Returns enabled types ordered by sort_order (cascade order — first match wins).
 * Pass { includeDisabled: true } to get every row, e.g. for the Settings editor.
 */
export function getEmailTypes(db: Database, opts?: { includeDisabled?: boolean }): EmailType[] {
  const sql = opts?.includeDisabled
    ? "SELECT * FROM email_types ORDER BY sort_order, id"
    : "SELECT * FROM email_types WHERE enabled = 1 ORDER BY sort_order, id";
  const rows = db.prepare(sql).all() as EmailTypeRow[];
  return rows.map(r => ({
    id: r.id,
    name: r.name,
    detection: r.detection,
    matchScope: r.match_scope === "subject" ? "subject" : "combined",
    mustSurface: r.must_surface,
    enabled: r.enabled === 1,
    sortOrder: r.sort_order,
    source: r.source,
  }));
}

/** Add a custom email type (Phase 29 Categories panel). */
export function addEmailType(db: Database, t: {
  name: string;
  detection: string;
  matchScope?: "combined" | "subject";
  mustSurface?: string | null;
  sortOrder?: number;
}): void {
  db.prepare(`
    INSERT INTO email_types (name, detection, match_scope, must_surface, sort_order, source)
    VALUES (?, ?, ?, ?, ?, 'manual')
  `).run(t.name, t.detection, t.matchScope ?? "combined", t.mustSurface ?? null, t.sortOrder ?? 0);
}

/** Update an email type's editable fields by id (Phase 29). Only the supplied
 *  fields are written; enabling/disabling is `{ enabled }`. */
export function updateEmailType(db: Database, id: number, fields: {
  name?: string;
  detection?: string;
  matchScope?: "combined" | "subject";
  mustSurface?: string | null;
  sortOrder?: number;
  enabled?: boolean;
}): void {
  const sets: string[] = [];
  const vals: (string | number | null)[] = [];
  if (fields.name !== undefined) { sets.push("name = ?"); vals.push(fields.name); }
  if (fields.detection !== undefined) { sets.push("detection = ?"); vals.push(fields.detection); }
  if (fields.matchScope !== undefined) { sets.push("match_scope = ?"); vals.push(fields.matchScope); }
  if (fields.mustSurface !== undefined) { sets.push("must_surface = ?"); vals.push(fields.mustSurface); }
  if (fields.sortOrder !== undefined) { sets.push("sort_order = ?"); vals.push(fields.sortOrder); }
  if (fields.enabled !== undefined) { sets.push("enabled = ?"); vals.push(fields.enabled ? 1 : 0); }
  if (sets.length === 0) return;
  vals.push(id);
  db.prepare(`UPDATE email_types SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
}

/** Delete an email type by id (Phase 29). */
export function deleteEmailType(db: Database, id: number): void {
  db.prepare("DELETE FROM email_types WHERE id = ?").run(id);
}
