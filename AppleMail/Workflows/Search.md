# Workflow: Search

Search emails by subject, sender, date range, body, mailbox, or across all accounts.

## Command

`search <query> [N] [options]` (aliases: `find`, `query`)

| Option | Description |
|--------|-------------|
| `-m box` | Target mailbox (unified path: `i/...`, `g/...`, plain name). |
| `--mailbox all` | Search every mailbox. Cheap on the SQL fast path. |
| `-f addr` | Filter by sender address (substring match). |
| `-u` | Unread only. |
| `-b` / `--body` | Search body text. Slow (30 to 90 seconds); routes through AppleScript. |
| `--after YYYY-MM-DD` | Restrict to messages received on or after this date. |
| `--before YYYY-MM-DD` | Restrict to messages received on or before this date. |

## Performance

Default searches (subject, sender, date) query Mail's SQLite `Envelope Index` directly at `~/Library/Mail/V10/MailData/Envelope Index` and return in 20 to 30 milliseconds regardless of mailbox size. `--mailbox all` is cheap on this path (single SQL query, no per-mailbox AppleScript fan-out). Body search routes through AppleScript and is slow; use it only when full-text body match is required. If the SQLite database is unavailable the code automatically falls back to AppleScript.

## Examples

```
apple-mail.sh search "invoice" 20
apple-mail.sh search "the" 5 --mailbox all
apple-mail.sh search "tax" --from "irs.gov" --after 2026-01-01
apple-mail.sh search "report" --body --mailbox sent --before 2026-04-01
apple-mail.sh search "alert" -u
```
