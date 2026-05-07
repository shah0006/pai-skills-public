# Reference: CommandRef

Every command in `Tools/apple-mail.sh` (and the `Tools/Accounts.sh` wrapper) in one place. Lifted from the pre-Phase-1 SKILL.md command tables; output formats and command names are invariant by design (EmailTriage `email-parser.ts` and `triage-formatter.ts` parse these strings).

## Reading

| Command | Aliases | Usage |
|---------|---------|-------|
| `list [N] [-m box] [-u]` | `ls` | List recent emails (default 10). `-u` = unread only. |
| `read <id> [-m box]` | `show`, `view` | Read full email by ID. |
| `unread [-m box]` | `count-unread` | Count unread messages. |
| `thread <id> [-m box]` | `conversation` | List thread messages (headers). |
| `thread-read <id> [-m box]` | `threadread` | Full thread with bodies, chronological. |
| `attachments <id> [-m box]` | `attach`, `att` | List attachments (name, MIME, size). |
| `open <id> [-m box]` | `open-email` | Open email in Mail.app GUI window. |

## Searching

`search <query> [N] [options]` (aliases: `find`, `query`)

| Option | Description |
|--------|-------------|
| `-m box` | Target mailbox or unified path. |
| `--mailbox all` | All mailboxes (single SQL query, fast). |
| `-f addr` | Filter by sender. |
| `-u` | Unread only. |
| `-b` / `--body` | Search body text (slow, AppleScript path). |
| `--after YYYY-MM-DD` | Restrict to or after date. |
| `--before YYYY-MM-DD` | Restrict to or before date. |

## Composing

| Command | Aliases | Key Options |
|---------|---------|-------------|
| `send <to> <subj> <body>` | `compose`, `new` | `--to` (repeatable), `--cc`, `--bcc`, `--from`, `--attach` / `-A` (repeatable). |
| `reply <id> <body>` | `respond` | `--all`, `-m`, `--cc`, `--bcc`. |
| `reply-all <id> <body>` | `replyall` | `--all` implicit. |
| `forward <id> --to addr` | `fwd` | `--body` (prefix text), `-m`. |
| `draft --to addr -s subj -B body` | `save-draft` | `--cc`. |

Composition routes through the vault-first rule documented in `SKILL.md`. See `Workflows/Send.md` for the procedure.

## Organization (single-email)

| Command | Aliases | Usage |
|---------|---------|-------|
| `flag <id> [-m box]` | `star` | Flag email. |
| `unflag <id> [-m box]` | `unstar` | Remove flag. |
| `mark-read <id> [-m box]` | `markread` | Mark read. |
| `mark-unread <id> [-m box]` | `markunread` | Mark unread. |
| `move <id> <dest> [-m src]` | | Move to mailbox. |
| `trash <id> [-m box]` | `delete`, `rm` | Move to Trash. |
| `archive <id> [-m box]` | | Move to Archive. |

## Bulk operations (mailbox-wide)

Three modes: no flag = dry-run, `--confirm` = interactive, `--force` = immediate (PAI-safe).

| Command | Key Options |
|---------|-------------|
| `bulk-trash -m box [--unread-only] [--force]` | Trash all (or unread) in a mailbox. |
| `bulk-move -m box -d dest [--unread-only] [--force]` | Move between mailboxes. |
| `bulk-mark-read -m box [--force]` | Mark all read. |

## Bulk operations (by ID)

Operate on specific messages in a single AppleScript call. Not-found IDs warn but do not stop the batch.

| Command | Usage |
|---------|-------|
| `bulk-trash-ids <id> ... [-m box]` | Trash specific messages. |
| `bulk-move-ids <id> ... <dest> [-m box]` | Move specific messages (last positional argument is destination, or use `--dest`). |
| `bulk-archive-ids <id> ... [-m box]` | Archive specific messages. |
| `bulk-mark-read-ids <id> ... [-m box]` | Mark specific messages read. |
| `bulk-flag-ids <id> ... [-m box]` | Flag specific messages. |
| `bulk-unflag-ids <id> ... [-m box]` | Unflag specific messages. |
| `bulk-mark-unread-ids <id> ... [-m box]` | Mark specific messages unread. |

Output: `N of M message(s) processed`.

## Attachments and export

| Command | Aliases | Usage |
|---------|---------|-------|
| `save-attachment <id> [-m box] [-o dir]` | `save-att` | Download attachments (default `~/Downloads/`). |
| `export <id> [-m box] [-o path]` | `export-email` | Export to Obsidian `.email.md` with YAML frontmatter. |

## Watch / monitor

| Command | Purpose |
|---------|---------|
| `watch start` | Start launchd monitoring (every 2 minutes). |
| `watch stop` | Stop monitoring. |
| `watch status` | Show status, last check time, unread and VIP counts. |
| `watch check` | Manual check now. |
| `watch log [N]` | Show last N log lines (default 30). |
| `watch vip` | Display VIP sender list. |
| `watch vip-add <sender>` | Add VIP sender (case-insensitive partial match). |

VIP list path (post-v5): `${PAI_DIR:-$HOME/.claude/PAI}/USER/SKILLCUSTOMIZATIONS/AppleMail/watch-vip.txt`. Log: `~/.cache/apple-mail-watch/watch.log`.

## Info

| Command | Aliases | Purpose |
|---------|---------|---------|
| `accounts` | `accts` | Raw Mail.app account probe (no triage filter). For filtered output, use `Tools/Accounts.sh`. |
| `folders` | `mailboxes`, `boxes` | List all mailboxes with unread and total counts. |

## Multi-account flow (Tools/Accounts.sh)

| Invocation | Behavior |
|------------|----------|
| `Tools/Accounts.sh` | Default. Print accounts where `triage: true` from `accounts.yaml`; fall back to raw Mail.app probe if YAML missing. |
| `Tools/Accounts.sh --init` | Probe Mail.app, write `accounts.yaml` with every account marked `triage: true`. |
| `Tools/Accounts.sh --refresh` | Re-probe; add new accounts as `triage: true`; preserve existing flags; warn on disappearances. |
| `Tools/Accounts.sh --help` | Print usage. |

See `Workflows/Setup.md` for the full procedure.

## Bulk Unsubscribe (Tools/BulkUnsubscribe.sh)

See `Workflows/BulkOps.md` for option list and examples.

## Conventions

- Plain text only (HTML stripped with notice).
- `--mailbox` accepts unified paths: `i/...`, `g/...`, `y` `h` `a` `p` aliases, plain `inbox`/`sent`/`drafts`/`trash`/`junk`. Full spec at `References/MultiAccount.md`.
- Output line shape: `ID:NNNNN [READ]/[ ]/[⚑] [📎] | date | from | subject [| ACCT:name]`. Full spec at `References/OutputFormats.md`.
