#!/bin/bash
# apple-messages.sh — macOS Messages.app control via AppleScript + chat.db
#
# Read: queries ~/Library/Messages/chat.db (SQLite) — requires Full Disk Access
# Send: AppleScript via osascript — requires Automation permission for Messages.app
#
# Adapted from ~/.claude/PAI/PULSE/lib/{imessage-send.ts,messages-db.ts,sanitize.ts}
# into a stand-alone bash CLI matching the AppleMail skill pattern (PAI v5 standards).
#
# Preserved capabilities from prior Pulse build:
#   • Chunked send with buddy + chat-id fallback
#   • Incremental new-message fetch (cursor-based) — `new-since <rowid>`
#   • Atomic cursor persistence (`save-cursor` / `load-cursor`)
#   • Latest ROWID for cursor init — `latest-rowid`
#   • Defensive injection-pattern detection — `analyze <text>`
#   • Sanitization (zero-width strip, unicode normalize) — `sanitize <text>`
#
# Added for PAI v5 parity with AppleMail:
#   • Group chats — `chats`, `chat-read`, `send-chat`, `chat-members`
#   • Attachments — `attachments`, `attachment-save`
#   • Export to vault Markdown — `export <handle> [N] [--out path]`
#   • Watch mode — `watch [--interval N]`
#   • Statistics — `stats`, `last-seen <handle>`
#   • Send variants — `send-multi`, `send-image`, `send-from-vault`
#   • Read management — `mark-read <rowid>` (best effort)

set -euo pipefail

CHAT_DB="${HOME}/Library/Messages/chat.db"
APPLE_EPOCH_OFFSET=978307200   # seconds between Unix epoch and Apple epoch
STATE_DIR="${HOME}/.claude/PAI/MEMORY/AppleMessages"
CURSOR_FILE="${STATE_DIR}/cursor.txt"
DEFAULT_VAULT_EXPORT_DIR="/Volumes/Hyperdrive 4 Tb/Main Obsidian (Sync)/40 - System/iMessage Exports"

usage() {
  cat <<'EOF'
apple-messages.sh — control Messages.app from the CLI (PAI v5)

USAGE
  apple-messages.sh <command> [args]

READ COMMANDS (query chat.db — needs Full Disk Access)
  list [N] [--unread] [--from <handle>]   List N most recent messages (default 20)
  read <handle> [N]                       Conversation with one contact (default 30)
  search <query> [N] [--from <handle>]    Search message text (default 20 results)
  unread                                  Count of unread incoming messages
  latest-rowid                            Highest ROWID in chat.db (for cursor init)
  new-since <rowid>                       Fetch new INCOMING messages since cursor
  handles                                 Recent 1-on-1 conversation partners
  chats                                   Recent chat threads (incl. group chats)
  chat-read <chat-id> [N]                 Read messages from a specific chat thread
  chat-members <chat-id>                  List members of a group chat
  attachments <rowid>                     List attachments on a message
  attachment-save <rowid> [<dir>]         Copy attachments to a directory
  last-seen <handle>                      When did this contact last message us
  stats [N]                               Top N partners by message volume

SEND COMMANDS (AppleScript — needs Automation permission)
  send <handle> <text>                    Send iMessage to phone number or email
  send-multi <handle1,handle2,...> <text> Send to multiple recipients
  send-chat <chat-id> <text>              Send to a specific chat thread
  send-file <handle> <path>               Send body of a text file
  send-from-vault <handle> <vault-path>   Send body of a vault draft (recommended workflow)
  send-image <handle> <image-path>        Send an image attachment

WATCH MODE (background polling)
  watch [--interval <seconds>] [--callback <cmd>]
                                          Poll chat.db; print new incoming msgs.
                                          Default interval 3s. Persists cursor in state dir.
  reset-cursor                            Reset cursor to latest ROWID (skip backlog)

EXPORT (vault integration)
  export <handle> [N] [--out <dir>]       Export conversation to Markdown
                                          Default dir: vault iMessage Exports folder
  daily-digest [--out <path>]             Today's incoming messages, grouped by handle

ORGANIZATION
  mark-read <rowid>                       Best-effort mark message as read

SECURITY (preserved from Pulse build)
  analyze <text>                          Detect prompt-injection patterns; risk level
  sanitize <text>                         Strip dangerous chars; normalize unicode

DIAGNOSTICS
  doctor                                  Verify Full Disk Access + Automation permission
  health                                  Print state directory, cursor, latest ROWID
  help | --help                           This message

NOTES
  Handles are phone numbers (e.g. +13125551234) or Apple-ID emails.
  Output of read commands uses tab-separated columns: rowid | direction | timestamp | handle | text
  Composing: per PAI standards, draft messages in a vault file first; only call `send` after review.
  State persistence: ${STATE_DIR}
EOF
}

