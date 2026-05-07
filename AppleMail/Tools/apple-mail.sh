#!/bin/bash
#
# apple-mail.sh — Comprehensive macOS Mail.app CLI via AppleScript
# Part of PAI (Personal AI Infrastructure)
#
# A 47-command CLI for reading, sending, searching, organizing, and monitoring
# email via macOS Mail.app. Built with Bash + dynamically-generated AppleScript.
# v3.0: Unified path convention (account-prefix/mailbox-path) for account-scoped ops.
#
# Requirements:
#   - macOS 12 (Monterey) or later
#   - Mail.app configured with at least one account
#   - Bash 3.2+ (ships with macOS)
#
# Architecture:
#   Each command builds an AppleScript string using heredoc templates with
#   variable expansion, then executes it via `osascript -e`. Helper functions
#   (osa_str, mb_resolve, find_msg) handle escaping, mailbox resolution, and
#   message lookup. Output is tab-separated plain text for easy parsing.
#
#   Key patterns:
#   - Unquoted heredocs (<<APPLESCRIPT) allow Bash variable expansion
#   - osa_str() escapes user input for safe AppleScript string embedding
#   - mb_resolve() handles system mailboxes (inbox, sent, etc.) differently
#     from custom/hierarchical mailboxes (up to 4 levels deep)
#   - find_msg() locates messages by ID with fallback search
#
# Adding a new command:
#   1. Create a function (e.g., my_command()) following existing patterns
#   2. Add a section header comment block above it
#   3. Add the command to show_usage()
#   4. Add a case entry in the main() dispatcher at the bottom
#   5. Use osa_str() for ALL user-provided strings before embedding in AppleScript
#

VERSION="3.0.0"

# Purpose: Escape a string for safe embedding in AppleScript double-quoted string literals.
# Parameters: $1 — the raw string to escape
# Output: escaped string on stdout (no trailing newline)
# Side effects: none
# Escaping order matters: backslashes first, then quotes.
osa_str() {
    printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

# Purpose: Generate AppleScript that sets 'targetMailbox' from a mailbox name string.
# Parameters: $1 — mailbox name (default: "inbox"). Supports system names (inbox, sent,
#   drafts, trash, junk), flat custom names, and hierarchical paths (up to 4 levels deep).
# Output: AppleScript code fragment on stdout (multi-line, indented)
# Side effects: none
# For system mailboxes: direct reference. For custom: searches accounts at runtime.
mb_resolve() {
    local m="${1:-inbox}"
    local m_lower m_esc
    m_lower=$(echo "$m" | tr '[:upper:]' '[:lower:]')
    m_esc=$(osa_str "$m")

    case "$m_lower" in
        ""|inbox)
            printf '    set targetMailbox to inbox\n' ;;
        sent|"sent messages")
            printf '    set targetMailbox to sent mailbox\n' ;;
        drafts|draft)
            printf '    set targetMailbox to drafts mailbox\n' ;;
        trash|deleted|"deleted messages")
            printf '    set targetMailbox to trash mailbox\n' ;;
        junk|spam)
            printf '    set targetMailbox to junk mailbox\n' ;;
        *)
            printf '    set targetMailbox to inbox\n'
            printf '    set mbFound_ to false\n'
            if [[ "$m" == *"/"* ]]; then
                # Hierarchical path: navigate up to 4 levels deep
                IFS='/' read -ra PATH_PARTS <<< "$m"
                local num_parts="${#PATH_PARTS[@]}"
                printf '    repeat with acct_ in accounts\n'
                printf '        try\n'
                local esc0; esc0=$(osa_str "${PATH_PARTS[0]}")
                printf '            set mb0_ to first mailbox of acct_ whose name is "%s"\n' "$esc0"
                if [[ $num_parts -ge 2 ]]; then
                    local esc1; esc1=$(osa_str "${PATH_PARTS[1]}")
                    printf '            set mb1_ to first mailbox of mb0_ whose name is "%s"\n' "$esc1"
                fi
                if [[ $num_parts -ge 3 ]]; then
                    local esc2; esc2=$(osa_str "${PATH_PARTS[2]}")
                    printf '            set mb2_ to first mailbox of mb1_ whose name is "%s"\n' "$esc2"
                fi
                if [[ $num_parts -ge 4 ]]; then
                    local esc3; esc3=$(osa_str "${PATH_PARTS[3]}")
                    printf '            set mb3_ to first mailbox of mb2_ whose name is "%s"\n' "$esc3"
                fi
                # Point targetMailbox at deepest resolved level
                case $num_parts in
                    2) printf '            set targetMailbox to mb1_\n' ;;
                    3) printf '            set targetMailbox to mb2_\n' ;;
                    4) printf '            set targetMailbox to mb3_\n' ;;
                    *) printf '            set targetMailbox to mb0_\n' ;;
                esac
                printf '            set mbFound_ to true\n'
                printf '            exit repeat\n'
                printf '        end try\n'
                printf '    end repeat\n'
            else
                printf '    repeat with acct_ in accounts\n'
                printf '        try\n'
                printf '            set targetMailbox to first mailbox of acct_ whose name is "%s"\n' "$m_esc"
                printf '            set mbFound_ to true\n'
                printf '            exit repeat\n'
                printf '        end try\n'
                printf '    end repeat\n'
            fi
            printf '    if not mbFound_ then\n'
            printf '        return "Error: Mailbox not found: %s. Run apple-mail.sh folders to see all mailboxes."\n' "$m_esc"
            printf '    end if\n' ;;
    esac
}

