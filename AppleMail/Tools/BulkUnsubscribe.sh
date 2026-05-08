#!/usr/bin/env bash
# bulk-unsubscribe.sh v2.0 — Parallel bulk unsubscribe with trash and blocking
#
# v2.0: Parallel HTTP requests (20x speedup), bulk trash, sender blocking via Mail rule
# v1.0: Sequential processing with per-message trash
#
# Usage:
#   bulk-unsubscribe.sh [--mailbox <name>] [--account <name>] [--dry-run] [--trash-after]
#                       [--block-senders] [--parallel <n>] [--limit <n>]
#
# Options:
#   --mailbox <name>   Mailbox to process (default: zzUnsubscribe)
#   --account <name>   iCloud account name (default: iCloud)
#   --dry-run          Show what would happen without actually unsubscribing
#   --trash-after      Bulk-trash the entire mailbox after processing
#   --block-senders    Create Apple Mail rule to auto-delete future messages from these senders
#   --parallel <n>     Max concurrent HTTP requests (default: 20)
#   --limit <n>        Process at most n emails (default: all)
#
# Output:
#   Prints one line per email: STATUS | SUBJECT | METHOD | URL
#   Creates log file in Unsubscribe Logs folder

set -euo pipefail

MAILBOX="zzUnsubscribe"
ACCOUNT="iCloud"
DRY_RUN=false
TRASH_AFTER=false
BLOCK_SENDERS=false
LIMIT=0
PARALLEL=20

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mailbox) MAILBOX="$2"; shift 2 ;;
    --account) ACCOUNT="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    --trash-after) TRASH_AFTER=true; shift ;;
    --block-senders) BLOCK_SENDERS=true; shift ;;
    --parallel) PARALLEL="$2"; shift 2 ;;
    --limit) LIMIT="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

APPLE_MAIL_SH="$(dirname "$0")/apple-mail.sh"
WORK_DIR=$(mktemp -d)
mkdir -p "$WORK_DIR/results"
trap 'rm -rf "$WORK_DIR"' EXIT

echo "=== Bulk Unsubscribe v2.0: $ACCOUNT / $MAILBOX ===" >&2
echo "Parallel: $PARALLEL | Dry run: $DRY_RUN | Trash: $TRASH_AFTER | Block: $BLOCK_SENDERS" >&2

# Log file — override via APPLEMAIL_UNSUBSCRIBE_LOG_DIR; falls back to SKILLCUSTOMIZATIONS, then a local cache dir
LOG_DIR="${APPLEMAIL_UNSUBSCRIBE_LOG_DIR:-${PAI_DIR:-$HOME/.claude/PAI}/USER/SKILLCUSTOMIZATIONS/AppleMail/UnsubscribeLogs}"
if [[ ! -d "$LOG_DIR" ]]; then
  if ! mkdir -p "$LOG_DIR" 2>/dev/null; then
    LOG_DIR="${HOME}/.cache/AppleMail/UnsubscribeLogs"
    mkdir -p "$LOG_DIR"
  fi
fi
LOG_FILE="${LOG_DIR}/Unsubscribe Log $(date +%Y-%m-%d_%H:%M) - ${MAILBOX}.log"
echo "Log: $LOG_FILE" >&2
echo "# Bulk Unsubscribe Log v2.0 - $(date)" > "$LOG_FILE"
echo "# Mailbox: $ACCOUNT / $MAILBOX" >> "$LOG_FILE"
echo "# Parallel: $PARALLEL | Dry run: $DRY_RUN | Trash: $TRASH_AFTER | Block: $BLOCK_SENDERS" >> "$LOG_FILE"
echo "" >> "$LOG_FILE"

# ===== PHASE 1: Extract headers + senders in one AppleScript call =====
echo "Fetching email headers and senders from mailbox..." >&2
START_TIME=$(date +%s)

HEADERS_TSV=$(osascript << APPLESCRIPT
tell application "Mail"
  try
    set mb_ to first mailbox of account "$ACCOUNT" whose name is "$MAILBOX"
  on error
    return "ERROR: Mailbox not found"
  end try
  set output to ""
  set msgCount to count of (messages of mb_)
  set maxCount to $LIMIT
  if maxCount = 0 then set maxCount to msgCount
  repeat with i from 1 to maxCount
    if i > msgCount then exit repeat
    set msg_ to message i of mb_
    set mid to id of msg_
    set subj to subject of msg_
    set senderAddr to sender of msg_
    set hdrs to «class alhe» of msg_
    -- Extract List-Unsubscribe from headers
    set unsubLine to ""
    set hdrLines to paragraphs of hdrs
    repeat with ln_ in hdrLines
      set lnStr to ln_ as string
      if lnStr starts with "List-Unsubscribe:" or lnStr starts with "list-unsubscribe:" then
        set unsubLine to lnStr
      else if unsubLine is not "" and (lnStr starts with " " or lnStr starts with tab) then
        set unsubLine to unsubLine & lnStr
      else if unsubLine is not "" then
        exit repeat
      end if
    end repeat
    if unsubLine is "" then set unsubLine to "NO_UNSUB"
    set output to output & mid & tab & subj & tab & unsubLine & tab & senderAddr & linefeed
  end repeat
  return output
end tell
APPLESCRIPT
)

