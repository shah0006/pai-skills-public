// ~/.claude/skills/EmailTriage/tests/execute-triage.test.ts
import { describe, test, expect } from "bun:test";
import {
  parseActionsCell,
  parseTriageTable,
  parseCheckboxList,
  parseInstructions,
  buildExecutionPlan,
  checkInboxCompleteness,
  parseAccountMap,
  parseArrivalMap,
} from "../Tools/ExecuteTriage";

// --- parseActionsCell ---

describe("parseActionsCell", () => {
  test("parses single action code", () => {
    expect(parseActionsCell("K")).toEqual(["K"]);
  });

  test("parses multiple comma-separated codes", () => {
    expect(parseActionsCell("R, FU:2026-03-10")).toEqual(["R", "FU:2026-03-10"]);
  });

  test("parses codes without spaces after comma", () => {
    expect(parseActionsCell("T,BL")).toEqual(["T", "BL"]);
  });

  test("returns empty array for blank string", () => {
    expect(parseActionsCell("")).toEqual([]);
  });

  test("returns empty array for whitespace-only string", () => {
    expect(parseActionsCell("   ")).toEqual([]);
  });

  test("trims whitespace from individual codes", () => {
    expect(parseActionsCell(" A , T ")).toEqual(["A", "T"]);
  });

  test("handles single action with colon parameter", () => {
    expect(parseActionsCell("FU:2026-04-01")).toEqual(["FU:2026-04-01"]);
  });
});

// --- parseTriageTable ---

describe("parseTriageTable", () => {
  const sampleTable = `| ID | Sender | Subject | Actions | Notes |
| --- | --- | --- | --- | --- |
| 12345 | alice@test.com | Meeting tomorrow | R | reply needed |
| 67890 | bob@test.com [VIP] | Invoice #42 [att] | A, FU:2026-03-15 | archive + followup |
| 11111 | spam@junk.com | Buy now!!! | T |  |`;

  test("extracts correct number of rows", () => {
    const rows = parseTriageTable(sampleTable);
    expect(rows).toHaveLength(3);
  });

  test("extracts id from first column", () => {
    const rows = parseTriageTable(sampleTable);
    expect(rows[0].id).toBe("12345");
    expect(rows[1].id).toBe("67890");
    expect(rows[2].id).toBe("11111");
  });

  test("extracts parsed actions from Actions column", () => {
    const rows = parseTriageTable(sampleTable);
    expect(rows[0].actions).toEqual(["R"]);
    expect(rows[1].actions).toEqual(["A", "FU:2026-03-15"]);
    expect(rows[2].actions).toEqual(["T"]);
  });

  test("extracts notes from Notes column", () => {
    const rows = parseTriageTable(sampleTable);
    expect(rows[0].notes).toBe("reply needed");
    expect(rows[1].notes).toBe("archive + followup");
  });

  test("handles blank Actions cell", () => {
    const table = `| ID | Sender | Subject | Actions | Notes |
| --- | --- | --- | --- | --- |
| 55555 | noop@test.com | Nothing to do |  |  |`;
    const rows = parseTriageTable(table);
    expect(rows[0].actions).toEqual([]);
  });

  test("returns empty array for empty input", () => {
    expect(parseTriageTable("")).toEqual([]);
  });

  test("skips header and separator rows", () => {
    const table = `| ID | Sender | Subject | Actions | Notes |
| --- | --- | --- | --- | --- |
| 99999 | test@x.com | Only row | K |  |`;
    const rows = parseTriageTable(table);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("99999");
  });
});

// --- parseCheckboxList ---

describe("parseCheckboxList", () => {
  test("extracts checked items", () => {
    const text = `- [x] \`79640\` Nate's Substack -- Weekly digest (domain:substack.com)
- [x] \`79641\` LinkedIn -- New connections`;
    const items = parseCheckboxList(text);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ id: "79640", checked: true });
    expect(items[1]).toEqual({ id: "79641", checked: true });
  });

  test("extracts unchecked items", () => {
    const text = `- [ ] \`88888\` Keep This -- Important newsletter`;
    const items = parseCheckboxList(text);
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({ id: "88888", checked: false });
  });

  test("handles mix of checked and unchecked", () => {
    const text = `- [x] \`11111\` Trash this
- [ ] \`22222\` Keep this
- [x] \`33333\` Trash this too`;
    const items = parseCheckboxList(text);
    expect(items).toHaveLength(3);
    expect(items[0].checked).toBe(true);
    expect(items[1].checked).toBe(false);
    expect(items[2].checked).toBe(true);
  });

  test("returns empty array for no checkboxes", () => {
    expect(parseCheckboxList("Some random text\nwith no checkboxes")).toEqual([]);
  });

  test("returns empty array for empty input", () => {
    expect(parseCheckboxList("")).toEqual([]);
  });
});