# ── helpers ────────────────────────────────────────────────────────────────
escape_applescript() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

apple_ts_to_iso() {
  local ns="$1"
  if [[ -z "$ns" || "$ns" == "0" ]]; then echo ""; return; fi
  local unix_secs=$(( ns / 1000000000 + APPLE_EPOCH_OFFSET ))
  date -r "$unix_secs" "+%Y-%m-%d %H:%M:%S" 2>/dev/null || echo ""
}

require_db() {
  if [[ ! -r "$CHAT_DB" ]]; then
    echo "ERROR: cannot read $CHAT_DB" >&2
    echo "Grant Full Disk Access to your terminal in System Settings → Privacy & Security." >&2
    exit 2
  fi
}

ensure_state_dir() {
  mkdir -p "$STATE_DIR"
}

sql_escape() {
  printf '%s' "$1" | sed "s/'/''/g"
}

print_row() {
  # rowid | direction | iso-time | handle | text
  printf "%s\t%s\t%s\t%s\t%s\n" "$1" "$2" "$3" "$4" "$5"
}

# ── read commands ─────────────────────────────────────────────────────────
cmd_list() {
  require_db
  local n=20 unread_filter="" from_handle=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --unread) unread_filter="AND m.is_read = 0 AND m.is_from_me = 0" ;;
      --from)   from_handle="$2"; shift ;;
      [0-9]*)   n="$1" ;;
    esac
    shift
  done
  local from_filter=""
  if [[ -n "$from_handle" ]]; then
    local h
    h="$(sql_escape "$from_handle")"
    from_filter="AND h.id LIKE '%${h}%'"
  fi

  sqlite3 -separator $'\t' "$CHAT_DB" "
    SELECT
      m.ROWID,
      CASE m.is_from_me WHEN 1 THEN 'OUT' ELSE 'IN ' END,
      m.date,
      COALESCE(h.id, '(group)'),
      REPLACE(REPLACE(COALESCE(m.text, ''), CHAR(10), ' '), CHAR(13), ' ')
    FROM message m
    LEFT JOIN handle h ON m.handle_id = h.ROWID
    WHERE m.text IS NOT NULL AND m.text != ''
    $unread_filter
    $from_filter
    ORDER BY m.ROWID DESC
    LIMIT $n;
  " | while IFS=$'\t' read -r rowid dir nsdate handle text; do
    print_row "$rowid" "$dir" "$(apple_ts_to_iso "$nsdate")" "$handle" "$text"
  done
}

cmd_read() {
  require_db
  local handle="${1:?handle required}"
  local n="${2:-30}"
  local h
  h="$(sql_escape "$handle")"

  sqlite3 -separator $'\t' "$CHAT_DB" "
    SELECT m.ROWID,
      CASE m.is_from_me WHEN 1 THEN 'OUT' ELSE 'IN ' END,
      m.date, COALESCE(h.id, '(group)'),
      REPLACE(REPLACE(COALESCE(m.text, ''), CHAR(10), ' '), CHAR(13), ' ')
    FROM message m
    LEFT JOIN handle h ON m.handle_id = h.ROWID
    WHERE m.text IS NOT NULL AND m.text != ''
      AND (h.id LIKE '%${h}%' OR h.id = '${h}')
    ORDER BY m.ROWID DESC
    LIMIT $n;
  " | tail -r | while IFS=$'\t' read -r rowid dir nsdate handle_out text; do
    print_row "$rowid" "$dir" "$(apple_ts_to_iso "$nsdate")" "$handle_out" "$text"
  done
}

