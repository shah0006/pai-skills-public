// tests/merge-stage-summary.test.ts — Bug B regression coverage.
//
// mergeIntoExistingNote previously updated section heading counts +
// frontmatter totals but DID NOT reconcile the human-readable stage
// summary line (`> 5 VIP | 0 Action | 0 Financial | 0 Info | 26 Bulk |
// 11 Auto-processed`). Result: incremental re-generation produced a doc
// where the summary disagreed with the section counts.
import { describe, test, expect } from "bun:test";
import { mergeIntoExistingNote } from "../Tools/GenerateTriage";

function fixtureWithStaleSummary(): string {
  // Sections show real counts (11 VIP, 0 Action, 0 Financial, 0 Info, 20 Bulk,
  // 11 Auto-processed) but the summary line still says the old 5/26 counts.
  const vipEntries = Array.from({ length: 11 }, (_, i) =>
    `#### [9700${i}](message://test-${i}) sender${i}@test [VIP] [i] -- 2026-05-18\n**Subject ${i}**\n`
  ).join("\n");
  const bulkRows = Array.from({ length: 20 }, (_, i) =>
    `| [9800${i}](message://b-${i}) [i] | bulk${i}@x | Bulk subject ${i} | | | | x | | | | | | |`
  ).join("\n");
  const autoRows = Array.from({ length: 11 }, (_, i) =>
    `| [9900${i}](message://a-${i}) [i] | auto${i}@x | Auto subject ${i} | | staged | | x | | | | | | | |`
  ).join("\n");

  return `---
date: 2026-05-18
document-type: email-triage
total: 42
inbox-total: 42
unread: 47
review-count: 11
auto-count: 31
account-map: "97000:i"
status: pending
modified: 2026-05-18T10:00:00
---
# Email Triage -- May 18, 2026

> 42 emails | 47 unread | 11 need review | Generated: 2026-05-18_14:43 | Est. review: 3 min
> 5 VIP | 0 Action | 0 Financial | 0 Info | 26 Bulk | 11 Auto-processed
>
> **Action codes:** K=Keep A=Archive T=Trash R=Reply D=Defer FU=Follow-up J=Junk U=Unsub AP=Approve BL=Block

## [] Stage 1: VIP (11)
*People who matter most.*

${vipEntries}

## [] Stage 2: Action Required (0)
*Direct asks needing your response.*

*None*

## [] Stage 3: Financial & Documents (0)
*Receipts, statements.*

*None*

## [] Stage 4: Informational (0)
*Newsletters and updates.*

*None*

## [] Stage 5: Bulk Dispose (20)
*Bulk archive or trash.*

| ID | Sender | Subject | 📎 | Archive To | A | T | J | U | BD | BS | You |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${bulkRows}

## [] Stage 6: Auto-Processed (11)
*Pre-classified.*

| ID | Sender | Subject | 📎 | Rule | Archive To | A | T | K | J | U | BD | BS | You |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${autoRows}

## Execution Log
*(empty)*
`;
}

describe("mergeIntoExistingNote — Bug B stale stage summary line", () => {
  test("reconciles the summary line to match actual section counts", () => {
    const before = fixtureWithStaleSummary();
    expect(before).toContain("> 5 VIP | 0 Action | 0 Financial | 0 Info | 26 Bulk | 11 Auto-processed");

    // Re-merge with no new emails — the reconciliation block should fix the summary.
    const after = mergeIntoExistingNote(before, [], [], new Date().toISOString());

    expect(after).toContain("> 11 VIP | 0 Action | 0 Financial | 0 Info | 20 Bulk | 11 Auto-processed");
    expect(after).not.toContain("> 5 VIP | 0 Action | 0 Financial | 0 Info | 26 Bulk | 11 Auto-processed");
  });

  test("section heading counts remain accurate after merge", () => {
    const before = fixtureWithStaleSummary();
    const after = mergeIntoExistingNote(before, [], [], new Date().toISOString());

    expect(after).toMatch(/## \[\] Stage 1: VIP \(11\)/);
    expect(after).toMatch(/## \[\] Stage 2: Action Required \(0\)/);
    expect(after).toMatch(/## \[\] Stage 5: Bulk Dispose \(20\)/);
    expect(after).toMatch(/## \[\] Stage 6: Auto-Processed \(11\)/);
  });

  test("frontmatter total is reconciled from section counts (11 + 20 + 11 = 42)", () => {
    const before = fixtureWithStaleSummary();
    const after = mergeIntoExistingNote(before, [], [], new Date().toISOString());

    expect(after).toMatch(/^total: 42$/m);
    expect(after).toMatch(/^review-count: 11$/m);
    expect(after).toMatch(/^auto-count: 31$/m);
  });
});
