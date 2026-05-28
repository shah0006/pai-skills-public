# Workflow: ScheduledSend

Send-later: queue an email to be sent at a future timestamp via launchd. Zero-dependency dispatcher.

## Trigger

CLI:

```bash
bun run ~/.claude/skills/EmailTriage/Tools/SendLater.ts schedule \
  --to recipient@example.com \
  --subject "Subject line" \
  --body "Body text" \
  --send-at "2026-04-09_08:00"

bun run ~/.claude/skills/EmailTriage/Tools/SendLater.ts list
bun run ~/.claude/skills/EmailTriage/Tools/SendLater.ts cancel <send-id>
bun run ~/.claude/skills/EmailTriage/Tools/SendLater.ts catchup [--dry-run]
bun run ~/.claude/skills/EmailTriage/Tools/SendLater.ts cleanup [--days 30]
```

Also auto-invoked by `Tools/ExecuteTriage.ts` when an `SEND_AT YYYY-MM-DD_HH:MM` action is parsed during Workflow: Execute.

## What it does

- Writes a self-contained JSON package to `scheduled/<id>.json`:
	```json
	{ "id": "...", "recipient": "...", "subject": "...", "body": "...", "account": "...", "send_at": "...", "attempts": 0 }
	```
- Materializes a launchd plist that runs `send-dispatcher.sh <id>.json` once at the requested time.
- Loads the plist into `~/Library/LaunchAgents/` so launchd picks it up.
- At send time, `send-dispatcher.sh` reads the JSON, calls `apple-mail.sh send` (iCloud) or the Gmail transport (Phase 1+), and on success moves the JSON to `scheduled/sent/`. On failure: retry up to 3 attempts then rename to `<id>.failed.json`.
- The dispatcher is **zero-dependency** at send time: no Bun, no Node, no Claude Code. Pure bash + AppleScript via Mail.app. The Mac just needs to be awake (or this catchup job catches up on next wake).

## Catchup behavior

- `catchup` scans `scheduled/*.json` for entries whose `send_at` is in the past and not yet sent. Re-attempts each.
- Combined with the recurring `com.pai.send-later` launchd plist (every 6 hours), missed sends due to Mac sleep are caught up automatically.

## Verification

```bash
launchctl list | grep send-later        # is the recurring plist loaded?
ls -la ~/.claude/skills/EmailTriage/scheduled/
ls -la ~/.claude/skills/EmailTriage/scheduled/sent/
sqlite3 ~/.claude/skills/EmailTriage/triage.db \
  "SELECT id, recipient, send_at, status FROM scheduled_sends ORDER BY send_at DESC LIMIT 5;"
```

## Installing the recurring plist

The `com.pai.send-later.plist.template` at the skill root is the source. The materialized plist (with absolute paths to your bun + skill location) goes into `~/Library/LaunchAgents/`. See `Workflows/Setup.md` for the install steps.

## Cancelling

```bash
bun run ~/.claude/skills/EmailTriage/Tools/SendLater.ts cancel <send-id>
```

Removes both the JSON and the corresponding plist.

## Edge cases

- **Mac asleep at send time** — launchd queues missed runs. Combined with the recurring 6-hour catchup, sends fire on next wake.
- **Network down at send time** — retry up to 3 attempts with backoff. After 3, JSON is renamed to `<id>.failed.json` and surfaced in the next morning's triage note.
- **Wrong account name** — the dispatcher reports the AppleScript error in `scheduled/send-dispatcher.log`.
