# Workflow: Manage (single-email organization)

Flag, mark-read, move, trash, or archive a single email by ID.

## Commands

| Command | Aliases | Usage |
|---------|---------|-------|
| `flag <id> [-m box]` | `star` | Flag the email. |
| `unflag <id> [-m box]` | `unstar` | Remove the flag. |
| `mark-read <id> [-m box]` | `markread` | Mark as read. |
| `mark-unread <id> [-m box]` | `markunread` | Mark as unread. |
| `move <id> <dest> [-m src]` | | Move to another mailbox. |
| `trash <id> [-m box]` | `delete`, `rm` | Move to Trash. |
| `archive <id> [-m box]` | | Move to Archive. |

For batch versions (operate on a list of IDs in one AppleScript call), see `Workflows/BulkOps.md`.

## Steps

1. Resolve the destination mailbox via unified path syntax (`i/...`, `g/...`, plain name) per `References/MultiAccount.md`.
2. Run the command. Output is one-line confirmation per success or a self-explanatory error.
3. For destructive operations (`trash`, `move`), no dry-run flag is exposed at this single-email level; the caller is responsible for confirming the right ID first via `read <id>` if uncertain.

## Examples

```
apple-mail.sh flag 79132
apple-mail.sh mark-read 79132 -m drafts
apple-mail.sh move 79132 "i/Receipts"
apple-mail.sh trash 79132
apple-mail.sh archive 79132
```