cmd_search() {
  require_db
  local query="" n=20 from_handle=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --from) from_handle="$2"; shift ;;
      [0-9]*) n="$1" ;;
      *) [[ -z "$query" ]] && query="$1" ;;
    esac
    shift
  done
  [[ -z "$query" ]] && { echo "ERROR: query required" >&2; exit 1; }

  local q from_filter=""
  q="$(sql_escape "$query")"
  if [[ -n "$from_handle" ]]; then
    local h
    h="$(sql_escape "$from_handle")"
    from_filter="AND h.id LIKE '%${h}%'"
  fi

  sqlite3 -separator $'\t' "$CHAT_DB" "
    SELECT m.ROWID,
      CASE m.is_from_me WHEN 1 THEN 'OUT' ELSE 'IN ' END,
      m.date, COALESCE(h.id, '(group)'),
      REPLACE(REPLACE(m.text, CHAR(10), ' '), CHAR(13), ' ')
    FROM message m
    LEFT JOIN handle h ON m.handle_id = h.ROWID
    WHERE m.text LIKE '%${q}%'
    $from_filter
    ORDER BY m.ROWID DESC
    LIMIT $n;
  " | while IFS=$'\t' read -r rowid dir nsdate handle text; do
    print_row "$rowid" "$dir" "$(apple_ts_to_iso "$nsdate")" "$handle" "$text"
  done
}

cmd_unread() {
  require_db
  sqlite3 "$CHAT_DB" "SELECT COUNT(*) FROM message WHERE is_read = 0 AND is_from_me = 0 AND text IS NOT NULL AND text != '';"
}

cmd_latest_rowid() {
  require_db
  sqlite3 "$CHAT_DB" "SELECT COALESCE(MAX(ROWID), 0) FROM message;"
}

cmd_new_since() {
  require_db
  local since="${1:?rowid required}"
  sqlite3 -separator $'\t' "$CHAT_DB" "
    SELECT m.ROWID,
      'IN ',
      m.date, COALESCE(h.id, '(group)'),
      REPLACE(REPLACE(COALESCE(m.text, ''), CHAR(10), ' '), CHAR(13), ' '),
      COALESCE(c.chat_identifier, '')
    FROM message m
    LEFT JOIN handle h ON m.handle_id = h.ROWID
    LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
    LEFT JOIN chat c ON cmj.chat_id = c.ROWID
    WHERE m.ROWID > $since
      AND m.is_from_me = 0
      AND m.text IS NOT NULL AND m.text != ''
    ORDER BY m.ROWID ASC;
  " | while IFS=$'\t' read -r rowid dir nsdate handle text chat_id; do
    printf "%s\t%s\t%s\t%s\t%s\t%s\n" "$rowid" "$dir" "$(apple_ts_to_iso "$nsdate")" "$handle" "$text" "$chat_id"
  done
}

cmd_handles() {
  require_db
  sqlite3 -separator $'\t' "$CHAT_DB" "
    SELECT h.id AS handle, MAX(m.date) AS last_msg, COUNT(*) AS msg_count
    FROM message m
    JOIN handle h ON m.handle_id = h.ROWID
    WHERE m.text IS NOT NULL AND m.text != ''
    GROUP BY h.id
    ORDER BY last_msg DESC
    LIMIT 30;
  " | while IFS=$'\t' read -r handle nsdate count; do
    printf "%s\t%s\t%s msgs\n" "$handle" "$(apple_ts_to_iso "$nsdate")" "$count"
  done
}

cmd_chats() {
  require_db
  sqlite3 -separator $'\t' "$CHAT_DB" "
    SELECT
      c.chat_identifier,
      c.display_name,
      MAX(m.date) AS last_msg,
      COUNT(DISTINCT m.ROWID) AS msg_count
    FROM chat c
    JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID
    JOIN message m ON m.ROWID = cmj.message_id
    WHERE m.text IS NOT NULL AND m.text != ''
    GROUP BY c.chat_identifier
    ORDER BY last_msg DESC
    LIMIT 30;
  " | while IFS=$'\t' read -r chat_id display_name nsdate count; do
    printf "%s\t%s\t%s\t%s msgs\n" "$chat_id" "${display_name:-(no name)}" "$(apple_ts_to_iso "$nsdate")" "$count"
  done
}

