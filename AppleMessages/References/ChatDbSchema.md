# References: chat.db schema

`~/Library/Messages/chat.db` is a SQLite database. The skill reads it via `sqlite3` (CLI) — no `bun:sqlite` dependency.

## Key tables

### `message`
- `ROWID` — primary key, monotonically increasing
- `text` — message body (NULL for some system messages)
- `date` — nanoseconds since 2001-01-01 UTC (Apple epoch)
- `is_from_me` — 1 if sent by user, 0 if received
- `is_read` — read state (sender side; only meaningful for `is_from_me=0`)
- `handle_id` — FK to `handle.ROWID`
- `service` — "iMessage" or "SMS"

### `handle`
- `ROWID` — primary key
- `id` — phone number (e.g. `+13125551234`) or email (Apple ID)
- `service` — "iMessage" or "SMS"
- `country` — country code

### `chat`
- `ROWID` — primary key
- `chat_identifier` — group chat ID (e.g. `chat123456789`) or 1-on-1 handle
- `display_name` — group name (NULL for 1-on-1)
- `is_archived`, `style` — flags

### Join tables
- `chat_message_join(chat_id, message_id)` — message-to-chat
- `chat_handle_join(chat_id, handle_id)` — chat membership

### `attachment`
- `ROWID` — primary key
- `filename` — POSIX path with `~` for home (e.g. `~/Library/Messages/Attachments/.../file.pdf`)
- `mime_type` — MIME (e.g. `image/png`, `application/pdf`)
- `total_bytes` — file size
- `created_date` — Apple-epoch nanoseconds

### `message_attachment_join(message_id, attachment_id)` — message-to-attachment

## Apple epoch conversion

```
unix_seconds = apple_nanoseconds / 1_000_000_000 + 978_307_200
```

Where 978307200 = seconds between 1970-01-01 UTC and 2001-01-01 UTC.

The skill's `apple_ts_to_iso` helper does this and formats with `date -r`.

## Common queries

### Recent messages

```sql
SELECT m.ROWID, m.is_from_me, m.date, h.id, m.text
FROM message m
LEFT JOIN handle h ON m.handle_id = h.ROWID
WHERE m.text IS NOT NULL AND m.text != ''
ORDER BY m.ROWID DESC
LIMIT 20;
```

### Conversation with one handle

```sql
SELECT m.ROWID, m.is_from_me, m.date, m.text
FROM message m
LEFT JOIN handle h ON m.handle_id = h.ROWID
WHERE h.id = '+13125551234'
  AND m.text IS NOT NULL AND m.text != ''
ORDER BY m.ROWID DESC
LIMIT 30;
```

### Group chat membership

```sql
SELECT h.id
FROM chat_handle_join chj
JOIN handle h ON h.ROWID = chj.handle_id
JOIN chat c ON c.ROWID = chj.chat_id
WHERE c.chat_identifier = 'chat123456789';
```

### Attachments per message

```sql
SELECT a.filename, a.mime_type, a.total_bytes
FROM attachment a
JOIN message_attachment_join maj ON maj.attachment_id = a.ROWID
WHERE maj.message_id = <rowid>;
```

## Read-only

`chat.db` is owned by `com.apple.security` TCC and behaves read-only via Full Disk Access. SQL `UPDATE` will fail. The skill's `mark-read` accordingly warns and exits non-zero.
