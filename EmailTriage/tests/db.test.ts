import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  initDb,
  addVipSender,
  isVipSender,
  addJunkSender,
  isJunkSender,
  addKnownSender,
  isKnownSender,
  getKnownSenders,
  recordTriageSession,
  getRecentHistory,
  addUnsubscribed,
  isUnsubscribed,
  recordEmailAction,
  recordFollowUp,
  getOverdueFollowUps,
  resolveFollowUp,
  getRoutingRules,
  addRoutingRule,
  removeRoutingRule,
  getVipSenders,
  getJunkSenders,
  recordUnsubscribe,
  updateTriageReviewTime,
  runMigration,
  recordDomainActivity,
} from "../Tools/Db";

let db: Database;

beforeEach(() => {
  db = initDb(":memory:");
});

afterEach(() => {
  db.close();
});

describe("VIP senders", () => {
  test("adds and checks VIP sender", () => {
    addVipSender(db, "vip@example.com", "Test VIP");
    expect(isVipSender(db, "vip@example.com")).toBe(true);
    expect(isVipSender(db, "other@example.com")).toBe(false);
  });

  test("adding duplicate VIP does not throw", () => {
    addVipSender(db, "vip@example.com", "VIP One");
    addVipSender(db, "vip@example.com", "VIP One Again");
    expect(isVipSender(db, "vip@example.com")).toBe(true);
  });
});

describe("Junk senders", () => {
  test("adds junk by address and checks", () => {
    addJunkSender(db, { address: "spammer@junk.com" });
    expect(isJunkSender(db, "spammer@junk.com", "junk.com")).toBe(true);
    expect(isJunkSender(db, "other@safe.com", "safe.com")).toBe(false);
  });

  test("adds junk by domain and checks", () => {
    addJunkSender(db, { domain: "wholejunkdomain.com" });
    expect(isJunkSender(db, "anyone@wholejunkdomain.com", "wholejunkdomain.com")).toBe(true);
    expect(isJunkSender(db, "safe@otherdomain.com", "otherdomain.com")).toBe(false);
  });

  test("junk with reason records reason", () => {
    addJunkSender(db, { address: "spam@x.com", reason: "persistent spam" });
    expect(isJunkSender(db, "spam@x.com", "x.com")).toBe(true);
  });
});

describe("Known senders", () => {
  test("adds and checks known sender", () => {
    addKnownSender(db, "known@example.com");
    expect(isKnownSender(db, "known@example.com")).toBe(true);
    expect(isKnownSender(db, "unknown@example.com")).toBe(false);
  });

  test("getKnownSenders returns Set", () => {
    addKnownSender(db, "a@x.com");
    addKnownSender(db, "b@x.com");
    const known = getKnownSenders(db);
    expect(known instanceof Set).toBe(true);
    expect(known.has("a@x.com")).toBe(true);
    expect(known.size).toBe(2);
  });

  test("duplicate addKnownSender increments times_seen", () => {
    addKnownSender(db, "repeat@x.com");
    addKnownSender(db, "repeat@x.com");
    const row = db.prepare("SELECT times_seen FROM known_senders WHERE address = ?").get("repeat@x.com") as { times_seen: number };
    expect(row.times_seen).toBe(2);
  });
});

describe("Unsubscribed", () => {
  test("adds and checks unsubscribed by address", () => {
    addUnsubscribed(db, { address: "newsletter@spam.com", method: "link" });
    expect(isUnsubscribed(db, "newsletter@spam.com", "spam.com")).toBe(true);
    expect(isUnsubscribed(db, "other@safe.com", "safe.com")).toBe(false);
  });

  test("adds and checks unsubscribed by domain", () => {
    addUnsubscribed(db, { domain: "alljunk.com", method: "manual" });
    expect(isUnsubscribed(db, "anyone@alljunk.com", "alljunk.com")).toBe(true);
    expect(isUnsubscribed(db, "safe@other.com", "other.com")).toBe(false);
  });
});

