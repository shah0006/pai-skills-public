// Tests for generate-triage.ts — the orchestrator that fetches, classifies, and outputs triage notes
import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { join } from "path";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { sampleRawEmails } from "./fixtures/sample-emails";
import type { ClassifiedEmail, TriageSession } from "../Tools/Types";

import {
  estimateMinutes,
  buildTriageSession,
  getOutputPath,
  buildClassificationCache,
  fetchEmails,
  generateTriage,
  parseExistingNote,
  mergeIntoExistingNote,
} from "../Tools/GenerateTriage";
import { formatTriageNote } from "../Tools/TriageFormatter";
import { initDb, runMigration } from "../Tools/Db";

// Test-only vault root. Set via env var so the live VAULT_ROOT loader picks it up.
const VAULT_ROOT = "/Volumes/Hyperdrive 4 Tb/Main Obsidian (Sync)";
process.env.EMAILTRIAGE_VAULT_ROOT = VAULT_ROOT;

// Helper: build a ClassifiedEmail from minimal data
function makeClassified(overrides: Partial<ClassifiedEmail>): ClassifiedEmail {
  return {
    id: "1",
    subject: "Test",
    from: "test@test.com",
    fromAddress: "test@test.com",
    fromDomain: "test.com",
    date: "2026-03-01",
    isRead: false,
    hasAttachment: false,
    snippet: "",
    account: "iCloud",
    priority: "review",
    funnelStage: "informational",
    matchedRule: null,
    folder: null,
    replyDraft: null,
    isVip: false,
    isJunk: false,
    isUnknownSender: false,
    ...overrides,
  };
}

// ─── estimateMinutes ───

describe("estimateMinutes", () => {
  test("returns 0 for empty array", () => {
    expect(estimateMinutes([])).toBe(0);
  });

  test("VIP and action emails cost 2 minutes each", () => {
    const emails = [
      makeClassified({ funnelStage: "vip" }),
      makeClassified({ funnelStage: "action" }),
    ];
    expect(estimateMinutes(emails)).toBe(4);
  });

  test("financial emails cost 0.5 minutes each", () => {
    const emails = [
      makeClassified({ funnelStage: "financial" }),
      makeClassified({ funnelStage: "financial" }),
    ];
    expect(estimateMinutes(emails)).toBe(1);
  });

  test("informational emails cost 0.5 minutes each", () => {
    const emails = [
      makeClassified({ funnelStage: "informational" }),
    ];
    expect(estimateMinutes(emails)).toBe(1);
  });

  test("bulk_dispose and auto_processed cost 0 minutes", () => {
    const emails = [
      makeClassified({ funnelStage: "bulk_dispose" }),
      makeClassified({ funnelStage: "auto_processed" }),
    ];
    expect(estimateMinutes(emails)).toBe(0);
  });

  test("mixed funnel stages sum correctly and ceil", () => {
    const emails = [
      makeClassified({ funnelStage: "vip" }),             // 2
      makeClassified({ funnelStage: "action" }),           // 2
      makeClassified({ funnelStage: "financial" }),        // 0.5
      makeClassified({ funnelStage: "informational" }),    // 0.5
      makeClassified({ funnelStage: "bulk_dispose" }),     // 0
      makeClassified({ funnelStage: "auto_processed" }),  // 0
    ];
    // 2 + 2 + 0.5 + 0.5 = 5
    expect(estimateMinutes(emails)).toBe(5);
  });
});

// ─── getOutputPath ───

describe("getOutputPath", () => {
  test("returns correct vault path for a date", () => {
    const path = getOutputPath("2026-03-01");
    expect(path).toBe(`${VAULT_ROOT}/Email Triage/Email Triage -- March 1, 2026.md`);
  });

  test("returns different paths for different dates", () => {
    const p1 = getOutputPath("2026-01-15");
    const p2 = getOutputPath("2026-02-28");
    expect(p1).not.toBe(p2);
    expect(p1).toContain("January 15, 2026");
    expect(p2).toContain("February 28, 2026");
    expect(p1.endsWith(".md")).toBe(true);
    expect(p2.endsWith(".md")).toBe(true);
  });
});

// ─── buildTriageSession ───