// --- parseInstructions ---

describe("parseInstructions", () => {
  test("recognizes add-junk-domain pattern", () => {
    const result = parseInstructions("add @newsletter.com to junk");
    expect(result).toEqual([{ type: "add_junk_domain", value: "newsletter.com" }]);
  });

  test("recognizes add-junk-domain without @ prefix", () => {
    const result = parseInstructions("add domain.com to junk");
    expect(result).toEqual([{ type: "add_junk_domain", value: "domain.com" }]);
  });

  test("recognizes VIP add pattern", () => {
    const result = parseInstructions("VIP add boss@company.com");
    expect(result).toEqual([{ type: "add_vip", value: "boss@company.com" }]);
  });

  test("handles case-insensitive VIP", () => {
    const result = parseInstructions("vip add ceo@firm.com");
    expect(result).toEqual([{ type: "add_vip", value: "ceo@firm.com" }]);
  });

  test("returns empty for unrecognized instructions", () => {
    const result = parseInstructions("create rule for all LinkedIn");
    expect(result).toEqual([]);
  });

  test("returns empty for blank input", () => {
    expect(parseInstructions("")).toEqual([]);
  });

  test("handles multiple instructions on separate lines", () => {
    const text = `add @spam.org to junk
VIP add friend@gmail.com`;
    const result = parseInstructions(text);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ type: "add_junk_domain", value: "spam.org" });
    expect(result[1]).toEqual({ type: "add_vip", value: "friend@gmail.com" });
  });
});

// --- buildExecutionPlan (integration of parsing + dry-run logic) ---