if [[ "$HEADERS_TSV" == "ERROR:"* ]]; then
  echo "$HEADERS_TSV" >&2
  exit 1
fi

EXTRACT_TIME=$(( $(date +%s) - START_TIME ))
echo "Headers extracted in ${EXTRACT_TIME}s" >&2

# ===== PHASE 2: Categorize into HTTP / MAILTO / NO_UNSUB =====
touch "$WORK_DIR/http_tasks.tsv" "$WORK_DIR/mailto_tasks.tsv" "$WORK_DIR/no_unsub.tsv" "$WORK_DIR/senders.txt"

while IFS=$'\t' read -r MSG_ID SUBJECT UNSUB_HEADER SENDER; do
  [[ -z "$MSG_ID" ]] && continue

  # Record sender for blocking
  [[ -n "$SENDER" ]] && echo "$SENDER" >> "$WORK_DIR/senders.txt"

  if [[ "$UNSUB_HEADER" == "NO_UNSUB" ]]; then
    printf '%s\t%s\t%s\n' "$MSG_ID" "$SUBJECT" "$SENDER" >> "$WORK_DIR/no_unsub.tsv"
    echo "NO_UNSUB | $MSG_ID | $SUBJECT" >> "$LOG_FILE"
    continue
  fi

  # Strip RFC 2822 folding whitespace before extracting URLs
  CLEAN_HEADER=$(echo "$UNSUB_HEADER" | tr -d ' \t')
  HTTP_URL=$(echo "$CLEAN_HEADER" | grep -oE 'https?://[^>",]+' | head -1 || true)
  MAILTO=$(echo "$CLEAN_HEADER" | grep -oE 'mailto:[^>",]+' | head -1 || true)

  if [[ -n "$HTTP_URL" ]]; then
    printf '%s\t%s\t%s\n' "$MSG_ID" "$SUBJECT" "$HTTP_URL" >> "$WORK_DIR/http_tasks.tsv"
  elif [[ -n "$MAILTO" ]]; then
    printf '%s\t%s\t%s\n' "$MSG_ID" "$SUBJECT" "$MAILTO" >> "$WORK_DIR/mailto_tasks.tsv"
  else
    printf '%s\t%s\t%s\n' "$MSG_ID" "$SUBJECT" "$SENDER" >> "$WORK_DIR/no_unsub.tsv"
    echo "NO_PARSE | $MSG_ID | $SUBJECT | $UNSUB_HEADER" >> "$LOG_FILE"
  fi
done <<< "$HEADERS_TSV"

HTTP_COUNT=$(wc -l < "$WORK_DIR/http_tasks.tsv" | tr -d ' ')
MAILTO_COUNT=$(wc -l < "$WORK_DIR/mailto_tasks.tsv" | tr -d ' ')
NO_UNSUB_COUNT=$(wc -l < "$WORK_DIR/no_unsub.tsv" | tr -d ' ')
TOTAL=$((HTTP_COUNT + MAILTO_COUNT + NO_UNSUB_COUNT))

echo "Categorized $TOTAL emails: $HTTP_COUNT HTTP, $MAILTO_COUNT MAILTO, $NO_UNSUB_COUNT no header" >&2
echo "# Categorized: $HTTP_COUNT HTTP, $MAILTO_COUNT MAILTO, $NO_UNSUB_COUNT no header" >> "$LOG_FILE"
echo "" >> "$LOG_FILE"

# ===== PHASE 3: Parallel HTTP unsubscribes =====
SUCCESS=0
FAILED=0

