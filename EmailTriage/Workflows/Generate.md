# Workflow: Generate

Build today's morning triage note from the inbox. This is stage 1 of the three-stage pipeline (Generate → Review → Execute).

## Trigger

Slash command: `/generate-email-triage` (vault command at `<vault>/.claude/commands/generate-email-triage.md`).

Or run directly:

```bash
bun run ~/.claude/skills/EmailTriage/Tools/GenerateTriage.ts \
  [--test] [--date YYYY-MM-DD] [--account i|g] [--force] [--all]
```

## Inputs

- Inbox emails fetched via `apple-mail.sh list --unread` (default) or `--all` for full inbox.
- Already-staged emails read from per-account folders (`i/Stages/Stage 1-6`, `g/Stages/Stage 1-6`).
- Rules from `triage.db` (`vip_senders`, `routing_rules`, `junk_senders`, `known_senders`, `follow_ups`).
- Seed YAML (first run only): `References/rules.yaml.seed`, `References/junk-senders.yaml.seed`.

## What it does

1. Fetches the inbox via the AppleMail transport.
2. Applies the 8-tier classification funnel: VIP → junk → sender rules → domain rules → subject rules → known senders → AI classifier → unknown.
3. Sorts NEW emails into per-account stage folders (Stage 1-6).
4. Re-classifies pre-staged emails at their current stage (preserving prior decisions).
5. Batches AI classification 5-10 emails per call to keep token cost low.
6. Writes a V2 triage note with mark-column tables and `[x]`/`[]` review gates to:
	- `<vault>/Email Triage/Email Triage -- <Month> <Day>, <Year>.md`
7. Populates `known_senders` (powers the `[NEW]` badge).
8. Resurfaces overdue follow-ups from `follow_ups`.
9. Sends an iMessage alert if time-sensitive emails detected.
10. Auto-regenerates `Email Triage/Reference/*.md` files when underlying data changed.

## Flags

| Flag | Effect |
|---|---|
| `--test` | Run on `tests/fixtures/sample-emails.ts` instead of live inbox. No Mail.app calls. |
| `--date YYYY-MM-DD` | Override the triage date (default: today). |
| `--account i|g` | Process only iCloud (`i`) or Gmail (`g`). Default: both. |
| `--force` | Destructive full regeneration. Drops all in-memory state and re-classifies from scratch. |
| `--all` | Fetch full inbox instead of unread-only. |

## Expected output

- New file at `<vault>/Email Triage/Email Triage -- <Month> <Day>, <Year>.md`.
- Reference file refreshes under `<vault>/Email Triage/Reference/` (debounced).
- iMessage alert fired only if urgent items detected.

## Verification

```bash
ls -la "<vault>/Email Triage/Email Triage -- $(date '+%B %-d, %Y').md"
sqlite3 ~/.claude/skills/EmailTriage/triage.db \
  "SELECT generated_at, total_emails FROM triage_history ORDER BY generated_at DESC LIMIT 1;"
```

## Customization

`~/.claude/PAI/USER/SKILLCUSTOMIZATIONS/EmailTriage/preferences.yaml` keys (all optional):

```yaml
vault_root: /Volumes/<your-volume>/<your-vault>
self_address: you@example.com
first_name: Yourname
persona: Yourname Lastname (your-role)
```

## Edge cases

- **Mail.app empty inbox** — verify Mail.app is running and the account synced. Run `apple-mail.sh list i` for iCloud only.
- **Rate limit (429)** — retries once after 5s, then falls back to rules-engine-only (skips AI classification).
- **Safe re-run** — second run on same date is incremental merge by default. Pass `--force` to regenerate destructively.
- **No Apple Mail message-ID** — Mail.app reassigns numeric IDs after a sort. Generator runs post-sort ID reconciliation.