describe("Triage history", () => {
  test("records a triage session", () => {
    recordTriageSession(db, {
      date: "2026-03-01",
      total: 18,
      archived: 8,
      trashed: 3,
      replied: 1,
      durationSec: 240,
    });
    const history = getRecentHistory(db, 7);
    expect(history.length).toBe(1);
    expect(history[0].total).toBe(18);
    expect(history[0].archived).toBe(8);
    expect(history[0].duration_sec).toBe(240);
  });

  test("records session with optional fields", () => {
    recordTriageSession(db, {
      date: "2026-03-01",
      total: 25,
      archived: 10,
      trashed: 5,
      replied: 2,
      durationSec: 300,
      unsubscribed: 3,
      blocked: 1,
    });
    const history = getRecentHistory(db, 7);
    expect(history[0].unsubscribed).toBe(3);
    expect(history[0].blocked).toBe(1);
  });
});

describe("Email actions", () => {
  test("records an email action", () => {
    recordEmailAction(db, "msg-123", "archive", "Newsletters");
    const rows = db.prepare("SELECT * FROM email_actions WHERE email_id = ?").all("msg-123") as any[];
    expect(rows.length).toBe(1);
    expect(rows[0].action).toBe("archive");
    expect(rows[0].folder).toBe("Newsletters");
  });

  test("records action without optional fields", () => {
    recordEmailAction(db, "msg-456", "trash");
    const rows = db.prepare("SELECT * FROM email_actions WHERE email_id = ?").all("msg-456") as any[];
    expect(rows.length).toBe(1);
    expect(rows[0].folder).toBeNull();
    expect(rows[0].notes).toBeNull();
  });
});

describe("Follow-ups", () => {
  test("records and retrieves overdue follow-ups", () => {
    recordFollowUp(db, {
      emailId: "msg-fu-1",
      followUpDate: "2026-03-01",
      sender: "boss@example.com",
      subject: "Project Update",
      originalDate: "2026-02-25",
    });
    const overdue = getOverdueFollowUps(db, "2026-03-02");
    expect(overdue.length).toBe(1);
    expect(overdue[0].emailId).toBe("msg-fu-1");
    expect(overdue[0].sender).toBe("boss@example.com");
    expect(overdue[0].subject).toBe("Project Update");
    expect(overdue[0].followUpDate).toBe("2026-03-01");
  });

  test("does not return follow-ups before their date", () => {
    recordFollowUp(db, {
      emailId: "msg-fu-2",
      followUpDate: "2026-04-01",
      sender: "future@example.com",
      subject: "Future Task",
      originalDate: "2026-03-01",
    });
    const overdue = getOverdueFollowUps(db, "2026-03-15");
    expect(overdue.length).toBe(0);
  });

  test("excludes follow-ups with a reply action", () => {
    recordFollowUp(db, {
      emailId: "msg-fu-3",
      followUpDate: "2026-03-01",
      sender: "replied@example.com",
      subject: "Already Replied",
      originalDate: "2026-02-20",
    });
    recordEmailAction(db, "msg-fu-3", "reply");
    const overdue = getOverdueFollowUps(db, "2026-03-02");
    expect(overdue.length).toBe(0);
  });

  test("resolveFollowUp marks follow-up as resolved", () => {
    recordFollowUp(db, {
      emailId: "msg-fu-4",
      followUpDate: "2026-03-01",
      sender: "resolve@example.com",
      subject: "Will Resolve",
      originalDate: "2026-02-20",
    });
    resolveFollowUp(db, "msg-fu-4");
    const overdue = getOverdueFollowUps(db, "2026-03-02");
    expect(overdue.length).toBe(0);
  });
});

// === V2 Migration and New CRUD Tests ===