if [[ $HTTP_COUNT -gt 0 ]]; then
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "DRY RUN: Would unsubscribe $HTTP_COUNT HTTP emails" >&2
    while IFS=$'\t' read -r MSG_ID SUBJECT URL; do
      echo "DRY_RUN | HTTP | $SUBJECT"
      echo "DRY_RUN | $MSG_ID | HTTP | $URL | $SUBJECT" >> "$LOG_FILE"
    done < "$WORK_DIR/http_tasks.tsv"
  else
    echo "Unsubscribing $HTTP_COUNT emails via HTTP ($PARALLEL concurrent)..." >&2
    UNSUB_START=$(date +%s)

    while IFS=$'\t' read -r MSG_ID SUBJECT URL; do
      (
        SC=$(curl -s -o /dev/null -w "%{http_code}" -L --max-time 15 \
          --user-agent "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" \
          "$URL" 2>/dev/null || echo "000")
        echo "$SC" > "$WORK_DIR/results/$MSG_ID"
      ) &

      # Throttle: limit concurrent background jobs
      while [[ $(jobs -rp | wc -l) -ge $PARALLEL ]]; do
        sleep 0.1
      done
    done < "$WORK_DIR/http_tasks.tsv"

    # Wait for all remaining jobs
    wait

    UNSUB_TIME=$(( $(date +%s) - UNSUB_START ))
    echo "HTTP unsubscribes completed in ${UNSUB_TIME}s" >&2

    # Collect results
    while IFS=$'\t' read -r MSG_ID SUBJECT URL; do
      SC=$(cat "$WORK_DIR/results/$MSG_ID" 2>/dev/null || echo "000")
      if [[ "$SC" =~ ^(200|201|204|302|301)$ ]]; then
        echo "✅ HTTP $SC | $SUBJECT"
        echo "SUCCESS | $MSG_ID | HTTP $SC | $URL | $SUBJECT" >> "$LOG_FILE"
        SUCCESS=$((SUCCESS + 1))
      else
        echo "❌ HTTP $SC | $SUBJECT"
        echo "FAILED | $MSG_ID | HTTP $SC | $URL | $SUBJECT" >> "$LOG_FILE"
        FAILED=$((FAILED + 1))
      fi
    done < "$WORK_DIR/http_tasks.tsv"
  fi
fi

# ===== PHASE 4: Sequential MAILTO unsubscribes =====
if [[ $MAILTO_COUNT -gt 0 ]]; then
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "DRY RUN: Would send $MAILTO_COUNT unsubscribe emails" >&2
    while IFS=$'\t' read -r MSG_ID SUBJECT MAILTO; do
      echo "DRY_RUN | MAILTO | $SUBJECT"
      echo "DRY_RUN | $MSG_ID | MAILTO | $MAILTO | $SUBJECT" >> "$LOG_FILE"
    done < "$WORK_DIR/mailto_tasks.tsv"
  else
    echo "Unsubscribing $MAILTO_COUNT emails via MAILTO (sequential)..." >&2

    while IFS=$'\t' read -r MSG_ID SUBJECT MAILTO; do
      MAILTO_ADDR=$(echo "$MAILTO" | sed 's/mailto://;s/?.*//')
      MAILTO_SUBJ=$(echo "$MAILTO" | grep -oE 'subject=[^&]+' | head -1 | sed 's/subject=//' | python3 -c "import sys,urllib.parse; print(urllib.parse.unquote(sys.stdin.read().strip()))" 2>/dev/null || echo "unsubscribe")

      if bash "$APPLE_MAIL_SH" send \
        --to "$MAILTO_ADDR" \
        --subject "${MAILTO_SUBJ:-unsubscribe}" \
        --body "Please unsubscribe me from this mailing list." 2>/dev/null; then
        echo "✅ MAILTO | $SUBJECT -> $MAILTO_ADDR"
        echo "SUCCESS | $MSG_ID | MAILTO | $MAILTO_ADDR | $SUBJECT" >> "$LOG_FILE"
        SUCCESS=$((SUCCESS + 1))
      else
        echo "❌ MAILTO | $SUBJECT"
        echo "FAILED | $MSG_ID | MAILTO | $MAILTO_ADDR | $SUBJECT" >> "$LOG_FILE"
        FAILED=$((FAILED + 1))
      fi
    done < "$WORK_DIR/mailto_tasks.tsv"
  fi
fi

# ===== PHASE 5: Bulk trash =====
if [[ "$TRASH_AFTER" == "true" && "$DRY_RUN" != "true" ]]; then
  echo "" >&2
  echo "Bulk-trashing all messages in $MAILBOX..." >&2
  if bash "$APPLE_MAIL_SH" bulk-trash --mailbox "$MAILBOX" --force 2>&1; then
    echo "✅ Mailbox $MAILBOX trashed" >&2
    echo "" >> "$LOG_FILE"
    echo "BULK_TRASH | $MAILBOX | SUCCESS" >> "$LOG_FILE"
  else
    echo "⚠️  Bulk trash returned an error (messages may still have been trashed)" >&2
    echo "" >> "$LOG_FILE"
    echo "BULK_TRASH | $MAILBOX | ERROR" >> "$LOG_FILE"
  fi