# Purpose: Parse a unified path string into account name + mailbox path.
# Parameters: $1 — unified path (e.g., "i/Receipts", "g/Stages/Stage 1 - VIP", "Receipts", "")
# Output: none (sets global variables)
# Side effects: sets _RP_ACCOUNT (Apple Mail account name, empty if none)
#               and _RP_MAILBOX (mailbox path, defaults to "inbox")
# Account alias mapping (case-insensitive):
#   i, icloud -> "iCloud"   |  g, gmail, google -> "Google"
#   y, yahoo -> "Yahoo"     |  h, hotmail -> "Hotmail"
#   a, aol -> "AOL"         |  p, protonmail -> "ProtonMail"
# Examples:
#   "" or no arg       -> account="", mailbox="inbox"
#   "i"                -> account="iCloud", mailbox="inbox"
#   "i/Receipts"       -> account="iCloud", mailbox="Receipts"
#   "g/Stages/Stage 1" -> account="Google", mailbox="Stages/Stage 1"
#   "Receipts"         -> account="", mailbox="Receipts" (all-accounts compat)
#   "inbox"            -> account="", mailbox="inbox"
resolve_path() {
    local input="$1"
    _RP_ACCOUNT=""
    _RP_MAILBOX="inbox"

    # Strip trailing slashes and whitespace
    input="${input%%/}"
    input="${input#"${input%%[![:space:]]*}"}"
    input="${input%"${input##*[![:space:]]}"}"

    # Empty or no argument -> unified inbox
    if [[ -z "$input" ]]; then
        return 0
    fi

    # Extract the first segment (before first slash, or the whole string)
    local first_seg remainder
    if [[ "$input" == *"/"* ]]; then
        first_seg="${input%%/*}"
        remainder="${input#*/}"
        # Clean empty segments from remainder (e.g., "i//Receipts")
        while [[ "$remainder" == /* ]]; do
            remainder="${remainder#/}"
        done
    else
        first_seg="$input"
        remainder=""
    fi

    # Check if first segment is a known account alias (case-insensitive)
    local first_lower
    first_lower=$(echo "$first_seg" | tr '[:upper:]' '[:lower:]')

    local matched_account=""
    case "$first_lower" in
        i|icloud)       matched_account="iCloud" ;;
        g|gmail|google) matched_account="Google" ;;
        y|yahoo)        matched_account="Yahoo" ;;
        h|hotmail)      matched_account="Hotmail" ;;
        a|aol)          matched_account="AOL" ;;
        p|protonmail)   matched_account="ProtonMail" ;;
    esac

    if [[ -n "$matched_account" ]]; then
        _RP_ACCOUNT="$matched_account"
        if [[ -n "$remainder" ]]; then
            _RP_MAILBOX="$remainder"
        else
            # Account alias alone = that account's inbox
            _RP_MAILBOX="inbox"
        fi
    else
        # No account prefix recognized -> old-style path (all accounts)
        _RP_ACCOUNT=""
        _RP_MAILBOX="$input"
    fi
}

# Purpose: Generate AppleScript that sets 'targetMailbox' for a specific account.
# Parameters: $1 — mailbox name (default: "inbox"), $2 — account name (empty = delegate to mb_resolve)
# Output: AppleScript code fragment on stdout (multi-line, indented)
# Side effects: none
# For system mailboxes with account: uses "inbox of targetAccount", etc.
# For custom mailboxes with account: navigates hierarchy within that account only.
# If account is empty, delegates to existing mb_resolve() for backward compat.
mb_resolve_acct() {
    local m="${1:-inbox}"
    local acct="${2:-}"

    # If no account specified, delegate to existing mb_resolve()
    if [[ -z "$acct" ]]; then
        mb_resolve "$m"
        return
    fi

    local m_lower m_esc acct_esc
    m_lower=$(echo "$m" | tr '[:upper:]' '[:lower:]')
    m_esc=$(osa_str "$m")
    acct_esc=$(osa_str "$acct")

    # First: locate the target account (direct lookup, not loop reference)
    printf '    set targetAccount to first account whose name is "%s"\n' "$acct_esc"

    # System mailbox properties (inbox of, sent mailbox of) are unreliable on
    # modern macOS for both iCloud and IMAP accounts. Use name-based lookup for all.
    local is_imap=false
    [[ "$acct" != "iCloud" ]] && is_imap=true

    case "$m_lower" in
        ""|inbox)
            printf '    set targetMailbox to first mailbox of targetAccount whose name is "INBOX"\n' ;;
        sent|"sent messages"|"sent mail")
            # Gmail uses "Sent Mail"; iCloud/others may use "Sent Messages"
            printf '    try\n'
            printf '        set targetMailbox to first mailbox of targetAccount whose name is "Sent Messages"\n'
            printf '    on error\n'
            printf '        set targetMailbox to first mailbox of targetAccount whose name is "Sent Mail"\n'
            printf '    end try\n' ;;
        drafts|draft)
            printf '    set targetMailbox to first mailbox of targetAccount whose name is "Drafts"\n' ;;
        trash|deleted|"deleted messages")
            printf '    try\n'
            printf '        set targetMailbox to first mailbox of targetAccount whose name is "Trash"\n'
            printf '    on error\n'
            printf '        set targetMailbox to first mailbox of targetAccount whose name is "Deleted Messages"\n'
            printf '    end try\n' ;;
        junk|spam)
            printf '    try\n'
            printf '        set targetMailbox to first mailbox of targetAccount whose name is "Junk"\n'
            printf '    on error\n'
            printf '        set targetMailbox to first mailbox of targetAccount whose name is "Spam"\n'
            printf '    end try\n' ;;
        *)
            printf '    set targetMailbox to first mailbox of targetAccount whose name is "INBOX"\n'
            printf '    set mbFound_ to false\n'
            if [[ "$m" == *"/"* ]]; then
                # Hierarchical path: navigate within the specific account
                IFS='/' read -ra PATH_PARTS <<< "$m"
                local num_parts="${#PATH_PARTS[@]}"
                printf '    try\n'
                local esc0; esc0=$(osa_str "${PATH_PARTS[0]}")
                printf '        set mb0_ to first mailbox of targetAccount whose name is "%s"\n' "$esc0"
                if [[ $num_parts -ge 2 ]]; then
                    local esc1; esc1=$(osa_str "${PATH_PARTS[1]}")
                    printf '        set mb1_ to first mailbox of mb0_ whose name is "%s"\n' "$esc1"
                fi
                if [[ $num_parts -ge 3 ]]; then
                    local esc2; esc2=$(osa_str "${PATH_PARTS[2]}")
                    printf '        set mb2_ to first mailbox of mb1_ whose name is "%s"\n' "$esc2"
                fi
                if [[ $num_parts -ge 4 ]]; then
                    local esc3; esc3=$(osa_str "${PATH_PARTS[3]}")
                    printf '        set mb3_ to first mailbox of mb2_ whose name is "%s"\n' "$esc3"
                fi
                case $num_parts in
                    2) printf '        set targetMailbox to mb1_\n' ;;
                    3) printf '        set targetMailbox to mb2_\n' ;;
                    4) printf '        set targetMailbox to mb3_\n' ;;
                    *) printf '        set targetMailbox to mb0_\n' ;;
                esac
                printf '        set mbFound_ to true\n'
                printf '    on error\n'
                printf '        return "Error: Mailbox not found: %s in account %s. Run apple-mail.sh folders to see all mailboxes."\n' "$m_esc" "$acct_esc"
                printf '    end try\n'
            else
                # Flat custom mailbox within the specific account
                printf '    try\n'
                printf '        set targetMailbox to first mailbox of targetAccount whose name is "%s"\n' "$m_esc"
                printf '        set mbFound_ to true\n'
                printf '    on error\n'
                printf '        return "Error: Mailbox not found: %s in account %s. Run apple-mail.sh folders to see all mailboxes."\n' "$m_esc" "$acct_esc"
                printf '    end try\n'
            fi
            # Note: not-found case handled by on error above
            ;;
    esac
}

# Purpose: Generate AppleScript that finds a message by ID in targetMailbox, sets targetMessage.
# Parameters: $1 — message ID, $2 — mailbox label for error messages (default: "inbox")
# Output: AppleScript code fragment on stdout
# Side effects: none
# Strategy: tries integer ID match first, falls back to string comparison loop.
find_msg() {
    local id="$1" mb_label="${2:-inbox}"
    local esc_id
    esc_id=$(osa_str "$id")
    printf '    set targetMessage to null\n'
    printf '    try\n'
    printf '        set targetMessage to first message of targetMailbox whose id is (%s as integer)\n' "$esc_id"
    printf '    on error\n'
    printf '        repeat with msg_ in messages of targetMailbox\n'
    printf '            if (id of msg_ as string) is "%s" then\n' "$esc_id"
    printf '                set targetMessage to msg_\n'
    printf '                exit repeat\n'
    printf '            end if\n'
    printf '        end repeat\n'
    printf '    end try\n'
    printf '    if targetMessage is null then return "Error: Email ID %s not found in %s"\n' "$esc_id" "$(osa_str "$mb_label")"
}

# Purpose: Display CLI help text with all commands, flags, and examples.
# Parameters: none
# Output: usage text to stdout
# Side effects: none
show_usage() {
    echo "Apple Mail Skill v${VERSION} — Comprehensive macOS Mail.app Interface"
    cat << 'USAGEEOF'

UNIFIED PATH CONVENTION (v3.0):
    Commands accept unified paths: <account-alias>/<mailbox-path>
    Account aliases: i=iCloud, g=Google, y=Yahoo, h=Hotmail, a=AOL, p=ProtonMail
    Examples: "i" (iCloud inbox), "i/Receipts", "g/Stages/Stage 1 - VIP"
    Old-style names still work: "inbox", "Receipts", "sent" (searches all accounts)
    Vocabulary (v5.1): `mailbox` is canonical; `label` is an interchangeable alias for both command-nouns (delete-mailbox / delete-label, rename-mailbox / rename-label, etc.) and flag values (--mailbox / --label). Same applies in the inverse for GoogleWorkspaceCLI v5 where `label` is canonical.

READING:
    list    [path] [--mailbox <name>] [--unread] [count]
            path: unified path (e.g., "i", "g/Receipts"). No path = unified inbox.
    read    <id> [--mailbox <name>]
    unread  [path] [--mailbox <name>]
    count   [path] [--unread]                   (fast integer count, no email data)
    headers <id> [--mailbox <name>]             (raw email headers)
    thread  <id> [--mailbox <name>]
    thread-read <id> [--mailbox <name>]         (full thread with bodies)
    attachments <id> [--mailbox <name>]
    open    <id> [--mailbox <name>]

SEARCHING:
    search  <query> [--mailbox <name>|all] [--from <addr>] [--unread] [--body] [--after YYYY-MM-DD] [--before YYYY-MM-DD] [count]
            Default: searches subject+sender (fast). Add --body for full-text (slow).
            --mailbox accepts unified paths (e.g., --mailbox "i/Receipts")

COMPOSING:
    send    --to <addr> [--to <addr2> ...] [--cc <addr>] [--bcc <addr>] [--from <email>] --subject <s> --body <b> [--attach /path] [--attach /path2]
            OR short form: send <to> <subject> <body>
            Multiple --to flags supported for multi-recipient sending.
    reply   <id> <body> [--all] [--mailbox <name>] [--cc <addr>] [--bcc <addr>]
    reply-all <id> <body> [--mailbox <name>] [--cc <addr>] [--bcc <addr>]
    forward <id> --to <addr> [--body <prefix>] [--mailbox <name>]
    draft   --to <addr> [--cc <addr>] --subject <s> --body <b>   (opens compose window for review)

ORGANIZATION:
    flag    <id> [--mailbox <name>]
    unflag  <id> [--mailbox <name>]
    mark-read   <id> [--mailbox <name>]
    mark-unread <id> [--mailbox <name>]
    move    <id> <dest-path> [--mailbox <src-path>]   (both accept unified paths)
    trash   <id> [--mailbox <name>]
    archive <id> [--mailbox <name>]

BULK OPERATIONS:
    bulk-trash       --mailbox <path> [--unread-only] [--confirm] [--force]
    bulk-move        --mailbox <path> --dest <path> [--unread-only] [--confirm] [--force]
    bulk-mark-read   --mailbox <path> [--confirm] [--force]
    bulk-archive     --mailbox <path> [--unread-only] [--confirm] [--force]
    bulk-flag        --mailbox <path> [--confirm] [--force]
    bulk-unflag      --mailbox <path> [--confirm] [--force]
    bulk-mark-unread --mailbox <path> [--confirm] [--force]
    bulk-junk        --mailbox <path> [--confirm] [--force]
    bulk-not-junk    --mailbox <path> [--confirm] [--force]
    Default: dry-run. --confirm: execute with y/N prompt. --force: execute immediately (no prompt, automation-safe).

JUNK AUDIT:
    audit-junk    [--account <alias>] [--dry-run] [--threshold N] [--auto-block N] [--db <path>] [--trash]
                  Scan Junk mailbox for recurring sender domains.
                  Cross-reference against junk_senders table in triage.db.
                  Report domains not yet blocked, sorted by frequency.
                  --account:     account alias (default: "i" for iCloud)
                  --dry-run:     show what would be added without modifying DB
                  --threshold:   minimum domain occurrences for report (default: 2)
                  --auto-block:  auto-add domains with N+ occurrences to junk_senders
                  --db:          path to triage.db (default: ~/.claude/skills/EmailTriage/triage.db)
                  --trash:       bulk-trash Junk folder contents after audit

BULK OPERATIONS BY ID:
    bulk-trash-ids       <id1> <id2> ... [--mailbox <path>]
    bulk-move-ids        <id1> <id2> ... <dest-path> [--mailbox <path>]
    bulk-archive-ids     <id1> <id2> ... [--mailbox <path>]
    bulk-mark-read-ids   <id1> <id2> ... [--mailbox <path>]
    bulk-flag-ids        <id1> <id2> ... [--mailbox <path>]
    bulk-unflag-ids      <id1> <id2> ... [--mailbox <path>]
    bulk-mark-unread-ids <id1> <id2> ... [--mailbox <path>]
    Execute in a single AppleScript call. No dry-run needed (operates only on listed IDs).
    IDs not found are reported as warnings but do not stop processing.
    For bulk-move-ids, the last positional arg (before --mailbox) is the destination path,
    or use --dest <path> explicitly.

MAILBOX MANAGEMENT:
    create-mailbox  <path>                      (e.g., "i/Personal/Subscriptions/New")
    delete-mailbox  <path>                      (must be empty, refuses system folders)
    rename-mailbox  <path> <new-name>           (renames leaf only)
    move-mailbox    <src-path> <dest-parent>    (move mailbox to different parent)
    sort-mailboxes  [account-alias]             (alphabetize custom mailboxes)
    folder-tree     [account-alias]             (flat list of unified paths, no counts)

TRASH MANAGEMENT (v5.1):
    empty-trash     [--account=<X>] [--force]   (permanently empty Trash; per-account confirmation; --force bypasses)
                                                (no --account: iterate every triage:true account, one prompt each)
    restore         <message-id> [--account=<X>] [--mailbox=<dest>|--label=<dest>]
                                                (restore a Trash message; default destination INBOX of the same account)
                                                (no --account: search every triage:true Trash; one match wins, ambiguous errors)

ATTACHMENTS & EXPORT:
    save-attachment <id> [--mailbox X] [--out /path/to/dir]   (default: ~/Downloads/)
    export <id> [--mailbox X] [--out /path/to/file.md]         (Obsidian email archival format)

WATCH (new mail monitoring):
    watch start     Start monitoring for new mail (every 2 min via launchd)
    watch stop      Stop monitoring
    watch status    Show if running, last check time, new messages since last session
    watch log [N]   Show recent watch notifications (default: 20 lines)
    watch vip       Edit VIP sender list
    watch check     Run a one-time check now (manual trigger)

INFO:
    accounts
    folders     (shows unread counts -- use folder-tree for plain paths)

MAILBOX NAMES:
    System: inbox, sent, drafts, trash, junk
    Custom: exact name from 'folders' output  e.g. "Archive", "AA Important"
    Unified: <alias>/<path>  e.g. "i/Receipts", "g/Stages/Stage 1 - VIP"

EXAMPLES:
    apple-mail.sh list i                             (iCloud inbox)
    apple-mail.sh list g/Receipts --unread 20        (Google Receipts, unread only)
    apple-mail.sh list --mailbox sent 10             (old style still works)
    apple-mail.sh list --unread
    apple-mail.sh count i --unread                   (fast unread count)
    apple-mail.sh count "g/Stages/Stage 1 - VIP"    (total count in folder)
    apple-mail.sh headers 79132                      (raw email headers)
    apple-mail.sh read 79132 --mailbox sent
    apple-mail.sh search "Oregon" --mailbox all 10
    apple-mail.sh search "receipt" --mailbox "i/Receipts" 5
    apple-mail.sh move 79132 "i/Archive" --mailbox "g/inbox"
    apple-mail.sh create-mailbox "i/Personal/Subscriptions/New"
    apple-mail.sh delete-mailbox "i/Old Stuff"
    apple-mail.sh rename-mailbox "i/Old Name" "New Name"
    apple-mail.sh move-mailbox "i/Alo" "i/Personal/Subscriptions"
    apple-mail.sh folder-tree i                      (all iCloud folders as paths)
    apple-mail.sh folder-tree                        (all accounts)
    apple-mail.sh bulk-archive --mailbox "i/Promos" --force
    apple-mail.sh bulk-junk --mailbox "i/Spam Folder" --force
    apple-mail.sh bulk-flag --mailbox "i/VIP" --force
    apple-mail.sh send --to "doc@hospital.com" --subject "Labs" --body "See attached" --attach ~/Downloads/labs.pdf
    apple-mail.sh reply 79132 "Thanks!" --all
    apple-mail.sh archive 76244
    apple-mail.sh bulk-trash --mailbox "i/Junk" --confirm
    apple-mail.sh bulk-move --mailbox "Stackskills" --dest "Archive" --confirm
    apple-mail.sh bulk-trash-ids 88849 88821 88819 88816 --mailbox "Junk"
    apple-mail.sh bulk-move-ids 88864 88840 88818 "i/Triage" --mailbox "Junk"
    apple-mail.sh bulk-archive-ids 88700 88701 88702 --mailbox "i"

USAGEEOF
}

# ─────────────────────────────────────────────
# LIST
# ─────────────────────────────────────────────
# Purpose: List emails in a mailbox with summary info.
# Parameters: [unified-path] [--mailbox name] [--unread] [count]
#   Unified path: "i/Receipts", "g", "Receipts" (see resolve_path)
#   --mailbox kept for backward compat (overrides unified path)
# Output: tab-separated rows (ID, date, from, subject, flags) to stdout
# Side effects: none (read-only)
list_emails() {
    local mailbox_name="" unread_only="false" count=10 unified_path=""
    local mailbox_flag_used="false"
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --mailbox|-m) mailbox_name="$2"; mailbox_flag_used="true"; shift 2 ;;
            --unread|-u)  unread_only="true"; shift ;;
            *)
                if [[ "$1" =~ ^[0-9]+$ ]]; then
                    count="$1"
                elif [[ -z "$unified_path" ]]; then
                    unified_path="$1"
                fi
                shift ;;
        esac
    done

    # Resolve: --mailbox flag takes priority, else unified path, else inbox default
    if [[ "$mailbox_flag_used" == "true" ]]; then
        # Legacy --mailbox mode: use mb_resolve directly
        local esc_mb
        esc_mb=$(osa_str "$mailbox_name")
        local mb_osa
        mb_osa=$(mb_resolve "$mailbox_name")
    else
        resolve_path "$unified_path"
        mailbox_name="$_RP_MAILBOX"
        local esc_mb
        esc_mb=$(osa_str "$mailbox_name")
        local mb_osa
        mb_osa=$(mb_resolve_acct "$_RP_MAILBOX" "$_RP_ACCOUNT")
    fi

    local display_label
    if [[ -n "$_RP_ACCOUNT" ]] && [[ "$mailbox_flag_used" != "true" ]]; then
        display_label=$(osa_str "${unified_path:-inbox}")
    else
        display_label="$esc_mb"
    fi

    osascript << OSAEOF
tell application "Mail"
    if not running then launch
$mb_osa

    if $unread_only then
        set allMessages to (messages of targetMailbox whose read status is false)
    else
        set allMessages to messages of targetMailbox
    end if

    set totalMessages to count of allMessages
    if totalMessages = 0 then
        if $unread_only then
            return "No unread messages in: $display_label"
        else
            return "No messages in: $display_label"
        end if
    end if

    set limitCount to $count
    if limitCount > totalMessages then set limitCount to totalMessages
    set messageList to items 1 thru limitCount of allMessages

    set output to "Mailbox: $display_label (" & totalMessages & " total)" & linefeed
    set output to output & "======================================" & linefeed

    repeat with msg in messageList
        set msgId to id of msg as string
        set readStatus to "[ ]"
        if read status of msg then set readStatus to "[READ]"
        set flagMark to "   "
        try
            if flagged status of msg then set flagMark to "[⚑]"
        end try
        set attMark to "   "
        try
            if (count of mail attachments of msg) > 0 then set attMark to "[📎]"
        end try
        set msgAcct to ""
        try
            set msgAcct to name of (account of mailbox of msg)
        end try
        set output to output & "ID:" & msgId & " " & readStatus & " " & flagMark & " " & attMark & " | " & (date received of msg as string) & " | " & (sender of msg) & " | " & (subject of msg) & " | ACCT:" & msgAcct & linefeed
    end repeat

    return output
end tell
OSAEOF
}

# ─────────────────────────────────────────────
# READ
# ─────────────────────────────────────────────
# Purpose: Read full content of a single email including headers, body, and attachment info.
# Parameters: [--mailbox name] <id>
# Output: formatted headers + body text to stdout
# Side effects: marks message as read in Mail.app
read_email() {
    local email_id="$1"; shift
    local mailbox_name="inbox"
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --mailbox|-m) mailbox_name="$2"; shift 2 ;;
            *) shift ;;
        esac
    done

    local esc_mb
    esc_mb=$(osa_str "$mailbox_name")

    osascript << OSAEOF
tell application "Mail"
    if not running then launch
$(mb_resolve "$mailbox_name")
$(find_msg "$email_id" "$mailbox_name")

    set msgSubject to subject of targetMessage
    set msgSender to sender of targetMessage
    set msgDate to date received of targetMessage
    set msgBody to content of targetMessage
    set msgFlagged to flagged status of targetMessage

    set toAddrs to ""
    try
        repeat with r in to recipients of targetMessage
            set toAddrs to toAddrs & (address of r) & "  "
        end repeat
    end try

    set ccAddrs to ""
    try
        repeat with r in cc recipients of targetMessage
            set ccAddrs to ccAddrs & (address of r) & "  "
        end repeat
    end try

    set attInfo to ""
    set isHtml to false
    try
        set attList to mail attachments of targetMessage
        if (count of attList) > 0 then
            set attInfo to linefeed & "Attachments (" & (count of attList) & "):" & linefeed
            repeat with att in attList
                set attName to name of att
                set attMime to ""
                try
                    set attMime to mime type of att
                end try
                if attMime contains "html" then set isHtml to true
                try
                    set attInfo to attInfo & "  - " & attName & " (" & (file size of att) & " bytes)" & linefeed
                on error
                    set attInfo to attInfo & "  - " & attName & linefeed
                end try
            end repeat
        end if
    end try

    -- Detect HTML in body (inline HTML email)
    -- Check both MIME type (attachment-based HTML) and content patterns (inline HTML).
    -- Some emails have HTML bodies without a text/html MIME attachment.
    if msgBody contains "<html" or msgBody contains "<HTML" or msgBody contains "<div" or msgBody contains "<p>" then
        set isHtml to true
    end if

    set read status of targetMessage to true

    set output to "======================================" & linefeed
    set output to output & "Subject: " & msgSubject & linefeed
    set output to output & "From:    " & msgSender & linefeed
    if toAddrs is not "" then set output to output & "To:      " & toAddrs & linefeed
    if ccAddrs is not "" then set output to output & "CC:      " & ccAddrs & linefeed
    set output to output & "Date:    " & (msgDate as string) & linefeed
    set output to output & "Mailbox: $esc_mb  |  Flagged: " & msgFlagged & "  |  ID: " & (id of targetMessage as string) & linefeed
    if isHtml then set output to output & "[HTML email — displayed as plain text, formatting stripped]" & linefeed
    if attInfo is not "" then set output to output & attInfo
    set output to output & "======================================" & linefeed & linefeed
    set output to output & msgBody

    return output
end tell
OSAEOF
}

# ─────────────────────────────────────────────
# SEARCH
# ─────────────────────────────────────────────
# Path to Mail's Envelope Index SQLite DB — the same index Mail.app's own search bar
# uses. Queries against this DB return in milliseconds vs 30-90s for AppleScript
# iteration. Used by the fast-path in search_emails() when body text is not needed.
APPLE_MAIL_ENVELOPE_INDEX="$HOME/Library/Mail/V10/MailData/Envelope Index"

# Purpose: SQLite fast-path for search_emails(). Queries Mail's Envelope Index
#   directly (~10ms) instead of iterating Mail.app via AppleScript (30-90s).
# Parameters: (all positional, in order)
#   $1 query        — subject/sender substring (may be empty)
#   $2 mailbox_name — user-facing mailbox name (for display only)
#   $3 from_filter  — sender address substring (may be empty)
#   $4 unread_only  — "true" or "false"
#   $5 count        — max results
#   $6 search_all   — "true" to search across all mailboxes
#   $7 after_date   — YYYY-MM-DD or empty
#   $8 before_date  — YYYY-MM-DD or empty
#   $9 mailbox_url_like — SQL LIKE pattern against mailboxes.url, or empty for no-op.
#                         Used when search_all=false to narrow to a specific mailbox.
# Output: search results in the same tab-separated format as the AppleScript path.
# Returns: 0 on success (including zero results), non-zero on any SQL error.
# Side effects: none (read-only SQL against a -readonly handle).
search_emails_sqlite() {
    local q="$1" mb_display="$2" from_f="$3" unread="$4" cnt="$5" all="$6"
    local after_d="$7" before_d="$8" mb_like="$9"
    local db="$APPLE_MAIL_ENVELOPE_INDEX"

    [[ ! -r "$db" ]] && return 2
    command -v sqlite3 >/dev/null 2>&1 || return 2

    # SQL string escape: double single-quotes.
    local qe fe mbe
    qe="${q//\'/\'\'}"
    fe="${from_f//\'/\'\'}"
    mbe="${mb_like//\'/\'\'}"

    local where="WHERE m.deleted = 0"

    # Mailbox scoping
    if [[ "$all" != "true" && -n "$mb_like" ]]; then
        where+=" AND mb.url LIKE '${mbe}'"
    fi

    # Unread filter: messages.read = 0 means unread
    if [[ "$unread" == "true" ]]; then
        where+=" AND m.read = 0"
    fi

    # Query substring: match subject OR sender address OR sender comment (display name)
    if [[ -n "$q" ]]; then
        where+=" AND (s.subject LIKE '%${qe}%' COLLATE NOCASE"
        where+=" OR a.address LIKE '%${qe}%' COLLATE NOCASE"
        where+=" OR a.comment LIKE '%${qe}%' COLLATE NOCASE)"
    fi

    # From filter: match sender address OR display-name comment
    if [[ -n "$from_f" ]]; then
        where+=" AND (a.address LIKE '%${fe}%' COLLATE NOCASE"
        where+=" OR a.comment LIKE '%${fe}%' COLLATE NOCASE)"
    fi

    # Date filters: date_received is Mac absolute time (seconds since 2001-01-01 UTC).
    # Convert YYYY-MM-DD to Mac absolute seconds via: (unix epoch) - 978307200.
    if [[ -n "$after_d" ]]; then
        local ts
        ts=$(date -j -f "%Y-%m-%d" "$after_d" "+%s" 2>/dev/null) || return 3
        where+=" AND m.date_received >= $((ts - 978307200))"
    fi
    if [[ -n "$before_d" ]]; then
        local ts
        ts=$(date -j -f "%Y-%m-%d" "$before_d" "+%s" 2>/dev/null) || return 3
        # End of that day
        where+=" AND m.date_received <= $((ts - 978307200 + 86399))"
    fi

    # Run the query. Output each row as tab-separated fields we then format below.
    # GROUP BY global_message_id dedupes messages that appear in multiple mailboxes
    # (common with Gmail's All Mail + a sub-label). MIN(mb.url) picks a stable
    # representative mailbox for display.
    local rows
    rows=$(sqlite3 -readonly -separator $'\x1f' "$db" "
SELECT m.message_id,
       MAX(m.read),
       MAX(m.flagged),
       CASE WHEN MIN(mb.url) LIKE '%/INBOX%' THEN 'INBOX'
            ELSE substr(MIN(mb.url), instr(MIN(mb.url), '/') + 2) END,
       datetime(MAX(m.date_received) + 978307200, 'unixepoch', 'localtime'),
       COALESCE(NULLIF(a.comment,'') || ' <' || a.address || '>', a.address),
       COALESCE(s.subject,'')
FROM messages m
LEFT JOIN addresses a ON m.sender = a.ROWID
LEFT JOIN subjects  s ON m.subject = s.ROWID
LEFT JOIN mailboxes mb ON m.mailbox = mb.ROWID
$where
GROUP BY m.global_message_id
ORDER BY MAX(m.date_received) DESC
LIMIT $cnt;
" 2>/dev/null) || return 1

    # Format output to match AppleScript path exactly.
    local scope_label="$mb_display"
    [[ "$all" == "true" ]] && scope_label="all mailboxes"
    local num_results
    if [[ -z "$rows" ]]; then
        num_results=0
    else
        num_results=$(printf '%s\n' "$rows" | grep -c .)
    fi

    if [[ $num_results -eq 0 ]]; then
        printf 'No results for: "%s"\n' "$q"
        return 0
    fi

    printf 'Search: "%s" in %s — %d result(s)\n' "$q" "$scope_label" "$num_results"
    printf '======================================\n'
    # Use a while-read loop with the 0x1f separator so fields containing spaces
    # or tabs stay intact.
    while IFS=$'\x1f' read -r msgid read_flag flagged_flag mbname dt sender subj; do
        [[ -z "$msgid" ]] && continue
        local rs="[ ]"; [[ "$read_flag" == "1" ]] && rs="[READ]"
        local fm="   ";  [[ "$flagged_flag" == "1" ]] && fm="[⚑]"
        # Strip trailing slash and URL-decode common mailbox characters for display.
        local mb_clean="${mbname//%20/ }"
        mb_clean="${mb_clean//%5B/[}"
        mb_clean="${mb_clean//%5D/]}"
        printf 'ID:%s %s %s [%s] %s | %s | %s\n' \
            "$msgid" "$rs" "$fm" "$mb_clean" "$dt" "$sender" "$subj"
    done <<< "$rows"

    return 0
}

# Purpose: Search emails by query string with optional filters (from, date range, unread, body).
# Parameters: [--mailbox name|unified-path|all] [--from addr] [--body] [--after date] [--before date] [--unread] <query> [count]
#   --mailbox accepts unified paths (e.g., "i/Receipts") or "all" for cross-account search
# Output: tab-separated search results to stdout
# Side effects: none (read-only)
# Performance: sender/subject/date searches use Mail's SQLite Envelope Index (~10ms).
#   Full-text body search (--body) falls back to the AppleScript path (slow).
search_emails() {
    local query="" mailbox_name="inbox" from_filter=""
    local unread_only="false" search_body="false" count=20 search_all="false"
    local after_date="" before_date=""

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --mailbox|-m)
                mailbox_name="$2"
                [[ "$2" == "all" ]] && search_all="true"
                shift 2 ;;
            all)   mailbox_name="all"; search_all="true"; shift ;;
            --from|-f)   from_filter="$2"; shift 2 ;;
            --unread|-u) unread_only="true"; shift ;;
            --body|-b)   search_body="true"; shift ;;
            --after)     after_date="$2"; shift 2 ;;
            --before)    before_date="$2"; shift 2 ;;
            *)
                if [[ -z "$query" ]]; then query="$1"
                elif [[ "$1" =~ ^[0-9]+$ ]]; then count="$1"
                fi
                shift ;;
        esac
    done

    # ─── SQLite fast-path ─────────────────────────────────────────────
    # For non-body searches, query Mail's Envelope Index SQLite DB directly.
    # Returns in milliseconds vs 30-90s for AppleScript iteration, and makes
    # --mailbox all trivially work (no AppleEvent timeout from per-mailbox fan-out).
    # --body still routes through AppleScript since body text isn't in the index.
    if [[ "$search_body" != "true" ]]; then
        local mb_like=""
        if [[ "$search_all" != "true" ]]; then
            # Translate common aliases + unified paths to a URL LIKE pattern against
            # mailboxes.url. Values are imap://GUID/PATH style. We intentionally use
            # broad patterns (trailing %) so hierarchical paths also match.
            local mb_lower
            mb_lower=$(echo "$mailbox_name" | tr '[:upper:]' '[:lower:]')
            case "$mb_lower" in
                ""|inbox)                 mb_like='%/INBOX%' ;;
                sent|"sent messages")     mb_like='%/Sent%' ;;
                drafts|draft)             mb_like='%/Drafts%' ;;
                trash|deleted|"deleted messages") mb_like='%/Deleted%' ;;
                junk|spam)                mb_like='%/Junk%' ;;
                *)
                    # Unified path or free-form mailbox name.
                    # resolve_path gives us a mailbox subpath; URL-encode spaces for matching.
                    resolve_path "$mailbox_name" 2>/dev/null || true
                    local raw="${_RP_MAILBOX:-$mailbox_name}"
                    local encoded="${raw// /%20}"
                    mb_like="%/${encoded}%"
                    ;;
            esac
        fi

        # Try the fast path. If it succeeds (rc=0), we're done.
        # rc=1 = SQL error, rc=2 = sqlite3 missing / DB unreadable, rc=3 = bad date —
        # all of which fall through to the AppleScript path below.
        if search_emails_sqlite \
            "$query" "$mailbox_name" "$from_filter" "$unread_only" \
            "$count" "$search_all" "$after_date" "$before_date" "$mb_like"; then
            return 0
        fi
    fi

    local esc_query esc_from esc_mb
    esc_query=$(osa_str "$query")
    esc_from=$(osa_str "$from_filter")
    esc_mb=$(osa_str "$mailbox_name")

    # Build mailbox list snippet — resolve unified paths via resolve_path
    local mb_list_osa
    if [[ "$search_all" == "true" ]]; then
        mb_list_osa=$(cat << 'MBLIST'
    set mailboxesToSearch to {inbox}
    try
        set end of mailboxesToSearch to sent mailbox
    end try
    repeat with acct_ in accounts
        try
            repeat with mb_ in mailboxes of acct_
                set end of mailboxesToSearch to mb_
            end repeat
        end try
    end repeat
MBLIST
)
    else
        resolve_path "$mailbox_name"
        mb_list_osa="$(mb_resolve_acct "$_RP_MAILBOX" "$_RP_ACCOUNT")
    set mailboxesToSearch to {targetMailbox}"
        esc_mb=$(osa_str "${_RP_MAILBOX}")
    fi

    # Convert YYYY-MM-DD to MM/DD/YYYY for AppleScript date comparison.
    local date_filter_osa=""
    if [[ -n "$after_date" ]]; then
        local after_year="${after_date:0:4}" after_month="${after_date:5:2}" after_day="${after_date:8:2}"
        date_filter_osa+="    set afterDate_ to date \"${after_month}/${after_day}/${after_year} 00:00:00\""$'\n'
        date_filter_osa+="    set filterAfter_ to true"$'\n'
    else
        date_filter_osa+="    set filterAfter_ to false"$'\n'
    fi
    if [[ -n "$before_date" ]]; then
        local before_year="${before_date:0:4}" before_month="${before_date:5:2}" before_day="${before_date:8:2}"
        date_filter_osa+="    set beforeDate_ to date \"${before_month}/${before_day}/${before_year} 23:59:59\""$'\n'
        date_filter_osa+="    set filterBefore_ to true"$'\n'
    else
        date_filter_osa+="    set filterBefore_ to false"$'\n'
    fi

    osascript << OSAEOF
tell application "Mail"
    if not running then launch

$mb_list_osa

$date_filter_osa
    set searchResults to {}
    set maxResults to $count

    repeat with searchMailbox in mailboxesToSearch
        try
            set msgList to messages of searchMailbox
            if $unread_only then
                set msgList to (messages of searchMailbox whose read status is false)
            end if

            repeat with msg in msgList
                if (count of searchResults) >= maxResults then exit repeat

                set msgSubject to subject of msg as string
                set msgSender to sender of msg as string

                set matchesQuery to false
                if "$esc_query" is "" then
                    set matchesQuery to true
                else if msgSubject contains "$esc_query" then
                    set matchesQuery to true
                else if msgSender contains "$esc_query" then
                    set matchesQuery to true
                end if

                if not matchesQuery and $search_body then
                    try
                        if (content of msg as string) contains "$esc_query" then
                            set matchesQuery to true
                        end if
                    end try
                end if

                set matchesFrom to true
                if "$esc_from" is not "" then
                    if msgSender does not contain "$esc_from" then
                        set matchesFrom to false
                    end if
                end if

                set includeMsg_ to true
                if filterAfter_ and (date received of msg) < afterDate_ then set includeMsg_ to false
                if filterBefore_ and (date received of msg) > beforeDate_ then set includeMsg_ to false
                if matchesQuery and matchesFrom and includeMsg_ then
                    set end of searchResults to msg
                end if
            end repeat
        end try
        if (count of searchResults) >= maxResults then exit repeat
    end repeat

    if (count of searchResults) = 0 then
        return "No results for: \"$esc_query\""
    end if

    set scopeLabel to "$esc_mb"
    if $search_all then set scopeLabel to "all mailboxes"
    set output to "Search: \"$esc_query\" in " & scopeLabel & " — " & (count of searchResults) & " result(s)" & linefeed
    set output to output & "======================================" & linefeed

    repeat with msg in searchResults
        set readStatus to "[ ]"
        if read status of msg then set readStatus to "[READ]"
        set flagMark to "   "
        try
            if flagged status of msg then set flagMark to "[⚑]"
        end try
        set mbName_ to ""
        try
            set mbName_ to name of mailbox of msg
        end try
        set output to output & "ID:" & (id of msg as string) & " " & readStatus & " " & flagMark & " [" & mbName_ & "] " & (date received of msg as string) & " | " & (sender of msg) & " | " & (subject of msg) & linefeed
    end repeat

    return output
end tell
OSAEOF
}

# ─────────────────────────────────────────────
# SEND
# ─────────────────────────────────────────────
# Purpose: Send a new email via Mail.app.
# Parameters: --to addr [--cc addr] [--bcc addr] [--from addr] [--subject text] [--body text] [--attachment path]
#   Also supports short form: send <to> <subject> <body>
# Output: confirmation message to stdout
# Side effects: sends email via configured Mail.app account
send_email() {
    local to_addrs=() cc_addr="" bcc_addr="" from_addr="" subject="" body=""
    local attachments=()

    if [[ $# -eq 3 ]] && [[ "$1" != --* ]]; then
        to_addrs=("$1"); subject="$2"; body="$3"
    else
        while [[ $# -gt 0 ]]; do
            case "$1" in
                --to|-t)      to_addrs+=("$2"); shift 2 ;;
                --cc|-c)      cc_addr="$2"; shift 2 ;;
                --bcc|-b)     bcc_addr="$2"; shift 2 ;;
                --from|-f)    from_addr="$2"; shift 2 ;;
                --subject|-s) subject="$2"; shift 2 ;;
                --body|-B)    body="$2"; shift 2 ;;
                --attach|--attachment|-A)  attachments+=("$2"); shift 2 ;;
                *) shift ;;
            esac
        done
    fi

    if [[ ${#to_addrs[@]} -eq 0 ]] || [[ -z "$subject" ]] || [[ -z "$body" ]]; then
        echo "Error: --to, --subject, and --body are all required"
        return 1
    fi

    for att_path in "${attachments[@]}"; do
        if [[ ! -f "$att_path" ]]; then
            echo "Error: Attachment not found: $att_path" >&2
            return 1
        fi
    done

    local esc_cc esc_bcc esc_from esc_subj esc_body
    esc_cc=$(osa_str "$cc_addr")
    esc_bcc=$(osa_str "$bcc_addr")
    esc_from=$(osa_str "$from_addr")
    esc_subj=$(osa_str "$subject")
    esc_body=$(osa_str "$body")

    local att_osa=""
    local att_count=${#attachments[@]}
    for att_path in "${attachments[@]}"; do
        local esc_att
        esc_att=$(osa_str "$att_path")
        att_osa+="        make new attachment with properties {file name: POSIX file \"${esc_att}\"} at end of content of newMessage"$'\n'
    done

    # Build to-recipients AppleScript block (supports multiple --to)
    local to_osa="" to_summary=""
    for addr in "${to_addrs[@]}"; do
        local esc_addr
        esc_addr=$(osa_str "$addr")
        to_osa+="        make new to recipient at end of to recipients with properties {address:\"${esc_addr}\"}"$'\n'
        [[ -n "$to_summary" ]] && to_summary+=", "
        to_summary+="$addr"
    done
    local esc_to_summary
    esc_to_summary=$(osa_str "$to_summary")

    osascript << OSAEOF
tell application "Mail"
    if not running then launch

    set msgProps to {subject:"$esc_subj", content:"$esc_body
"}
    if "$esc_from" is not "" then
        set msgProps to msgProps & {sender:"$esc_from"}
    end if

    set newMessage to make new outgoing message with properties msgProps
    tell newMessage
$to_osa
        if "$esc_cc" is not "" then
            make new cc recipient at end of cc recipients with properties {address:"$esc_cc"}
        end if
        if "$esc_bcc" is not "" then
            make new bcc recipient at end of bcc recipients with properties {address:"$esc_bcc"}
        end if
    end tell
$att_osa
    tell newMessage to send

    set resultStr to "Sent ($att_count attachment(s)) → $esc_to_summary"
    if $att_count = 0 then set resultStr to "Sent → $esc_to_summary"
    if "$esc_cc" is not "" then set resultStr to resultStr & " | CC: $esc_cc"
    if "$esc_bcc" is not "" then set resultStr to resultStr & " | BCC: $esc_bcc"
    return resultStr
end tell
OSAEOF
}

# ─────────────────────────────────────────────
# REPLY
# ─────────────────────────────────────────────
# Purpose: Reply to an existing email (single or reply-all).
# Parameters: [--mailbox name] <id> [--body text] [--reply-all] [--cc addr] [--bcc addr]
# Output: confirmation message to stdout
# Side effects: sends reply email via Mail.app
reply_email() {
    local email_id="$1"; shift
    local reply_body="" mailbox_name="inbox" reply_all="false" cc_addr="" bcc_addr=""
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --all|-a)     reply_all="true"; shift ;;
            --mailbox|-m) mailbox_name="$2"; shift 2 ;;
            --cc|-c)      cc_addr="$2"; shift 2 ;;
            --bcc|-b)     bcc_addr="$2"; shift 2 ;;
            *)            reply_body="$1"; shift ;;
        esac
    done

    local esc_body esc_mb esc_cc esc_bcc
    esc_body=$(osa_str "$reply_body")
    esc_mb=$(osa_str "$mailbox_name")
    esc_cc=$(osa_str "$cc_addr")
    esc_bcc=$(osa_str "$bcc_addr")

    osascript << OSAEOF
tell application "Mail"
    if not running then launch
$(mb_resolve "$mailbox_name")
$(find_msg "$email_id" "$mailbox_name")

    set originalSender to sender of targetMessage

    try
        set replyMessage to missing value
        if $reply_all then
            set replyMessage to reply targetMessage with reply to all
        else
            set replyMessage to reply targetMessage
        end if
        tell replyMessage
            set content to "$esc_body" & return & return & content
            if "$esc_cc" is not "" then
                make new cc recipient at end of cc recipients with properties {address:"$esc_cc"}
            end if
            if "$esc_bcc" is not "" then
                make new bcc recipient at end of bcc recipients with properties {address:"$esc_bcc"}
            end if
            send
        end tell
    on error
        -- Fallback: if Mail.app's native reply API fails, construct manual reply.
        set replySubject to subject of targetMessage
        if replySubject does not start with "Re: " then set replySubject to "Re: " & replySubject
        set newReply to make new outgoing message with properties {subject:replySubject, content:"$esc_body"}
        tell newReply
            make new to recipient at end of to recipients with properties {address:originalSender}
            if "$esc_cc" is not "" then
                make new cc recipient at end of cc recipients with properties {address:"$esc_cc"}
            end if
            if "$esc_bcc" is not "" then
                make new bcc recipient at end of bcc recipients with properties {address:"$esc_bcc"}
            end if
            send
        end tell
    end try

    set resultStr to "Reply sent → " & originalSender
    if $reply_all then set resultStr to resultStr & " (reply-all)"
    if "$esc_cc" is not "" then set resultStr to resultStr & " | CC: $esc_cc"
    if "$esc_bcc" is not "" then set resultStr to resultStr & " | BCC: $esc_bcc"
    return resultStr
end tell
OSAEOF
}

# ─────────────────────────────────────────────
# FORWARD
# ─────────────────────────────────────────────
# Purpose: Forward an email to a new recipient.
# Parameters: [--mailbox name] <id> --to addr [--body text]
# Output: confirmation message to stdout
# Side effects: sends forwarded email via Mail.app
forward_email() {
    local email_id="$1"; shift
    local to_addr="" extra_body="" mailbox_name="inbox"
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --to|-t)      to_addr="$2"; shift 2 ;;
            --body|-b)    extra_body="$2"; shift 2 ;;
            --mailbox|-m) mailbox_name="$2"; shift 2 ;;
            *) shift ;;
        esac
    done

    if [[ -z "$to_addr" ]]; then echo "Error: --to <address> required"; return 1; fi

    local esc_to esc_body esc_mb
    esc_to=$(osa_str "$to_addr")
    esc_body=$(osa_str "$extra_body")
    esc_mb=$(osa_str "$mailbox_name")

    osascript << OSAEOF
tell application "Mail"
    if not running then launch
$(mb_resolve "$mailbox_name")
$(find_msg "$email_id" "$mailbox_name")

    set fwdMessage to forward targetMessage
    tell fwdMessage
        make new to recipient at end of to recipients with properties {address:"$esc_to"}
        if "$esc_body" is not "" then
            set content to "$esc_body" & return & return & content
        end if
        send
    end tell
    return "Forwarded → $esc_to"
end tell
OSAEOF
}

# ─────────────────────────────────────────────
# DRAFT
# ─────────────────────────────────────────────
# Purpose: Open a compose window in Mail.app for review before sending.
# Parameters: --to addr [--cc addr] [--subject text] [--body text]
# Output: confirmation message to stdout
# Side effects: opens visible compose window; auto-saves to Drafts on close
save_draft() {
    local to_addr="" cc_addr="" subject="" body=""
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --to|-t)      to_addr="$2"; shift 2 ;;
            --cc|-c)      cc_addr="$2"; shift 2 ;;
            --subject|-s) subject="$2"; shift 2 ;;
            --body|-B)    body="$2"; shift 2 ;;
            *) shift ;;
        esac
    done

    local esc_to esc_cc esc_subj esc_body
    esc_to=$(osa_str "$to_addr")
    esc_cc=$(osa_str "$cc_addr")
    esc_subj=$(osa_str "$subject")
    esc_body=$(osa_str "$body")

    osascript << OSAEOF
tell application "Mail"
    if not running then launch
    set draftMsg to make new outgoing message with properties {subject:"$esc_subj", content:"$esc_body", visible:true}
    tell draftMsg
        if "$esc_to" is not "" then
            make new to recipient at end of to recipients with properties {address:"$esc_to"}
        end if
        if "$esc_cc" is not "" then
            make new cc recipient at end of cc recipients with properties {address:"$esc_cc"}
        end if
    end tell
    return "Draft opened for review: \"$esc_subj\""
end tell
OSAEOF
}

# ─────────────────────────────────────────────
# FLAG / UNFLAG
# ─────────────────────────────────────────────
# Purpose: Flag or unflag an email in Mail.app.
# Parameters: [--mailbox name] <id> <true|false>
# Output: confirmation message to stdout
# Side effects: changes flag status of the message
flag_email() {
    local email_id="$1" flag_state="$2"; shift 2
    local mailbox_name="inbox"
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --mailbox|-m) mailbox_name="$2"; shift 2 ;;
            *) shift ;;
        esac
    done

    local action_word
    [[ "$flag_state" == "true" ]] && action_word="Flagged" || action_word="Unflagged"
    local esc_mb
    esc_mb=$(osa_str "$mailbox_name")

    osascript << OSAEOF
tell application "Mail"
    if not running then launch
$(mb_resolve "$mailbox_name")
$(find_msg "$email_id" "$mailbox_name")
    set flagged status of targetMessage to $flag_state
    return "$action_word: " & (subject of targetMessage)
end tell
OSAEOF
}

# ─────────────────────────────────────────────
# MARK READ / UNREAD
# ─────────────────────────────────────────────
# Purpose: Mark an email as read or unread.
# Parameters: [--mailbox name] <id> <true|false> (true=read, false=unread)
# Output: confirmation message to stdout
# Side effects: changes read status of the message
mark_email() {
    local email_id="$1" read_state="$2"; shift 2
    local mailbox_name="inbox"
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --mailbox|-m) mailbox_name="$2"; shift 2 ;;
            *) shift ;;
        esac
    done

    local action_word
    [[ "$read_state" == "true" ]] && action_word="Marked read" || action_word="Marked unread"

    osascript << OSAEOF
tell application "Mail"
    if not running then launch
$(mb_resolve "$mailbox_name")
$(find_msg "$email_id" "$mailbox_name")
    set read status of targetMessage to $read_state
    return "$action_word: " & (subject of targetMessage)
end tell
OSAEOF
}

# ─────────────────────────────────────────────
# MOVE
# ─────────────────────────────────────────────
# Purpose: Move an email to a different mailbox.
# Parameters: <id> <destination-unified-path> [--mailbox src-unified-path]
#   Both source (--mailbox) and destination accept unified paths.
# Output: confirmation message to stdout
# Side effects: moves the message to the destination mailbox
move_email() {
    local email_id="$1" dest_name="$2"; shift 2
    local src_name="inbox"
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --mailbox|-m) src_name="$2"; shift 2 ;;
            *) shift ;;
        esac
    done

    # Resolve source via unified path
    resolve_path "$src_name"
    local src_mb="$_RP_MAILBOX" src_acct="$_RP_ACCOUNT"
    local src_osa
    src_osa=$(mb_resolve_acct "$src_mb" "$src_acct")

    # Resolve destination via unified path
    resolve_path "$dest_name"
    local dest_mb="$_RP_MAILBOX" dest_acct="$_RP_ACCOUNT"
    local dest_osa
    dest_osa=$(mb_resolve_acct "$dest_mb" "$dest_acct" | sed 's/targetMailbox/destMailbox/g; s/targetAccount/destAccount/g')

    local esc_dest
    esc_dest=$(osa_str "$dest_name")

    # Determine if this is a Gmail move from inbox (needs INBOX label cleanup)
    # Gmail IMAP: AppleScript "move" adds the dest label but doesn't remove INBOX.
    local src_mb_lower
    src_mb_lower=$(echo "$src_mb" | tr '[:upper:]' '[:lower:]')
    local needs_gmail_cleanup=false
    if [[ "$src_mb_lower" == "inbox" || -z "$src_mb_lower" ]]; then
        # Source is inbox -- check if dest account is Gmail (or source account if specified)
        local effective_acct="${dest_acct:-$src_acct}"
        if [[ "$effective_acct" == "Google" ]] && command -v gws &>/dev/null; then
            needs_gmail_cleanup=true
        fi
    fi

    local result rc
    if $needs_gmail_cleanup; then
        # Gmail path: get message id property, do the move, then strip INBOX label via gws
        result=$(osascript << OSAEOF
tell application "Mail"
    if not running then launch
$src_osa
$(find_msg "$email_id" "$src_mb")
    set msgSubject to subject of targetMessage
    set msgIdVal to message id of targetMessage
$dest_osa
    move targetMessage to destMailbox
    return "MSGID:" & msgIdVal & linefeed & "Moved \"" & msgSubject & "\" → $esc_dest"
end tell
OSAEOF
)
        rc=$?

        # Show the user-facing message (strip internal MSGID line)
        echo "$result" | grep -v "^MSGID:"

        # Post-move: remove INBOX label via Gmail API so email leaves the inbox
        if [[ $rc -eq 0 ]]; then
            local msg_id_header
            msg_id_header=$(echo "$result" | grep "^MSGID:" | sed 's/^MSGID://' | xargs)
            if [[ -n "$msg_id_header" ]]; then
                # Search Gmail by RFC822 Message-ID to get the Gmail internal ID
                local gmail_id
                gmail_id=$(gws gmail users messages list \
                    --params "{\"userId\":\"me\",\"q\":\"rfc822msgid:${msg_id_header}\",\"maxResults\":1}" \
                    2>/dev/null | grep '"id"' | head -1 | sed 's/.*"id": *"//;s/".*//')
                if [[ -n "$gmail_id" ]]; then
                    gws gmail users messages modify \
                        --params "{\"userId\":\"me\",\"id\":\"${gmail_id}\"}" \
                        --json '{"removeLabelIds":["INBOX"]}' &>/dev/null \
                        && echo "  (Gmail INBOX label removed)" \
                        || echo "  (Warning: Gmail INBOX label removal failed)" >&2
                fi
            fi
        fi
        return $rc
    else
        # Standard move (iCloud or non-inbox source -- AppleScript handles correctly)
        osascript << OSAEOF
tell application "Mail"
    if not running then launch
$src_osa
$(find_msg "$email_id" "$src_mb")
    set msgSubject to subject of targetMessage
$dest_osa
    move targetMessage to destMailbox
    return "Moved \"" & msgSubject & "\" → $esc_dest"
end tell
OSAEOF
    fi
}

# ─────────────────────────────────────────────
# TRASH
# ─────────────────────────────────────────────
# Purpose: Move an email to the trash.
# Parameters: <id> [--mailbox unified-path]
# Output: confirmation message to stdout
# Side effects: moves the message to Trash
trash_email() {
    local email_id="$1"; shift
    local mailbox_name="inbox"
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --mailbox|-m) mailbox_name="$2"; shift 2 ;;
            *) shift ;;
        esac
    done

    resolve_path "$mailbox_name"
    local mb_osa
    mb_osa=$(mb_resolve_acct "$_RP_MAILBOX" "$_RP_ACCOUNT")

    osascript << OSAEOF
tell application "Mail"
    if not running then launch
$mb_osa
$(find_msg "$email_id" "$_RP_MAILBOX")
    set msgSubject to subject of targetMessage
    delete targetMessage
    return "Moved to trash: \"" & msgSubject & "\""
end tell
OSAEOF
}

# ─────────────────────────────────────────────
# UNREAD COUNT
# ─────────────────────────────────────────────
# Purpose: Count unread emails in one or all mailboxes.
# Parameters: [unified-path] [--mailbox name]
#   Accepts unified path as first positional arg or via --mailbox flag.
# Output: unread count per mailbox to stdout
# Side effects: none (read-only)
count_unread() {
    local mailbox_name="" unified_path="" mailbox_flag_used="false"
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --mailbox|-m) mailbox_name="$2"; mailbox_flag_used="true"; shift 2 ;;
            *)
                if [[ -z "$unified_path" ]]; then
                    unified_path="$1"
                fi
                shift ;;
        esac
    done

    if [[ "$mailbox_flag_used" == "true" ]]; then
        resolve_path "$mailbox_name"
    else
        resolve_path "$unified_path"
    fi

    local esc_mb mb_osa
    esc_mb=$(osa_str "${unified_path:-${mailbox_name:-inbox}}")
    mb_osa=$(mb_resolve_acct "$_RP_MAILBOX" "$_RP_ACCOUNT")

    osascript << OSAEOF
