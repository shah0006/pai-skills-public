# Workflow: Read

How to query message history from `chat.db`.

## Quick lookups

| Goal | Command |
|---|---|
| Last 20 messages, any direction | `apple-messages.sh list 20` |
| Only unread incoming | `apple-messages.sh list 20 --unread` |
| Conversation with one contact (last 30, oldest-first) | `apple-messages.sh read "+13125551234" 30` |
| Search for a phrase | `apple-messages.sh search "subject phrase"` |
| Search within one contact | `apple-messages.sh search "phrase" --from "+13125551234"` |
| Total unread count | `apple-messages.sh unread` |
| Recent contacts | `apple-messages.sh handles` |
| Recent chats (incl. group) | `apple-messages.sh chats` |
| Read a specific group chat | `apple-messages.sh chat-read <chat-identifier>` |
| Volume stats (top 15 partners) | `apple-messages.sh stats 15` |
| Last seen for a contact | `apple-messages.sh last-seen "+13125551234"` |

## Output schema

Tab-separated rows:

```
rowid \t direction \t YYYY-MM-DD HH:MM:SS \t handle \t text
```

`direction` is `OUT` (sent by user) or `IN ` (received). For chat threads from `new-since` and `watch`, a 6th column `chat_id` is appended.

## Tips

- Use `read <handle>` not `list --from` when you want chronological full-conversation view.
- For SQL-like ad-hoc queries on the schema, see `References/ChatDbSchema.md`.
- `chat.db` access is read-only; the skill never writes to it. The `mark-read` command is best-effort and will warn.