fi

# ===== PHASE 6: Block senders via Apple Mail rule =====
if [[ "$BLOCK_SENDERS" == "true" && "$DRY_RUN" != "true" ]]; then
  echo "" >&2
  echo "Extracting unique senders for blocking..." >&2

  # Extract email addresses from sender strings like "Name <email>" or bare "email"
  SENDERS_FILE="$WORK_DIR/unique_senders.txt"
  grep -oE '[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}' "$WORK_DIR/senders.txt" \
    | tr '[:upper:]' '[:lower:]' \
    | sort -u > "$SENDERS_FILE"

  SENDER_COUNT=$(wc -l < "$SENDERS_FILE" | tr -d ' ')
  echo "Found $SENDER_COUNT unique sender addresses" >&2

  if [[ $SENDER_COUNT -gt 0 ]]; then
    RULE_NAME="PAI Blocked $(date +%Y-%m-%d)"

    # Write AppleScript to a temp file to avoid quoting issues with 200+ addresses
    BLOCK_SCRIPT="$WORK_DIR/block_senders.applescript"
    cat > "$BLOCK_SCRIPT" << 'BLOCKHEADER'
tell application "Mail"
BLOCKHEADER

    # Delete existing rule with same name
    echo "  try" >> "$BLOCK_SCRIPT"
    echo "    delete (every rule whose name is \"$RULE_NAME\")" >> "$BLOCK_SCRIPT"
    echo "  end try" >> "$BLOCK_SCRIPT"

    # Create the rule
    echo "  set newRule to make new rule at end of rules with properties {name:\"$RULE_NAME\", all conditions must be met:false, delete message:true, enabled:true, stop evaluating rules:false}" >> "$BLOCK_SCRIPT"

    # Add a condition for each sender
    while IFS= read -r addr; do
      [[ -z "$addr" ]] && continue
      echo "  make new rule condition at end of rule conditions of newRule with properties {rule type:from header, qualifier:does contain value, expression:\"$addr\"}" >> "$BLOCK_SCRIPT"
    done < "$SENDERS_FILE"

    echo "end tell" >> "$BLOCK_SCRIPT"

    # Substitute the rule name (was literal $RULE_NAME in the heredoc)
    sed -i '' "s/\$RULE_NAME/$RULE_NAME/g" "$BLOCK_SCRIPT"

    if osascript "$BLOCK_SCRIPT" 2>/dev/null; then
      echo "✅ Created Mail rule '$RULE_NAME' with $SENDER_COUNT blocked senders" >&2
      echo "" >> "$LOG_FILE"
      echo "BLOCK_RULE | $RULE_NAME | $SENDER_COUNT senders | SUCCESS" >> "$LOG_FILE"
    else
      echo "⚠️  Failed to create Mail rule. Sender list saved to log." >&2
      echo "" >> "$LOG_FILE"
      echo "BLOCK_RULE | FAILED" >> "$LOG_FILE"
    fi

    # Always save sender list to log
    echo "" >> "$LOG_FILE"
    echo "# Blocked Senders ($SENDER_COUNT unique)" >> "$LOG_FILE"
    cat "$SENDERS_FILE" >> "$LOG_FILE"
  fi
fi

# ===== SUMMARY =====
DURATION=$(( $(date +%s) - START_TIME ))
SKIPPED=0
[[ "$DRY_RUN" == "true" ]] && SKIPPED=$((HTTP_COUNT + MAILTO_COUNT))

echo "" >&2
echo "=== Results ($DURATION seconds) ===" >&2
echo "Total:        $TOTAL" >&2
echo "✅ Succeeded: $SUCCESS" >&2
echo "❌ Failed:    $FAILED" >&2
echo "⚠️  No header: $NO_UNSUB_COUNT" >&2
[[ $SKIPPED -gt 0 ]] && echo "🔍 Skipped:   $SKIPPED (dry run)" >&2
echo "Log: $LOG_FILE" >&2

echo "" >> "$LOG_FILE"
echo "# Results: Total=$TOTAL Success=$SUCCESS Failed=$FAILED NoHeader=$NO_UNSUB_COUNT Duration=${DURATION}s" >> "$LOG_FILE"

echo ""
echo "Total=$TOTAL Success=$SUCCESS Failed=$FAILED NoHeader=$NO_UNSUB_COUNT Duration=${DURATION}s"
