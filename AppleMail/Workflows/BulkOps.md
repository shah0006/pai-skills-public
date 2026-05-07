# Workflow: BulkOps

Bulk-process emails by mailbox or by a list of message IDs. Includes the unsubscribe pipeline.

## Mailbox-wide bulk

Three execution modes: no flag = dry-run, `--confirm` = interactive prompt, `--force` = immediate (PAI-safe).

| Command | Key Options |
|---------|-------------|
| `bulk-trash -m box [--unread-only] [--force]` | Trash all (or unread) in a mailbox. |
| `bulk-move -m box -d dest [--unread-only] [--force]` | Move between mailboxes. |
| `bulk-mark-read -m box [--force]` | Mark all as read. |

## By-ID bulk

Operate on specific messages in a single AppleScript call. No dry-run needed; you already named the IDs.

| Command | Usage |
|---------|-------|
| `bulk-trash-ids <id> ... [-m box]` | Trash specific messages. |
| `bulk-move-ids <id> ... <dest> [-m box]` | Move specific messages (last positional argument is the destination, or use `--dest`). |
| `bulk-archive-ids <id> ... [-m box]` | Archive specific messages. |
| `bulk-mark-read-ids <id> ... [-m box]` | Mark specific messages read. |
| `bulk-flag-ids <id> ... [-m box]` | Flag specific messages. |
| `bulk-unflag-ids <id> ... [-m box]` | Unflag specific messages. |
| `bulk-mark-unread-ids <id> ... [-m box]` | Mark specific messages unread. |

Not-found IDs produce warnings but do not stop the batch. Output: `N of M message(s) processed`.

## Bulk Unsubscribe (HTTP + MAILTO + sender block)

Run `Tools/BulkUnsubscribe.sh` against a mailbox to parallel-process every email in it.

| Option | Description |
|--------|-------------|
| `--mailbox <name>` | Mailbox to process (default: `zzUnsubscribe`). |
| `--account <name>` | iCloud account name (default: `iCloud`). |
| `--dry-run` | Show what would happen without unsubscribing. |
| `--trash-after` | Bulk-trash the entire mailbox after processing. |
| `--block-senders` | Create an Apple Mail rule to auto-delete future messages from these senders. |
| `--parallel <n>` | Max concurrent HTTP requests (default: 20). |
| `--limit <n>` | Process at most N emails (default: all). |

The script extracts each email's `List-Unsubscribe` header, classifies as HTTP / MAILTO / no-header, parallel-fetches HTTP URLs, sequentially sends MAILTO unsubscribes through `apple-mail.sh send`, optionally bulk-trashes the mailbox, and optionally builds an Apple Mail rule covering every sender encountered.

Logs land at the project's Unsubscribe Logs folder if the vault is mounted, otherwise at `~/.claude/skills/AppleMail/logs/`.

## Examples

```
apple-mail.sh bulk-trash -m "i/Promotions" --unread-only --force
apple-mail.sh bulk-move -m "i/Inbox" -d "i/Stages/Stage 1 - VIP" --unread-only --force
apple-mail.sh bulk-mark-read -m drafts --force

apple-mail.sh bulk-trash-ids 79132 79133 79134
apple-mail.sh bulk-move-ids 79132 79133 "i/Receipts"
apple-mail.sh bulk-archive-ids 79132 79133

bash ~/.claude/skills/AppleMail/Tools/BulkUnsubscribe.sh \
  --mailbox "zzUnsubscribe" --trash-after --block-senders --parallel 20
```