describe("buildExecutionPlan", () => {
  const sampleNote = `---
date: 2026-03-01
document-type: email-triage
accounts: [icloud, gmail]
total: 6
unread: 4
status: pending
processed_at: null
---
# Email Triage -- March 1, 2026
> 6 emails | 4 unread | Generated: 7:40 AM | Est. review: 3 min
> Edit Actions column using codes below. Leave blank to keep as-is.
>
> **Codes:** K=Keep A=Archive T=Trash R=Reply D=Defer FU=Follow-up J=Junk U=Unsub AP=Approve BL=Block
> Multiple actions: comma-separated -- e.g. \`R, FU:2026-03-10\` or \`U, T\`

## Instructions
*Freeform commands -- executor parses and applies before processing emails.*
add @marketing.io to junk
VIP add doctor@hospital.org

## Action Required (1)
*VIP senders and AI-flagged urgent items. Edit Actions column.*

| ID | Sender | Subject | Actions | Notes |
| --- | --- | --- | --- | --- |
| 10001 | vip@example.com [VIP] | Urgent matter | R | must reply |

**Reply Drafts:**

**10001 -- vip@example.com:**
> Thank you for reaching out. I will review and respond shortly.

## Review Needed (2)
*Non-VIP emails needing a decision. Edit Actions column.*

| ID | Sender | Subject | Actions | Notes |
| --- | --- | --- | --- | --- |
| 10002 | newsletter@news.com | Weekly digest | A |  |
| 10003 | colleague@work.com | Project update | K |  |

## Unknown Senders (1)
*First-time senders. AP = approve (add to known), BL = block (add to junk).*

| ID | Sender | Subject | Actions | Notes |
| --- | --- | --- | --- | --- |
| 10004 | stranger@unknown.com | Hello there | BL |  |

## Auto-Archive Queue (1) -- uncheck to keep
*Rule-matched or AI-classified as low-priority. All will be archived.*
- [x] \`10005\` Substack Digest -- Weekly roundup (domain:substack.com)

## Auto-Trash Queue (1) -- uncheck to keep
*Junk registry matches or AI-classified as trash.*
- [x] \`10006\` Spam Corp -- Buy now!!! (junk:domain)

## Unsubscribe Queue (0) -- uncheck to skip
*PAI detected List-Unsubscribe headers. Will auto-unsubscribe via RFC 8058.*

## Execution Log
*Filled in by PAI after processing*
- Archived: --  |  Trashed: --  |  Replied: --  |  Unsubscribed: --  |  Blocked: --
- Processed at: --
- Duration: --`;

  test("dry run mode: returns action plan without executing", () => {
    const plan = buildExecutionPlan(sampleNote);
    expect(plan).toBeDefined();
    expect(plan.instructions).toHaveLength(2);
    expect(plan.actions.length).toBeGreaterThan(0);
  });

  test("parses instructions from note", () => {
    const plan = buildExecutionPlan(sampleNote);
    expect(plan.instructions[0]).toEqual({ type: "add_junk_domain", value: "marketing.io" });
    expect(plan.instructions[1]).toEqual({ type: "add_vip", value: "doctor@hospital.org" });
  });

  test("parses action table rows into plan", () => {
    const plan = buildExecutionPlan(sampleNote);
    const ids = plan.actions.map(a => a.id);
    expect(ids).toContain("10001");
    expect(ids).toContain("10002");
    expect(ids).toContain("10003");
    expect(ids).toContain("10004");
  });

  test("parses checked auto-archive items", () => {
    const plan = buildExecutionPlan(sampleNote);
    const archiveItem = plan.actions.find(a => a.id === "10005");
    expect(archiveItem).toBeDefined();
    expect(archiveItem!.actionCodes).toEqual(["A"]);
  });

  test("parses checked auto-trash items", () => {
    const plan = buildExecutionPlan(sampleNote);
    const trashItem = plan.actions.find(a => a.id === "10006");
    expect(trashItem).toBeDefined();
    expect(trashItem!.actionCodes).toEqual(["T"]);
  });

  test("skips emails with no actions (K = keep = no-op)", () => {
    const plan = buildExecutionPlan(sampleNote);
    const keepItem = plan.actions.find(a => a.id === "10003");
    expect(keepItem).toBeDefined();
    expect(keepItem!.actionCodes).toEqual(["K"]);
  });

  test("extracts reply draft for R action", () => {
    const plan = buildExecutionPlan(sampleNote);
    const replyItem = plan.actions.find(a => a.id === "10001");
    expect(replyItem).toBeDefined();
    expect(replyItem!.replyDraft).toContain("Thank you for reaching out");
  });

  test("generates correct summary counts", () => {
    const plan = buildExecutionPlan(sampleNote);
    expect(plan.summary.archive).toBe(2);  // 10002 + 10005
    expect(plan.summary.trash).toBe(2);    // 10006 + 10004 (BL = trash + block)
    expect(plan.summary.reply).toBe(1);    // 10001
    expect(plan.summary.block).toBe(1);    // 10004
    expect(plan.summary.keep).toBe(1);     // 10003
  });

  test("handles note with no action tables gracefully", () => {
    const minimalNote = `---
date: 2026-03-01
status: pending
---
# Email Triage -- March 1, 2026

## Instructions

## Execution Log
`;
    const plan = buildExecutionPlan(minimalNote);
    expect(plan.actions).toEqual([]);
    expect(plan.instructions).toEqual([]);
  });

  test("unchecked auto-queue items are excluded from plan", () => {
    const noteWithUnchecked = `---
date: 2026-03-01
status: pending
---
# Email Triage

## Instructions

## Auto-Archive Queue (2) -- uncheck to keep
- [x] \`50001\` Keep archiving -- yes
- [ ] \`50002\` Do not archive -- no

## Execution Log
`;
    const plan = buildExecutionPlan(noteWithUnchecked);
    const ids = plan.actions.map(a => a.id);
    expect(ids).toContain("50001");
    expect(ids).not.toContain("50002");
  });
});

// --- checkInboxCompleteness ---

describe("checkInboxCompleteness", () => {
  test("returns zero-remaining message when inbox is empty", () => {
    const result = checkInboxCompleteness(0, 0);
    expect(result.remaining).toBe(0);
    expect(result.message).toContain("Inbox zero achieved");
  });

  test("returns warning when emails remain", () => {
    const result = checkInboxCompleteness(5, 2);
    expect(result.remaining).toBe(5);
    expect(result.message).toContain("5 emails still in inbox");
    expect(result.message).toContain("2 arrived during processing");
  });

  test("distinguishes pre-triage from new arrivals", () => {
    const result = checkInboxCompleteness(10, 3);
    expect(result.remaining).toBe(10);
    expect(result.message).toContain("7 pre-triage");
    expect(result.message).toContain("3 arrived during processing");
  });

  test("handles case where all remaining are new arrivals", () => {
    const result = checkInboxCompleteness(4, 4);
    expect(result.remaining).toBe(4);
    expect(result.message).toContain("0 pre-triage");
    expect(result.message).toContain("4 arrived during processing");
  });
});

// --- parseAccountMap ---