tell application "Mail"
    if not running then launch
$mb_osa
    set unreadCount to (count of (messages of targetMailbox whose read status is false))
    set totalCount to (count of messages of targetMailbox)
    return "Mailbox: $esc_mb" & linefeed & "Unread: " & unreadCount & " / " & totalCount & " total"
end tell
OSAEOF
}

# ─────────────────────────────────────────────
# THREAD
# ─────────────────────────────────────────────
# Purpose: Get thread/conversation headers for a message.
# Parameters: [--mailbox name] <id>
# Output: tab-separated thread message headers to stdout
# Side effects: none (read-only)
get_thread() {
    local email_id="$1"; shift
    local mailbox_name="inbox"
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --mailbox|-m) mailbox_name="$2"; shift 2 ;;
            *) shift ;;
        esac
    done

    osascript << OSAEOF
tell application "Mail"
    if not running then launch
$(mb_resolve "$mailbox_name")
$(find_msg "$email_id" "$mailbox_name")

    set baseSubject to subject of targetMessage as string
    if baseSubject starts with "Re: " then set baseSubject to text 5 thru -1 of baseSubject
    if baseSubject starts with "Fwd: " then set baseSubject to text 6 thru -1 of baseSubject
    if baseSubject starts with "FW: " then set baseSubject to text 5 thru -1 of baseSubject
    if baseSubject starts with "RE: " then set baseSubject to text 5 thru -1 of baseSubject

    set threadMessages to {}
    repeat with msg in messages of targetMailbox
        set s to subject of msg as string
        if s starts with "Re: " then set s to text 5 thru -1 of s
        if s starts with "Fwd: " then set s to text 6 thru -1 of s
        if s starts with "FW: " then set s to text 5 thru -1 of s
        if s starts with "RE: " then set s to text 5 thru -1 of s
        if s is baseSubject then set end of threadMessages to msg
    end repeat

    set output to "Thread: \"" & baseSubject & "\" — " & (count of threadMessages) & " message(s)" & linefeed
    set output to output & "======================================" & linefeed

    repeat with msg in threadMessages
        set readStatus to "[ ]"
        if read status of msg then set readStatus to "[READ]"
        set output to output & "ID:" & (id of msg as string) & " " & readStatus & " | " & (date received of msg as string) & " | " & (sender of msg) & " | " & (subject of msg) & linefeed
    end repeat

    return output
