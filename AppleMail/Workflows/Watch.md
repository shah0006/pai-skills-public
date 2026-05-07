# Workflow: Watch

Run a launchd-scheduled monitor that alerts on new mail, with VIP priority handling.

## Commands

| Command | Purpose |
|---------|---------|
| `watch start` | Start launchd monitoring (every 2 minutes). |
| `watch stop` | Stop monitoring. |
| `watch status` | Show status, last check time, unread and VIP counts. |
| `watch check` | Manual check now (one-shot). |
| `watch log [N]` | Show the last N lines of the log (default 30). |
| `watch vip` | Display the current VIP sender list. |
| `watch vip-add <sender>` | Add a VIP sender (case-insensitive partial match). |

## VIP list location

The VIP list lives in the user's customization area:
`${PAI_DIR:-$HOME/.claude/PAI}/USER/SKILLCUSTOMIZATIONS/AppleMail/watch-vip.txt`.

`Tools/WatchCheck.sh` falls back to the legacy in-skill location during the v5-refactor verification window. Edit the file directly (one name or email fragment per line; `#` for comments) and the next launchd tick picks it up.

The launchd plist for `watch start` references `Tools/WatchCheck.sh` after Phase 1; if you ran `watch start` before the refactor, run `watch stop` then `watch start` once to regenerate the plist with the new path.

## Logs

Log file: `~/.cache/apple-mail-watch/watch.log` (one line per check, plus VIP and new-mail entries).

## Voice notification

VIP arrivals trigger a voice notification through Pulse on `localhost:31337`; this is not blocking — if Pulse is offline the watch still files a desktop notification via macOS `osascript`.

## Examples

```
apple-mail.sh watch start
apple-mail.sh watch status
apple-mail.sh watch check
apple-mail.sh watch log 50
apple-mail.sh watch vip
apple-mail.sh watch vip-add "rob.koscik"
```
