#!/bin/bash
# send-dispatcher.sh -- Standalone send agent for launchd-scheduled emails
# Zero dependencies: no database, no Bun/Node, no Claude Code.
# Usage: send-dispatcher.sh /path/to/send-XXXX.json
# Called by launchd at the scheduled time. Self-cleans after success.

set -euo pipefail

APPLE_MAIL="$HOME/.claude/skills/AppleMail/Tools/apple-mail.sh"
LOG="$HOME/.claude/skills/EmailTriage/scheduled/send-dispatcher.log"
MAX_RETRIES=3

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"; }

JSON_PATH="${1:-}"
if [[ -z "$JSON_PATH" || ! -f "$JSON_PATH" ]]; then
  log "ERROR: JSON file not found: $JSON_PATH"
  exit 1
fi

SEND_DIR="$(dirname "$JSON_PATH")"
SENT_DIR="$SEND_DIR/sent"
BASENAME="$(basename "$JSON_PATH" .json)"

# Parse JSON with python3 (always available on macOS)
# Uses sys.argv[2] for key name to avoid shell injection via field values
parse() { python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(d.get(sys.argv[2],''))" "$JSON_PATH" "$1"; }

RECIPIENT="$(parse recipient)"
SUBJECT="$(parse subject)"
BODY="$(parse body)"
ACCOUNT="$(parse account)"
PLIST_LABEL="$(parse plistLabel)"

# Validate plist label contains only safe characters (alphanumeric, dots, hyphens)
if [[ -n "$PLIST_LABEL" && ! "$PLIST_LABEL" =~ ^[a-zA-Z0-9._-]+$ ]]; then
  log "ERROR: Invalid plist label: $PLIST_LABEL"
  exit 1
fi

if [[ -z "$RECIPIENT" || -z "$SUBJECT" || -z "$BODY" ]]; then
  log "ERROR: Missing required fields in $JSON_PATH"
  exit 1
fi

log "Sending to $RECIPIENT: $SUBJECT"

# Attempt send with retries
SENT=false
for i in $(seq 1 $MAX_RETRIES); do
  if bash "$APPLE_MAIL" send --to "$RECIPIENT" --subject "$SUBJECT" --body "$BODY" --account "$ACCOUNT" 2>>"$LOG"; then
    SENT=true
    break
  fi
  log "Retry $i/$MAX_RETRIES failed for $RECIPIENT"
  sleep 5
done

if $SENT; then
  log "SUCCESS: Sent to $RECIPIENT"
  # Move JSON to sent/
  mkdir -p "$SENT_DIR"
  mv "$JSON_PATH" "$SENT_DIR/$BASENAME.json"
  # Self-clean: unload and remove launchd plist
  if [[ -n "$PLIST_LABEL" ]]; then
    PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"
    if [[ -f "$PLIST_PATH" ]]; then
      launchctl unload "$PLIST_PATH" 2>/dev/null || true
      rm -f "$PLIST_PATH"
      log "Cleaned up plist: $PLIST_LABEL"
    fi
  fi
else
  log "FAILED: All $MAX_RETRIES retries exhausted for $RECIPIENT"
  # Rename to .failed.json for attention
  mv "$JSON_PATH" "$SEND_DIR/$BASENAME.failed.json"
  # Clean up plist even on failure (no point re-triggering a broken send)
  if [[ -n "$PLIST_LABEL" ]]; then
    PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"
    if [[ -f "$PLIST_PATH" ]]; then
      launchctl unload "$PLIST_PATH" 2>/dev/null || true
      rm -f "$PLIST_PATH"
      log "Cleaned up plist after failure: $PLIST_LABEL"
    fi
  fi
fi