end tell
OSAEOF
}

# ─────────────────────────────────────────────
# THREAD READ
# ─────────────────────────────────────────────
# Purpose: Get full thread with message bodies, sorted chronologically (oldest first).
# Parameters: [--mailbox name] <id>
# Output: full messages with headers and bodies to stdout
# Side effects: none (read-only)
thread_read() {
    local email_id="$1"; shift
    local mailbox_name="inbox"
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --mailbox|-m) mailbox_name="$2"; shift 2 ;;
            *) shift ;;
        esac
    done

    local esc_mb
    esc_mb=$(osa_str "$mailbox_name")

    osascript << OSAEOF
tell application "Mail"
    if not running then launch
$(mb_resolve "$mailbox_name")
$(find_msg "$email_id" "$mailbox_name")

    set baseSubject to subject of targetMessage
    repeat
        if baseSubject starts with "Re: " then
            set baseSubject to text 5 thru end of baseSubject
        else if baseSubject starts with "Fwd: " then
            set baseSubject to text 6 thru end of baseSubject
        else if baseSubject starts with "RE: " then
            set baseSubject to text 5 thru end of baseSubject
        else if baseSubject starts with "FW: " then
            set baseSubject to text 5 thru end of baseSubject
        else
            exit repeat
        end if
    end repeat

    set threadMsgs to {}
    repeat with msg in messages of targetMailbox
        set msgSubj to subject of msg
        repeat
            if msgSubj starts with "Re: " then
                set msgSubj to text 5 thru end of msgSubj
            else if msgSubj starts with "Fwd: " then
                set msgSubj to text 6 thru end of msgSubj
            else if msgSubj starts with "RE: " then
                set msgSubj to text 5 thru end of msgSubj
            else if msgSubj starts with "FW: " then
                set msgSubj to text 5 thru end of msgSubj
            else
                exit repeat
            end if
        end repeat
        if msgSubj is baseSubject then
            set end of threadMsgs to msg
        end if
    end repeat

    set threadCount to count of threadMsgs
    set output to "Thread: \"" & baseSubject & "\" — " & threadCount & " message(s)" & linefeed
    set output to output & "======================================" & linefeed

    set msgIndex to 0
    repeat with msg in threadMsgs
        set msgIndex to msgIndex + 1
        set output to output & "[" & msgIndex & "/" & threadCount & "] " & (sender of msg) & " | " & (date received of msg as string) & " | ID: " & (id of msg as string) & linefeed
        set output to output & "--------------------------------------" & linefeed
        set output to output & (content of msg) & linefeed
        set output to output & linefeed
    end repeat

    return output
end tell
OSAEOF
}

# ─────────────────────────────────────────────
# SAVE ATTACHMENT
# ─────────────────────────────────────────────
# Purpose: Save one or all attachments from an email to disk.
# Parameters: [--mailbox name] <id> [name|index] [--output path]
# Output: saved file path(s) to stdout
# Side effects: writes file(s) to disk (default: ~/Downloads/)
save_attachment() {
    local email_id="$1"; shift
    local mailbox_name="inbox" out_dir="$HOME/Downloads"

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --mailbox|-m) mailbox_name="$2"; shift 2 ;;
            --out|-o)     out_dir="$2"; shift 2 ;;
            *) shift ;;
        esac
    done

    if [[ -z "$email_id" ]]; then echo "Error: Email ID required" >&2; return 1; fi

    mkdir -p "$out_dir" 2>/dev/null

    local esc_out
    esc_out=$(osa_str "$out_dir")

    osascript << OSAEOF
tell application "Mail"
    if not running then launch
$(mb_resolve "$mailbox_name")
$(find_msg "$email_id" "$mailbox_name")

    set attList to mail attachments of targetMessage
    set attCount to count of attList
    if attCount = 0 then
        return "No attachments found on email ID $email_id"
    end if

    set savedFiles to ""
    repeat with att in attList
        set attName to name of att
        set outPath to "$esc_out/" & attName
        try
            save att in POSIX file outPath
            set savedFiles to savedFiles & "Saved: " & attName & " → " & outPath & linefeed
        on error errMsg
            set savedFiles to savedFiles & "Error saving " & attName & ": " & errMsg & linefeed
        end try
    end repeat

    return "Saved " & attCount & " attachment(s):" & linefeed & savedFiles
end tell
OSAEOF
}

# ─────────────────────────────────────────────
# ATTACHMENTS
# ─────────────────────────────────────────────
# Purpose: List all attachments in an email with name, MIME type, and size.
# Parameters: [--mailbox name] <id>
# Output: tab-separated attachment info (name, MIME, size) to stdout
# Side effects: none (read-only)
list_attachments() {
    local email_id="$1"; shift
    local mailbox_name="inbox"
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --mailbox|-m) mailbox_name="$2"; shift 2 ;;
            *) shift ;;
        esac
    done

    osascript << OSAEOF
tell application "Mail"
    if not running then launch
$(mb_resolve "$mailbox_name")
$(find_msg "$email_id" "$mailbox_name")

    set attList to mail attachments of targetMessage
    if (count of attList) = 0 then
        return "No attachments in: " & (subject of targetMessage)
    end if

    set output to "Attachments for: \"" & (subject of targetMessage) & "\"" & linefeed
    set output to output & "======================================" & linefeed
    set n to 1

    repeat with att in attList
        set attName to name of att
        set attMime to mime type of att
        try
            set output to output & n & ". " & attName & " | " & attMime & " | " & (file size of att) & " bytes" & linefeed
        on error
            set output to output & n & ". " & attName & " | " & attMime & linefeed
        end try
        set n to n + 1
    end repeat

    return output
end tell
OSAEOF
}

# ─────────────────────────────────────────────
# OPEN
# ─────────────────────────────────────────────
# Purpose: Open a specific email message in Mail.app's GUI window.
# Parameters: $1 — message ID (required), optional --mailbox flag
# Output: confirmation message or error
# Side effects: activates Mail.app, opens message window
open_email() {
    local email_id="$1"; shift
    local mailbox_name=""
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --mailbox|-m) mailbox_name="$2"; shift 2 ;;
            *) shift ;;
        esac
    done

    local esc_id
    esc_id=$(osa_str "$email_id")

    if [[ -n "$mailbox_name" ]]; then
        local script
        script=$(cat <<OSAEOF
tell application "Mail"
    activate
$(mb_resolve "$mailbox_name")
$(find_msg "$email_id" "$mailbox_name")

    open targetMessage
    return "Opened: " & (subject of targetMessage)
end tell
OSAEOF
)
        osascript -e "$script"
    else
        local script
        script=$(cat <<OSAEOF
tell application "Mail"
    activate
    set targetID to ($esc_id as integer)
    repeat with acct in every account
        repeat with mbox in every mailbox of acct
            try
                set msgs to (messages of mbox whose id is targetID)
                if (count of msgs) > 0 then
                    open item 1 of msgs
                    return "Opened: " & (subject of item 1 of msgs)
                end if
            end try
        end repeat
    end repeat
    return "Error: Email ID $esc_id not found"
end tell
OSAEOF
)
        osascript -e "$script"
    fi
}

