# References: Messages.app AppleScript

How the skill drives Messages.app for outgoing messages.

## Why AppleScript and not `osascript -e "send to chat..."` directly?

Two reasons: (1) macOS Sonoma/Sequoia changed buddy-resolution semantics; the `participant ... of targetService` form is the most reliable; (2) we want a fallback chain so a single API change doesn't break the whole skill.

## Primary path: buddy-based send

```applescript
tell application "Messages"
  set targetService to 1st account whose service type = iMessage
  set targetBuddy to participant "+13125551234" of targetService
  send "Hello world" to targetBuddy
end tell
```

The skill builds this script with shell-escaped handle and text, then runs `osascript -e "<script>"`. Returns 0 on success.

## Fallback: chat-id form

If the primary fails (buddy not found, service unreachable):

```applescript
tell application "Messages"
  send "Hello world" to chat id "iMessage;-;+13125551234"
end tell
```

The chat-id form `iMessage;-;<handle>` is what Messages.app uses internally to route 1-on-1 chats. For group chats, use the actual `chat_identifier` from `chat.db` (e.g. `chat123456789`).

## Image attachments

```applescript
tell application "Messages"
  set targetService to 1st account whose service type = iMessage
  set targetBuddy to participant "+13125551234" of targetService
  send (POSIX file "/absolute/path/to/image.png") to targetBuddy
end tell
```

Path must be absolute (the skill resolves with `cd $(dirname ...) && pwd`).

## Group chat send

```applescript
tell application "Messages"
  send "Hello group" to chat id "chat123456789"
end tell
```

Use `apple-messages.sh chats` to enumerate `chat_identifier` values.

## Escaping

Backslashes and double-quotes must be escaped in AppleScript string literals:

```bash
echo 'He said "hi"' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
# He said \"hi\"
```

The skill's `escape_applescript` helper does this automatically.

## Permissions

First call to `tell application "Messages"` triggers a TCC prompt asking your terminal app to control Messages.app. Click OK. After that, the permission persists in System Settings → Privacy & Security → Automation. Revoking and re-granting takes a few seconds.

## Diagnostics

```bash
# Verify Automation permission
osascript -e 'tell application "Messages" to return name'
# → "Messages" if granted, AppleScript error if not.
```

The skill's `doctor` command runs this exact check.

## Limits & quirks

- iMessage has no documented hard message-length limit, but very long messages (>10k chars) sometimes get rejected silently. The skill chunks at 8000 chars with newline/space-aware splitting and 500ms inter-chunk delay.
- `participant "<handle>" of <service>` requires the handle to be exactly as Messages.app stores it (E.164 format like `+13125551234` works; some older entries use `(312) 555-1234` — convert before sending).
- The `send` AppleScript verb returns immediately; delivery is async. There's no synchronous "delivered" confirmation in AppleScript. To detect a "Not Delivered" status, you must poll `chat.db` for the resulting message and check `error` column on the message row.
