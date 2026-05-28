-- EmailTriage SQLite Schema
-- Tables for sender classification, triage history, and action tracking
-- Date format: YYYY-MM-DD_HH:MM (vault standard: underscore separator, 24-hour clock)

CREATE TABLE IF NOT EXISTS vip_senders (
  address TEXT PRIMARY KEY,
  name TEXT,
  account TEXT,
  added_at TEXT DEFAULT (strftime('%Y-%m-%d_%H:%M', 'now'))
);

CREATE TABLE IF NOT EXISTS junk_senders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  address TEXT,
  domain TEXT,
  account TEXT,
  added_at TEXT DEFAULT (strftime('%Y-%m-%d_%H:%M', 'now')),
  reason TEXT
);

CREATE TABLE IF NOT EXISTS known_senders (
  address TEXT PRIMARY KEY,
  first_seen TEXT DEFAULT (strftime('%Y-%m-%d_%H:%M', 'now')),
  last_seen TEXT DEFAULT (strftime('%Y-%m-%d_%H:%M', 'now')),
  times_seen INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS unsubscribed (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  address TEXT,
  domain TEXT,
  method TEXT,
  unsubscribed_at TEXT DEFAULT (strftime('%Y-%m-%d_%H:%M', 'now'))
);

CREATE TABLE IF NOT EXISTS triage_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  total INTEGER DEFAULT 0,
  archived INTEGER DEFAULT 0,
  trashed INTEGER DEFAULT 0,
  replied INTEGER DEFAULT 0,
  unsubscribed INTEGER DEFAULT 0,
  blocked INTEGER DEFAULT 0,
  duration_sec INTEGER DEFAULT 0,
  generated_at TEXT,
  processed_at TEXT,
  review_duration_sec INTEGER,
  created_at TEXT DEFAULT (strftime('%Y-%m-%d_%H:%M', 'now'))
);

CREATE TABLE IF NOT EXISTS email_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email_id TEXT NOT NULL,
  date TEXT NOT NULL,
  action TEXT NOT NULL,
  folder TEXT,
  notes TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%d_%H:%M', 'now'))
);

CREATE TABLE IF NOT EXISTS follow_ups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email_id TEXT NOT NULL,
  follow_up_date TEXT NOT NULL,
  sender TEXT NOT NULL,
  subject TEXT NOT NULL,
  original_date TEXT NOT NULL,
  resolved INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (strftime('%Y-%m-%d_%H:%M', 'now'))
);

CREATE TABLE IF NOT EXISTS scheduled_sends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email_id TEXT NOT NULL,
  send_at TEXT NOT NULL,
  reply_content TEXT NOT NULL,
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  account TEXT,
  json_path TEXT,
  plist_path TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%d_%H:%M', 'now', 'localtime')),
  sent_at TEXT
);

-- Routing rules (replaces sender/domain/subject rules from rules.yaml)
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

-- Domain activity tracking for auto-block frequency analysis
CREATE TABLE IF NOT EXISTS domain_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL,
  address TEXT,
  triage_date TEXT NOT NULL,
  action_taken TEXT,
  email_id TEXT,
  arrival_timestamp TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%d_%H:%M', 'now'))
);

-- Email-type taxonomy (AD-1) — per-user, seeded from References/email-types.yaml.seed.
-- The classifier and the AI-summary prompt both derive their type list from this
-- table. Users customize it via the Settings Categories panel; adding a type is
-- a single INSERT, no code change. `detection` is a case-insensitive regex;
-- `match_scope` is 'combined' (subject + body) or 'subject'.
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

-- Settings (Phase 29) — per-user key/value configuration: the AI-summarizer
-- prompt and model/provider choice, the receipt-folder path, and other tunables
-- the Settings UI edits. Key/value so new settings need no schema change.
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT DEFAULT (strftime('%Y-%m-%d_%H:%M', 'now'))
);

-- Performance indexes
CREATE INDEX IF NOT EXISTS idx_junk_address ON junk_senders(address);
CREATE INDEX IF NOT EXISTS idx_junk_domain ON junk_senders(domain);
CREATE INDEX IF NOT EXISTS idx_routing_match ON routing_rules(rule_type, match_value);
CREATE INDEX IF NOT EXISTS idx_known_address ON known_senders(address);
CREATE INDEX IF NOT EXISTS idx_followup_date ON follow_ups(follow_up_date, resolved);
CREATE INDEX IF NOT EXISTS idx_domain_activity_domain ON domain_activity(domain);
CREATE INDEX IF NOT EXISTS idx_domain_activity_date ON domain_activity(triage_date);
CREATE INDEX IF NOT EXISTS idx_email_types_enabled ON email_types(enabled, sort_order);

-- Phase 2: reconciler drift / conflict log (new table only; no ALTER of existing tables)
CREATE TABLE IF NOT EXISTS reconciliation_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%d_%H:%M', 'now')),
  account TEXT NOT NULL,
  email_id TEXT NOT NULL,
  conflict_type TEXT NOT NULL,
  sqlite_value TEXT,
  remote_value TEXT,
  resolution TEXT,
  detail TEXT
);

CREATE INDEX IF NOT EXISTS idx_reconciliation_email ON reconciliation_log(email_id, created_at);