# ─────────────────────────────────────────────
# EXPORT TO MARKDOWN
# ─────────────────────────────────────────────
# Purpose: Export an email to Obsidian-compatible markdown (.email.md) with YAML frontmatter.
# Parameters: [--mailbox name] <id> [--output path]
# Output: file path of created .email.md to stdout
# Side effects: writes markdown file to disk
# Note: uses ||| delimiter and \a record separator for safe field parsing.
export_email() {
    local email_id="$1"; shift
    local mailbox_name="inbox" out_path=""

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --mailbox|-m) mailbox_name="$2"; shift 2 ;;
            --out|-o)     out_path="$2"; shift 2 ;;
            *) shift ;;
        esac
    done

    if [[ -z "$email_id" ]]; then echo "Error: Email ID required" >&2; return 1; fi

    local raw
    raw=$(osascript << OSAEOF
tell application "Mail"
    if not running then launch
$(mb_resolve "$mailbox_name")
$(find_msg "$email_id" "$mailbox_name")

    set msgSubject to subject of targetMessage
    set msgSender to sender of targetMessage
    set msgDate to date received of targetMessage
    set msgBody to content of targetMessage

    set toAddrs to ""
    try
        repeat with r in to recipients of targetMessage
            if toAddrs is not "" then set toAddrs to toAddrs & ", "
            set toAddrs to toAddrs & (address of r)
        end repeat
    end try

    set ccAddrs to ""
    try
        repeat with r in cc recipients of targetMessage
            if ccAddrs is not "" then set ccAddrs to ccAddrs & ", "
            set ccAddrs to ccAddrs & (address of r)
        end repeat
    end try

    set attNames to ""
    try
        repeat with att in mail attachments of targetMessage
            if attNames is not "" then set attNames to attNames & ", "
            set attNames to attNames & (name of att)
        end repeat
    end try

    return msgSubject & "|||" & msgSender & "|||" & (msgDate as string) & "|||" & toAddrs & "|||" & ccAddrs & "|||" & attNames & "|||" & msgBody
end tell
OSAEOF
)

    # Use ||| as field delimiter and bell character (\a) as record separator.
    # Avoids conflicts with tabs, newlines, and pipes in email content.
    local subj sender date_str to_str cc_str att_str body_str
    subj=$(printf '%s\a' "$raw" | awk 'BEGIN{RS="\a"; FS="\\|\\|\\|"} {print $1}')
    sender=$(printf '%s\a' "$raw" | awk 'BEGIN{RS="\a"; FS="\\|\\|\\|"} {print $2}')
    date_str=$(printf '%s\a' "$raw" | awk 'BEGIN{RS="\a"; FS="\\|\\|\\|"} {print $3}')
    to_str=$(printf '%s\a' "$raw" | awk 'BEGIN{RS="\a"; FS="\\|\\|\\|"} {print $4}')
    cc_str=$(printf '%s\a' "$raw" | awk 'BEGIN{RS="\a"; FS="\\|\\|\\|"} {print $5}')
    att_str=$(printf '%s\a' "$raw" | awk 'BEGIN{RS="\a"; FS="\\|\\|\\|"} {print $6}')
    body_str=$(printf '%s\a' "$raw" | awk 'BEGIN{RS="\a"; FS="\\|\\|\\|"} {print $7}')
    local nl
    nl=$(printf '\n')
    subj="${subj//$nl/ }"
    sender="${sender//$nl/ }"
    date_str="${date_str//$nl/ }"
    to_str="${to_str//$nl/ }"
    cc_str="${cc_str//$nl/ }"
    att_str="${att_str//$nl/ }"

    local today
    today=$(date '+%Y-%m-%d')
    if [[ -z "$out_path" ]]; then
        local safe_subj
        safe_subj=$(echo "$subj" | tr '/:*?"<>|\\' '-' | cut -c1-60)
        out_path="$HOME/Downloads/${today} ${safe_subj}.email.md"
    fi

    local sender_email
    sender_email=$(echo "$sender" | grep -oE '[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}' | head -1)

    {
        echo "---"
        echo "created: $today"
        echo "modified: $today"
        echo "document-type: email"
        echo "status: archive"
        echo "tags:"
        echo "  - email-archive"
        echo "from: ${sender_email:-$sender}"
        echo "to: $to_str"
        [[ -n "$cc_str" ]] && echo "cc: $cc_str"
        echo "subject: $subj"
        echo "date: $today"
        echo "email-id: $email_id"
        echo "---"
        echo "# $subj"
        echo ""
        echo "**From:** $sender"
        [[ -n "$to_str" ]] && echo "**To:** $to_str"
        [[ -n "$cc_str" ]] && echo "**CC:** $cc_str"
        echo "**Date:** $date_str"
        echo ""
        echo "---"
        echo ""
        echo "$body_str"
        [[ -n "$att_str" ]] && echo "" && echo "**Attachments:** $att_str"
    } > "$out_path"

    echo "Exported: $out_path"
}

# ─────────────────────────────────────────────
# ARCHIVE
# ─────────────────────────────────────────────
# Purpose: Archive an email (move to Archive mailbox).
# Parameters: <id> [--mailbox unified-path]
# Output: confirmation message to stdout
# Side effects: moves message to Archive mailbox
archive_email() {
    local email_id="$1"; shift
    local mailbox_name="inbox"
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --mailbox|-m) mailbox_name="$2"; shift 2 ;;
            *) shift ;;
        esac
    done

    if [[ -z "$email_id" ]]; then echo "Error: Email ID required" >&2; return 1; fi

    resolve_path "$mailbox_name"
    local mb_osa
    mb_osa=$(mb_resolve_acct "$_RP_MAILBOX" "$_RP_ACCOUNT")
    local dest_osa
    dest_osa=$(mb_resolve_acct "Archive" "$_RP_ACCOUNT" | sed 's/targetMailbox/destMailbox/g; s/targetAccount/destAccount/g')

    osascript << OSAEOF
tell application "Mail"
    if not running then launch
$mb_osa
$(find_msg "$email_id" "$_RP_MAILBOX")
$dest_osa
    set msgSubject to subject of targetMessage
    move targetMessage to destMailbox
    return "Archived: " & msgSubject & " → Archive"
end tell
OSAEOF
}

# ─────────────────────────────────────────────
# BULK OPERATIONS
# ─────────────────────────────────────────────
# Purpose: Bulk operations (trash, move, mark-read, archive, flag, unflag, mark-unread, junk, not-junk) on entire mailboxes.
# Parameters: <operation> --mailbox unified-path [--unread-only] [--dest unified-path] [--color N] [--confirm|--force]
# Output: count or confirmation to stdout
# Side effects: depends on operation -- trash/move/mark-read/flag/archive/junk messages
# Two-phase: count first (always), then dry-run/confirm/force execution.
bulk_operation() {
    local op="$1"; shift
    local mailbox_name="" dest_name="" unread_only="false" confirm="false" force="false"
    local flag_color=""  # Note: Apple Mail AppleScript does not support flag colors; parsed but unused

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --mailbox|-m)  mailbox_name="$2"; shift 2 ;;
            --dest|-d)     dest_name="$2"; shift 2 ;;
            --unread-only|-u) unread_only="true"; shift ;;
            --confirm|-c)  confirm="true"; shift ;;
            --force|-f)    force="true"; confirm="true"; shift ;;
            --color)       flag_color="$2"; shift 2 ;;
            *) shift ;;
        esac
    done

    if [[ -z "$mailbox_name" ]]; then
        echo "Error: --mailbox <name> required" >&2; return 1
    fi
    if [[ "$op" == "move" ]] && [[ -z "$dest_name" ]]; then
        echo "Error: --dest <folder> required for bulk-move" >&2; return 1
    fi

    # Resolve source mailbox via unified path
    resolve_path "$mailbox_name"
    local src_mb="$_RP_MAILBOX" src_acct="$_RP_ACCOUNT"
    local esc_mb
    esc_mb=$(osa_str "$mailbox_name")
    local mb_osa
    mb_osa=$(mb_resolve_acct "$src_mb" "$src_acct")

    # Resolve destination if needed (move operation)
    local esc_dest=""
    local dest_osa=""
    if [[ "$op" == "move" ]]; then
        resolve_path "$dest_name"
        esc_dest=$(osa_str "$dest_name")
        dest_osa=$(mb_resolve_acct "$_RP_MAILBOX" "$_RP_ACCOUNT" | sed 's/targetMailbox/destMailbox/g; s/targetAccount/destAccount/g')
    fi

    local action_osa=""
    case "$op" in
        trash)
            action_osa='delete msg_'
            ;;
        move)
            action_osa='move msg_ to destMailbox'
            ;;
        mark-read)
            action_osa='set read status of msg_ to true'
            ;;
        archive)
            action_osa='move msg_ to destMailbox'
            dest_osa=$(mb_resolve_acct "Archive" "$src_acct" | sed 's/targetMailbox/destMailbox/g; s/targetAccount/destAccount/g')
            ;;
        flag)
            action_osa='set flagged status of msg_ to true'
            ;;
        unflag)
            action_osa='set flagged status of msg_ to false'
            ;;
        mark-unread)
            action_osa='set read status of msg_ to false'
            ;;
        junk)
            action_osa='set junk mail status of msg_ to true
                move msg_ to junk mailbox'
            ;;
        not-junk)
            action_osa='set junk mail status of msg_ to false
                move msg_ to inbox'
            ;;
    esac

    local filter_osa=""
    if [[ "$unread_only" == "true" ]]; then
        filter_osa='set msgList to (messages of targetMailbox whose read status is false)'
    else
        filter_osa='set msgList to messages of targetMailbox'
    fi

    # Always get count first
    local count_result
    count_result=$(osascript << OSAEOF
tell application "Mail"
    if not running then launch
$mb_osa
    $filter_osa
    return (count of msgList) as string
end tell
OSAEOF
)

    if [[ "$confirm" != "true" ]]; then
        echo "DRY-RUN: Would $op $count_result message(s) from: $mailbox_name"
        [[ "$op" == "move" ]] && echo "Destination: $dest_name"
        echo "Add --confirm to execute (with prompt) or --force to execute immediately."
        return 0
    fi

    if [[ "$force" != "true" ]]; then
        echo "This will $op $count_result message(s) from: $mailbox_name"
        [[ "$op" == "move" ]] && echo "Destination: $dest_name"
        read -r -p "Proceed? [y/N] " response
        if [[ ! "$response" =~ ^[Yy]$ ]]; then
            echo "Cancelled."
            return 0
        fi
    fi

    osascript << OSAEOF
tell application "Mail"
    if not running then launch
$mb_osa
$dest_osa
    $filter_osa
    set msgCount to count of msgList
    repeat with i from msgCount to 1 by -1
        set msg_ to item i of msgList
        $action_osa
    end repeat
    return (msgCount as string) & " message(s) processed from: $esc_mb"
end tell
OSAEOF
}

# ─────────────────────────────────────────────
# BULK OPERATION BY IDS
# ─────────────────────────────────────────────
# Purpose: Apply an operation (trash, move, archive, mark-read, flag, etc.)
#   to specific messages identified by their numeric IDs in a single AppleScript call.
# Parameters: $1 — operation name, remaining — IDs and flags
# Output: count of successfully processed messages to stdout; warnings for not-found IDs to stderr
# Side effects: modifies messages in Mail.app
# Flags: --mailbox <path> (optional, defaults to inbox), --dest <path> (required for move)
bulk_operation_by_ids() {
    local op="$1"; shift
    local mailbox_name="inbox" dest_name=""
    local -a ids=()

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --mailbox|-m) mailbox_name="$2"; shift 2 ;;
            --dest|-d)    dest_name="$2"; shift 2 ;;
            --)           shift; break ;;
            -*)           echo "Warning: Unknown flag $1 ignored" >&2; shift ;;
            *)            ids+=("$1"); shift ;;
        esac
    done
    # Remaining args after -- are also IDs
    while [[ $# -gt 0 ]]; do
        ids+=("$1"); shift
    done

    # For bulk-move-ids, the last non-flag arg before --mailbox is the dest path
    # Re-parse: if op is "move" and no --dest was given, treat last ID as dest
    if [[ "$op" == "move" ]] && [[ -z "$dest_name" ]]; then
        if [[ ${#ids[@]} -lt 2 ]]; then
            echo "Error: bulk-move-ids requires at least one ID and a destination path" >&2
            return 1
        fi
        dest_name="${ids[-1]}"
        unset 'ids[-1]'
    fi

    if [[ ${#ids[@]} -eq 0 ]]; then
        echo "Error: At least one message ID required" >&2
        return 1
    fi
    if [[ "$op" == "move" ]] && [[ -z "$dest_name" ]]; then
        echo "Error: Destination path required for bulk-move-ids (last positional arg or --dest)" >&2
        return 1
    fi

    # Resolve source mailbox via unified path
    resolve_path "$mailbox_name"
    local src_mb="$_RP_MAILBOX" src_acct="$_RP_ACCOUNT"
    local esc_mb
    esc_mb=$(osa_str "$mailbox_name")
    local mb_osa
    mb_osa=$(mb_resolve_acct "$src_mb" "$src_acct")

    # Resolve destination if needed
    local dest_osa=""
    local esc_dest=""
    if [[ "$op" == "move" ]]; then
        resolve_path "$dest_name"
        esc_dest=$(osa_str "$dest_name")
        dest_osa=$(mb_resolve_acct "$_RP_MAILBOX" "$_RP_ACCOUNT" | sed 's/targetMailbox/destMailbox/g; s/targetAccount/destAccount/g')
    elif [[ "$op" == "archive" ]]; then
        dest_osa=$(mb_resolve_acct "Archive" "$src_acct" | sed 's/targetMailbox/destMailbox/g; s/targetAccount/destAccount/g')
    fi

    # Build the action AppleScript fragment
    local action_osa=""
    case "$op" in
        trash)       action_osa='delete msg_' ;;
        move)        action_osa='move msg_ to destMailbox' ;;
        mark-read)   action_osa='set read status of msg_ to true' ;;
        archive)     action_osa='move msg_ to destMailbox' ;;
        flag)        action_osa='set flagged status of msg_ to true' ;;
        unflag)      action_osa='set flagged status of msg_ to false' ;;
        mark-unread) action_osa='set read status of msg_ to false' ;;
        *)           echo "Error: Unknown operation '$op'" >&2; return 1 ;;
    esac

    # Build the AppleScript ID list: {88849, 88821, 88819}
    local id_list=""
    for id in "${ids[@]}"; do
        if [[ -n "$id_list" ]]; then
            id_list="${id_list}, ${id}"
        else
            id_list="${id}"
        fi
    done

    osascript << OSAEOF
tell application "Mail"
    if not running then launch
$mb_osa
$dest_osa
    set idTextList to "${id_list}"
    set AppleScript's text item delimiters to ", "
    set idTokens to text items of idTextList
    set AppleScript's text item delimiters to ""
    set successCount to 0
    set failedIds to {}
    repeat with idToken in idTokens
        set targetId to (idToken as integer)
        try
            set msg_ to first message of targetMailbox whose id is targetId
            ${action_osa}
            set successCount to successCount + 1
        on error
            copy idToken to end of failedIds
        end try
    end repeat
    set resultText to (successCount as string) & " of " & ((count of idTokens) as string) & " message(s) processed"
    if (count of failedIds) > 0 then
        set AppleScript's text item delimiters to ", "
        set failedStr to failedIds as string
        set AppleScript's text item delimiters to ""
        set resultText to resultText & " (not found: " & failedStr & ")"
    end if
    return resultText
end tell
OSAEOF
}

