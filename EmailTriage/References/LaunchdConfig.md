# Reference: launchd Configuration

EmailTriage uses launchd for two purposes: per-send scheduled emails (one-shot plists, generated on the fly by `Tools/SendLater.ts`), and a recurring catchup agent (`com.pai.send-later.plist.template`).

## File locations

| File | Purpose |
|---|---|
| `<skill-root>/com.pai.send-later.plist.template` | Recurring catchup template (source-controlled, placeholder paths) |
| `~/Library/LaunchAgents/com.pai.send-later.plist` | Materialized recurring agent (gitignored, machine-specific paths) |
| `<skill-root>/scheduled/<send-id>.json` | Pending send package |
| `<skill-root>/scheduled/<send-id>.plist` | One-shot per-send plist (auto-removed after success) |
| `<skill-root>/scheduled/sent/<send-id>.json` | Completed send package |
| `<skill-root>/scheduled/<send-id>.failed.json` | Failed after 3 retries |
| `<skill-root>/send-dispatcher.sh` | Zero-dependency send agent invoked by launchd |

## Recurring catchup agent

Template:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.pai.send-later</string>
  <key>ProgramArguments</key>
  <array>
    <string>__BUN_BIN__</string>
    <string>run</string>
    <string>__SKILL_DIR__/Tools/SendLater.ts</string>
  </array>
  <key>StartInterval</key>
  <integer>21600</integer>
  <key>StandardOutPath</key><string>/tmp/send-later.log</string>
  <key>StandardErrorPath</key><string>/tmp/send-later.log</string>
</dict>
</plist>
```

Replace placeholders:
- `__BUN_BIN__` → output of `which bun` (typically `~/.bun/bin/bun`).
- `__SKILL_DIR__` → `~/.claude/skills/EmailTriage` (or your install path).

`StartInterval` 21600 = every 6 hours. Adjust if needed.

Install / remove: see `Workflows/Setup.md`.

## Per-send one-shot plists

`Tools/SendLater.ts::createSendPackage()` generates a plist per send like:

```xml
<plist version="1.0">
<dict>
  <key>Label</key><string>com.pai.send-later.<send-id></string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string><skill-root>/send-dispatcher.sh</string>
    <string><skill-root>/scheduled/<send-id>.json</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Year</key><integer>...</integer>
    <key>Month</key><integer>...</integer>
    <key>Day</key><integer>...</integer>
    <key>Hour</key><integer>...</integer>
    <key>Minute</key><integer>...</integer>
  </dict>
  <key>RunAtLoad</key><false/>
</dict>
</plist>
```

Loaded with `launchctl bootstrap "gui/$(id -u)" <plist>` and removed with `launchctl bootout`.

## Why launchd vs cron / Bun timer

- **Resilience to sleep** — launchd queues missed runs and fires on wake.
- **No long-running process** — the dispatcher exits after sending. Nothing in memory between sends.
- **OS-native** — survives reboots, no PID file, no supervisor.
- **Zero deps at send time** — bash + osascript only. No Bun, Node, or Claude Code needed at launch.

## Verifying

```bash
plutil -lint ~/.claude/skills/EmailTriage/com.pai.send-later.plist.template

launchctl list | grep send-later

# Tail the log
tail -f /tmp/send-later.log
tail -f ~/.claude/skills/EmailTriage/scheduled/send-dispatcher.log
```

## Common failures

| Symptom | Cause | Fix |
|---|---|---|
| `Bootstrap failed: 5: Input/output error` | plist syntax error | `plutil -lint` to validate |
| `Service exited with abnormal code: 1` (immediately) | Bad `__BUN_BIN__` or `__SKILL_DIR__` substitution | Re-materialize plist, verify paths exist |
| Send fired but no email arrived | AppleMail send failed silently | Check `scheduled/send-dispatcher.log` for AppleScript errors |
| Recurring agent missed sends | `StartInterval` too long for sleep recovery | Reduce to 3600 (1 hr) if Mac sleeps frequently |