describe("Routing rules", () => {
  test("addRoutingRule inserts and returns ID", () => {
    const id = addRoutingRule(db, {
      ruleType: "sender",
      matchValue: "test@example.com",
      action: "archive",
      folder: "Newsletters",
      source: "manual",
    });
    expect(id).toBeGreaterThan(0);
  });

  test("getRoutingRules returns all rules", () => {
    addRoutingRule(db, { ruleType: "sender", matchValue: "a@x.com", action: "archive" });
    addRoutingRule(db, { ruleType: "domain", matchValue: "x.com", action: "trash" });
    addRoutingRule(db, { ruleType: "subject", matchValue: "receipt", action: "archive", folder: "Receipts" });
    const all = getRoutingRules(db);
    expect(all.length).toBe(3);
    expect(all[0].ruleType).toBe("sender");
    expect(all[1].ruleType).toBe("domain");
    expect(all[2].folder).toBe("Receipts");
  });

  test("getRoutingRules filters by type", () => {
    addRoutingRule(db, { ruleType: "sender", matchValue: "a@x.com", action: "archive" });
    addRoutingRule(db, { ruleType: "domain", matchValue: "x.com", action: "trash" });
    const senderOnly = getRoutingRules(db, "sender");
    expect(senderOnly.length).toBe(1);
    expect(senderOnly[0].matchValue).toBe("a@x.com");
  });

  test("removeRoutingRule deletes by ID", () => {
    const id = addRoutingRule(db, { ruleType: "sender", matchValue: "del@x.com", action: "archive" });
    removeRoutingRule(db, id);
    const all = getRoutingRules(db);
    expect(all.length).toBe(0);
  });

  test("addRoutingRule defaults stop to true and source to manual", () => {
    addRoutingRule(db, { ruleType: "domain", matchValue: "y.com", action: "archive" });
    const rules = getRoutingRules(db);
    expect(rules[0].stop).toBe(true);
    expect(rules[0].source).toBe("manual");
  });

  test("addRoutingRule respects stop=false", () => {
    addRoutingRule(db, { ruleType: "domain", matchValue: "z.com", action: "archive", stop: false });
    const rules = getRoutingRules(db);
    expect(rules[0].stop).toBe(false);
  });
});

describe("Bulk queries", () => {
  test("getVipSenders returns lowercase Set", () => {
    addVipSender(db, "VIP@Example.COM", "Test");
    addVipSender(db, "other@test.com");
    const vips = getVipSenders(db);
    expect(vips.has("vip@example.com")).toBe(true);
    expect(vips.has("other@test.com")).toBe(true);
    expect(vips.size).toBe(2);
  });

  test("getJunkSenders returns addresses and domains Sets", () => {
    addJunkSender(db, { address: "Spam@Junk.COM" });
    addJunkSender(db, { domain: "AllJunk.com" });
    const junk = getJunkSenders(db);
    expect(junk.addresses.has("spam@junk.com")).toBe(true);
    expect(junk.domains.has("alljunk.com")).toBe(true);
  });
});

describe("recordUnsubscribe", () => {
  test("writes to unsubscribed table", () => {
    recordUnsubscribe(db, "unsub@x.com", "x.com", "link");
    expect(isUnsubscribed(db, "unsub@x.com", "x.com")).toBe(true);
  });

  test("works with address only", () => {
    recordUnsubscribe(db, "addr@y.com", null, "manual");
    expect(isUnsubscribed(db, "addr@y.com", "y.com")).toBe(true);
  });

  test("works with domain only", () => {
    recordUnsubscribe(db, null, "whole.com", "auto");
    expect(isUnsubscribed(db, "any@whole.com", "whole.com")).toBe(true);
  });
});