# ─────────────────────────────────────────────
# AUDIT JUNK
# ─────────────────────────────────────────────
# Purpose: Scan Junk mailbox for recurring sender domains,
#   cross-reference against junk_senders table, and optionally auto-block.
# Parameters: [--account <alias>] [--dry-run] [--threshold N] [--auto-block N] [--db <path>] [--trash]
#   --account:     account alias (default: "i" for iCloud)
#   --dry-run:     show what would be added without modifying DB
#   --threshold:   minimum domain occurrences to include in report (default: 2)
#   --auto-block:  auto-add domains with N+ occurrences to junk_senders
#   --db:          path to triage.db (default: ~/.claude/skills/EmailTriage/triage.db)
#   --trash:       bulk-trash Junk folder contents after audit
# Output: report of domains sorted by frequency
# Side effects: with --auto-block, inserts into junk_senders; with --trash, deletes junk emails
audit_junk() {
    local account_alias="i" dry_run="false" threshold=2 auto_block=0
    local db_path="" trash_after="false"

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --account|-a)  account_alias="$2"; shift 2 ;;
            --dry-run|-n)  dry_run="true"; shift ;;
            --threshold|-t) threshold="$2"; shift 2 ;;
            --auto-block|-b) auto_block="$2"; shift 2 ;;
            --db|-d)       db_path="$2"; shift 2 ;;
            --trash)       trash_after="true"; shift ;;
            *) shift ;;
        esac
    done

    # Default DB path
    : "${db_path:=$HOME/.claude/skills/EmailTriage/triage.db}"

    # Verify DB exists
    if [[ ! -f "$db_path" ]]; then
        echo "Error: Database not found at: $db_path" >&2
        return 1
    fi

    # Resolve the Junk mailbox for the specified account
    local mailbox_path="${account_alias}/junk"
    resolve_path "$mailbox_path"
    local src_mb="$_RP_MAILBOX" src_acct="$_RP_ACCOUNT"
    local mb_osa
    mb_osa=$(mb_resolve_acct "$src_mb" "$src_acct")

    echo "Scanning Junk mailbox for account: ${src_acct}..."

    # Collect all sender addresses from the Junk mailbox using AppleScript
    local senders_raw
    senders_raw=$(osascript << OSAEOF
tell application "Mail"
    if not running then launch
$mb_osa
    set allMessages to messages of targetMailbox
    set msgCount to count of allMessages
    if msgCount = 0 then
        return "NO_MESSAGES"
    end if
    set senderList to {}
    repeat with msg in allMessages
        set end of senderList to sender of msg
    end repeat
    set AppleScript's text item delimiters to "|||"
    set result to senderList as string
    set AppleScript's text item delimiters to ""
    return result
end tell
OSAEOF
)

    if [[ "$senders_raw" == "NO_MESSAGES" ]]; then
        echo "No messages found in Junk mailbox."
        return 0
    fi

    # Parse senders with awk (bash 3.2 compatible, no associative arrays)
    # Sender format: "Name <email@domain.com>" or plain "email@domain.com"
    # Output: "count domain sample_email" per domain, sorted by count descending
    local domain_report
    domain_report=$(echo "$senders_raw" | awk -F '\\|\\|\\|' -v threshold="$threshold" '
    {
        for (i = 1; i <= NF; i++) {
            sender = $i
            gsub(/^[ \t]+|[ \t]+$/, "", sender)
            if (sender == "") continue

            email = ""
            # Extract from <email> (BSD awk compatible: no 3-arg match)
            if (match(sender, /<[^>]+>/)) {
                email = substr(sender, RSTART + 1, RLENGTH - 2)
            } else if (match(sender, /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/)) {
                email = substr(sender, RSTART, RLENGTH)
            }
            if (email == "") continue

            email = tolower(email)
            n = split(email, parts, "@")
            domain = parts[n]

            total_msgs++
            domain_count[domain]++
            if (!(domain in domain_sample)) {
                domain_sample[domain] = email
            }
        }
    }
    END {
        for (d in domain_count) {
            if (domain_count[d] >= threshold) {
                printf "%d %s %s\n", domain_count[d], d, domain_sample[d]
            }
        }
        # Print total stats to stderr for the header
        print "STATS " total_msgs " " length(domain_count) > "/dev/stderr"
    }
    ' 2>&1 | sort -rn)

    # Extract stats line from awk stderr
    local total_messages unique_domains
    local stats_line
    stats_line=$(echo "$domain_report" | grep "^STATS " | head -1)
    if [[ -n "$stats_line" ]]; then
        total_messages=$(echo "$stats_line" | awk '{print $2}')
        unique_domains=$(echo "$stats_line" | awk '{print $3}')
        # Remove the stats line from the report
        domain_report=$(echo "$domain_report" | grep -v "^STATS ")
    else
        total_messages=0
        unique_domains=0
    fi

    # Get existing blocked domains from junk_senders table
    local blocked_domains_list
    blocked_domains_list=$(sqlite3 "$db_path" "SELECT DISTINCT lower(domain) FROM junk_senders WHERE domain IS NOT NULL AND domain != '';" 2>/dev/null)

    # Write blocked domains to a temp file for fast lookup
    local tmp_blocked
    tmp_blocked=$(mktemp /tmp/audit-junk-blocked.XXXXXX)
    echo "$blocked_domains_list" > "$tmp_blocked"

    echo ""
    echo "=== Junk Folder Audit Report ==="
    echo "Account: ${src_acct} (${account_alias})"
    echo "Total messages: ${total_messages}"
    echo "Unique domains: ${unique_domains}"
    echo "Threshold for report: ${threshold}"
    echo ""

    # Separate into new and already-blocked domains
    local tmp_new
    tmp_new=$(mktemp /tmp/audit-junk-new.XXXXXX)

    echo "--- Domains not yet blocked (threshold: ${threshold}+) ---"
    local new_count=0
    while IFS=' ' read -r count domain sample_addr; do
        [[ -z "$domain" ]] && continue
        # Check if domain is in blocked list
        if grep -qx "$domain" "$tmp_blocked" 2>/dev/null; then
            continue
        fi
        echo "  ${count}x  ${domain}  (sample: ${sample_addr})"
        echo "${domain}|${count}|${sample_addr}" >> "$tmp_new"
        new_count=$((new_count + 1))
    done <<< "$domain_report"

    if [[ "$new_count" -eq 0 ]]; then
        echo "  (none above threshold)"
    fi

    echo ""
    echo "--- Already blocked domains ---"
    local blocked_count=0
    while IFS=' ' read -r count domain sample_addr; do
        [[ -z "$domain" ]] && continue
        if grep -qx "$domain" "$tmp_blocked" 2>/dev/null; then
            echo "  ${count}x  ${domain}  (BLOCKED)"
            blocked_count=$((blocked_count + 1))
        fi
    done <<< "$domain_report"

    if [[ "$blocked_count" -eq 0 ]]; then
        echo "  (none)"
    fi

    # Auto-block logic
    if [[ "$auto_block" -gt 0 ]]; then
        local added=0
        echo ""
        while IFS='|' read -r domain count sample_addr; do
            [[ -z "$domain" ]] && continue
            if [[ "$count" -ge "$auto_block" ]]; then
                # Sanitize for SQL (remove single quotes)
                domain=$(echo "$domain" | tr -d "'")
                sample_addr=$(echo "$sample_addr" | tr -d "'")
                if [[ "$dry_run" == "true" ]]; then
                    echo "DRY-RUN: Would block domain: ${domain} (${count}x, sample: ${sample_addr})"
                else
                    sqlite3 "$db_path" "INSERT INTO junk_senders (domain, address, reason, account) VALUES ('${domain}', '${sample_addr}', 'audit-junk auto-block (${count}x)', '${account_alias}');" 2>/dev/null
                    echo "BLOCKED: ${domain} (${count}x, sample: ${sample_addr})"
                    added=$((added + 1))
                fi
            fi
        done < "$tmp_new"

        if [[ "$dry_run" == "true" ]]; then
            echo ""
            echo "DRY-RUN: No changes made to database."
        else
            echo ""
            echo "Added ${added} domain(s) to junk_senders table."
        fi
    fi

    # Cleanup temp files
    rm -f "$tmp_blocked" "$tmp_new"

    # Trash after audit
    if [[ "$trash_after" == "true" ]]; then
        echo ""
        if [[ "$dry_run" == "true" ]]; then
            echo "DRY-RUN: Would bulk-trash Junk mailbox contents."
        else
            bulk_operation "trash" --mailbox "$mailbox_path" --force
        fi
    fi
}

# ─────────────────────────────────────────────
# HELPER: Check if a mailbox name is a system folder
# ─────────────────────────────────────────────
# Purpose: Return 0 if the mailbox name is a system folder, 1 otherwise.
# Parameters: $1 — mailbox name
# Output: none
# Side effects: none
_is_system_folder() {
    local name_lower
    name_lower=$(echo "$1" | tr '[:upper:]' '[:lower:]')
    case "$name_lower" in
        inbox|sent|"sent messages"|drafts|draft|trash|deleted|"deleted messages"|junk|spam|archive)
            return 0 ;;
        *)
            return 1 ;;
    esac
}

# ─────────────────────────────────────────────
# CREATE MAILBOX (12.2)
# ─────────────────────────────────────────────
# Purpose: Create a new mailbox at the specified location.
# Parameters: <unified-path> (e.g., "i/Personal/Subscriptions/Alo")
# Output: confirmation message to stdout
# Side effects: creates mailbox in Mail.app
# Errors gracefully if already exists (exit 0). Refuses system folder names.
# Creates parent folders if needed via AppleScript.
create_mailbox() {
    local path="$1"
    if [[ -z "$path" ]]; then
        echo "Error: Unified path required (e.g., 'i/Subscriptions/New')" >&2
        return 1
    fi

    resolve_path "$path"
    local acct="$_RP_ACCOUNT" mb="$_RP_MAILBOX"

    if [[ -z "$acct" ]]; then
        echo "Error: Account prefix required for create-mailbox (e.g., 'i/FolderName')" >&2
        return 1
    fi

    # Check if the leaf name is a system folder
    local leaf_name
    if [[ "$mb" == *"/"* ]]; then
        leaf_name="${mb##*/}"
    else
        leaf_name="$mb"
    fi
    if _is_system_folder "$leaf_name"; then
        echo "Error: Cannot create system folder '$leaf_name'. System folders are managed by Mail.app." >&2
        return 1
    fi

    local acct_esc
    acct_esc=$(osa_str "$acct")

    # Build AppleScript to create the mailbox, creating parents as needed.
    # IMAP accounts (Gmail, Yahoo, etc.) cannot create nested mailboxes via
    # AppleScript's parent-child pattern (`make new mailbox at end of mailboxes
    # of parentFolder`). For these accounts, create with the full slash-separated
    # path at the account level -- IMAP translates "/" to folder hierarchy.
    # iCloud uses native hierarchical creation which works fine.
    local is_imap=false
    [[ "$acct" != "iCloud" ]] && is_imap=true

    local osa_script=""
    if [[ "$mb" == *"/"* ]]; then
        IFS='/' read -ra PARTS <<< "$mb"
        local num_parts=${#PARTS[@]}

        if $is_imap; then
            # ── IMAP path: full-path creation at account level ──
            local mb_esc
            mb_esc=$(osa_str "$mb")
            local leaf_esc
            leaf_esc=$(osa_str "${PARTS[$((num_parts-1))]}")

            osa_script+="tell application \"Mail\""$'\n'
            osa_script+="    if not running then launch"$'\n'
            osa_script+="    set targetAccount to first account whose name is \"${acct_esc}\""$'\n'

            # Check if leaf already exists by navigating hierarchy (reading works)
            osa_script+="    try"$'\n'
            local check_ref="targetAccount"
            local i
            for (( i=0; i<num_parts-1; i++ )); do
                local part_esc
                part_esc=$(osa_str "${PARTS[$i]}")
                osa_script+="        set mb${i}_ to first mailbox of ${check_ref} whose name is \"${part_esc}\""$'\n'
                check_ref="mb${i}_"
            done
            osa_script+="        set existingLeaf_ to first mailbox of ${check_ref} whose name is \"${leaf_esc}\""$'\n'
            osa_script+="        return \"Mailbox already exists: ${leaf_esc}\""$'\n'
            osa_script+="    end try"$'\n'

            # Create with full path at account level (IMAP-safe)
            osa_script+="    make new mailbox with properties {name:\"${mb_esc}\"} at end of mailboxes of targetAccount"$'\n'
            osa_script+="    return \"Created: ${path}\""$'\n'
            osa_script+="end tell"$'\n'
        else
            # ── iCloud path: hierarchical parent-child creation ──
            local parent_ref="targetAccount"

            osa_script+="tell application \"Mail\""$'\n'
            osa_script+="    if not running then launch"$'\n'
            osa_script+="    set targetAccount to first account whose name is \"${acct_esc}\""$'\n'

            # Create/find each parent in the hierarchy
            local i
            for (( i=0; i<num_parts-1; i++ )); do
                local part_esc
                part_esc=$(osa_str "${PARTS[$i]}")
                osa_script+="    try"$'\n'
                osa_script+="        set parent${i}_ to first mailbox of ${parent_ref} whose name is \"${part_esc}\""$'\n'
                osa_script+="    on error"$'\n'
                osa_script+="        set parent${i}_ to make new mailbox with properties {name:\"${part_esc}\"} at end of mailboxes of ${parent_ref}"$'\n'
                osa_script+="    end try"$'\n'
                parent_ref="parent${i}_"
            done

            # Create the leaf mailbox
            local leaf_esc
            leaf_esc=$(osa_str "${PARTS[$((num_parts-1))]}")
            osa_script+="    try"$'\n'
            osa_script+="        set existing_ to first mailbox of ${parent_ref} whose name is \"${leaf_esc}\""$'\n'
            osa_script+="        return \"Mailbox already exists: ${leaf_esc}\""$'\n'
            osa_script+="    on error"$'\n'
            osa_script+="        make new mailbox with properties {name:\"${leaf_esc}\"} at end of mailboxes of ${parent_ref}"$'\n'
            osa_script+="        return \"Created: ${path}\""$'\n'
            osa_script+="    end try"$'\n'
            osa_script+="end tell"$'\n'
        fi
    else
        local mb_esc
        mb_esc=$(osa_str "$mb")
        osa_script="tell application \"Mail\"
    if not running then launch
    set targetAccount to first account whose name is \"${acct_esc}\"
    try
        set existing_ to first mailbox of targetAccount whose name is \"${mb_esc}\"
        return \"Mailbox already exists: ${mb_esc}\"
    on error
        make new mailbox with properties {name:\"${mb_esc}\"} at end of mailboxes of targetAccount
        return \"Created: ${path}\"
    end try
end tell"
    fi

    local result
    result=$(osascript -e "$osa_script" 2>&1)
    local rc=$?

    if [[ $rc -ne 0 ]] && $is_imap; then
        # AppleScript IMAP-create failure: surface the AppleScript error.
        # Previously this had a gws CLI fallback (Gmail label-creation stopgap),
        # removed 2026-05-06 in GoogleWorkspaceCLI v5 Phase 4 (Item 4 sign-off,
        # option C) because Tools/Gmail/Labels.ts now handles Gmail label
        # creation directly with full ergonomic parity. For Gmail label work,
        # use `bun ~/.claude/skills/GoogleWorkspaceCLI/Tools/Gmail/Labels.ts create <name>`.
        echo "$result" >&2
        return 1
    fi

    echo "$result"
    return $rc
}

# ─────────────────────────────────────────────
# DELETE MAILBOX (12.2)
# ─────────────────────────────────────────────
# Purpose: Delete an empty mailbox.
# Parameters: <unified-path>
# Output: confirmation message to stdout
# Side effects: removes mailbox from Mail.app
# Refuses if non-empty or system folder.
delete_mailbox() {
    local path="$1"
    if [[ -z "$path" ]]; then
        echo "Error: Unified path required" >&2
        return 1
    fi

    resolve_path "$path"
    local acct="$_RP_ACCOUNT" mb="$_RP_MAILBOX"

    if [[ -z "$acct" ]]; then
        echo "Error: Account prefix required for delete-mailbox" >&2
        return 1
    fi

    local leaf_name
    if [[ "$mb" == *"/"* ]]; then
        leaf_name="${mb##*/}"
    else
        leaf_name="$mb"
    fi
    if _is_system_folder "$leaf_name"; then
        echo "Error: Cannot delete system folder '$leaf_name'." >&2
        return 1
    fi

    local mb_osa
    mb_osa=$(mb_resolve_acct "$mb" "$acct")

    osascript << OSAEOF
tell application "Mail"
    if not running then launch
$mb_osa
    set msgCount to count of messages of targetMailbox
    if msgCount > 0 then
        return "Error: Mailbox is not empty (" & msgCount & " messages). Move or delete messages first."
    end if
    set mbName to name of targetMailbox
    delete targetMailbox
    return "Deleted: " & mbName
end tell
OSAEOF
}

# ─────────────────────────────────────────────
# RENAME MAILBOX (12.2)
# ─────────────────────────────────────────────
# Purpose: Rename a mailbox (leaf name only).
# Parameters: <unified-path> <new-name>
# Output: confirmation message to stdout
# Side effects: renames the mailbox in Mail.app
# Refuses system folders. Only changes the leaf name.
rename_mailbox() {
    local path="$1" new_name="$2"
    if [[ -z "$path" ]] || [[ -z "$new_name" ]]; then
        echo "Error: Usage: rename-mailbox <unified-path> <new-name>" >&2
        return 1
    fi

    resolve_path "$path"
    local acct="$_RP_ACCOUNT" mb="$_RP_MAILBOX"

    if [[ -z "$acct" ]]; then
        echo "Error: Account prefix required for rename-mailbox" >&2
        return 1
    fi

    local leaf_name
    if [[ "$mb" == *"/"* ]]; then
        leaf_name="${mb##*/}"
    else
        leaf_name="$mb"
    fi
    if _is_system_folder "$leaf_name"; then
        echo "Error: Cannot rename system folder '$leaf_name'." >&2
        return 1
    fi

    local mb_osa new_esc
    mb_osa=$(mb_resolve_acct "$mb" "$acct")
    new_esc=$(osa_str "$new_name")

    osascript << OSAEOF
tell application "Mail"
    if not running then launch
$mb_osa
    set oldName to name of targetMailbox
    set name of targetMailbox to "$new_esc"
    return "Renamed: " & oldName & " -> $new_esc"
end tell
OSAEOF
}

# ─────────────────────────────────────────────
# COUNT EMAILS (12.3)
# ─────────────────────────────────────────────
# Purpose: Return just the integer count of emails in a mailbox. Much faster than list.
# Parameters: [unified-path] [--unread]
# Output: integer count on stdout (no formatting)
# Side effects: none (read-only)
count_emails() {
    local unified_path="" unread_only="false"
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --unread|-u)  unread_only="true"; shift ;;
            --mailbox|-m) unified_path="$2"; shift 2 ;;
            *)
                if [[ -z "$unified_path" ]]; then
                    unified_path="$1"
                fi
                shift ;;
        esac
    done

    resolve_path "$unified_path"
    local mb_osa
    mb_osa=$(mb_resolve_acct "$_RP_MAILBOX" "$_RP_ACCOUNT")

    osascript << OSAEOF
tell application "Mail"
    if not running then launch
$mb_osa
    if $unread_only then
        return (count of (messages of targetMailbox whose read status is false)) as string
    else
        return (count of messages of targetMailbox) as string
    end if
end tell
OSAEOF
}

# ─────────────────────────────────────────────
# GET HEADERS (12.3)
# ─────────────────────────────────────────────
# Purpose: Return raw email headers for a message.
# Parameters: <id> [--mailbox unified-path]
# Output: key headers (From, To, Date, Message-ID, Reply-To, List-Unsubscribe, etc.) to stdout
# Side effects: none (read-only)
get_headers() {
    local email_id="$1"; shift
    local mailbox_name="inbox"
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --mailbox|-m) mailbox_name="$2"; shift 2 ;;
            *) shift ;;
        esac
    done

    if [[ -z "$email_id" ]]; then
        echo "Error: Email ID required" >&2
        return 1
    fi

    resolve_path "$mailbox_name"
    local mb_osa
    mb_osa=$(mb_resolve_acct "$_RP_MAILBOX" "$_RP_ACCOUNT")

    osascript << OSAEOF