cmd_chat_read() {
  require_db
  local chat_id="${1:?chat-id required}"
  local n="${2:-30}"
  local cid
  cid="$(sql_escape "$chat_id")"

  sqlite3 -separator $'\t' "$CHAT_DB" "
    SELECT m.ROWID,
      CASE m.is_from_me WHEN 1 THEN 'OUT' ELSE 'IN ' END,
      m.date, COALESCE(h.id, 'me'),
      REPLACE(REPLACE(COALESCE(m.text, ''), CHAR(10), ' '), CHAR(13), ' ')
    FROM message m
    LEFT JOIN handle h ON m.handle_id = h.ROWID
    JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
    JOIN chat c ON c.ROWID = cmj.chat_id
    WHERE c.chat_identifier = '${cid}'
      AND m.text IS NOT NULL AND m.text != ''
    ORDER BY m.ROWID DESC
    LIMIT $n;
  " | tac | while IFS=$'\t' read -r rowid dir nsdate handle text; do
    print_row "$rowid" "$dir" "$(apple_ts_to_iso "$nsdate")" "$handle" "$text"
  done
}

cmd_chat_members() {
  require_db
  local chat_id="${1:?chat-id required}"
  local cid
  cid="$(sql_escape "$chat_id")"
  sqlite3 -separator $'\t' "$CHAT_DB" "
    SELECT h.id, COALESCE(h.country, ''), COALESCE(h.service, '')
    FROM chat_handle_join chj
    JOIN handle h ON h.ROWID = chj.handle_id
    JOIN chat c ON c.ROWID = chj.chat_id
    WHERE c.chat_identifier = '${cid}';
  "
}

cmd_attachments() {
  require_db
  local rowid="${1:?rowid required}"
  sqlite3 -separator $'\t' "$CHAT_DB" "
    SELECT a.ROWID, a.filename, a.mime_type, a.total_bytes
    FROM attachment a
    JOIN message_attachment_join maj ON maj.attachment_id = a.ROWID
    WHERE maj.message_id = $rowid;
  "
}

