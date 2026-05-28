// Integration test: full generate -> format -> parse pipeline
// Uses fixture data only — no Apple Mail, no AI classifier, no network calls

import { describe, test, expect } from "bun:test";
import { buildTriageSession, estimateMinutes } from "../Tools/GenerateTriage";
import { formatTriageNote, formatDatetime } from "../Tools/TriageFormatter";
import { buildExecutionPlan, parseActionsCell, parseTriageTable, parseCheckboxList, parseInstructions, parseMiniBlocks, parseAccountMap } from "../Tools/ExecuteTriage";
import { classifyEmail } from "../Tools/RulesEngine";
import type { ClassificationCache } from "../Tools/RulesEngine";
import type { RawEmail, ClassifiedEmail, FunnelStage } from "../Tools/Types";
import { sampleRawEmails } from "./fixtures/sample-emails";

// Minimal cache — no rules, so emails fall through to "unknown" (needs AI)
const emptyCache: ClassificationCache = {
  vipSenders: new Set(),
  junkAddresses: new Set(),
  junkDomains: new Set(),
  routingRules: [],
  knownSenders: new Set(),
};

// Helper: classify fixture emails with empty cache
function classifyFixtures(): ClassifiedEmail[] {
  return sampleRawEmails.map(e => classifyEmail(e, emptyCache));
}

// Helper: build a minimal classified email for targeted tests
function makeClassified(overrides: Partial<ClassifiedEmail> & { id: string }): ClassifiedEmail {
  return {
    id: overrides.id,
    subject: overrides.subject ?? "Test Subject",
    from: overrides.from ?? "Test <test@example.com>",
    fromAddress: overrides.fromAddress ?? "test@example.com",
    fromDomain: overrides.fromDomain ?? "example.com",
    date: overrides.date ?? "Mar 1",
    isRead: overrides.isRead ?? false,
    hasAttachment: overrides.hasAttachment ?? false,
    snippet: overrides.snippet ?? "",
    account: overrides.account ?? "iCloud",
    priority: overrides.priority ?? "review",
    funnelStage: overrides.funnelStage ?? "informational",
    matchedRule: overrides.matchedRule ?? null,
    folder: overrides.folder ?? null,
    replyDraft: overrides.replyDraft ?? null,
    isVip: overrides.isVip ?? false,
    isJunk: overrides.isJunk ?? false,
    isUnknownSender: overrides.isUnknownSender ?? false,
  };
}