tell application "Mail"
    if not running then launch
$mb_osa
$(find_msg "$email_id" "$_RP_MAILBOX")

    set headerList to all headers of targetMessage
    set wantedHeaders to {"From", "To", "Date", "Message-ID", "Message-Id", "Reply-To", "List-Unsubscribe", "List-Unsubscribe-Post", "X-Mailer", "CC", "Cc", "Subject", "Content-Type"}

    set output to ""
    repeat with hdr in headerList
        set hdrName to name of hdr
        repeat with wanted in wantedHeaders
            if hdrName is wanted then
                set output to output & hdrName & ": " & (content of hdr) & linefeed
                exit repeat
            end if
        end repeat
    end repeat

    if output is "" then
        return "No matching headers found for ID: " & (id of targetMessage as string)
    end if
    return output
end tell
OSAEOF
}

# ─────────────────────────────────────────────
# SORT MAILBOXES (12.5)
# ─────────────────────────────────────────────
# Purpose: Alphabetize custom mailboxes within each level. System folders stay at top.
# Parameters: [account-alias] — optional, limits to one account
# Output: sorted mailbox list to stdout
# Side effects: reorders mailboxes in Mail.app
# Note: AppleScript mailbox reordering is limited; this reports the sorted order
# and renames mailboxes with numeric prefixes to achieve visual sorting.
sort_mailboxes() {
    local acct_filter=""
    if [[ -n "$1" ]]; then
        resolve_path "$1"
        acct_filter="$_RP_ACCOUNT"
    fi

    local acct_filter_esc=""
    if [[ -n "$acct_filter" ]]; then
        acct_filter_esc=$(osa_str "$acct_filter")
    fi

    osascript << OSAEOF
tell application "Mail"
    if not running then launch

    set output to ""

    repeat with acct in accounts
        set acctName to name of acct
        if "$acct_filter_esc" is not "" and acctName is not "$acct_filter_esc" then
            -- skip
        else
            set output to output & "Account: " & acctName & linefeed

            -- Get all custom mailbox names at top level
            set mbNames to {}
            try
                repeat with mb in mailboxes of acct
                    set end of mbNames to name of mb
                end repeat
            end try

            -- Simple bubble sort the names
            set sortedNames to mbNames
            set nameCount to count of sortedNames
            if nameCount > 1 then
                repeat with i from 1 to nameCount - 1
                    repeat with j from 1 to nameCount - i
                        if item j of sortedNames > item (j + 1) of sortedNames then
                            set temp to item j of sortedNames
                            set item j of sortedNames to item (j + 1) of sortedNames
                            set item (j + 1) of sortedNames to temp
                        end if
                    end repeat
                end repeat
            end if

            repeat with n in sortedNames
                set output to output & "  " & n & linefeed
            end repeat
            set output to output & linefeed
        end if
    end repeat

    return output
end tell
OSAEOF
}

# ─────────────────────────────────────────────
# MOVE MAILBOX (12.5)
# ─────────────────────────────────────────────
# Purpose: Move a mailbox to a different parent within the same account.
# Parameters: <source-unified-path> <dest-parent-unified-path>
# Output: confirmation message to stdout
# Side effects: moves mailbox in Mail.app
move_mailbox() {
    local src_path="$1" dest_path="$2"
    if [[ -z "$src_path" ]] || [[ -z "$dest_path" ]]; then
        echo "Error: Usage: move-mailbox <source-path> <dest-parent-path>" >&2
        return 1
    fi

    resolve_path "$src_path"
    local src_acct="$_RP_ACCOUNT" src_mb="$_RP_MAILBOX"

    if [[ -z "$src_acct" ]]; then
        echo "Error: Account prefix required for source path" >&2
        return 1
    fi

    local src_leaf
    if [[ "$src_mb" == *"/"* ]]; then
        src_leaf="${src_mb##*/}"
    else
        src_leaf="$src_mb"
    fi
    if _is_system_folder "$src_leaf"; then
        echo "Error: Cannot move system folder '$src_leaf'." >&2
        return 1
    fi

    resolve_path "$dest_path"
    local dest_acct="$_RP_ACCOUNT" dest_mb="$_RP_MAILBOX"

    local src_osa dest_osa
    src_osa=$(mb_resolve_acct "$src_mb" "$src_acct")
    dest_osa=$(mb_resolve_acct "$dest_mb" "$dest_acct" | sed 's/targetMailbox/destMailbox/g; s/targetAccount/destAccount/g')

    local src_leaf_esc
    src_leaf_esc=$(osa_str "$src_leaf")

    osascript << OSAEOF
tell application "Mail"
    if not running then launch
$src_osa
$dest_osa
    set srcName to name of targetMailbox
    move targetMailbox to end of mailboxes of destMailbox
    return "Moved mailbox: " & srcName & " -> $dest_path"
end tell
OSAEOF
}

# ─────────────────────────────────────────────
# FOLDER TREE (12.6)
# ─────────────────────────────────────────────
# Purpose: Return complete folder hierarchy as flat list of unified paths.
# Parameters: [account-alias] — optional, limits to one account
# Output: one unified path per line (e.g., "i/Personal/Subscriptions/Alo")
# Side effects: none (read-only)
# No unread counts -- just paths. Use 'folders' for counts.
folder_tree() {
    local acct_filter=""
    if [[ -n "$1" ]]; then
        resolve_path "$1"
        acct_filter="$_RP_ACCOUNT"
    fi

    local acct_filter_esc=""
    if [[ -n "$acct_filter" ]]; then
        acct_filter_esc=$(osa_str "$acct_filter")
    fi

    osascript << OSAEOF
tell application "Mail"
    if not running then launch

    -- Build account alias mapping (reverse: name -> short alias)
    set output to ""

    repeat with acct in accounts
        set acctName to name of acct
        if "$acct_filter_esc" is not "" and acctName is not "$acct_filter_esc" then
            -- skip non-matching accounts
        else
            -- Determine short alias for account
            set acctAlias to acctName
            if acctName is "iCloud" then set acctAlias to "i"
            if acctName is "Google" then set acctAlias to "g"
            if acctName is "Yahoo" then set acctAlias to "y"
            if acctName is "Hotmail" then set acctAlias to "h"
            if acctName is "AOL" then set acctAlias to "a"
            if acctName is "ProtonMail" then set acctAlias to "p"

            -- System folders for this account
            try
                set output to output & acctAlias & "/inbox" & linefeed
            end try
            try
                set mc to count of messages of sent mailbox of acct
                set output to output & acctAlias & "/sent" & linefeed
            end try
            try
                set mc to count of messages of drafts mailbox of acct
                set output to output & acctAlias & "/drafts" & linefeed
            end try
            try
                set mc to count of messages of trash mailbox of acct
                set output to output & acctAlias & "/trash" & linefeed
            end try
            try
                set mc to count of messages of junk mailbox of acct
                set output to output & acctAlias & "/junk" & linefeed
            end try

            -- Custom mailboxes (up to 4 levels deep)
            try
                repeat with mb in mailboxes of acct
                    set mbName to name of mb
                    set output to output & acctAlias & "/" & mbName & linefeed
                    -- Level 2
                    try
                        if (count of mailboxes of mb) > 0 then
                            repeat with mb2 in mailboxes of mb
                                set mb2Name to name of mb2
                                set output to output & acctAlias & "/" & mbName & "/" & mb2Name & linefeed
                                -- Level 3
                                try
                                    if (count of mailboxes of mb2) > 0 then
                                        repeat with mb3 in mailboxes of mb2
                                            set mb3Name to name of mb3
                                            set output to output & acctAlias & "/" & mbName & "/" & mb2Name & "/" & mb3Name & linefeed
                                            -- Level 4
                                            try
                                                if (count of mailboxes of mb3) > 0 then
                                                    repeat with mb4 in mailboxes of mb3
                                                        set mb4Name to name of mb4
                                                        set output to output & acctAlias & "/" & mbName & "/" & mb2Name & "/" & mb3Name & "/" & mb4Name & linefeed
                                                    end repeat
                                                end if
                                            end try
                                        end repeat
                                    end if
                                end try
                            end repeat
                        end if
                    end try
                end repeat
            end try
        end if
    end repeat

    return output
end tell
OSAEOF
}

# ─────────────────────────────────────────────
# ACCOUNTS
# ─────────────────────────────────────────────
# Purpose: List all configured email accounts in Mail.app.
# Parameters: none
# Output: tab-separated account info (name, email, type, enabled) to stdout
# Side effects: none (read-only)
list_accounts() {
    osascript << OSAEOF
tell application "Mail"
    if not running then launch
    set output to "Configured Email Accounts" & linefeed
    set output to output & "======================================" & linefeed
    repeat with acct in accounts
        set output to output & "Name:    " & (name of acct) & linefeed
        set output to output & "Email:   " & (email addresses of acct) & linefeed
        set output to output & "Type:    " & (account type of acct as string) & linefeed
        set output to output & "Enabled: " & (enabled of acct) & linefeed
        set output to output & "--------------------------------------" & linefeed
    end repeat
    return output
end tell
OSAEOF
}

# ─────────────────────────────────────────────
# FOLDERS
# ─────────────────────────────────────────────
# Purpose: List all mailboxes with unread and total message counts.
# Parameters: none
# Output: hierarchical tree of mailboxes (up to 4 levels deep) to stdout
# Side effects: none (read-only)
# Recursively enumerate mailboxes up to 4 levels deep.
list_folders() {
    osascript << OSAEOF
tell application "Mail"
    if not running then launch
    set output to "Mailbox Folders (unread / total)" & linefeed
    set output to output & "======================================" & linefeed

    try
        set uc to count of (messages of inbox whose read status is false)
        set output to output & "inbox          " & uc & " unread / " & (count of messages of inbox) & " total" & linefeed
    end try
    try
        set output to output & "sent           " & (count of messages of sent mailbox) & " messages" & linefeed
    end try
    try
        set output to output & "drafts         " & (count of messages of drafts mailbox) & " messages" & linefeed
    end try
    try
        set uc to count of (messages of trash mailbox whose read status is false)
        set output to output & "trash          " & uc & " unread / " & (count of messages of trash mailbox) & " total" & linefeed
    end try
    try
        set uc to count of (messages of junk mailbox whose read status is false)
        set output to output & "junk           " & uc & " unread / " & (count of messages of junk mailbox) & " total" & linefeed
    end try

    set output to output & linefeed

    repeat with acct in accounts
        set output to output & "── " & (name of acct) & " ──" & linefeed
        try
            repeat with mb in mailboxes of acct
                set mbName to name of mb
                set total to count of messages of mb
                try
                    set uc to count of (messages of mb whose read status is false)
                    if uc > 0 then
                        set output to output & "  " & mbName & "  (" & uc & " unread / " & total & " total)" & linefeed
                    else
                        set output to output & "  " & mbName & "  (" & total & ")" & linefeed
                    end if
                on error
                    set output to output & "  " & mbName & "  (" & total & ")" & linefeed
                end try
                -- Recurse into sub-mailboxes (up to 3 levels deep)
                try
                    if (count of mailboxes of mb) > 0 then
                        repeat with submb2 in mailboxes of mb
                            set sub2Name to name of submb2
                            set sub2Path to mbName & "/" & sub2Name
                            set sub2Total to count of messages of submb2
                            try
                                set sub2Uc to count of (messages of submb2 whose read status is false)
                                if sub2Uc > 0 then
                                    set output to output & "    " & sub2Path & "  (" & sub2Uc & " unread / " & sub2Total & " total)" & linefeed
                                else
                                    set output to output & "    " & sub2Path & "  (" & sub2Total & ")" & linefeed
                                end if
                            on error
                                set output to output & "    " & sub2Path & "  (" & sub2Total & ")" & linefeed
                            end try
                            -- Level 3
                            try
                                if (count of mailboxes of submb2) > 0 then
                                    repeat with submb3 in mailboxes of submb2
                                        set sub3Name to name of submb3
                                        set sub3Path to sub2Path & "/" & sub3Name
                                        set sub3Total to count of messages of submb3
                                        try
                                            set sub3Uc to count of (messages of submb3 whose read status is false)
                                            if sub3Uc > 0 then
                                                set output to output & "      " & sub3Path & "  (" & sub3Uc & " unread / " & sub3Total & " total)" & linefeed
                                            else
                                                set output to output & "      " & sub3Path & "  (" & sub3Total & ")" & linefeed
                                            end if
                                        on error
                                            set output to output & "      " & sub3Path & "  (" & sub3Total & ")" & linefeed
                                        end try
                                        -- Level 4
                                        try
                                            if (count of mailboxes of submb3) > 0 then
                                                repeat with submb4 in mailboxes of submb3
                                                    set sub4Name to name of submb4
                                                    set sub4Path to sub3Path & "/" & sub4Name
                                                    set sub4Total to count of messages of submb4
                                                    try
                                                        set sub4Uc to count of (messages of submb4 whose read status is false)
                                                        if sub4Uc > 0 then
                                                            set output to output & "        " & sub4Path & "  (" & sub4Uc & " unread / " & sub4Total & " total)" & linefeed
                                                        else
                                                            set output to output & "        " & sub4Path & "  (" & sub4Total & ")" & linefeed
                                                        end if
                                                    on error
                                                        set output to output & "        " & sub4Path & "  (" & sub4Total & ")" & linefeed
                                                    end try
                                                end repeat
                                            end if
                                        end try
                                    end repeat
                                end if
                            end try
                        end repeat
                    end if
                end try
            end repeat
        on error
            set output to output & "  (unable to list)" & linefeed
        end try
        set output to output & linefeed
    end repeat

    return output
end tell
OSAEOF
}

# ─────────────────────────────────────────────
# WATCH / MONITOR
# ─────────────────────────────────────────────
# Purpose: Manage background new-mail monitoring via launchd.
# Parameters: <subcommand> — start, stop, status, log, vip, vip-add, check
# Output: varies by subcommand
# Side effects: start/stop modify launchd agents; vip-add writes to VIP file
WATCH_PLIST="$HOME/Library/LaunchAgents/com.pai.apple-mail-watch.plist"
WATCH_CACHE="$HOME/.cache/apple-mail-watch"
WATCH_SCRIPT="$(cd "$(dirname "$0")" && pwd)/WatchCheck.sh"
WATCH_VIP="${PAI_DIR:-$HOME/.claude/PAI}/USER/SKILLCUSTOMIZATIONS/AppleMail/watch-vip.txt"
# Fallback to legacy in-skill path if USER customization missing
[[ ! -f "$WATCH_VIP" ]] && WATCH_VIP="$(cd "$(dirname "$0")" && pwd)/watch-vip.txt"

# Purpose: Generate a fresh launchd plist at WATCH_PLIST referencing Tools/WatchCheck.sh.
# Idempotent: overwrites any existing plist content. Called by watch start when the
# plist is missing or references a stale (pre-v5) path.
watch_create_plist() {
    local script_path
    script_path="$(cd "$(dirname "$0")" && pwd)/WatchCheck.sh"
    cat > "$WATCH_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.pai.apple-mail-watch</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>${script_path}</string>
    </array>
    <key>StartInterval</key>
    <integer>120</integer>
    <key>RunAtLoad</key>
    <false/>
    <key>StandardOutPath</key>
    <string>$HOME/.cache/apple-mail-watch/launchd-stdout.log</string>
    <key>StandardErrorPath</key>
    <string>$HOME/.cache/apple-mail-watch/launchd-stderr.log</string>
</dict>
</plist>
PLIST
}

watch_command() {
    local sub="${1:-status}"; shift 2>/dev/null || true

    case "$sub" in
        start)
            if launchctl list 2>/dev/null | grep -q "com.pai.apple-mail-watch"; then
                echo "Watch is already running."
                return 0
            fi
            mkdir -p "$WATCH_CACHE"
            # Seed state so first run doesn't alert on all existing unread
            if [[ ! -f "$WATCH_CACHE/last-check.json" ]]; then
                echo "Seeding initial state (suppressing first-run alerts)..."
                bash "$WATCH_SCRIPT" 2>/dev/null || true
            fi
            # Regenerate plist if missing or referencing a stale (pre-v5) path
            if [[ ! -f "$WATCH_PLIST" ]] || ! grep -q 'WatchCheck\.sh' "$WATCH_PLIST"; then
                watch_create_plist
            fi
            launchctl load "$WATCH_PLIST"
            echo "Watch started (checking every 2 minutes)."
            echo "VIP list: $WATCH_VIP"
            ;;
        stop)
            if ! launchctl list 2>/dev/null | grep -q "com.pai.apple-mail-watch"; then
                echo "Watch is not running."
                return 0
            fi
            launchctl unload "$WATCH_PLIST"
            echo "Watch stopped."
            ;;
        status)
            if launchctl list 2>/dev/null | grep -q "com.pai.apple-mail-watch"; then
                echo "Watch: RUNNING"
            else
                echo "Watch: STOPPED"
            fi
            if [[ -f "$WATCH_CACHE/last-check.json" ]]; then
                local last_mod
                last_mod=$(stat -f '%Sm' -t '%Y-%m-%d %H:%M:%S' "$WATCH_CACHE/last-check.json" 2>/dev/null || echo "unknown")
                local count
                count=$(/usr/bin/python3 -c "import json; print(len(json.load(open('$WATCH_CACHE/last-check.json'))))" 2>/dev/null || echo "?")
                echo "Last check: $last_mod ($count unread cached)"
            else
                echo "No state file yet (watch hasn't run)."
            fi
            if [[ -f "$WATCH_VIP" ]]; then
                local vip_count
                vip_count=$(grep -cv '^\s*$\|^\s*#' "$WATCH_VIP" 2>/dev/null || echo 0)
                echo "VIP senders: $vip_count configured"
            fi
            ;;
        log)
            local lines="${1:-30}"
            if [[ -f "$WATCH_CACHE/watch.log" ]]; then
                tail -n "$lines" "$WATCH_CACHE/watch.log"
            else
                echo "No log file yet."
            fi
            ;;
        vip)
            if [[ -f "$WATCH_VIP" ]]; then
                cat "$WATCH_VIP"
            else
                echo "No VIP file found at $WATCH_VIP"
            fi
            ;;
        vip-add)
            local entry="$1"
            [[ -z "$entry" ]] && { echo "Usage: watch vip-add <email-or-name-fragment>"; return 1; }
            echo "$entry" >> "$WATCH_VIP"
            echo "Added '$entry' to VIP list."
            ;;
        check)
            echo "Running manual check..."
            bash "$WATCH_SCRIPT"
            ;;
        *)
            echo "Usage: apple-mail.sh watch <start|stop|status|log|vip|vip-add|check>"
            echo ""
            echo "  start    — Start background mail monitoring (launchd, every 2 min)"
            echo "  stop     — Stop background monitoring"
            echo "  status   — Show watch status, last check time, VIP count"
            echo "  log [N]  — Show last N lines of watch log (default 30)"
            echo "  vip      — Show VIP sender list"
            echo "  vip-add  — Add a sender to the VIP list"
            echo "  check    — Run a manual check now"
            ;;
    esac
}