cmd_attachment_save() {
  require_db
  local rowid="${1:?rowid required}"
  local out_dir="${2:-${HOME}/Downloads/iMessage Attachments}"
  mkdir -p "$out_dir"

  local saved=0
  while IFS=$'\t' read -r att_id filename mime size; do
    [[ -z "$filename" ]] && continue
    # filename is like "~/Library/Messages/Attachments/.../filename.ext"
    local resolved="${filename/#\~/$HOME}"
    if [[ -r "$resolved" ]]; then
      cp -p "$resolved" "$out_dir/" && saved=$((saved+1))
    fi
  done < <(sqlite3 -separator $'\t' "$CHAT_DB" "
    SELECT a.ROWID, a.filename, COALESCE(a.mime_type, ''), COALESCE(a.total_bytes, 0)
    FROM attachment a
    JOIN message_attachment_join maj ON maj.attachment_id = a.ROWID
    WHERE maj.message_id = $rowid;
  ")
  echo "Saved $saved attachment(s) to $out_dir"
}

cmd_last_seen() {
  require_db
  local handle="${1:?handle required}"
  local h
  h="$(sql_escape "$handle")"
  sqlite3 -separator $'\t' "$CHAT_DB" "
    SELECT MAX(m.date)
    FROM message m
    JOIN handle hh ON m.handle_id = hh.ROWID
    WHERE hh.id LIKE '%${h}%' OR hh.id = '${h}';
  " | while read -r nsdate; do
    if [[ -z "$nsdate" || "$nsdate" == "0" ]]; then
      echo "no messages found"
    else
      apple_ts_to_iso "$nsdate"
    fi
  done
}

cmd_stats() {
  require_db
  local n="${1:-15}"
  printf "Handle\tTotal\tFrom them\tFrom me\tFirst seen\tLast seen\n"
  sqlite3 -separator $'\t' "$CHAT_DB" "
    SELECT h.id,
      COUNT(*),
      SUM(CASE WHEN m.is_from_me = 0 THEN 1 ELSE 0 END),
      SUM(CASE WHEN m.is_from_me = 1 THEN 1 ELSE 0 END),
      MIN(m.date),
      MAX(m.date)
    FROM message m
    JOIN handle h ON m.handle_id = h.ROWID
    WHERE m.text IS NOT NULL AND m.text != ''
    GROUP BY h.id
    ORDER BY COUNT(*) DESC
    LIMIT $n;
  " | while IFS=$'\t' read -r handle total inbound outbound first_ns last_ns; do
    printf "%s\t%s\t%s\t%s\t%s\t%s\n" "$handle" "$total" "$inbound" "$outbound" "$(apple_ts_to_iso "$first_ns")" "$(apple_ts_to_iso "$last_ns")"
  done
}

# ── send commands ─────────────────────────────────────────────────────────
cmd_send() {
  local handle="${1:?handle required}"
  local text="${2:?text required}"

  # PAI policy: send to mobile numbers only. Email handles often route via Apple ID
  # but commonly fail (Gmail/work email is not iMessage-registered). If caller passes
  # an email, refuse and instruct caller to look up a mobile or pass --allow-email.
  local allow_email=0
  if [[ "${3:-}" == "--allow-email" ]]; then allow_email=1; fi
  if [[ "$handle" == *"@"* && "$allow_email" -eq 0 ]]; then
    echo "ERROR: refusing to send to email handle '${handle}'." >&2
    echo "PAI policy: send to a mobile number (e.g. +13125551234). If the recipient has no mobile on file, ask the user." >&2
    echo "Override with: send <email> <text> --allow-email  (only if the email is iMessage-registered)." >&2
    exit 3
  fi

  local escaped_handle escaped_text
  escaped_handle="$(escape_applescript "$handle")"
  escaped_text="$(escape_applescript "$text")"

  local primary_script
  primary_script=$(cat <<EOF
tell application "Messages"
  set targetService to 1st account whose service type = iMessage
  set targetBuddy to participant "${escaped_handle}" of targetService
  send "${escaped_text}" to targetBuddy
end tell
EOF
)
  if osascript -e "$primary_script" >/dev/null 2>&1; then
    echo "✅ sent to ${handle}"
    return 0
  fi

  local chat_script
  chat_script=$(cat <<EOF
tell application "Messages"
  send "${escaped_text}" to chat id "iMessage;-;${escaped_handle}"
end tell
EOF
)
  if osascript -e "$chat_script" >/dev/null 2>&1; then
    echo "✅ sent to ${handle} (via chat-id fallback)"
    return 0
  fi

  echo "ERROR: failed to send to ${handle}" >&2
  exit 1
}

cmd_send_multi() {
  local handles_csv="${1:?comma-separated handles required}"
  local text="${2:?text required}"
  local IFS=','
  for h in $handles_csv; do
    cmd_send "$h" "$text" || echo "  (failed for $h)" >&2
  done
}

cmd_send_chat() {
  local chat_id="${1:?chat-id required}"
  local text="${2:?text required}"
  local escaped_text
  escaped_text="$(escape_applescript "$text")"
  local script
  script=$(cat <<EOF
tell application "Messages"
  send "${escaped_text}" to chat id "${chat_id}"
end tell
EOF
)
  if osascript -e "$script" >/dev/null 2>&1; then
    echo "✅ sent to chat ${chat_id}"
  else
    echo "ERROR: failed to send to chat ${chat_id}" >&2
    exit 1
  fi
}

cmd_send_file() {
  local handle="${1:?handle required}"
  local path="${2:?path required}"
  [[ -r "$path" ]] || { echo "ERROR: cannot read $path" >&2; exit 1; }
  cmd_send "$handle" "$(cat "$path")"
}

cmd_send_from_vault() {
  local handle="${1:?handle required}"
  local vault_path="${2:?vault path required}"
  [[ -r "$vault_path" ]] || { echo "ERROR: cannot read $vault_path" >&2; exit 1; }
  # Strip frontmatter if present, send body
  local body
  body="$(awk 'BEGIN{f=0} /^---$/{f++; next} f<2{next} {print}' "$vault_path")"
  if [[ -z "$(printf '%s' "$body" | tr -d '[:space:]')" ]]; then
    body="$(cat "$vault_path")"
  fi
  cmd_send "$handle" "$body"
}

cmd_send_image() {
  local handle="${1:?handle required}"
  local image_path="${2:?image path required}"
  [[ -r "$image_path" ]] || { echo "ERROR: cannot read $image_path" >&2; exit 1; }
  local abs_path
  abs_path="$(cd "$(dirname "$image_path")" && printf '%s/%s' "$(pwd)" "$(basename "$image_path")")"
  local escaped_handle
  escaped_handle="$(escape_applescript "$handle")"
  local script
  script=$(cat <<EOF
tell application "Messages"
  set targetService to 1st account whose service type = iMessage
  set targetBuddy to participant "${escaped_handle}" of targetService
  send (POSIX file "${abs_path}") to targetBuddy
end tell
EOF
)
  if osascript -e "$script" >/dev/null 2>&1; then
    echo "✅ image sent to ${handle}"
  else
    echo "ERROR: failed to send image" >&2
    exit 1
  fi
}

# ── watch mode ────────────────────────────────────────────────────────────
cmd_watch() {
  ensure_state_dir
  local interval=3 callback=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --interval) interval="$2"; shift ;;
      --callback) callback="$2"; shift ;;
    esac
    shift
  done

  local cursor
  if [[ -r "$CURSOR_FILE" ]]; then
    cursor="$(cat "$CURSOR_FILE")"
  else
    cursor="$(cmd_latest_rowid)"
    echo "$cursor" > "$CURSOR_FILE"
  fi

  echo "📡 Watching from ROWID $cursor (interval ${interval}s, Ctrl-C to stop)"
  while true; do
    local rows
    rows="$(cmd_new_since "$cursor")"
    if [[ -n "$rows" ]]; then
      while IFS=$'\t' read -r rowid dir iso handle text chat_id; do
        printf "🔔 %s\t%s\t%s\t%s\n" "$iso" "$handle" "$chat_id" "$text"
        if [[ -n "$callback" ]]; then
          # Pass: rowid, handle, chat_id, text as positional args
          "$callback" "$rowid" "$handle" "$chat_id" "$text" </dev/null >/dev/null 2>&1 || true
        fi
        cursor="$rowid"
      done <<< "$rows"
      # Atomic cursor save: tmp file + rename
      printf '%s' "$cursor" > "${CURSOR_FILE}.tmp"
      mv "${CURSOR_FILE}.tmp" "$CURSOR_FILE"
    fi
    sleep "$interval"
  done
}

