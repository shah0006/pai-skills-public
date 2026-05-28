import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { initDb, addVipSender, addJunkSender, addRoutingRule, recordUnsubscribe, recordFollowUp } from "../Tools/Db";
import {
  generateVipReference,
  generateRoutingRulesReference,
  generateJunkReference,
  generateUnsubscribeReference,
  generateFollowUpsReference,
  generateKnownSendersReference,
  generateAllReferences,
} from "../Tools/ReferenceGenerator";

let tmpDir: string;
let db: ReturnType<typeof initDb>;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "refgen-test-"));
  db = initDb(join(tmpDir, "test.db"));
});

afterAll(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("VIP Senders reference", () => {
  test("generates empty VIP file", () => {
    const path = generateVipReference(db, tmpDir);
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("# VIP Senders");
    expect(content).toContain("0 VIP senders");
    expect(content).toContain("No VIP senders configured");
  });

  test("includes added VIP sender", () => {
    addVipSender(db, "boss@company.com", "The Boss");
    const path = generateVipReference(db, tmpDir);
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("1 VIP sender ");
    expect(content).toContain("boss@company.com");
    expect(content).toContain("The Boss");
  });
});

describe("Routing Rules reference", () => {
  test("generates empty routing file", () => {
    const path = generateRoutingRulesReference(db, tmpDir);
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("# Routing Rules");
    expect(content).toContain("0 rules");
  });

  test("groups rules by folder", () => {
    addRoutingRule(db, { ruleType: "sender", matchValue: "news@example.com", action: "archive", folder: "i/Newsletters" });
    addRoutingRule(db, { ruleType: "domain", matchValue: "medical.org", action: "archive", folder: "i/Medical Education" });
    addRoutingRule(db, { ruleType: "sender", matchValue: "digest@medical.org", action: "archive", folder: "i/Medical Education" });
    const path = generateRoutingRulesReference(db, tmpDir);
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("3 rules");
    expect(content).toContain("### i/Newsletters");
    expect(content).toContain("### i/Medical Education");
    expect(content).toContain("news@example.com");
    expect(content).toContain("medical.org");
  });
});

describe("Junk Blocklist reference", () => {
  test("generates empty junk file", () => {
    const path = generateJunkReference(db, tmpDir);
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("# Junk Blocklist");
    expect(content).toContain("0 blocked addresses");
  });

  test("separates addresses and domains", () => {
    addJunkSender(db, { address: "spam@evil.com", reason: "phishing" });
    addJunkSender(db, { domain: "malware.net", reason: "malware" });
    const path = generateJunkReference(db, tmpDir);
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("## Blocked Addresses");
    expect(content).toContain("spam@evil.com");
    expect(content).toContain("phishing");
    expect(content).toContain("## Blocked Domains");
    expect(content).toContain("malware.net");
  });
});

describe("Unsubscribe History reference", () => {
  test("generates empty unsubscribe file", () => {
    const path = generateUnsubscribeReference(db, tmpDir);
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("# Unsubscribe History");
    expect(content).toContain("0 unsubscribe actions");
  });

  test("records unsubscribe action", () => {
    recordUnsubscribe(db, "newsletter@example.com", null, "one-click");
    const path = generateUnsubscribeReference(db, tmpDir);
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("newsletter@example.com");
    expect(content).toContain("one-click");
  });
});

describe("Follow-ups reference", () => {
  test("generates empty follow-ups file", () => {
    const path = generateFollowUpsReference(db, tmpDir);
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("# Follow-ups");
    expect(content).toContain("0 pending");
  });

  test("shows pending follow-up", () => {
    const futureDate = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    recordFollowUp(db, {
      emailId: "99001",
      followUpDate: futureDate,
      sender: "dr.jones@hospital.com",
      subject: "Lab results",
      originalDate: "2026-04-01",
    });
    const path = generateFollowUpsReference(db, tmpDir);
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("## Pending");
    expect(content).toContain("dr.jones@hospital.com");
    expect(content).toContain("Lab results");
  });
});

describe("Known Senders reference", () => {
  test("generates empty known senders file", () => {
    const path = generateKnownSendersReference(db, tmpDir);
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("# Known Senders");
    expect(content).toContain("0 unique senders");
  });
});

describe("generateAllReferences", () => {
  test("generates all 5 auto-updated files", () => {
    const paths = generateAllReferences(db, tmpDir);
    expect(paths).toHaveLength(5);
    for (const p of paths) {
      expect(existsSync(p)).toBe(true);
    }
    expect(paths.some(p => p.endsWith("VIP Senders.md"))).toBe(true);
    expect(paths.some(p => p.endsWith("Routing Rules.md"))).toBe(true);
    expect(paths.some(p => p.endsWith("Junk Blocklist.md"))).toBe(true);
    expect(paths.some(p => p.endsWith("Unsubscribe History.md"))).toBe(true);
    expect(paths.some(p => p.endsWith("Follow-ups.md"))).toBe(true);
  });

  test("all generated files have frontmatter", () => {
    const paths = generateAllReferences(db, tmpDir);
    for (const p of paths) {
      const content = readFileSync(p, "utf-8");
      expect(content.startsWith("---\n")).toBe(true);
      expect(content).toContain("auto-generated: true");
      expect(content).toContain("last-updated:");
    }
  });
});