describe("updateTriageReviewTime", () => {
  test("computes review duration from generated_at to processed_at", () => {
    // Insert a triage session with generated_at
    db.prepare(`
      INSERT INTO triage_history (date, total, generated_at)
      VALUES ('2026-04-01', 30, '2026-04-01_08:00')
    `).run();

    updateTriageReviewTime(db, "2026-04-01", "2026-04-01_08:10");

    const row = db.prepare(
      "SELECT processed_at, review_duration_sec FROM triage_history WHERE date = '2026-04-01'"
    ).get() as { processed_at: string; review_duration_sec: number };
    expect(row.processed_at).toBe("2026-04-01_08:10");
    expect(row.review_duration_sec).toBe(600); // 10 minutes
  });

  test("does nothing for non-existent date", () => {
    updateTriageReviewTime(db, "9999-01-01", "9999-01-01_09:00");
    // No error thrown
  });
});

describe("Migration", () => {
  // Use a temp dir with no YAML files to avoid touching real data
  let emptyDir: string;

  beforeEach(() => {
    emptyDir = mkdtempSync(join(tmpdir(), "et-migration-"));
  });

  test("runMigration on fresh DB creates routing_rules table and indexes", () => {
    runMigration(db, emptyDir);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='routing_rules'").all();
    expect(tables.length).toBe(1);
  });

  test("runMigration is idempotent (running twice produces no errors)", () => {
    runMigration(db, emptyDir);
    runMigration(db, emptyDir);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='routing_rules'").all();
    expect(tables.length).toBe(1);
  });

  test("migration adds account column to vip_senders", () => {
    runMigration(db, emptyDir);
    const cols = db.prepare("PRAGMA table_info(vip_senders)").all() as { name: string }[];
    expect(cols.some(c => c.name === "account")).toBe(true);
  });

  test("migration adds columns to triage_history", () => {
    runMigration(db, emptyDir);
    const cols = db.prepare("PRAGMA table_info(triage_history)").all() as { name: string }[];
    const colNames = cols.map(c => c.name);
    expect(colNames).toContain("generated_at");
    expect(colNames).toContain("processed_at");
    expect(colNames).toContain("review_duration_sec");
  });

  test("migration adds columns to scheduled_sends", () => {
    runMigration(db, emptyDir);
    const cols = db.prepare("PRAGMA table_info(scheduled_sends)").all() as { name: string }[];
    const colNames = cols.map(c => c.name);
    expect(colNames).toContain("account");
    expect(colNames).toContain("json_path");
    expect(colNames).toContain("plist_path");
  });
});

