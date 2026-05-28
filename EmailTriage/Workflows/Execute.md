# Workflow: Execute

Stage 3: apply the reviewed decisions to Mail.app and the database.

## Trigger

Slash command: `/process-email` (vault command at `<vault>/.claude/commands/process-email.md`).

Or run directly:

```bash
bun run ~/.claude/skills/EmailTriage/Tools/ExecuteTriage.ts \
  [--date YYYY-MM-DD] [--dry-run]
```

## Inputs

- Today's triage note (`<vault>/Email Triage/Email Triage -- <Month> <Day>, <Year>.md`).
- Approved staged drafts at `<vault>/Email Triage/Staged/` (Reply rows).
- `triage.db` (writes audit log + scheduled-send packages).

## What it does

1. Reads the triage note and respects review gates: only stages with `[x]` in the heading are processed.
2. Parses action codes from mark columns:
	- `K` Keep, `A` Archive, `T` Trash, `J` Junk, `R` Reply, `D` Defer, `FU` Follow-up, `U` Unsubscribe, `BD` Block Domain, `BS` Block Sender, `SEND_AT` Scheduled send.
3. Extracts message IDs from the V2 link format `[87126](message://87126) [i]`.
4. Routes per-account: iCloud through `apple-mail.sh`, Gmail through `apple-mail.sh` today (Phase 1 of the Gmail Transport Proposal will swap Gmail to gws).
5. Reply rows: writes draft to `Staged/`, surfaces for re-review before final send. Approved drafts get sent via Mail.app.
6. Scheduled sends: `SEND_AT 2026-04-09_08:00` rows create launchd packages under `scheduled/` (see Workflow: ScheduledSend).
7. Records every action to `email_actions` (audit log).
8. Updates the triage note's Triage Overview table with execution results.

## Flags

| Flag | Effect |
|---|---|
| `--date YYYY-MM-DD` | Process the note for a date other than today. |
| `--dry-run` | Print what would happen; no Mail.app or DB writes. |

## Expected output

- Mail.app: emails moved/archived/trashed/replied per the marked actions.
- DB: rows in `email_actions`, `vip_senders`, `junk_senders`, `routing_rules`, `follow_ups`, `scheduled_sends` per the actions.
- Triage note: Triage Overview table updated with success counts.

## Verification

```bash
sqlite3 ~/.claude/skills/EmailTriage/triage.db \
  "SELECT action, COUNT(*) FROM email_actions WHERE date(created_at)=date('now') GROUP BY action;"
ls -la "<vault>/Email Triage/Staged/"
```

## Edge cases

- **Stale message ID** — Mail.app reassigns numeric IDs after a sort. Executor falls back to staging-folder search per account; logs `[RETRY]` and `[FALLBACK]`.
- **Unchecked stage `[]`** — skipped silently. Re-check the gate to enable, then re-run.
- **Failed scheduled send** — JSON file renamed to `<id>.failed.json`. Run `bun run Tools/SendLater.ts catchup` to retry.
- **V1 legacy note** — backward-compatible; falls through to V1 parser.
