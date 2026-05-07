#!/bin/bash
#
# Apple Mail Skill — Smoke Test Suite
# Runs read-only commands to verify all major subsystems work.
# Usage: bash ~/.claude/skills/AppleMail/test-apple-mail.sh
#

SCRIPT="$HOME/.claude/skills/AppleMail/Tools/apple-mail.sh"
PASS=0
FAIL=0
SKIP=0

pass() { echo "  ✓ $1"; ((PASS++)); }
fail() { echo "  ✗ $1"; ((FAIL++)); }
skip() { echo "  - $1 (skipped)"; ((SKIP++)); }

run_test() {
    local name="$1"; shift
    local output
    output=$("$SCRIPT" "$@" 2>&1)
    local exit_code=$?
    if [[ $exit_code -eq 0 ]] && [[ -n "$output" ]] && ! echo "$output" | grep -qi "^Error:"; then
        pass "$name"
    else
        fail "$name → $output"
    fi
}

echo ""
echo "Apple Mail Skill v2.2.0 — Smoke Test"
echo "======================================"
echo ""

echo "── INFO COMMANDS ──"
run_test "accounts" accounts
run_test "folders" folders

echo ""
echo "── LISTING ──"
run_test "list inbox (5)" list 5
run_test "list --unread" list --unread
run_test "list sent (3)" list --mailbox sent 3

echo ""
echo "── UNREAD COUNT ──"
run_test "unread inbox" unread
run_test "unread sent" unread --mailbox sent

echo ""
echo "── SEARCH ──"
run_test "search inbox (subject)" search "the" 3
run_test "search --mailbox all" search "the" --mailbox all 3
run_test "search --from filter" search "the" --from "@" --mailbox all 5
run_test "search --after date" search "the" --after 2026-01-01 --mailbox all 3

echo ""
echo "── READ (uses first inbox message) ──"
FIRST_ID=$("$SCRIPT" list 1 2>/dev/null | grep "^ID:" | head -1 | awk '{print $1}' | sed 's/ID://')
if [[ -n "$FIRST_ID" ]]; then
    run_test "read <id>" read "$FIRST_ID"
    run_test "attachments <id>" attachments "$FIRST_ID"
    run_test "thread <id>" thread "$FIRST_ID"
    run_test "thread-read <id>" thread-read "$FIRST_ID"
else
    skip "read/attachments/thread (inbox empty)"
fi

echo ""
echo "── HELP ──"
run_test "help" help

echo ""
echo "── SEND VALIDATION (no actual send) ──"
# Test that error message fires correctly for missing args
output=$("$SCRIPT" send 2>&1)
if echo "$output" | grep -q "required\|Error\|Usage"; then
    pass "send missing-args produces error"
    ((PASS++))
else
    fail "send missing-args should produce error"
    ((FAIL++))
fi

# Test that bulk dry-run works (no --confirm = safe)
output=$("$SCRIPT" bulk-trash --mailbox inbox 2>&1)
if echo "$output" | grep -qi "DRY-RUN\|dry.run\|Would"; then
    pass "bulk-trash dry-run (no --confirm)"
    ((PASS++))
else
    fail "bulk-trash without --confirm should dry-run → $output"
    ((FAIL++))
fi

echo ""
echo "── LABEL ALIASES (v5.1 housekeeping) ──"
run_test "list-labels (alias for folders)" list-labels
run_test "label-tree (alias for folder-tree)" label-tree
# Alias parity: same handler returns identical error output for missing args
out_mb=$("$SCRIPT" delete-mailbox 2>&1 || true)
out_lb=$("$SCRIPT" delete-label   2>&1 || true)
if [[ -n "$out_mb" && "$out_mb" == "$out_lb" ]]; then
    pass "delete-label parity with delete-mailbox"
else
    fail "delete-label parity with delete-mailbox (mb=$out_mb / lb=$out_lb)"
fi
out_mb=$("$SCRIPT" rename-mailbox 2>&1 || true)
out_lb=$("$SCRIPT" rename-label   2>&1 || true)
if [[ -n "$out_mb" && "$out_mb" == "$out_lb" ]]; then
    pass "rename-label parity with rename-mailbox"
else
    fail "rename-label parity with rename-mailbox"
fi
out_mb=$("$SCRIPT" create-mailbox 2>&1 || true)
out_lb=$("$SCRIPT" create-label   2>&1 || true)
if [[ -n "$out_mb" && "$out_mb" == "$out_lb" ]]; then
    pass "create-label parity with create-mailbox"
else
    fail "create-label parity with create-mailbox"
fi
# --label flag rewrites to --mailbox: search with --label all should work
output=$("$SCRIPT" search "the" 1 --label all 2>&1 || true)
if echo "$output" | grep -qi "Search:"; then
    pass "--label flag rewrites to --mailbox"
else
    fail "--label flag should rewrite to --mailbox → $output"
fi

echo ""
echo "── EMPTY TRASH (v5.1 housekeeping) ──"
# Unknown account errors cleanly even with --force
output=$("$SCRIPT" empty-trash --account=NONEXISTENT_XYZ --force 2>&1 || true)
if echo "$output" | grep -qi "not found"; then
    pass "empty-trash unknown account errors"
else
    fail "empty-trash unknown account should error → $output"
fi
# Prompt flow with 'n' answer skips deletion (or already-empty path)
output=$(echo "n" | "$SCRIPT" empty-trash --account=iCloud 2>&1 || true)
if echo "$output" | grep -qi "Skipped\|Trash already empty\|Permanently delete"; then
    pass "empty-trash prompt flow (n keeps Trash intact)"
else
    fail "empty-trash prompt flow → $output"
fi

echo ""
echo "── HELP TEXT (v5.1 housekeeping) ──"
output=$("$SCRIPT" help 2>&1)
if echo "$output" | grep -qE "empty-trash" && echo "$output" | grep -qE "restore "; then
    pass "help mentions v5.1 commands (empty-trash + restore)"
else
    fail "help should mention empty-trash and restore"
fi

echo ""
echo "── RESTORE (v5.1 housekeeping) ──"
# Missing message ID errors
output=$("$SCRIPT" restore 2>&1 || true)
if echo "$output" | grep -qi "required\|Error"; then
    pass "restore missing-id errors"
else
    fail "restore missing-id should error → $output"
fi
# Nonexistent message ID errors
output=$("$SCRIPT" restore 999999999999 --account=iCloud 2>&1 || true)
if echo "$output" | grep -qi "not found\|failed\|Error"; then
    pass "restore unknown message-id errors"
else
    fail "restore unknown message-id should error → $output"
fi

echo ""
echo "══════════════════════════════════════"
echo "Results: $PASS passed | $FAIL failed | $SKIP skipped"
echo ""
if [[ $FAIL -eq 0 ]]; then
    echo "✓ All tests passed — skill is healthy"
    exit 0
else
    echo "✗ $FAIL test(s) failed — investigate above"
    exit 1
fi
