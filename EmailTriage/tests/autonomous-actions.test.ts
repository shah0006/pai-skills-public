// tests/autonomous-actions.test.ts — Phase 24 autonomous Stage 5/6 safety.
import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { scanForAutonomousActions } from "../Tools/AutonomousActions";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(`
    CREATE TABLE domain_activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      domain TEXT NOT NULL,
      address TEXT,
      triage_date TEXT NOT NULL,
      action_taken TEXT,
      email_id TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%d_%H:%M', 'now'))
    );
  `);
});

function seed(rows: Array<{ domain: string; address?: string; date: string; action: string }>) {
  const insert = db.prepare("INSERT INTO domain_activity (domain, address, triage_date, action_taken, email_id) VALUES (?, ?, ?, ?, ?)");
  rows.forEach((r, i) => insert.run(r.domain, r.address ?? null, r.date, r.action, `e${i}`));
}

describe("scanForAutonomousActions — recommendations", () => {
  test("strong-history trash sender → recommended for auto-trash", () => {
    // 12 prior trashes, no contradictions → 1.0 × 12/(12+2) = 0.857 confidence,
    // above the 0.85 sender threshold (intentionally conservative — n=6 gets
    // 0.75 which is skipped; user has to clearly establish the pattern first)
    seed(Array.from({ length: 12 }, (_, i) => ({
      domain: "spam.test", address: "x@spam.test", date: `2026-05-${String(i + 1).padStart(2, "0")}`, action: "T",
    })));
    const result = scanForAutonomousActions(db, [
      { emailId: "new1", fromAddress: "x@spam.test", fromDomain: "spam.test", funnelStage: "bulk_dispose" },
    ]);
    expect(result.recommendations.length).toBeGreaterThan(0);
    expect(result.recommendations[0].action).toBe("T");
  });

  test("VIP email is NEVER auto-actioned regardless of confidence", () => {
    seed(Array.from({ length: 20 }, (_, i) => ({
      domain: "spam.test", address: "vip@spam.test", date: `2026-05-${i + 1}`, action: "T",
    })));
    const result = scanForAutonomousActions(db, [
      { emailId: "v1", fromAddress: "vip@spam.test", fromDomain: "spam.test", isVip: true },
    ]);
    expect(result.recommendations).toHaveLength(0);
    expect(result.skipped.vip).toBe(1);
  });

  test("reply-history sender is NOT auto-actioned (reply is intent-bearing)", () => {
    seed(Array.from({ length: 10 }, (_, i) => ({
      domain: "friend.test", address: "buddy@friend.test", date: `2026-05-${i + 1}`, action: "R",
    })));
    const result = scanForAutonomousActions(db, [
      { emailId: "f1", fromAddress: "buddy@friend.test", fromDomain: "friend.test" },
    ]);
    expect(result.recommendations).toHaveLength(0);
    expect(result.skipped.nonExecutableAction).toBe(1);
  });

  test("sender with < 5 history samples → skipped (weak sample size)", () => {
    seed([
      { domain: "x.test", address: "a@x.test", date: "2026-05-10", action: "T" },
      { domain: "x.test", address: "a@x.test", date: "2026-05-11", action: "T" },
      { domain: "x.test", address: "a@x.test", date: "2026-05-12", action: "T" },
    ]);
    const result = scanForAutonomousActions(db, [
      { emailId: "n1", fromAddress: "a@x.test", fromDomain: "x.test" },
    ]);
    expect(result.recommendations).toHaveLength(0);
    expect(result.skipped.weakSampleSize).toBe(1);
  });

  test("domain layer requires 10+ samples", () => {
    seed(Array.from({ length: 8 }, (_, i) => ({
      domain: "smalldomain.test", address: `a${i}@smalldomain.test`, date: `2026-05-${10 + i}`, action: "T",
    })));
    const result = scanForAutonomousActions(db, [
      { emailId: "n1", fromAddress: "new@smalldomain.test", fromDomain: "smalldomain.test" },
    ]);
    expect(result.recommendations).toHaveLength(0);
    expect(result.skipped.weakSampleSize).toBe(1);
  });

  test("unknown sender + unknown domain → low-confidence skip", () => {
    const result = scanForAutonomousActions(db, [
      { emailId: "n1", fromAddress: "stranger@nowhere.test", fromDomain: "nowhere.test" },
    ]);
    expect(result.recommendations).toHaveLength(0);
    expect(result.skipped.lowConfidence).toBe(1);
  });

  test("unsub action with strong history → recommended for auto-unsub", () => {
    // n=12, pct=1.0 → confidence 0.857 (above 0.85 sender threshold)
    seed(Array.from({ length: 12 }, (_, i) => ({
      domain: "promo.test", address: "promo@promo.test", date: `2026-05-${String(i + 1).padStart(2, "0")}`, action: "U",
    })));
    const result = scanForAutonomousActions(db, [
      { emailId: "u1", fromAddress: "promo@promo.test", fromDomain: "promo.test" },
    ]);
    expect(result.recommendations.length).toBeGreaterThan(0);
    expect(result.recommendations[0].action).toBe("U");
  });
});

describe("scanForAutonomousActions — counts", () => {
  test("scanned reflects input length", () => {
    const result = scanForAutonomousActions(db, [
      { emailId: "1", fromAddress: "a@x.test", fromDomain: "x.test" },
      { emailId: "2", fromAddress: "b@x.test", fromDomain: "x.test" },
      { emailId: "3", fromAddress: "c@x.test", fromDomain: "x.test" },
    ]);
    expect(result.scanned).toBe(3);
  });
});