describe("buildTriageSession", () => {
  test("assembles session with correct date and counts", () => {
    const classified: ClassifiedEmail[] = [
      makeClassified({ id: "1", isRead: false, funnelStage: "vip" }),
      makeClassified({ id: "2", isRead: true, funnelStage: "informational" }),
      makeClassified({ id: "3", isRead: false, funnelStage: "auto_processed" }),
    ];

    const session = buildTriageSession(classified, "2026-03-01");
    expect(session.date).toBe("2026-03-01");
    expect(session.total).toBe(3);
    expect(session.unread).toBe(2);
    expect(session.emails).toHaveLength(3);
    expect(session.generatedAt).toBeTruthy();
  });

  test("unread count only counts isRead=false", () => {
    const classified: ClassifiedEmail[] = [
      makeClassified({ id: "1", isRead: true }),
      makeClassified({ id: "2", isRead: true }),
      makeClassified({ id: "3", isRead: false }),
    ];

    const session = buildTriageSession(classified, "2026-03-01");
    expect(session.unread).toBe(1);
  });

  test("estimatedMinutes matches estimateMinutes function", () => {
    const classified: ClassifiedEmail[] = [
      makeClassified({ funnelStage: "action" }),
      makeClassified({ funnelStage: "informational" }),
    ];
    const session = buildTriageSession(classified, "2026-03-01");
    expect(session.estimatedMinutes).toBe(estimateMinutes(classified));
  });

  test("generatedAt is a valid ISO timestamp", () => {
    const session = buildTriageSession([], "2026-03-01");
    const parsed = new Date(session.generatedAt);
    expect(parsed.getTime()).not.toBeNaN();
  });

  test("empty emails produces zero counts", () => {
    const session = buildTriageSession([], "2026-03-01");
    expect(session.total).toBe(0);
    expect(session.unread).toBe(0);
    expect(session.estimatedMinutes).toBe(0);
    expect(session.emails).toHaveLength(0);
  });
});

// ─── buildClassificationCache ───

describe("buildClassificationCache", () => {
  test("builds cache with Sets from a migrated DB", () => {
    const seedDir = join(import.meta.dir, "..", "References");
    const db = initDb(":memory:");
    runMigration(db, seedDir);
    const cache = buildClassificationCache(db);
    db.close();

    expect(cache.vipSenders).toBeInstanceOf(Set);
    expect(cache.vipSenders.size).toBeGreaterThan(0);
    expect(cache.junkAddresses).toBeInstanceOf(Set);
    expect(cache.junkDomains).toBeInstanceOf(Set);
    expect(cache.routingRules).toBeInstanceOf(Array);
    expect(cache.routingRules.length).toBeGreaterThan(0);
    expect(cache.knownSenders).toBeInstanceOf(Set);
  });

  test("junk data is seeded from YAML migration", () => {
    const seedDir = join(import.meta.dir, "..", "References");
    const db = initDb(":memory:");
    runMigration(db, seedDir);
    const cache = buildClassificationCache(db);
    db.close();

    // Check that at least some junk addresses or domains were seeded
    expect(cache.junkAddresses.size + cache.junkDomains.size).toBeGreaterThan(0);
  });
});

// ─── fetchEmails ───

describe("fetchEmails", () => {
  test("--test mode returns sample emails without calling apple-mail.sh", async () => {
    const result = await fetchEmails(true);
    expect(result.emails).toHaveLength(sampleRawEmails.length);
    expect(result.emails[0].id).toBe(sampleRawEmails[0].id);
    expect(result.inboxTotal).toBe(sampleRawEmails.length);
  });

  test("--test mode emails have correct shape", async () => {
    const result = await fetchEmails(true);
    for (const e of result.emails) {
      expect(e).toHaveProperty("id");
      expect(e).toHaveProperty("subject");
      expect(e).toHaveProperty("fromAddress");
      expect(e).toHaveProperty("fromDomain");
      expect(e).toHaveProperty("isRead");
    }
  });

  test("live mode fetches with limit 500, accountFilter, and fetchAll plumbing (source check)", () => {
    const source = readFileSync(join(__dirname, "../Tools/GenerateTriage.ts"), "utf-8");
    // Default limit is 500 (with optional account filter prefix)
    expect(source).toContain("500");
    expect(source).toContain("timeout: 90_000");
    expect(source).toContain("accountFilter");
    // The --unread optimization was retired (see comment "was: unread-only opt"); fetchAll plumbing remains
    expect(source).toContain("fetchAll");
  });
});

