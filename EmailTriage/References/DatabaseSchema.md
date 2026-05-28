# Reference: Database Schema

EmailTriage uses one SQLite database at `<skill-root>/triage.db`. The canonical schema lives at `References/schema.sql` and is replayed (via `CREATE TABLE IF NOT EXISTS`) on every `initDb()` call so a missing DB self-bootstraps.

## Tables (10)

### Sender classification

| Table | Purpose | Auto-reference file |
|---|---|---|
| `vip_senders` | VIP addresses (always Stage 1, action priority) | `Email Triage/Reference/VIP Senders.md` |
| `junk_senders` | Blocked addresses + domains (auto-trashed) | `Email Triage/Reference/Junk Blocklist.md` |
| `routing_rules` | Sender / domain / subject classification rules | `Email Triage/Reference/Routing Rules.md` |
| `known_senders` | Every sender ever seen (frequency tracking) | `Email Triage/Reference/Known Senders.md` (on request) |

### History and audit

| Table | Purpose |
|---|---|
| `triage_history` | One row per `generateTriage()` run: counts + timing |
| `email_actions` | One row per Execute action (audit log) |
| `unsubscribed` | One-click unsubscribe attempts: address, method, success |
| `domain_activity` | Per-domain activity rollup (powers auto-block of frequent-trash domains) |

### Workflow state

| Table | Purpose |
|---|---|
| `follow_ups` | Email IDs marked `FU YYYY-MM-DD` — resurface on or after that date |
| `scheduled_sends` | Pending / sent / failed scheduled-send packages with launchd plist refs |

## Date convention

All `*_at` columns use the vault's date format: `YYYY-MM-DD_HH:MM` (underscore separator, 24-hour, no seconds). The schema's `DEFAULT (strftime('%Y-%m-%d_%H:%M', 'now'))` enforces this. Avoid `datetime('now')` (different format).

## Indexes

| Index | On | Why |
|---|---|---|
| `idx_junk_address` | `junk_senders(address)` | Tier 2 lookup |
| `idx_junk_domain` | `junk_senders(domain)` | Tier 3 lookup |
| `idx_routing_match` | `routing_rules(rule_type, match_value)` | Tiers 4-6 lookup |
| `idx_known_address` | `known_senders(address)` | Tier 7 lookup |
| `idx_followup_date` | `follow_ups(follow_up_date, resolved)` | resurface scan |
| `idx_domain_activity_domain` | `domain_activity(domain)` | auto-block freq scan |
| `idx_domain_activity_date` | `domain_activity(triage_date)` | day-bounded freq scan |

## Migrations

Migrations are managed by `Tools/Db.ts::runMigration()`, which is idempotent:

- `CREATE TABLE IF NOT EXISTS` for new tables.
- `ALTER TABLE` only after `hasColumn()` check, so migrations can re-run safely.
- Index creation uses `IF NOT EXISTS`.
- YAML seed (`References/rules.yaml.seed`, `References/junk-senders.yaml.seed`) is loaded only when no rules.yaml / junk-senders.yaml exist; this seeds a fresh DB but never overwrites a populated one.

## Direct query reference

Common ops:

```bash
sqlite3 ~/.claude/skills/EmailTriage/triage.db <<'SQL'
.headers on
.mode column
SELECT date, total, archived, trashed, replied, duration_sec
FROM triage_history ORDER BY date DESC LIMIT 7;
SQL
```

```bash
sqlite3 ~/.claude/skills/EmailTriage/triage.db \
  "SELECT address, name, account FROM vip_senders ORDER BY added_at DESC LIMIT 20;"
```

## Backups

The DB is in `.gitignore` — it's per-machine state. Back it up with the rest of your `~/.claude/` (e.g. via Time Machine). Recovery is a fresh `runMigration()` against an empty DB; you lose history but rules re-seed from YAML.
