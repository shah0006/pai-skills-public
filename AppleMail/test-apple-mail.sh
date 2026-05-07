#!/bin/bash
#
# Apple Mail Skill — Smoke Test Suite
# Runs read-only commands to verify all major subsystems work.
# Usage: bash ~/.claude/skills/AppleMail/test-apple-mail.sh
#

SCRIPT="$HOME/.claude/skills/AppleMail/apple-mail.sh"
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
