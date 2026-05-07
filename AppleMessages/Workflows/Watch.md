# Workflow: Watch

Real-time tail of incoming iMessages. Cursor-based; survives restarts.

## First-run setup

```bash
# Initialize cursor at current state (skip backlog)
apple-messages.sh reset-cursor
```

This writes the latest ROWID to `~/.claude/PAI/MEMORY/AppleMessages/cursor.txt`.

## Tail mode

```bash
# Default: poll every 3s
apple-messages.sh watch

# Custom interval
apple-messages.sh watch --interval 5

# With a callback that fires per new message
apple-messages.sh watch --callback "/path/to/handler.sh"
```

The callback receives positional args: `<rowid> <handle> <chat_id> <text>`. Stdout / stderr of the callback are discarded; the callback failure does not stop the watch loop.

## Cursor semantics

- Only INCOMING messages (`is_from_me = 0`) with non-empty text are surfaced.
- Cursor is advanced after each batch and persisted atomically (`cursor.txt.tmp` + rename).
- Reset with `apple-messages.sh reset-cursor` (skips all current backlog).
- Inspect with `apple-messages.sh health`.

## Manual incremental fetch (no daemon)

```bash
# Get cursor
cursor=$(cat ~/.claude/PAI/MEMORY/AppleMessages/cursor.txt)

# Fetch new since cursor
apple-messages.sh new-since "$cursor"

# Update cursor manually
echo "<new_max_rowid>" > ~/.claude/PAI/MEMORY/AppleMessages/cursor.txt
```

## Why this exists

Carries over the cursor + atomic-persistence pattern from the prior PAI Pulse iMessage module (`PULSE/lib/messages-db.ts` + `modules/imessage.ts` cursor persistence). Without a watch loop, you'd have to poll manually each turn.