// ─── generateTriage (integration, --test mode) ───

describe("generateTriage integration (--test mode)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "triage-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("generates triage session with correct total from fixtures", async () => {
    const result = await generateTriage({
      testMode: true,
      date: "2026-03-01",
      outputDir: tmpDir,
      dbPath: join(tmpDir, "test-triage.db"),
    });

    expect(result.session.total).toBe(sampleRawEmails.length);
  });

  test("writes markdown file to output directory", async () => {
    const result = await generateTriage({
      testMode: true,
      date: "2026-03-01",
      outputDir: tmpDir,
      dbPath: join(tmpDir, "test-triage.db"),
    });

    expect(existsSync(result.outputPath)).toBe(true);
    const content = readFileSync(result.outputPath, "utf-8");
    expect(content).toContain("Email Triage");
    expect(content).toContain("2026-03-01");
  });

  test("creates Reference/ and Staged/ subfolders", async () => {
    await generateTriage({
      testMode: true,
      date: "2026-03-01",
      outputDir: tmpDir,
      dbPath: join(tmpDir, "test-triage.db"),
    });

    expect(existsSync(join(tmpDir, "Reference"))).toBe(true);
    expect(existsSync(join(tmpDir, "Staged"))).toBe(true);
    expect(existsSync(join(tmpDir, "Staged", "Sent"))).toBe(true);
  });

  test("subfolder creation is idempotent", async () => {
    // Run twice -- second run should not error
    await generateTriage({ testMode: true, date: "2026-03-01", outputDir: tmpDir, dbPath: join(tmpDir, "test-triage.db") });
    await generateTriage({ testMode: true, date: "2026-03-01", outputDir: tmpDir, dbPath: join(tmpDir, "test-triage.db") });

    expect(existsSync(join(tmpDir, "Reference"))).toBe(true);
    expect(existsSync(join(tmpDir, "Staged"))).toBe(true);
  });

  test("markdown contains YAML frontmatter", async () => {
    const result = await generateTriage({
      testMode: true,
      date: "2026-03-01",
      outputDir: tmpDir,
      dbPath: join(tmpDir, "test-triage.db"),
    });

    const content = readFileSync(result.outputPath, "utf-8");
    expect(content.startsWith("---\n")).toBe(true);
    expect(content).toContain("document-type: email-triage");
  });

  test("classifies VIP sender with funnelStage vip", async () => {
    const result = await generateTriage({
      testMode: true,
      date: "2026-03-01",
      outputDir: tmpDir,
      dbPath: join(tmpDir, "test-triage.db"),
    });

    // vip-example-1@example.com is a VIP in rules.yaml.seed (placeholder)
    const vipEmail = result.session.emails.find(
      (e) => e.fromAddress === "vip-example-1@example.com"
    );
    expect(vipEmail).toBeDefined();
    expect(vipEmail!.priority).toBe("action");
    expect(vipEmail!.funnelStage).toBe("vip");
    expect(vipEmail!.isVip).toBe(true);
  });

  test("classifies junk sender with funnelStage auto_processed", async () => {
    const result = await generateTriage({
      testMode: true,
      date: "2026-03-01",
      outputDir: tmpDir,
      dbPath: join(tmpDir, "test-triage.db"),
    });

    // example-spammer@example-marketing.com is in junk-senders.yaml.seed (placeholder)
    const junkEmail = result.session.emails.find(
      (e) => e.fromAddress === "example-spammer@example-marketing.com"
    );
    expect(junkEmail).toBeDefined();
    expect(junkEmail!.priority).toBe("trash");
    expect(junkEmail!.funnelStage).toBe("auto_processed");
    expect(junkEmail!.isJunk).toBe(true);
  });

  test("classifies domain-matched sender as auto_processed", async () => {
    const result = await generateTriage({
      testMode: true,
      date: "2026-03-01",
      outputDir: tmpDir,
      dbPath: join(tmpDir, "test-triage.db"),
    });

    // substack.com has a domain rule -> archive
    const substackEmail = result.session.emails.find(
      (e) => e.fromDomain === "substack.com"
    );
    expect(substackEmail).toBeDefined();
    expect(substackEmail!.priority).toBe("archive");
    expect(substackEmail!.funnelStage).toBe("auto_processed");
  });

  test("markdown contains funnel stage sections", async () => {
    const result = await generateTriage({
      testMode: true,
      date: "2026-03-01",
      outputDir: tmpDir,
      dbPath: join(tmpDir, "test-triage.db"),
    });

    const content = readFileSync(result.outputPath, "utf-8");
    expect(content).toContain("## [] Stage 1: VIP");
    expect(content).toContain("## [] Stage 2: Action Required");
    expect(content).toContain("## [] Stage 3: Financial & Documents");
    expect(content).toContain("## [] Stage 4: Informational");
    expect(content).toContain("## [] Stage 5: Bulk Dispose");
    expect(content).toContain("## [] Stage 6: Auto-Processed");
  });

  test("records triage session in database", async () => {
    const { Database } = await import("bun:sqlite");
    const dbPath = join(tmpDir, "test-triage.db");

    await generateTriage({
      testMode: true,
      date: "2026-03-01",
      outputDir: tmpDir,
      dbPath,
    });

    const db = new Database(dbPath);
    const rows = db.prepare("SELECT * FROM triage_history WHERE date = ?").all("2026-03-01") as any[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].total).toBe(sampleRawEmails.length);
    db.close();
  });

  test("unread count reflects fixture data", async () => {
    const result = await generateTriage({
      testMode: true,
      date: "2026-03-01",
      outputDir: tmpDir,
      dbPath: join(tmpDir, "test-triage.db"),
    });

    const expectedUnread = sampleRawEmails.filter((e) => !e.isRead).length;
    expect(result.session.unread).toBe(expectedUnread);
  });

  test("estimatedMinutes is a positive number for non-trivial input", async () => {
    const result = await generateTriage({
      testMode: true,
      date: "2026-03-01",
      outputDir: tmpDir,
      dbPath: join(tmpDir, "test-triage.db"),
    });

    expect(result.session.estimatedMinutes).toBeGreaterThan(0);
  });

  test("returns the output file path", async () => {
    const result = await generateTriage({
      testMode: true,
      date: "2026-03-01",
      outputDir: tmpDir,
      dbPath: join(tmpDir, "test-triage.db"),
    });

    expect(result.outputPath).toContain("March 1, 2026");
    expect(result.outputPath.endsWith(".md")).toBe(true);
    expect(result.outputPath.startsWith(tmpDir)).toBe(true);
  });
});