describe("integration: generate -> format -> parse pipeline", () => {

  test("buildTriageSession produces valid TriageSession shape", () => {
    const classified = classifyFixtures();
    const session = buildTriageSession(classified, "2026-03-01");

    expect(session.date).toBe("2026-03-01");
    expect(session.total).toBe(sampleRawEmails.length);
    expect(session.unread).toBeGreaterThan(0);
    expect(session.estimatedMinutes).toBeGreaterThanOrEqual(0);
    expect(session.generatedAt).toBeTruthy();
    expect(Array.isArray(session.emails)).toBe(true);
    expect(session.emails.length).toBe(sampleRawEmails.length);
  });

  test("formatTriageNote produces valid markdown with funnel stage sections", () => {
    const emails: ClassifiedEmail[] = [
      makeClassified({ id: "001", priority: "action", funnelStage: "vip", isVip: true }),
      makeClassified({ id: "002", priority: "action", funnelStage: "action" }),
      makeClassified({ id: "003", priority: "review", funnelStage: "financial" }),
      makeClassified({ id: "004", priority: "archive", funnelStage: "bulk_dispose", matchedRule: "ai:marketing" }),
      makeClassified({ id: "005", priority: "trash", funnelStage: "auto_processed", matchedRule: "junk:spam.com" }),
    ];
    const session = buildTriageSession(emails, "2026-03-01");
    const markdown = formatTriageNote(session);

    // YAML frontmatter
    expect(markdown).toContain("date: 2026-03-01");
    expect(markdown).toContain("document-type: email-triage");
    expect(markdown).toContain("status: pending");

    // Funnel stage sections
    expect(markdown).toContain("## [] Stage 1: VIP (1)");
    expect(markdown).toContain("## [] Stage 2: Action Required (1)");
    expect(markdown).toContain("## [] Stage 3: Financial & Documents (1)");
    expect(markdown).toContain("## [] Stage 5: Bulk Dispose (1)");
    expect(markdown).toContain("## [] Stage 6: Auto-Processed (1)");
    expect(markdown).toContain("## Execution Log");

    // VIP/Action use mini-blocks with #### `ID`
    expect(markdown).toContain("#### `001`");
    expect(markdown).toContain("#### `002`");

    // Financial uses compact table with Type, Vendor, Amount columns
    expect(markdown).toContain("| ID | Date | Sender | Type | Vendor | Amount | Subject | 📎 | Action | Archive To | You |");

    // Stage 5 bulk dispose uses table format
    expect(markdown).toContain("| 004 [i] |");
    // Stage 6 auto-processed uses table format
    expect(markdown).toContain("| 005 [i] |");
  });

  test("parseActionsCell handles all action codes", () => {
    expect(parseActionsCell("A")).toEqual(["A"]);
    expect(parseActionsCell("R, FU:2026-03-10")).toEqual(["R", "FU:2026-03-10"]);
    expect(parseActionsCell("U, T")).toEqual(["U", "T"]);
    expect(parseActionsCell("BL")).toEqual(["BL"]);
    expect(parseActionsCell("")).toEqual([]);
    expect(parseActionsCell("  ")).toEqual([]);
    expect(parseActionsCell("J")).toEqual(["J"]);
    expect(parseActionsCell("AP")).toEqual(["AP"]);
    expect(parseActionsCell("D")).toEqual(["D"]);
    // Case-insensitive: lowercase input gets uppercased
    expect(parseActionsCell("a")).toEqual(["A"]);
    expect(parseActionsCell("r, fu:2026-03-10")).toEqual(["R", "FU:2026-03-10"]);
    expect(parseActionsCell("K")).toEqual(["K"]);
  });

  test("parseTriageTable extracts rows with actions", () => {
    const table = `| ID | Sender | Subject | Actions | Notes |
| --- | --- | --- | --- | --- |
| 001 | test@example.com | Important | R | needs reply |
| 002 | boss@work.com | Urgent | A |  |
| 003 | news@daily.com | Newsletter | T, U |  |`;

    const rows = parseTriageTable(table);
    expect(rows.length).toBe(3);
    expect(rows[0].id).toBe("001");
    expect(rows[0].actions).toEqual(["R"]);
    expect(rows[0].notes).toBe("needs reply");
    expect(rows[1].actions).toEqual(["A"]);
    expect(rows[2].actions).toEqual(["T", "U"]);
  });

  test("parseCheckboxList extracts checked and unchecked items", () => {
    const list = `- [x] \`101\` Sender A -- Subject A (domain:a.com)
- [ ] \`102\` Sender B -- Subject B (domain:b.com)
- [x] \`103\` Sender C -- Subject C (domain:c.com)`;

    const items = parseCheckboxList(list);
    expect(items.length).toBe(3);
    expect(items[0]).toEqual({ id: "101", checked: true });
    expect(items[1]).toEqual({ id: "102", checked: false });
    expect(items[2]).toEqual({ id: "103", checked: true });
  });

  test("parseInstructions handles junk domain and VIP commands", () => {
    const text = `add @spam.com to junk
VIP add boss@company.com
add marketing.net to junk`;

    const instructions = parseInstructions(text);
    expect(instructions.length).toBe(3);
    expect(instructions[0]).toEqual({ type: "add_junk_domain", value: "spam.com" });
    expect(instructions[1]).toEqual({ type: "add_vip", value: "boss@company.com" });
    expect(instructions[2]).toEqual({ type: "add_junk_domain", value: "marketing.net" });
  });

  test("buildExecutionPlan parses funnel-stage format", () => {
    const noteWithActions = `---
date: 2026-03-01
status: pending
---
# Email Triage -- March 1, 2026

## Instructions
*Examples here*

>

## Stage 1: VIP (1)
*People who matter most. Always review first.*
#### \`001\` test@example.com [VIP]
**Test Subject**
**Action:** [A]  **You:**

## Stage 2: Action Required (0)
*None*

## Stage 3: Financial & Documents (0)
*None*

## Stage 4: Informational (0)
*None*

## Stage 5: Bulk Dispose (1) -- uncheck to keep
*Marketing, transactional.*
- [x] \`002\` Example Sender -- Newsletter subject (ai:marketing)

## Stage 6: Auto-Processed (1) -- uncheck to keep
*Rule-matched and junk.*
- [x] \`003\` Spammer -- Spam subject (junk:spam.com)

## Execution Log
*Filled in by PAI after processing*
- Archived: --  |  Trashed: --  |  Replied: --  |  Unsubscribed: --  |  Blocked: --
- Processed at: --
- Duration: --
`;
    const plan = buildExecutionPlan(noteWithActions);

    expect(plan.actions.length).toBe(3);

    // Mini-block: archive action from VIP section
    const tableAction = plan.actions.find(a => a.id === "001");
    expect(tableAction).toBeTruthy();
    expect(tableAction!.actionCodes).toEqual(["A"]);
    expect(tableAction!.source).toBe("table");

    // Bulk dispose checkbox → archive
    const bulkAction = plan.actions.find(a => a.id === "002");
    expect(bulkAction).toBeTruthy();
    expect(bulkAction!.actionCodes).toEqual(["A"]);
    expect(bulkAction!.source).toBe("bulk-dispose");

    // Auto-eliminated with (junk:...) → trash
    const junkAction = plan.actions.find(a => a.id === "003");
    expect(junkAction).toBeTruthy();
    expect(junkAction!.actionCodes).toEqual(["T"]);
    expect(junkAction!.source).toBe("auto-processed");

    // Summary counts
    expect(plan.summary.archive).toBe(2); // 001 + 002
    expect(plan.summary.trash).toBe(1);   // 003
  });

  test("estimateMinutes scales with funnel stages", () => {
    expect(estimateMinutes([])).toBe(0);

    const vipEmails = [
      makeClassified({ id: "1", funnelStage: "vip" }),
      makeClassified({ id: "2", funnelStage: "action" }),
    ];
    const financialEmails = [
      makeClassified({ id: "3", funnelStage: "financial" }),
      makeClassified({ id: "4", funnelStage: "informational" }),
    ];
    const autoEmails = [
      makeClassified({ id: "5", funnelStage: "auto_processed" }),
    ];

    // 2 action-tier = 4 min, 2 informational-tier = 1 min = 5 total
    const mixed = [...vipEmails, ...financialEmails, ...autoEmails];
    expect(estimateMinutes(mixed)).toBe(5);

    // VIP + action = 2 min each
    expect(estimateMinutes(vipEmails)).toBe(4);

    // Financial + informational = 0.5 min each, ceil = 1
    expect(estimateMinutes(financialEmails)).toBe(1);

    // Auto-only = 0 min
    expect(estimateMinutes(autoEmails)).toBe(0);
  });

  test("formatDatetime produces vault-standard format", () => {
    const d = new Date(2026, 2, 1, 8, 30); // March 1, 2026 08:30
    expect(formatDatetime(d)).toBe("2026-03-01_08:30");
  });

  test("full pipeline: classify -> session -> note -> plan round-trip", () => {
    // Step 1: Classify fixture emails with empty rules
    const classified = classifyFixtures();

    // With empty rules and empty known senders, all should be unknown senders
    for (const e of classified) {
      expect(e.isUnknownSender).toBe(true);
    }

    // Step 2: Build session
    const session = buildTriageSession(classified, "2026-03-01");
    expect(session.total).toBe(5);

    // Step 3: Format to markdown
    const markdown = formatTriageNote(session);
    expect(markdown).toContain("# Email Triage -- March 1, 2026");
    expect(markdown).toContain(`total: ${session.total}`);

    // Step 4: Parse back to execution plan
    const plan = buildExecutionPlan(markdown);

    // V2 format uses review gating: stages with unchecked "## []" headings are
    // skipped by the executor. Since formatTriageNote() produces unchecked headings,
    // the round-trip correctly yields 0 actions (user must mark [x] to approve).
    expect(plan.actions.length).toBe(0);
    expect(plan.summary.archive).toBe(0);
  });

  test("unchecked bulk-dispose items are excluded from execution plan", () => {
    const note = `## Stage 5: Bulk Dispose (3) -- uncheck to keep
*Marketing, transactional.*
- [x] \`201\` Sender A -- Subject A
- [ ] \`202\` Sender B -- Subject B
- [x] \`203\` Sender C -- Subject C
`;
    const plan = buildExecutionPlan(note);

    // Only checked items (201, 203) should be in the plan
    const ids = plan.actions.map(a => a.id);
    expect(ids).toContain("201");
    expect(ids).not.toContain("202");
    expect(ids).toContain("203");
    expect(plan.summary.archive).toBe(2);
  });

  test("instructions are parsed before email actions in execution plan", () => {
    const note = `## Instructions
add @spam.com to junk
VIP add ceo@company.com

## Stage 1: VIP (1)
*People who matter most.*
#### \`301\` test@x.com [VIP]
**Hello**
**Action:** [R]  **You:**
`;
    const plan = buildExecutionPlan(note);
    expect(plan.instructions.length).toBe(2);
    expect(plan.instructions[0].type).toBe("add_junk_domain");
    expect(plan.instructions[1].type).toBe("add_vip");
    expect(plan.actions.length).toBe(1);
    expect(plan.actions[0].actionCodes).toEqual(["R"]);
  });

  test("parseMiniBlocks extracts IDs, actions, and user instructions", () => {
    const section = `*People who matter most.*
#### \`101\` boss@firm.com [VIP]
**Urgent Matter [att]**
*AI: Needs immediate response*
**Draft:** I'll handle this right away.
**Action:** [R]  **You:** reply saying I'm on it

#### \`102\` vip@company.com [VIP]
**Follow Up**
**Action:** [A]  **You:**
`;
    const blocks = parseMiniBlocks(section);
    expect(blocks.length).toBe(2);
    expect(blocks[0].id).toBe("101");
    expect(blocks[0].actions).toEqual(["R"]);
    expect(blocks[0].notes).toBe("reply saying I'm on it");
    expect(blocks[1].id).toBe("102");
    expect(blocks[1].actions).toEqual(["A"]);
    expect(blocks[1].notes).toBe("");
  });

  test("account-map roundtrip: formatter writes it, executor parses it back", () => {
    // Build classified emails with mixed accounts
    const emails: ClassifiedEmail[] = [
      makeClassified({ id: "201", funnelStage: "vip", isVip: true, account: "iCloud" }),
      makeClassified({ id: "202", funnelStage: "action", account: "Google" }),
      makeClassified({ id: "203", funnelStage: "informational", account: "iCloud" }),
      makeClassified({ id: "204", funnelStage: "bulk_dispose", account: "Google", matchedRule: "ai:marketing" }),
    ];

    // Step 1: Format -> note with account-map in frontmatter
    const session = buildTriageSession(emails, "2026-04-05");
    const markdown = formatTriageNote(session);

    // Verify account-map is in the YAML frontmatter
    expect(markdown).toContain("account-map:");

    // Step 2: Parse account-map back
    const accountMap = parseAccountMap(markdown);
    expect(accountMap.get("201")).toBe("i");
    expect(accountMap.get("202")).toBe("g");
    expect(accountMap.get("203")).toBe("i");
    expect(accountMap.get("204")).toBe("g");

    // Step 3: Build execution plan -- verify enrichItem sets account on each ActionItem
    const plan = buildExecutionPlan(markdown);
    for (const action of plan.actions) {
      const expectedAccount = accountMap.get(action.id);
      expect(action.account).toBe(expectedAccount ?? "i");
    }
  });

  test("account filter shows in triage note header", () => {
    const emails: ClassifiedEmail[] = [
      makeClassified({ id: "301", funnelStage: "informational", account: "iCloud" }),
    ];
    const session = buildTriageSession(emails, "2026-04-05", 47, "i" as any);
    const markdown = formatTriageNote(session);
    expect(markdown).toContain("(iCloud only)");
    expect(markdown).toContain("account-filter: i");
  });

  test("no account filter shows no filter label", () => {
    const emails: ClassifiedEmail[] = [
      makeClassified({ id: "302", funnelStage: "informational", account: "iCloud" }),
    ];
    const session = buildTriageSession(emails, "2026-04-05");
    const markdown = formatTriageNote(session);
    expect(markdown).not.toContain("(iCloud only)");
    expect(markdown).not.toContain("(Gmail only)");
    expect(markdown).not.toContain("account-filter:");
  });

  // --- V2 cross-cutting tests ---

  test("V2 review-gated round-trip: checked stages produce actions", () => {
    // Simulate a V2 note where user has checked Stage 4 Informational
    const note = `---
date: 2026-04-05
status: pending
account-map: "501:i,502:g,503:i"
---
# Email Triage -- April 5, 2026

## [x] Stage 4: Informational (3)

| ID | Date | Sender | Subject | Archive To | A | T | K | You |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| [501](message://501) [i] | 4/5 | sender1@x.com | Subject One | -- | x |  |  |  |
| [502](message://502) [g] | 4/5 | sender2@y.com | Subject Two | -- |  | x |  | check later |
| [503](message://503) [i] | 4/5 | sender3@z.com | Subject Three | -- | x |  |  |  |

## [] Stage 5: Bulk Dispose (1) -- uncheck to keep
*Auto-classified.*
- [x] \`601\` Promo Co -- Weekly Deal

## Execution Log
`;
    const plan = buildExecutionPlan(note);
    // Stage 4 is checked, so its actions are included
    const stage4Actions = plan.actions.filter(a => ["501", "502", "503"].includes(a.id));
    expect(stage4Actions.length).toBe(3);
    expect(stage4Actions.find(a => a.id === "501")!.actionCodes).toContain("A");
    expect(stage4Actions.find(a => a.id === "502")!.actionCodes).toContain("T");
    expect(stage4Actions.find(a => a.id === "502")!.notes).toBe("check later");

    // Stage 5 is unchecked, so its items are skipped
    const stage5Actions = plan.actions.filter(a => a.id === "601");
    expect(stage5Actions.length).toBe(0);
  });

  test("V2 mark-column table: multiple mark columns parsed correctly", () => {
    const note = `---
date: 2026-04-05
status: pending
account-map: "701:i,702:g,703:i"
---
# Email Triage

## [x] Stage 5: Bulk Dispose (3)

| ID | Sender | Subject | Archive To | A | T | J | U | BD | BS | You |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| [701](message://701) [i] | spam@bad.com | Buy Now | -- |  |  |  | x |  |  |  |
| [702](message://702) [g] | news@letter.com | Weekly | -- | x |  |  |  |  |  |  |
| [703](message://703) [i] | junk@evil.org | Click Here | -- |  |  |  |  | x |  | block domain |

## Execution Log
`;
    const plan = buildExecutionPlan(note);
    expect(plan.actions.find(a => a.id === "701")!.actionCodes).toContain("U");
    expect(plan.actions.find(a => a.id === "702")!.actionCodes).toContain("A");
    expect(plan.actions.find(a => a.id === "703")!.actionCodes).toContain("BD");
    expect(plan.actions.find(a => a.id === "703")!.notes).toBe("block domain");
  });

  test("V2 format: all stages present in generated note", () => {
    const emails: ClassifiedEmail[] = [
      makeClassified({ id: "801", funnelStage: "vip", isVip: true }),
      makeClassified({ id: "802", funnelStage: "action" }),
      makeClassified({ id: "803", funnelStage: "financial" }),
      makeClassified({ id: "804", funnelStage: "informational" }),
      makeClassified({ id: "805", funnelStage: "bulk_dispose", matchedRule: "ai:marketing" }),
      makeClassified({ id: "806", funnelStage: "unknown_sender", isUnknownSender: true }),
    ];
    const session = buildTriageSession(emails, "2026-04-05");
    const markdown = formatTriageNote(session);

    // All V2 stages present
    expect(markdown).toContain("Stage 1:");
    expect(markdown).toContain("Stage 2:");
    expect(markdown).toContain("Stage 3:");
    expect(markdown).toContain("Stage 4:");
    expect(markdown).toContain("Stage 5:");
    expect(markdown).toContain("Stage 6:");

    // Review checkboxes present on gated stages
    expect(markdown).toMatch(/## \[] Stage [456]/);
  });

  test("migration: db schema handles all V2 columns", () => {
    const { initDb, recordScheduledSend, getDueSends, markSendComplete } = require("../Tools/Db");
    const { Database } = require("bun:sqlite");

    // Verify scheduled_sends has new columns
    const db = initDb(":memory:");
    recordScheduledSend(db, {
      emailId: "m1",
      sendAt: "2026-04-07_08:00",
      replyContent: "test",
      recipient: "a@b.com",
      subject: "s",
      account: "g",
      jsonPath: "/tmp/send-1.json",
      plistPath: "/tmp/com.pai.send.1.plist",
    });
    const rows = db.prepare("SELECT account, json_path, plist_path FROM scheduled_sends WHERE email_id = ?").all("m1") as any[];
    expect(rows[0].account).toBe("g");
    expect(rows[0].json_path).toBe("/tmp/send-1.json");
    expect(rows[0].plist_path).toBe("/tmp/com.pai.send.1.plist");
    db.close();
  });
});