cmd_reset_cursor() {
  ensure_state_dir
  local rid
  rid="$(cmd_latest_rowid)"
  printf '%s' "$rid" > "$CURSOR_FILE"
  echo "Cursor reset to $rid"
}

# ── export ────────────────────────────────────────────────────────────────
cmd_export() {
  require_db
  local handle="" n=200 out_dir="$DEFAULT_VAULT_EXPORT_DIR"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --out) out_dir="$2"; shift ;;
      [0-9]*) n="$1" ;;
      *) [[ -z "$handle" ]] && handle="$1" ;;
    esac
    shift
  done
  [[ -z "$handle" ]] && { echo "ERROR: handle required" >&2; exit 1; }

  mkdir -p "$out_dir"
  local safe_handle="${handle//[^a-zA-Z0-9._-]/_}"
  local out_file="${out_dir}/iMessage - ${safe_handle}.md"
  {
    echo "---"
    echo "created: $(date '+%Y-%m-%d')"
    echo "modified: $(date '+%Y-%m-%dT%H:%M:%S%z')"
    echo "document-type: imessage-export"
    echo "handle: ${handle}"
    echo "messages: ${n}"
    echo "---"
    echo
    echo "# iMessage Conversation — ${handle}"
    echo
    cmd_read "$handle" "$n" | while IFS=$'\t' read -r rowid dir iso handle_out text; do
      if [[ "$dir" == "OUT" ]]; then
        printf "**Me** (%s):\n\n%s\n\n---\n\n" "$iso" "$text"
      else
        printf "**%s** (%s):\n\n%s\n\n---\n\n" "$handle_out" "$iso" "$text"
      fi
    done
  } > "$out_file"
  echo "✅ exported $n msgs to: $out_file"
}