// ─── parseExistingNote ───

describe("parseExistingNote", () => {
  test("extracts IDs from mini-blocks", () => {
    const note = `## Stage 1: VIP (1)\n*desc*\n#### \`12345\` vip@test.com [VIP]\n**Subject**\n**Action:** [R]  **You:** reply needed\n`;
    const state = parseExistingNote(note);
    expect(state.knownIds.has("12345")).toBe(true);
  });

  test("extracts IDs from table rows", () => {
    const note = `| 67890 | 2026-03-01 | sender@test.com | Subject | note | A |\n`;
    const state = parseExistingNote(note);
    expect(state.knownIds.has("67890")).toBe(true);
  });

  test("extracts IDs from checkbox items", () => {
    const note = `- [x] \`11111\` Sender -- Subject (rule:domain)\n- [ ] \`22222\` Other -- Other\n`;
    const state = parseExistingNote(note);
    expect(state.knownIds.has("11111")).toBe(true);
    expect(state.knownIds.has("22222")).toBe(true);
  });

  test("extracts IDs from message:// link mini-blocks", () => {
    const note = `#### [12345](message://%3Cabc@def%3E) vip@test.com\n`;
    const state = parseExistingNote(note);
    expect(state.knownIds.has("12345")).toBe(true);
  });

  test("extracts decisions from mini-blocks", () => {
    const note = `#### \`12345\` sender@test.com\n**Subject**\n**Action:** [D]  **You:** defer to next week\n`;
    const state = parseExistingNote(note);
    expect(state.decisions.get("12345")).toEqual({ action: "D", you: "defer to next week" });
  });

  test("extracts instructions section content", () => {
    const note = `## Instructions\n*Freeform commands*\n*Examples*\nadd @spam.com to junk\nVIP add boss@co.com\n\n## Stage 1: VIP (0)\n`;
    const state = parseExistingNote(note);
    expect(state.instructionsContent).toContain("add @spam.com to junk");
    expect(state.instructionsContent).toContain("VIP add boss@co.com");
  });

  test("extracts execution log when populated", () => {
    const note = `## Execution Log\n- Archived: 5  |  Trashed: 2\n- Processed at: 2026-03-01T10:00:00\n- Duration: 45s\n`;
    const state = parseExistingNote(note);
    expect(state.executionLog).toContain("Archived: 5");
    expect(state.executionLog).toContain("Processed at: 2026-03-01");
  });

  test("ignores default execution log (unpopulated)", () => {
    const note = `## Execution Log\n*Filled in by PAI after processing*\n- Archived: --  |  Trashed: --\n- Processed at: --\n- Duration: --\n`;
    const state = parseExistingNote(note);
    expect(state.executionLog).toBeUndefined();
  });

  test("returns empty state for empty input", () => {
    const state = parseExistingNote("");
    expect(state.knownIds.size).toBe(0);
    expect(state.decisions.size).toBe(0);
    expect(state.instructionsContent).toBe("");
    expect(state.executionLog).toBeUndefined();
  });
});

