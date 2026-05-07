#!/bin/bash
#
# Tools/Accounts.sh — Multi-account init/filter/refresh wrapper for AppleMail v5.
#
# Built as a separate Tool rather than modifying apple-mail.sh body, per the
# Phase 1 anti-criterion in the AppleMail v5 Refactor Proposal.
# apple-mail.sh accounts continues to do the raw Mail.app probe; this script
# is the canonical entry-point for filtered, triage-ready account lists.
#
# Modes:
#   --init       Probe Mail.app, write accounts.yaml at the USER customization path
#                with every discovered account marked triage:true. Idempotent.
#   (default)    Read accounts.yaml; emit account names where triage:true.
#                Falls back to raw probe if accounts.yaml is missing.
#   --refresh    Re-probe Mail.app and merge into existing accounts.yaml,
#                preserving the triage flag on already-known accounts and
#                warning if any previously-known account was deleted.
#
# Storage: ${PAI_DIR:-$HOME/.claude/PAI}/USER/SKILLCUSTOMIZATIONS/AppleMail/accounts.yaml
#
# Usage:
#   Accounts.sh                    # default read (filtered)
#   Accounts.sh --init
#   Accounts.sh --refresh
#   Accounts.sh --help

set -euo pipefail

VERSION="1.0.0"

PAI_DIR_RESOLVED="${PAI_DIR:-$HOME/.claude/PAI}"
ACCOUNTS_YAML="$PAI_DIR_RESOLVED/USER/SKILLCUSTOMIZATIONS/AppleMail/accounts.yaml"
APPLE_MAIL_SH="$(cd "$(dirname "$0")" && pwd)/apple-mail.sh"

usage() {
    cat <<EOF
Tools/Accounts.sh v$VERSION — multi-account init/filter/refresh wrapper

Modes:
  --init       Probe Mail.app and create accounts.yaml at the USER customization path.
               Every discovered account is marked triage: true by default.
  (default)    Read accounts.yaml and print accounts where triage: true.
               Falls back to raw probe of Mail.app if accounts.yaml is missing.
  --refresh    Re-probe Mail.app; add new accounts as triage: true; preserve flags
               on existing accounts; warn on accounts that disappeared from Mail.

Storage:
  $ACCOUNTS_YAML

Examples:
  Accounts.sh                    # default filtered read
  Accounts.sh --init             # bootstrap accounts.yaml
  Accounts.sh --refresh          # update existing accounts.yaml
EOF
}

# Probe Mail.app for the live account list (one name per line).
probe_mail_accounts() {
    osascript -e 'tell application "Mail" to get name of every account' 2>/dev/null \
        | tr ',' '\n' \
        | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' \
        | grep -v '^$' \
        || true
}

# Write a fresh accounts.yaml with every probed account marked triage:true.
write_init_yaml() {
    mkdir -p "$(dirname "$ACCOUNTS_YAML")"
    local tmp
    tmp=$(mktemp)
    {
        echo "# AppleMail accounts.yaml — populated by Tools/Accounts.sh --init"
        echo "# triage: true means the account participates in default-filtered output."
        echo "accounts:"
        probe_mail_accounts | while IFS= read -r name; do
            [[ -z "$name" ]] && continue
            printf '  - name: %s\n    triage: true\n' "$name"
        done
    } > "$tmp"
    mv "$tmp" "$ACCOUNTS_YAML"
    echo "Wrote $ACCOUNTS_YAML" >&2
    echo "Edit the triage flags as needed; default is true for every discovered account." >&2
}

# Read accounts.yaml and emit names where triage:true.
read_filtered() {
    awk '
        /^[[:space:]]*-[[:space:]]*name:[[:space:]]*/ {
            sub(/^[[:space:]]*-[[:space:]]*name:[[:space:]]*/, "")
            name=$0
            triage=""
            next
        }
        /^[[:space:]]*triage:[[:space:]]*/ {
            sub(/^[[:space:]]*triage:[[:space:]]*/, "")
            triage=$0
            if (triage == "true" && name != "") print name
            name=""; triage=""
        }
    ' "$ACCOUNTS_YAML"
}

# Refresh: re-probe; new accounts default to triage:true; existing accounts keep flag; warn on deletions.
refresh_yaml() {
    if [[ ! -f "$ACCOUNTS_YAML" ]]; then
        echo "No accounts.yaml at $ACCOUNTS_YAML — running --init instead." >&2
        write_init_yaml
        return 0
    fi
    local probed_file existing_file new_yaml
    probed_file=$(mktemp)
    existing_file=$(mktemp)
    new_yaml=$(mktemp)
    probe_mail_accounts > "$probed_file"
    awk '
        /^[[:space:]]*-[[:space:]]*name:[[:space:]]*/ { sub(/^[[:space:]]*-[[:space:]]*name:[[:space:]]*/, ""); name=$0 }
        /^[[:space:]]*triage:[[:space:]]*/ { sub(/^[[:space:]]*triage:[[:space:]]*/, ""); printf("%s\t%s\n", name, $0); name="" }
    ' "$ACCOUNTS_YAML" > "$existing_file"
    {
        echo "# AppleMail accounts.yaml — refreshed by Tools/Accounts.sh --refresh"
        echo "accounts:"
        while IFS= read -r name; do
            [[ -z "$name" ]] && continue
            local flag
            flag=$(awk -F'\t' -v n="$name" '$1==n { print $2; exit }' "$existing_file")
            [[ -z "$flag" ]] && flag="true"
            printf '  - name: %s\n    triage: %s\n' "$name" "$flag"
        done < "$probed_file"
    } > "$new_yaml"
    while IFS=$'\t' read -r prev_name _; do
        [[ -z "$prev_name" ]] && continue
        if ! grep -qx "$prev_name" "$probed_file"; then
            echo "WARNING: account '$prev_name' was in accounts.yaml but is no longer in Mail.app." >&2
        fi
    done < "$existing_file"
    mv "$new_yaml" "$ACCOUNTS_YAML"
    rm -f "$probed_file" "$existing_file"
    echo "Refreshed $ACCOUNTS_YAML" >&2
}

main() {
    local mode="${1:-}"
    case "$mode" in
        --help|-h)
            usage
            ;;
        --init)
            write_init_yaml
            ;;
        --refresh)
            refresh_yaml
            ;;
        "")
            if [[ -f "$ACCOUNTS_YAML" ]]; then
                read_filtered
            else
                echo "No accounts.yaml at $ACCOUNTS_YAML — falling back to raw Mail.app probe." >&2
                echo "Run: Tools/Accounts.sh --init   to bootstrap." >&2
                probe_mail_accounts
            fi
            ;;
        *)
            echo "Unknown mode: $mode" >&2
            echo "" >&2
            usage >&2
            exit 2
            ;;
    esac
}

main "$@"