describe("Migration YAML seeding", () => {
  let seedDir: string;

  beforeEach(() => {
    seedDir = mkdtempSync(join(tmpdir(), "et-seed-"));
    // Write minimal test YAML files
    writeFileSync(join(seedDir, "rules.yaml"), `
vip_senders:
  - vip-seed@test.com

sender_rules:
  - match:
      from: sender@test.com
    action: archive
    folder: TestFolder
  - match:
      domain: domainkey.com
    action: archive
    folder: DomainKeyFolder

domain_rules:
  - match:
      from_domain: testdomain.com
    action: archive
    folder: DomainFolder

subject_rules:
  - match:
      subject_contains: test-subject
    action: archive
    folder: SubjectFolder
`);
    writeFileSync(join(seedDir, "junk-senders.yaml"), `
by_address:
  - junkaddr@spam.com

by_domain:
  - junkdomain.com
`);
  });

  test("VIP entries from rules.yaml appear in vip_senders after migration", () => {
    runMigration(db, seedDir);
    expect(isVipSender(db, "vip-seed@test.com")).toBe(true);
  });

  test("sender/domain/subject rules appear in routing_rules with source=seed", () => {
    runMigration(db, seedDir);
    const rules = getRoutingRules(db);
    expect(rules.length).toBe(4);
    expect(rules.every(r => r.source === "seed")).toBe(true);
    expect(rules.find(r => r.ruleType === "sender")?.matchValue).toBe("sender@test.com");
    // domain: key in sender_rules and from_domain: in domain_rules both seed as "domain" type
    const domainRules = rules.filter(r => r.ruleType === "domain");
    expect(domainRules.length).toBe(2);
    expect(domainRules.map(r => r.matchValue).sort()).toEqual(["domainkey.com", "testdomain.com"]);
    expect(rules.find(r => r.ruleType === "subject")?.matchValue).toBe("test-subject");
  });

  test("junk entries from junk-senders.yaml appear in junk_senders", () => {
    runMigration(db, seedDir);
    expect(isJunkSender(db, "junkaddr@spam.com", "spam.com")).toBe(true);
    expect(isJunkSender(db, "anyone@junkdomain.com", "junkdomain.com")).toBe(true);
  });

  test("YAML files are renamed to .seed after migration", () => {
    runMigration(db, seedDir);
    expect(existsSync(join(seedDir, "rules.yaml"))).toBe(false);
    expect(existsSync(join(seedDir, "rules.yaml.seed"))).toBe(true);
    expect(existsSync(join(seedDir, "junk-senders.yaml"))).toBe(false);
    expect(existsSync(join(seedDir, "junk-senders.yaml.seed"))).toBe(true);
  });

  test("second migration does not duplicate seed data (reads .seed idempotently)", () => {
    runMigration(db, seedDir);
    // YAML files are now .seed; second run reads them but doesn't duplicate
    runMigration(db, seedDir);
    const rules = getRoutingRules(db);
    expect(rules.length).toBe(4); // still 4, not 8
  });

  test("migration seeds from .yaml.seed files when .yaml files are absent", () => {
    // Simulate disaster recovery: DB is gone but .seed files remain
    const seedOnlyDir = mkdtempSync(join(tmpdir(), "et-seed-only-"));
    writeFileSync(join(seedOnlyDir, "rules.yaml.seed"), `
vip_senders:
  - recovered-vip@test.com

sender_rules:
  - match:
      from: "recovered@sender.com"
    action: archive
    folder: Recovered
`);
    writeFileSync(join(seedOnlyDir, "junk-senders.yaml.seed"), `
by_address:
  - recovered-junk@spam.com
by_domain:
  - recoveredjunk.com
`);

    runMigration(db, seedOnlyDir);
    expect(isVipSender(db, "recovered-vip@test.com")).toBe(true);
    expect(isJunkSender(db, "recovered-junk@spam.com", "")).toBe(true);
    expect(isJunkSender(db, "", "recoveredjunk.com")).toBe(true);
    const rules = getRoutingRules(db);
    expect(rules.some(r => r.matchValue === "recovered@sender.com")).toBe(true);

    // .seed files should NOT be renamed
    expect(existsSync(join(seedOnlyDir, "rules.yaml.seed"))).toBe(true);
    rmSync(seedOnlyDir, { recursive: true, force: true });
  });
});

describe("Domain activity tracking", () => {
  test("records domain activity with arrival timestamp successfully", () => {
    recordDomainActivity(
      db,
      "example.com",
      "sender@example.com",
      "2026-05-20",
      "A",
      "12345",
      "2026-05-20_13:15"
    );

    const row = db.prepare("SELECT * FROM domain_activity WHERE email_id = ?").get("12345") as any;
    expect(row).toBeDefined();
    expect(row.domain).toBe("example.com");
    expect(row.address).toBe("sender@example.com");
    expect(row.triage_date).toBe("2026-05-20");
    expect(row.action_taken).toBe("A");
    expect(row.email_id).toBe("12345");
    expect(row.arrival_timestamp).toBe("2026-05-20_13:15");
  });

  test("records domain activity without arrival timestamp successfully", () => {
    recordDomainActivity(
      db,
      "example.com",
      "sender@example.com",
      "2026-05-20",
      "A",
      "12346"
    );

    const row = db.prepare("SELECT * FROM domain_activity WHERE email_id = ?").get("12346") as any;
    expect(row).toBeDefined();
    expect(row.arrival_timestamp).toBeNull();
  });
});