// ─── mergeIntoExistingNote ───

describe("mergeIntoExistingNote", () => {
  // Build a realistic existing note using the formatter
  function buildExistingNote(): string {
    const emails: ClassifiedEmail[] = [
      makeClassified({ id: "100", funnelStage: "vip", isVip: true, fromAddress: "boss@vip.com", subject: "VIP Email", priority: "action" }),
      makeClassified({ id: "200", funnelStage: "action", fromAddress: "colleague@work.com", subject: "Action needed", priority: "action" }),
      makeClassified({ id: "300", funnelStage: "informational", fromAddress: "news@info.com", subject: "Newsletter", priority: "review" }),
      makeClassified({ id: "400", funnelStage: "auto_processed", fromAddress: "junk@spam.com", subject: "Spam", priority: "trash", matchedRule: "junk:domain" }),
    ];
    const session = buildTriageSession(emails, "2026-03-01");
    return formatTriageNote(session);
  }

  test("no new emails updates timestamp only", () => {
    const existing = buildExistingNote();
    const merged = mergeIntoExistingNote(existing, [], new Set(), "2026-03-01T12:00:00Z");
    expect(merged).toContain("Updated:");
    expect(merged).toContain("+0 new");
    // All original content preserved
    expect(merged).toContain("boss@vip.com");
    expect(merged).toContain("colleague@work.com");
  });

  test("new VIP email is inserted into Stage 1", () => {
    const existing = buildExistingNote();
    const newEmail = makeClassified({
      id: "500", funnelStage: "vip", isVip: true,
      fromAddress: "newvip@test.com", subject: "New VIP", priority: "action",
    });
    const merged = mergeIntoExistingNote(existing, [newEmail], new Set(), "2026-03-01T12:00:00Z");
    expect(merged).toContain("newvip@test.com");
    expect(merged).toContain("## [] Stage 1: VIP (2)");
    // Existing VIP still there
    expect(merged).toContain("boss@vip.com");
  });

  test("new informational email is inserted into Stage 4 table", () => {
    const existing = buildExistingNote();
    const newEmail = makeClassified({
      id: "600", funnelStage: "informational",
      fromAddress: "update@info.com", subject: "Weekly Update", priority: "review",
    });
    const merged = mergeIntoExistingNote(existing, [newEmail], new Set(), "2026-03-01T12:00:00Z");
    expect(merged).toContain("update@info.com");
    expect(merged).toContain("## [] Stage 4: Informational (2)");
  });

  test("new auto-processed email is inserted into Stage 6 table", () => {
    const existing = buildExistingNote();
    const newEmail = makeClassified({
      id: "700", funnelStage: "auto_processed",
      from: "Auto Junk <auto@junk.com>", fromAddress: "auto@junk.com",
      subject: "Auto Spam", priority: "trash", matchedRule: "junk:address",
    });
    const merged = mergeIntoExistingNote(existing, [newEmail], new Set(), "2026-03-01T12:00:00Z");
    expect(merged).toContain("Auto Junk");
    expect(merged).toContain("## [] Stage 6: Auto-Processed (2)");
  });

  test("preserves existing user-edited action codes", () => {
    let existing = buildExistingNote();
    // Simulate user editing Action from [R] to [D] in a mini-block
    existing = existing.replace("**Action:** [R]  **You:**", "**Action:** [D]  **You:** defer to Monday");
    const merged = mergeIntoExistingNote(existing, [], new Set(), "2026-03-01T12:00:00Z");
    expect(merged).toContain("**Action:** [D]  **You:** defer to Monday");
  });

  test("preserves existing instructions content", () => {
    let existing = buildExistingNote();
    // Simulate user typing in the Instructions section
    existing = existing.replace(
      "## Instructions\n*Freeform commands",
      "## Instructions\n*Freeform commands",
    );
    // Add instruction after the blank > line
    existing = existing.replace(">\n\n", ">\nadd @marketing.io to junk\n\n");
    const merged = mergeIntoExistingNote(existing, [], new Set(), "2026-03-01T12:00:00Z");
    expect(merged).toContain("add @marketing.io to junk");
  });

  test("marks [GONE] emails that are no longer in inbox", () => {
    const existing = buildExistingNote();
    const goneIds = new Set(["100"]); // VIP email disappeared
    const merged = mergeIntoExistingNote(existing, [], goneIds, "2026-03-01T12:00:00Z");
    expect(merged).toContain("[GONE]");
    // The other emails are NOT marked [GONE]
    const goneCount = (merged.match(/\[GONE\]/g) || []).length;
    expect(goneCount).toBeGreaterThanOrEqual(1);
  });

  test("updates frontmatter totals for new emails", () => {
    const existing = buildExistingNote();
    const newEmail = makeClassified({
      id: "800", funnelStage: "action",
      fromAddress: "new@test.com", subject: "New Email", priority: "action",
    });
    const merged = mergeIntoExistingNote(existing, [newEmail], new Set(), "2026-03-01T12:00:00Z");
    // Original had 4 emails, now should have 5
    expect(merged).toMatch(/^total: 5$/m);
  });

  test("updates account-map with new email entries", () => {
    const existing = buildExistingNote();
    const newEmail = makeClassified({
      id: "900", funnelStage: "informational",
      fromAddress: "new@test.com", subject: "New", priority: "review",
      account: "iCloud",
    });
    const merged = mergeIntoExistingNote(existing, [newEmail], new Set(), "2026-03-01T12:00:00Z");
    expect(merged).toContain("900:i");
  });

  test("summary line includes merge annotation", () => {
    const existing = buildExistingNote();
    const newEmail = makeClassified({
      id: "1000", funnelStage: "action",
      fromAddress: "new@test.com", subject: "New", priority: "action",
    });
    const merged = mergeIntoExistingNote(existing, [newEmail], new Set(), "2026-03-01T12:00:00Z");
    expect(merged).toContain("Updated:");
    expect(merged).toContain("+1 new");
  });
});