describe("parseAccountMap", () => {
  test("parses standard account-map from frontmatter", () => {
    const note = `---\naccount-map: "101:i,102:g,103:i"\n---\n# Test`;
    const map = parseAccountMap(note);
    expect(map.size).toBe(3);
    expect(map.get("101")).toBe("i");
    expect(map.get("102")).toBe("g");
    expect(map.get("103")).toBe("i");
  });

  test("returns empty map when no account-map in frontmatter", () => {
    const note = `---\ndate: 2026-04-05\n---\n# Test`;
    const map = parseAccountMap(note);
    expect(map.size).toBe(0);
  });

  test("returns empty map for empty account-map value", () => {
    const note = `---\naccount-map: ""\n---\n# Test`;
    const map = parseAccountMap(note);
    expect(map.size).toBe(0);
  });

  test("handles whitespace in pairs", () => {
    const note = `---\naccount-map: " 101 : i , 102 : g "\n---`;
    const map = parseAccountMap(note);
    expect(map.get("101")).toBe("i");
    expect(map.get("102")).toBe("g");
  });

  test("skips malformed pairs (missing colon)", () => {
    const note = `---\naccount-map: "101:i,badpair,103:g"\n---`;
    const map = parseAccountMap(note);
    expect(map.size).toBe(2);
    expect(map.get("101")).toBe("i");
    expect(map.get("103")).toBe("g");
  });

  test("handles trailing comma", () => {
    const note = `---\naccount-map: "101:i,102:g,"\n---`;
    const map = parseAccountMap(note);
    expect(map.size).toBe(2);
  });

  test("last entry wins for duplicate IDs", () => {
    const note = `---\naccount-map: "101:i,101:g"\n---`;
    const map = parseAccountMap(note);
    expect(map.get("101")).toBe("g");
  });
});

// --- Phase 13.6: Follow-up tracking in execute-triage (source checks) ---

import { readFileSync } from "fs";
import { join } from "path";

describe("Phase 13.6: follow-up tracking in executor", () => {
  const source = readFileSync(join(__dirname, "../Tools/ExecuteTriage.ts"), "utf-8");

  test("resolveFollowUp is imported", () => {
    expect(source).toContain("resolveFollowUp");
  });

  test("Reply action resolves follow-ups", () => {
    // In the case "R" block, resolveFollowUp should be called
    const rCaseBlock = source.slice(source.indexOf('case "R":'), source.indexOf('case "D":'));
    expect(rCaseBlock).toContain("resolveFollowUp(db, item.id)");
  });

  test("Archive action resolves follow-ups", () => {
    // In the case "A" block, resolveFollowUp should be called
    const aCaseBlock = source.slice(source.indexOf('case "A":'), source.indexOf('case "T":'));
    expect(aCaseBlock).toContain("resolveFollowUp(db, item.id)");
  });

  test("FU:date action records follow-up", () => {
    expect(source).toContain("recordFollowUp(db,");
  });
});

describe("parseArrivalMap", () => {
  test("parses standard arrival-map with colons in timestamps", () => {
    const note = `---\narrival-map: "101:2026-05-20_13:15,102:2026-05-20_13:30"\n---\n# Test`;
    const map = parseArrivalMap(note);
    expect(map.size).toBe(2);
    expect(map.get("101")).toBe("2026-05-20_13:15");
    expect(map.get("102")).toBe("2026-05-20_13:30");
  });

  test("handles unquoted or single quoted or malformed pairs", () => {
    const note = `---\narrival-map: 101:2026-05-20_13:15,102:2026-05-20_13:30\n---`;
    const map = parseArrivalMap(note);
    expect(map.size).toBe(2);
    expect(map.get("101")).toBe("2026-05-20_13:15");
    expect(map.get("102")).toBe("2026-05-20_13:30");
  });

  test("handles empty/missing map gracefully", () => {
    const note = `---\ndate: 2026-05-20\n---`;
    const map = parseArrivalMap(note);
    expect(map.size).toBe(0);
  });
});

describe("buildExecutionPlan enrichment with arrivalTimestamp", () => {
  test("enriches VIP action items with arrivalTimestamp", () => {
    const note = `---
account-map: "101:i"
arrival-map: "101:2026-05-20_13:15"
---
## [x] Stage 1: VIP
#### \`101\` boss@firm.com -- Urgent Matter -- May 20, 2026_13:15 [VIP]
**Subject:** Urgent Matter
**Action:** [R]
**Draft reply:** Okay.
`;
    const plan = buildExecutionPlan(note);
    expect(plan.actions.length).toBe(1);
    expect(plan.actions[0].id).toBe("101");
    expect(plan.actions[0].arrivalTimestamp).toBe("2026-05-20_13:15");
  });
});