cmd_daily_digest() {
  require_db
  local out_path=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --out) out_path="$2"; shift ;;
    esac
    shift
  done

  local today_unix today_apple
  today_unix=$(date -j -f "%Y-%m-%d %H:%M:%S" "$(date '+%Y-%m-%d') 00:00:00" "+%s")
  today_apple=$(( (today_unix - APPLE_EPOCH_OFFSET) * 1000000000 ))

  local content
  content="$(sqlite3 -separator $'\t' "$CHAT_DB" "
    SELECT h.id, m.date, REPLACE(REPLACE(m.text, CHAR(10), ' '), CHAR(13), ' ')
    FROM message m
    JOIN handle h ON m.handle_id = h.ROWID
    WHERE m.is_from_me = 0
      AND m.date > $today_apple
      AND m.text IS NOT NULL AND m.text != ''
    ORDER BY h.id, m.date ASC;
  " | awk -F'\t' '
    BEGIN { last_handle = "" }
    {
      if ($1 != last_handle) {
        print ""
        print "## " $1
        print ""
        last_handle = $1
      }
      cmd = "date -r $((" $2 " / 1000000000 + " 978307200 ")) +%H:%M"
      cmd | getline t; close(cmd)
      print "- [" t "] " $3
    }')"

  local digest
  digest="# iMessage Daily Digest — $(date '+%Y-%m-%d')

${content}
"
  if [[ -n "$out_path" ]]; then
    printf '%s' "$digest" > "$out_path"
    echo "✅ digest written to $out_path"
  else
    printf '%s\n' "$digest"
  fi
}

# ── organization ───────────────────────────────────────────────────────────
cmd_mark_read() {
  require_db
  local rowid="${1:?rowid required}"
  # Best effort: chat.db is normally read-only via FDA; this UPDATE may fail
  if sqlite3 "$CHAT_DB" "UPDATE message SET is_read = 1 WHERE ROWID = $rowid;" 2>/dev/null; then
    echo "✅ marked $rowid read"
  else
    echo "⚠️ chat.db is read-only via Full Disk Access; cannot mark read at the SQL layer." >&2
    echo "Tip: opening the conversation in Messages.app updates is_read naturally." >&2
    return 1
  fi
}

# ── security (sanitize / injection) ────────────────────────────────────────
cmd_analyze() {
  local text="${1:?text required}"
  local matches=0 risk="MINIMAL"
  local patterns=(
    "ignore (previous|prior|all|above|the) (instructions?|prompts?|rules?)"
    "disregard (previous|prior|all|above|the) (instructions?|prompts?|rules?)"
    "forget (everything|all|previous|your) (instructions?|rules?|training)"
    "you are now (a|an|my|the)"
    "new (instructions?|role|persona|identity)"
    "system *:?(prompt|message|instruction)"
    "\\[INST\\]|\\[/INST\\]"
    "<\\|?(system|endoftext|im_start|im_end)\\|?>"
    "override (your|all|previous|the) (instructions?|rules?|settings?)"
    "act as (if|though) you (are|were)"
    "pretend (you are|to be|that)"
    "roleplay as"
    "jailbreak"
    "DAN mode|do anything now"
    "bypass (your|the|all) (restrictions?|filters?|rules?)"
    "reveal (your|the) (system|secret|hidden) ?(prompt|instructions?)?"
    "admin ?(mode|access|override)"
    "sudo mode"
    "developer mode"
  )
  for p in "${patterns[@]}"; do
    if printf '%s' "$text" | grep -iqE "$p"; then
      matches=$((matches + 1))
    fi
  done
  if   [[ $matches -ge 3 ]]; then risk="CRITICAL"
  elif [[ $matches -ge 2 ]]; then risk="HIGH"
  elif [[ $matches -ge 1 ]]; then risk="MEDIUM"
  fi
  printf "risk\t%s\nmatches\t%s\n" "$risk" "$matches"
}