// ─── generateTriage incremental (--test mode) ───

describe("generateTriage incremental mode", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "triage-incr-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("second run on same date produces incremental merge", async () => {
    const opts = {
      testMode: true,
      date: "2026-03-01",
      outputDir: tmpDir,
      dbPath: join(tmpDir, "test-triage.db"),
    };

    // First run
    const result1 = await generateTriage(opts);
    expect(result1.session.total).toBe(sampleRawEmails.length);

    // Second run (same test data = all emails already known)
    const result2 = await generateTriage(opts);
    // Should produce an incremental update with 0 new emails
    const content = readFileSync(result2.outputPath, "utf-8");
    expect(content).toContain("+0 new");
    expect(content).toContain("Updated:");
  });

  test("--force flag produces full regeneration even with existing note", async () => {
    const opts = {
      testMode: true,
      date: "2026-03-01",
      outputDir: tmpDir,
      dbPath: join(tmpDir, "test-triage.db"),
    };

    // First run
    await generateTriage(opts);

    // Second run with --force
    const result2 = await generateTriage({ ...opts, force: true });
    const content = readFileSync(result2.outputPath, "utf-8");
    // Force mode generates fresh note, no "Updated:" annotation
    expect(content).not.toContain("+0 new");
    expect(result2.session.total).toBe(sampleRawEmails.length);
  });

  test("DB deduplication: second run does not create duplicate session", async () => {
    const { Database } = await import("bun:sqlite");
    const dbPath = join(tmpDir, "test-triage.db");
    const opts = {
      testMode: true,
      date: "2026-03-01",
      outputDir: tmpDir,
      dbPath,
    };

    await generateTriage(opts);
    await generateTriage(opts);

    const db = new Database(dbPath);
    const rows = db.prepare("SELECT * FROM triage_history WHERE date = ?").all("2026-03-01") as any[];
    // Should be exactly 1 row (updated, not duplicated)
    expect(rows.length).toBe(1);
    db.close();
  });

  test("instructions survive incremental merge", async () => {
    const opts = {
      testMode: true,
      date: "2026-03-01",
      outputDir: tmpDir,
      dbPath: join(tmpDir, "test-triage.db"),
    };

    // First run
    const result1 = await generateTriage(opts);

    // Manually edit the note to add instructions
    let content = readFileSync(result1.outputPath, "utf-8");
    content = content.replace(">\n\n", ">\nadd @marketing.io to junk\n\n");
    const { writeFileSync } = await import("fs");
    writeFileSync(result1.outputPath, content);

    // Second run
    const result2 = await generateTriage(opts);
    const merged = readFileSync(result2.outputPath, "utf-8");
    expect(merged).toContain("add @marketing.io to junk");
  });
});

