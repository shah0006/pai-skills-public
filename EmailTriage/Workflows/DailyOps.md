# Workflow: DailyOps

The standard "morning triage" loop. Runs the full Generate → Review → Execute pipeline once per day.

## Steps

### 1. Generate

```bash
/generate-email-triage
```

Creates `<vault>/Email Triage/Email Triage -- <today>.md`. iMessage alert fires if anything is time-sensitive. Auto-regenerated reference files refresh in `<vault>/Email Triage/Reference/`.

### 2. Review

```bash
/start-email-triage
```

Opens `http://localhost:9988`. Use `j`/`k` to navigate, `a`/`t`/`r`/`d`/`u`/`b` to mark actions, `space` to toggle selection. Review-gate each stage with `[x]` in the note (default: VIP and Action_Required pre-checked, others manual).

Optional: open `<vault>/Email Triage/Staged/` to refine any reply drafts before they get sent.

### 3. Execute

```bash
/process-email
```

Applies the marked decisions: moves emails into Mail.app folders, sends approved replies, queues scheduled sends, blocks senders/domains, fires unsubscribes. Updates the Triage Overview table at the top of the note.

## Daily verification

```bash
sqlite3 ~/.claude/skills/EmailTriage/triage.db \
  "SELECT generated_at, processed_at, total_emails, review_duration_sec
   FROM triage_history ORDER BY generated_at DESC LIMIT 1;"

ls "<vault>/Email Triage/" | tail -3
```

## Cadence

- **Daily at 7-9am** — typical run. Inbox Zero by mid-morning.
- **Weekly** — review `<vault>/Email Triage/Reference/Unsubscribe History.md` for senders who ignored RFC 8058 and need `BD` blocks.
- **Monthly** — review analytics tab in the web UI; tune `routing_rules` for the patterns that need fewer manual decisions.

## When to use `--force`

Run `/generate-email-triage --force` only when:

- The triage note got corrupted mid-edit and needs a clean rewrite.
- Major rule change (mass `BD` of a domain) happened mid-day and you want the new rules applied to the existing note.

`--force` is destructive: any in-note manual edits are overwritten. Default incremental merge preserves prior decisions.

## Recovery

If `/process-email` fails partway:

```bash
sqlite3 ~/.claude/skills/EmailTriage/triage.db \
  "SELECT email_id, action, success, error_message FROM email_actions
   WHERE date(created_at)=date('now') AND success=0 ORDER BY created_at DESC;"
```

Re-run with `--dry-run` first to confirm the parse is clean, then re-run for real. The note tracks per-stage processed-at timestamps so you can tell which stages already ran.

## Phase 1 readiness (Gmail Transport)

When the Gmail Transport Phase 1 lands (per the signed-off proposal at `Coordination/EmailTriage Gmail Transport Proposal.md`), Gmail Stage moves swap from Mail.app folders to Gmail labels. The web UI hides the difference; the user-facing triage flow is unchanged. Acceptance criteria:

1. Morning triage on the Gmail account runs without Mail.app being open.
2. Mail.app shows the Gmail account as a passive viewer; gws is the sole writer.
3. Gmail web UI shows triaged messages under `Stages/Stage N - ...` labels with no INBOX label.
