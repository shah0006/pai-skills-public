# Workflow: Setup

First-run permissions and verification. Run once after install.

## Prerequisites

1. **Full Disk Access** — for terminal to read `~/Library/Messages/chat.db`.
   - System Settings → Privacy & Security → Full Disk Access → toggle ON for your terminal app (Terminal.app, iTerm, Ghostty, etc.).
   - macOS will surface a TCC prompt the first time you query chat.db — clicking Allow grants this. If you click Don't Allow, grant manually as above.
2. **Automation permission** — for `osascript` to control Messages.app.
   - System Settings → Privacy & Security → Automation → expand your terminal app → toggle ON for "Messages".
   - First `send` will trigger a TCC prompt; click OK.

## Verification

```bash
~/.claude/skills/AppleMessages/Tools/apple-messages.sh doctor
```

Expected output:

```
=== chat.db readable? ===
✅ /Users/<you>/Library/Messages/chat.db
   latest ROWID: <some integer>

=== Messages.app accessible? ===
✅ Automation permission granted

=== State dir ===
  /Users/<you>/.claude/PAI/MEMORY/AppleMessages
  cursor: <integer or "(not initialized — run `reset-cursor` or `watch` to initialize)">
```

If either check is ❌, follow the on-screen instruction to grant the permission, then re-run `doctor`.

## Optional: Test send

Send a quick test to your own mobile to confirm the AppleScript path is wired:

```bash
~/.claude/skills/AppleMessages/Tools/apple-messages.sh send "+1<your-mobile>" "AppleMessages skill test — if you see this, the send path is working."
```

## State directory

`~/.claude/PAI/MEMORY/AppleMessages/` holds:

- `cursor.txt` — single integer (latest ROWID processed by `watch`)

Initialize with `reset-cursor` (skips backlog) or just run `watch` once and Ctrl-C.

## Customization

If you want different defaults (export folder, draft folder, recipient allow-list), create:

`~/.claude/PAI/USER/SKILLCUSTOMIZATIONS/AppleMessages/PREFERENCES.md`

The skill reads this on every invocation and overrides defaults.