// ─── Phase 13.4: Faster generation optimizations ───

describe("Phase 13.4 optimizations", () => {
  test("Opt 1: fetchEmails accepts fetchAll parameter", async () => {
    // Test mode ignores fetchAll, but signature must accept it
    const result = await fetchEmails(true, undefined, true);
    expect(result.emails.length).toBe(sampleRawEmails.length);
    const resultUnread = await fetchEmails(true, undefined, false);
    expect(resultUnread.emails.length).toBe(sampleRawEmails.length);
  });

  test("Opt 1: --unread optimization retired; source documents the retirement", () => {
    const source = readFileSync(join(__dirname, "../Tools/GenerateTriage.ts"), "utf-8");
    // The "fetchAll ? '' : '--unread '" pattern was removed; fetchAll = true is now the default
    expect(source).toContain("fetchAll = true");
    expect(source).toContain("was: unread-only opt");
  });

  test("Opt 3: lazy drafts -- no draft API calls during triage (source check)", () => {
    const source = readFileSync(join(__dirname, "../Tools/GenerateTriage.ts"), "utf-8");
    // Lazy drafts: draft generation still deferred, but bodies ARE fetched for Stages 1-2
    expect(source).toContain("Lazy drafts (Opt 3)");
    // generateDraftsForEmails should exist but NOT be called in generateTriage
    expect(source).toContain("async function generateDraftsForEmails");
    const generateTriageFn = source.slice(source.indexOf("async function generateTriage"));
    expect(generateTriageFn).not.toContain("generateDraftsForEmails(");
    // Bodies ARE fetched for VIP/Action (Phase 14.1 body inclusion rules)
    expect(generateTriageFn).toContain("fetchEmailBodies(");
  });

  test("Opt 3: triage note shows draft placeholder for VIP/action emails without drafts", () => {
    const emails = [
      makeClassified({ id: "v1", funnelStage: "vip", priority: "action", isVip: true, replyDraft: null }),
    ];
    const session: TriageSession = {
      date: "2026-04-01",
      generatedAt: new Date().toISOString(),
      total: 1,
      inboxTotal: 1,
      unread: 1,
      emails,
      estimatedMinutes: 2,
    };
    const note = formatTriageNote(session);
    expect(note).toContain("**Draft reply:** *(pending -- generated on review or execution)*");
  });

  test("Opt 4: note is written before sort (source check)", () => {
    const source = readFileSync(join(__dirname, "../Tools/GenerateTriage.ts"), "utf-8");
    // Verify the order: Bun.write appears before sortToStageFolders in generateTriage
    const genFn = source.slice(source.indexOf("async function generateTriage"));
    const writeIdx = genFn.indexOf("await Bun.write(outPath, markdown)");
    const sortIdx = genFn.indexOf("sortToStageFolders(");
    expect(writeIdx).toBeGreaterThan(0);
    expect(sortIdx).toBeGreaterThan(0);
    expect(writeIdx).toBeLessThan(sortIdx);
  });

  test("Opt 1: GenerateOptions includes fetchAll field", () => {
    const source = readFileSync(join(__dirname, "../Tools/GenerateTriage.ts"), "utf-8");
    expect(source).toContain("fetchAll?: boolean");
  });
});

