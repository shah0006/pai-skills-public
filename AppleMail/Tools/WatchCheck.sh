#!/bin/bash
#
# Apple Mail Watch — New Mail Checker
# Called by Keyboard Maestro or launchd on a schedule.
# Compares current unread messages against last-known state.
# Notifies on new arrivals, with VIP priority alerting.
#

CACHE_DIR="$HOME/.cache/apple-mail-watch"
STATE_FILE="$CACHE_DIR/last-check.json"
LOG_FILE="$CACHE_DIR/watch.log"
VIP_FILE="${PAI_DIR:-$HOME/.claude/PAI}/USER/SKILLCUSTOMIZATIONS/AppleMail/watch-vip.txt"
# Fallback to legacy location during the verification window
[[ ! -f "$VIP_FILE" ]] && VIP_FILE="$HOME/.claude/skills/AppleMail/watch-vip.txt"
[[ ! -f "$VIP_FILE" ]] && echo "Warning: VIP file not found at $VIP_FILE — VIP filtering disabled" >&2
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APPLE_MAIL="$SCRIPT_DIR/apple-mail.sh"

mkdir -p "$CACHE_DIR"

# Get current unread message IDs and metadata from inbox
get_unread_json() {
    osascript << 'OSAEOF'
tell application "Mail"
    if not running then return "[]"
    set unreadMsgs to (messages of inbox whose read status is false)
    set msgCount to count of unreadMsgs
    if msgCount is 0 then return "[]"

    set jsonOut to "["
    set isFirst to true
    -- Limit to 200 to avoid slowness
    if msgCount > 200 then set msgCount to 200
    repeat with i from 1 to msgCount
        set msg to item i of unreadMsgs
        set msgId to id of msg as string
        set msgSender to sender of msg as string
        set msgSubject to subject of msg as string
        -- Escape quotes for JSON
        set tid to AppleScript's text item delimiters
        set AppleScript's text item delimiters to "\""
        set msgSender to text items of msgSender
        set AppleScript's text item delimiters to "\\\""
        set msgSender to msgSender as string
        set AppleScript's text item delimiters to "\""
        set msgSubject to text items of msgSubject
        set AppleScript's text item delimiters to "\\\""
        set msgSubject to msgSubject as string
        set AppleScript's text item delimiters to tid
        if not isFirst then set jsonOut to jsonOut & ","
        set jsonOut to jsonOut & "{\"id\":" & msgId & ",\"sender\":\"" & msgSender & "\",\"subject\":\"" & msgSubject & "\"}"
        set isFirst to false
    end repeat
    set jsonOut to jsonOut & "]"
    return jsonOut
end tell
OSAEOF
}

# Load VIP list (one email/name per line)
load_vips() {
    if [[ -f "$VIP_FILE" ]]; then
        cat "$VIP_FILE"
    fi
}

# Check if a sender matches any VIP
is_vip() {
    local sender="$1"
    local sender_lower
    sender_lower=$(echo "$sender" | tr '[:upper:]' '[:lower:]')
    while IFS= read -r vip; do
        [[ -z "$vip" || "$vip" == \#* ]] && continue
        local vip_lower
        vip_lower=$(echo "$vip" | tr '[:upper:]' '[:lower:]')
        if [[ "$sender_lower" == *"$vip_lower"* ]]; then
            echo "$vip"
            return 0
        fi
    done < <(load_vips)
    return 1
}

# Send macOS notification
notify() {
    local title="$1" message="$2" sound="${3:-default}"
    osascript -e "display notification \"$message\" with title \"$title\" sound name \"$sound\""
}

# Send voice notification if VoiceServer is running
voice_notify() {
    local message="$1"
    curl -s -m 2 -X POST http://localhost:8888/notify \
        -H "Content-Type: application/json" \
        -d "{\"message\": \"$message\", \"voice_id\": \"fTtv3eikoepIosk8dTZ5\"}" \
        >/dev/null 2>&1 || true
}

# Log entry
log_entry() {
    local ts
    ts=$(date '+%Y-%m-%d_%H:%M:%S')
    echo "[$ts] $*" >> "$LOG_FILE"
}

# Main check
main() {
    local current_json new_ids=() new_vip=() new_regular=()

    # Get current unread
    current_json=$(get_unread_json)

    # Extract current IDs
    local current_ids
    current_ids=$(echo "$current_json" | /usr/bin/python3 -c "
import sys, json
data = json.load(sys.stdin)
for m in data:
    print(m['id'])
" 2>/dev/null || echo "")

    # Load previous IDs
    local prev_ids=""
    if [[ -f "$STATE_FILE" ]]; then
        prev_ids=$(/usr/bin/python3 -c "
import sys, json
with open('$STATE_FILE') as f:
    data = json.load(f)
for m in data:
    print(m['id'])
" 2>/dev/null || echo "")
    fi

    # Find new IDs (in current but not in previous)
    while IFS= read -r id; do
        [[ -z "$id" ]] && continue
        if ! echo "$prev_ids" | grep -q "^${id}$"; then
            new_ids+=("$id")
        fi
    done <<< "$current_ids"

    # Save current state
    echo "$current_json" > "$STATE_FILE"

    # If no new messages, exit quietly
    if [[ ${#new_ids[@]} -eq 0 ]]; then
        exit 0
    fi

    # Categorize new messages as VIP or regular
    for id in "${new_ids[@]}"; do
        local sender subject vip_match
        sender=$(echo "$current_json" | /usr/bin/python3 -c "
import sys, json
data = json.load(sys.stdin)
for m in data:
    if str(m['id']) == '$id':
        print(m['sender'])
        break
" 2>/dev/null || echo "unknown")
        subject=$(echo "$current_json" | /usr/bin/python3 -c "
import sys, json
data = json.load(sys.stdin)
for m in data:
    if str(m['id']) == '$id':
        print(m['subject'])
        break
" 2>/dev/null || echo "")

        if vip_match=$(is_vip "$sender"); then
            new_vip+=("$sender: $subject")
            log_entry "VIP: $sender — $subject"
        else
            new_regular+=("$sender: $subject")
            log_entry "NEW: $sender — $subject"
        fi
    done

    # Notify for VIP messages (individual, with sound)
    for msg in "${new_vip[@]}"; do
        notify "📬 VIP Mail" "$msg" "Purr"
        voice_notify "New email from ${msg%%:*}"
    done

    # Notify for regular messages (batch summary)
    local reg_count=${#new_regular[@]}
    if [[ $reg_count -gt 0 ]]; then
        if [[ $reg_count -eq 1 ]]; then
            notify "📨 New Mail" "${new_regular[0]}" "default"
        else
            # Show first sender + count
            local first_sender="${new_regular[0]%%:*}"
            notify "📨 $reg_count New Emails" "From $first_sender and $((reg_count - 1)) others" "default"
        fi
    fi

    local total=$((${#new_vip[@]} + ${#new_regular[@]}))
    log_entry "Check complete: $total new (${#new_vip[@]} VIP, ${#new_regular[@]} regular)"
}

main "$@"
