# Workflow: Read

Read inbox, list emails, view a single email, walk a thread, inspect attachments. All read-only.

## Commands

| Command | Aliases | Usage |
|---------|---------|-------|
| `list [N] [-m box] [-u]` | `ls` | List recent emails (default 10). `-u` = unread only. |
| `read <id> [-m box]` | `show`, `view` | Read full email body by ID. |
| `unread [-m box]` | `count-unread` | Count unread messages. |
| `thread <id> [-m box]` | `conversation` | List thread messages (headers only). |
| `thread-read <id> [-m box]` | `threadread` | Full thread with bodies, chronological. |
| `attachments <id> [-m box]` | `attach`, `att` | List attachments (name, MIME, size). |
| `open <id> [-m box]` | `open-email` | Open the email in Mail.app GUI window. |

`-m` accepts unified paths: `i/Receipts`, `g/Stages/Stage 1 - VIP`, plain `inbox`, etc. See `References/MultiAccount.md`.

## Steps

1. If the user names a mailbox other than the inbox, resolve it via the unified path syntax in `References/MultiAccount.md`.
2. Run the appropriate command. List output line format is documented in `References/OutputFormats.md`; downstream parsers (EmailTriage `email-parser.ts`, `triage-formatter.ts`) depend on this format.
3. For thread workflows, prefer `thread-read` when the user wants to understand the conversation; prefer `thread` when only headers are needed.

## Examples

```
apple-mail.sh list 20
apple-mail.sh list -u -m sent
apple-mail.sh read 79132
apple-mail.sh thread-read 79132 -m drafts
apple-mail.sh attachments 79132
apple-mail.sh unread -m "i/Receipts"
```