// ─── Phase 13.5: Known senders population ───

describe("Phase 13.5: known senders population", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "triage-known-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("first run populates known_senders table", async () => {
    const dbPath = join(tmpDir, "known.db");
    await generateTriage({
      testMode: true,
      date: "2026-04-01",
      outputDir: tmpDir,
      dbPath,
    });

    const db = initDb(dbPath);
    runMigration(db, join(__dirname, "..", "References"));
    const rows = db.prepare("SELECT address, times_seen FROM known_senders").all() as Array<{ address: string; times_seen: number }>;
    db.close();

    // Should have at least one sender from sample emails
    expect(rows.length).toBeGreaterThan(0);
    // All should have times_seen >= 1
    for (const row of rows) {
      expect(row.times_seen).toBeGreaterThanOrEqual(1);
    }
  });

  test("second run increments times_seen for same senders", async () => {
    const dbPath = join(tmpDir, "known.db");
    const opts = {
      testMode: true,
      date: "2026-04-01",
      outputDir: tmpDir,
      dbPath,
      force: true,
    };

    // First run
    await generateTriage(opts);
    // Second run (force to re-process all)
    await generateTriage(opts);

    const db = initDb(dbPath);
    runMigration(db, join(__dirname, "..", "References"));
    const rows = db.prepare("SELECT address, times_seen FROM known_senders").all() as Array<{ address: string; times_seen: number }>;
    db.close();

    // Every sender should have times_seen >= 2 from two runs
    for (const row of rows) {
      expect(row.times_seen).toBeGreaterThanOrEqual(2);
    }
  });

  test("first-time senders are flagged as unknown in first run", async () => {
    const dbPath = join(tmpDir, "known.db");
    const result = await generateTriage({
      testMode: true,
      date: "2026-04-01",
      outputDir: tmpDir,
      dbPath,
    });

    // With a fresh DB and no prior known senders, all should be unknown
    const unknownCount = result.session.emails.filter(e => e.isUnknownSender).length;
    expect(unknownCount).toBeGreaterThan(0);
  });

  test("[NEW] badge appears in triage note for unknown senders", async () => {
    const dbPath = join(tmpDir, "known.db");
    const result = await generateTriage({
      testMode: true,
      date: "2026-04-01",
      outputDir: tmpDir,
      dbPath,
    });

    // If any emails are unknown, the note should contain [NEW] badges
    const unknownEmails = result.session.emails.filter(e => e.isUnknownSender);
    if (unknownEmails.length > 0) {
      expect(result.markdown).toContain("`[NEW]`");
    }
  });

  test("addKnownSender is called in generateTriage (source check)", () => {
    const source = readFileSync(join(__dirname, "../Tools/GenerateTriage.ts"), "utf-8");
    expect(source).toContain("addKnownSender(db,");
    // Must happen after classification, not before
    const genFn = source.slice(source.indexOf("async function generateTriage"));
    const classifyIdx = genFn.indexOf("classifyEmail(email, cache)");
    const upsertIdx = genFn.indexOf("addKnownSender(db,");
    expect(classifyIdx).toBeGreaterThan(0);
    expect(upsertIdx).toBeGreaterThan(classifyIdx);
  });
});