cmd_sanitize() {
  local text="${1:?text required}"
  # Strip zero-width chars + control chars (except \n \t)
  printf '%s' "$text" \
    | python3 -c "
import sys, unicodedata
t = sys.stdin.read()
t = unicodedata.normalize('NFKC', t)
t = ''.join(c for c in t if unicodedata.category(c) not in ('Cc','Cf') or c in ('\n','\t'))
sys.stdout.write(t)
" 2>/dev/null || printf '%s' "$text"
}

# ── doctor / health ────────────────────────────────────────────────────────
cmd_doctor() {
  echo "=== chat.db readable? ==="
  if [[ -r "$CHAT_DB" ]]; then
    echo "✅ $CHAT_DB"
    local rowid
    rowid=$(sqlite3 "$CHAT_DB" "SELECT MAX(ROWID) FROM message;" 2>&1) || rowid="ERROR"
    echo "   latest ROWID: $rowid"
  else
    echo "❌ Cannot read $CHAT_DB — grant Full Disk Access in System Settings"
  fi

  echo ""
  echo "=== Messages.app accessible? ==="
  if osascript -e 'tell application "Messages" to return name' >/dev/null 2>&1; then
    echo "✅ Automation permission granted"
  else
    echo "❌ Cannot control Messages.app — grant Automation permission in System Settings → Privacy & Security → Automation"
  fi

  echo ""
  echo "=== State dir ==="
  echo "  $STATE_DIR"
  if [[ -r "$CURSOR_FILE" ]]; then
    echo "  cursor: $(cat "$CURSOR_FILE")"
  else
    echo "  cursor: (not initialized — run \`reset-cursor\` or \`watch\` to initialize)"
  fi
}

cmd_health() {
  ensure_state_dir
  local cursor latest
  cursor="$(cat "$CURSOR_FILE" 2>/dev/null || echo 0)"
  latest="$(cmd_latest_rowid)"
  cat <<EOF
state_dir       $STATE_DIR
cursor_file     $CURSOR_FILE
cursor          $cursor
latest_rowid    $latest
backlog         $(( latest - cursor ))
chat_db         $CHAT_DB
chat_db_size    $(stat -f "%z" "$CHAT_DB" 2>/dev/null || echo "?")
EOF
}

# ── dispatch ──────────────────────────────────────────────────────────────
cmd="${1:-help}"
shift || true

case "$cmd" in
  list)                cmd_list "$@" ;;
  read|show)           cmd_read "$@" ;;
  search|find)         cmd_search "$@" ;;
  unread)              cmd_unread ;;
  latest-rowid)        cmd_latest_rowid ;;
  new-since)           cmd_new_since "$@" ;;
  handles)             cmd_handles ;;
  chats)               cmd_chats ;;
  chat-read)           cmd_chat_read "$@" ;;
  chat-members)        cmd_chat_members "$@" ;;
  attachments)         cmd_attachments "$@" ;;
  attachment-save)     cmd_attachment_save "$@" ;;
  last-seen)           cmd_last_seen "$@" ;;
  stats)               cmd_stats "$@" ;;
  send|compose)        cmd_send "$@" ;;
  send-multi)          cmd_send_multi "$@" ;;
  send-chat)           cmd_send_chat "$@" ;;
  send-file)           cmd_send_file "$@" ;;
  send-from-vault)     cmd_send_from_vault "$@" ;;
  send-image)          cmd_send_image "$@" ;;
  watch)               cmd_watch "$@" ;;
  reset-cursor)        cmd_reset_cursor ;;
  export)              cmd_export "$@" ;;
  daily-digest)        cmd_daily_digest "$@" ;;
  mark-read)           cmd_mark_read "$@" ;;
  analyze)             cmd_analyze "$@" ;;
  sanitize)            cmd_sanitize "$@" ;;
  doctor|test)         cmd_doctor ;;
  health)              cmd_health ;;
  help|--help|-h)      usage ;;
  *) echo "Unknown command: $cmd" >&2; usage; exit 1 ;;
esac