# ─────────────────────────────────────────────
# V5.1 HOUSEKEEPING — label aliases + empty-trash + restore
# ─────────────────────────────────────────────
# Added 2026-05-05 per `Coordination/AppleMail v5.1 Housekeeping Patch.md`.
# Purpose: cross-skill parity with GoogleWorkspaceCLI v5. AppleMail keeps `mailbox`
# as canonical vocabulary; `label` is a parallel alias added at the dispatch layer
# and via flag-name normalization so existing argument parsing sees only --mailbox.

# Purpose: Pre-process "$@" to rewrite --label / --label=X to --mailbox / --mailbox=X.
# Parameters: positional args (typically the script's "$@")
# Output: nothing; mutates outer $@ via the caller's `set --` invocation
# Side effects: assigns the global array NORMALIZED_ARGS (caller does set -- "${NORMALIZED_ARGS[@]}")
normalize_label_aliases() {
    NORMALIZED_ARGS=()
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --label=*) NORMALIZED_ARGS+=("--mailbox=${1#--label=}") ;;
            --label)
                NORMALIZED_ARGS+=("--mailbox")
                if [[ $# -ge 2 ]]; then
                    NORMALIZED_ARGS+=("$2")
                    shift
                fi
                ;;
            *) NORMALIZED_ARGS+=("$1") ;;
        esac
        shift
    done
}

# Purpose: Resolve any account-name input (single-letter alias, full name, email) to
#          the canonical Mail.app account name.
# Parameters: $1 — input string
# Output: canonical account name on stdout; empty on no match
# Side effects: probes Mail.app for canonical account list (osascript)
resolve_account_name() {
    local input="$1"
    [[ -z "$input" ]] && return 1
    local input_lower
    input_lower=$(echo "$input" | tr '[:upper:]' '[:lower:]')
    case "$input_lower" in
        i|icloud)            echo "iCloud"; return 0 ;;
        g|google|gmail)      echo "Google"; return 0 ;;
        y|yahoo)             echo "Yahoo"; return 0 ;;
        h|hotmail|outlook)   echo "Hotmail"; return 0 ;;
        a|aol)               echo "AOL"; return 0 ;;
        p|proton|protonmail) echo "ProtonMail"; return 0 ;;
    esac
    local probed
    probed=$(osascript -e 'tell application "Mail" to get name of every account' 2>/dev/null \
        | tr ',' '\n' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
    while IFS= read -r name; do
        [[ -z "$name" ]] && continue
        local name_lower
        name_lower=$(echo "$name" | tr '[:upper:]' '[:lower:]')
        if [[ "$input_lower" == "$name_lower" ]]; then
            echo "$name"
            return 0
        fi
    done <<< "$probed"
    local input_esc
    input_esc=$(osa_str "$input")
    local by_email
    by_email=$(osascript -e "tell application \"Mail\"
        repeat with ac in accounts
            set ea to email addresses of ac
            repeat with em in ea
                if (em as string) is \"$input_esc\" then return name of ac as string
            end repeat
        end repeat
        return \"\"
    end tell" 2>/dev/null)
    if [[ -n "$by_email" ]]; then
        echo "$by_email"
        return 0
    fi
    return 1
}

# Purpose: Get the list of triage-eligible Mail.app account names (filtered).
# Parameters: none
# Output: one canonical account name per line on stdout
# Side effects: invokes Tools/Accounts.sh which reads accounts.yaml or probes Mail.app
get_triage_accounts() {
    local script_dir
    script_dir=$(cd "$(dirname "$0")" && pwd)
    "$script_dir/Accounts.sh" 2>/dev/null
}

# Purpose: Permanently empty the Trash mailbox for one or more accounts.
# Parameters: optional --account=<X>, optional --force
# Output: per-account status messages
# Side effects: PERMANENTLY deletes every message in target Trash mailboxes
empty_trash() {
    local account=""
    local force=false
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --account=*) account="${1#--account=}"; shift ;;
            --account)   account="${2:-}"; shift 2 ;;
            --force)     force=true; shift ;;
            *) echo "Error: unknown option for empty-trash: $1" >&2; exit 1 ;;
        esac
    done
    local -a accounts=()
    if [[ -n "$account" ]]; then
        local resolved
        resolved=$(resolve_account_name "$account")
        if [[ -z "$resolved" ]]; then
            echo "Error: account '$account' not found in Mail.app" >&2
            exit 1
        fi
        accounts=("$resolved")
    else
        while IFS= read -r name; do
            [[ -n "$name" ]] && accounts+=("$name")
        done < <(get_triage_accounts)
        if [[ ${#accounts[@]} -eq 0 ]]; then
            echo "Error: no triage:true accounts configured. Run Tools/Accounts.sh --init" >&2
            exit 1
        fi
    fi
    for ac in "${accounts[@]}"; do
        local ac_esc
        ac_esc=$(osa_str "$ac")
        local count
        count=$(osascript -e "tell application \"Mail\"
            try
                set tm to first mailbox of account \"$ac_esc\" whose name is \"Trash\"
            on error
                try
                    set tm to first mailbox of account \"$ac_esc\" whose name is \"Deleted Messages\"
                on error
                    return \"-1\"
                end try
            end try
            return (count of (messages of tm)) as string
        end tell" 2>/dev/null)
        if [[ "$count" == "-1" || -z "$count" ]]; then
            echo "[$ac] Trash mailbox not found, skipped"
            continue
        fi
        if [[ "$count" == "0" ]]; then
            echo "[$ac] Trash already empty (0 messages)"
            continue
        fi
        if [[ "$force" != "true" ]]; then
            local confirm=""
            read -r -p "Permanently delete $count messages from Trash for account $ac? [y/N] " confirm
            if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
                echo "[$ac] Skipped"
                continue
            fi
        fi
        osascript -e "tell application \"Mail\"
            try
                set tm to first mailbox of account \"$ac_esc\" whose name is \"Trash\"
            on error
                set tm to first mailbox of account \"$ac_esc\" whose name is \"Deleted Messages\"
            end try
            delete every message of tm
        end tell" >/dev/null 2>&1
        echo "[$ac] Emptied Trash ($count messages)"
    done
}

# Purpose: Restore a Trash message back to a target mailbox (default INBOX).
# Parameters: $1 — message ID; optional --account=<X>, --mailbox=<dest> (--label= alias
#             handled by normalize_label_aliases at main() entry)
# Output: status message
# Side effects: moves the message in Mail.app
restore_message() {
    local msg_id="${1:-}"; shift 2>/dev/null || true
    if [[ -z "$msg_id" ]]; then
        echo "Error: restore requires a message ID" >&2
        exit 1
    fi
    local account=""
    local dest_mailbox=""
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --account=*)  account="${1#--account=}"; shift ;;
            --account)    account="${2:-}"; shift 2 ;;
            --mailbox=*)  dest_mailbox="${1#--mailbox=}"; shift ;;
            --mailbox)    dest_mailbox="${2:-}"; shift 2 ;;
            *) echo "Error: unknown option for restore: $1" >&2; exit 1 ;;
        esac
    done
    local resolved_account=""
    if [[ -n "$account" ]]; then
        resolved_account=$(resolve_account_name "$account")
        if [[ -z "$resolved_account" ]]; then
            echo "Error: account '$account' not found in Mail.app" >&2
            exit 1
        fi
    else
        local -a found_in=()
        while IFS= read -r ac; do
            [[ -z "$ac" ]] && continue
            local ac_esc
            ac_esc=$(osa_str "$ac")
            local exists
            exists=$(osascript -e "tell application \"Mail\"
                try
                    set tm to first mailbox of account \"$ac_esc\" whose name is \"Trash\"
                on error
                    try
                        set tm to first mailbox of account \"$ac_esc\" whose name is \"Deleted Messages\"
                    on error
                        return \"NO\"
                    end try
                end try
                try
                    set msg to first message of tm whose id is $msg_id
                    return \"YES\"
                on error
                    return \"NO\"
                end try
            end tell" 2>/dev/null)
            if [[ "$exists" == "YES" ]]; then
                found_in+=("$ac")
            fi
        done < <(get_triage_accounts)
        if [[ ${#found_in[@]} -eq 0 ]]; then
            echo "Error: message $msg_id not found in any Trash" >&2
            exit 1
        elif [[ ${#found_in[@]} -gt 1 ]]; then
            echo "Error: message $msg_id ambiguous; found in: ${found_in[*]}; pass --account=<X>" >&2
            exit 1
        fi
        resolved_account="${found_in[0]}"
    fi
    [[ -z "$dest_mailbox" ]] && dest_mailbox="INBOX"
    local ac_esc dest_esc
    ac_esc=$(osa_str "$resolved_account")
    dest_esc=$(osa_str "$dest_mailbox")
    if osascript -e "tell application \"Mail\"
        try
            set tm to first mailbox of account \"$ac_esc\" whose name is \"Trash\"
        on error
            set tm to first mailbox of account \"$ac_esc\" whose name is \"Deleted Messages\"
        end try
        set msg to first message of tm whose id is $msg_id
        try
            set dm to first mailbox of account \"$ac_esc\" whose name is \"$dest_esc\"
        on error
            error \"destination mailbox not found: $dest_esc\"
        end try
        move msg to dm
    end tell" >/dev/null 2>&1; then
        echo "Restored message $msg_id from $resolved_account/Trash to $resolved_account/$dest_mailbox"
    else
        echo "Error: restore failed for message $msg_id (not in Trash, or destination missing)" >&2
        exit 1
    fi
}

# ─────────────────────────────────────────────
# MAIN DISPATCHER
# ─────────────────────────────────────────────
# Purpose: Command dispatcher — routes CLI arguments to the appropriate function.
# Parameters: command name + remaining args (passed through to subfunction)
# Output: delegates to subfunction output
# Side effects: delegates to subfunction side effects
main() {
    if [[ $# -eq 0 ]]; then show_usage; exit 1; fi

    # v5.1 housekeeping: rewrite --label / --label=X to --mailbox / --mailbox=X
    # so existing argument parsers see only --mailbox. NORMALIZED_ARGS is set globally.
    normalize_label_aliases "$@"
    set -- "${NORMALIZED_ARGS[@]}"

    local command="$1"; shift

    case "${command}" in
        list|ls)
            list_emails "$@" ;;
        read|show|view)
            [[ $# -eq 0 ]] && { echo "Error: Email ID required"; exit 1; }
            read_email "$@" ;;
        search|find|query)
            [[ $# -eq 0 ]] && { echo "Error: Search query required"; exit 1; }
            search_emails "$@" ;;
        send|compose|new)
            send_email "$@" ;;
        reply|respond)
            [[ $# -lt 2 ]] && { echo "Usage: reply <id> <body> [--all]"; exit 1; }
            reply_email "$@" ;;
        reply-all|replyall)
            [[ $# -lt 2 ]] && { echo "Usage: reply-all <id> <body>"; exit 1; }
            reply_email "$1" "$2" --all "${@:3}" ;;
        forward|fwd)
            forward_email "$@" ;;
        draft|save-draft)
            save_draft "$@" ;;
        flag|star)
            [[ $# -eq 0 ]] && { echo "Error: Email ID required"; exit 1; }
            flag_email "$1" "true" "${@:2}" ;;
        unflag|unstar)
            [[ $# -eq 0 ]] && { echo "Error: Email ID required"; exit 1; }
            flag_email "$1" "false" "${@:2}" ;;
        mark-read|markread)
            [[ $# -eq 0 ]] && { echo "Error: Email ID required"; exit 1; }
            mark_email "$1" "true" "${@:2}" ;;
        mark-unread|markunread)
            [[ $# -eq 0 ]] && { echo "Error: Email ID required"; exit 1; }
            mark_email "$1" "false" "${@:2}" ;;
        move)
            [[ $# -lt 2 ]] && { echo "Usage: move <id> <dest-path> [--mailbox <src-path>]"; exit 1; }
            move_email "$@" ;;
        trash|delete|rm)
            [[ $# -eq 0 ]] && { echo "Error: Email ID required"; exit 1; }
            trash_email "$@" ;;
        unread|count-unread)
            count_unread "$@" ;;
        count)
            count_emails "$@" ;;
        headers|get-headers)
            [[ $# -eq 0 ]] && { echo "Error: Email ID required" >&2; exit 1; }
            get_headers "$@" ;;
        thread|conversation)
            [[ $# -eq 0 ]] && { echo "Error: Email ID required"; exit 1; }
            get_thread "$@" ;;
        attachments|attach|att)
            [[ $# -eq 0 ]] && { echo "Error: Email ID required"; exit 1; }
            list_attachments "$@" ;;
        open|open-email)
            [[ $# -eq 0 ]] && { echo "Error: Email ID required" >&2; exit 1; }
            open_email "$@" ;;
        save-attachment|save-att|download-attachment)
            [[ $# -eq 0 ]] && { echo "Error: Email ID required" >&2; exit 1; }
            save_attachment "$@" ;;
        bulk-trash)
            bulk_operation "trash" "$@" ;;
        bulk-move)
            bulk_operation "move" "$@" ;;
        bulk-mark-read|bulk-markread)
            bulk_operation "mark-read" "$@" ;;
        bulk-archive)
            bulk_operation "archive" "$@" ;;
        bulk-flag)
            bulk_operation "flag" "$@" ;;
        bulk-unflag)
            bulk_operation "unflag" "$@" ;;
        bulk-mark-unread)
            bulk_operation "mark-unread" "$@" ;;
        bulk-junk)
            bulk_operation "junk" "$@" ;;
        bulk-not-junk)
            bulk_operation "not-junk" "$@" ;;
        audit-junk)
            audit_junk "$@" ;;
        bulk-trash-ids)
            bulk_operation_by_ids "trash" "$@" ;;
        bulk-move-ids)
            bulk_operation_by_ids "move" "$@" ;;
        bulk-archive-ids)
            bulk_operation_by_ids "archive" "$@" ;;
        bulk-mark-read-ids)
            bulk_operation_by_ids "mark-read" "$@" ;;
        bulk-flag-ids)
            bulk_operation_by_ids "flag" "$@" ;;
        bulk-unflag-ids)
            bulk_operation_by_ids "unflag" "$@" ;;
        bulk-mark-unread-ids)
            bulk_operation_by_ids "mark-unread" "$@" ;;
        create-mailbox|create-mb|create-label)
            [[ $# -eq 0 ]] && { echo "Error: Unified path required" >&2; exit 1; }
            create_mailbox "$@" ;;
        delete-mailbox|delete-mb|delete-label)
            [[ $# -eq 0 ]] && { echo "Error: Unified path required" >&2; exit 1; }
            delete_mailbox "$@" ;;
        rename-mailbox|rename-mb|rename-label)
            [[ $# -lt 2 ]] && { echo "Usage: rename-mailbox <path> <new-name>" >&2; exit 1; }
            rename_mailbox "$@" ;;
        move-mailbox|move-mb)
            [[ $# -lt 2 ]] && { echo "Usage: move-mailbox <src-path> <dest-parent-path>" >&2; exit 1; }
            move_mailbox "$@" ;;
        sort-mailboxes|sort-mb)
            sort_mailboxes "$@" ;;
        folder-tree|tree|label-tree)
            folder_tree "$@" ;;
        thread-read|threadread)
            [[ $# -eq 0 ]] && { echo "Error: Email ID required" >&2; exit 1; }
            thread_read "$@" ;;
        export|export-email)
            [[ $# -eq 0 ]] && { echo "Error: Email ID required" >&2; exit 1; }
            export_email "$@" ;;
        archive)
            [[ $# -eq 0 ]] && { echo "Error: Email ID required" >&2; exit 1; }
            archive_email "$@" ;;
        accounts|accts|--accounts)
            exec "$(cd "$(dirname "$0")" && pwd)/Accounts.sh" "$@" ;;
        folders|mailboxes|boxes|list-mailboxes|list-labels)
            list_folders ;;
        empty-trash)
            empty_trash "$@" ;;
        restore)
            [[ $# -eq 0 ]] && { echo "Error: restore requires a message ID" >&2; exit 1; }
            restore_message "$@" ;;
        watch|monitor)
            watch_command "$@" ;;
        help|--help|-h)
            show_usage ;;
        version|--version|-v)
            echo "Apple Mail Skill v${VERSION}" ;;
        *)
            echo "Unknown command: ${command}"
            echo "Run 'apple-mail.sh help' for usage."
            exit 1 ;;
    esac
}

main "$@"
