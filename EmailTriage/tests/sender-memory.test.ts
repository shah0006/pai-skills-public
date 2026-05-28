// tests/sender-memory.test.ts — Phase 22 v0 coverage.
import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { getSenderHistory, getDomainHistory } from "../Tools/SenderMemory";

function makeDb(): Database {
  const db = new Database(":memory:");
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
  return db;
}

function seed(db: Database, rows: Array<{ domain: string; address?: string; date: string; action: string }>) {
  const insert = db.prepare("INSERT INTO domain_activity (domain, address, triage_date, action_taken, email_id) VALUES (?, ?, ?, ?, ?)");
  rows.forEach((r, i) => insert.run(r.domain, r.address ?? null, r.date, r.action, `e${i}`));
}

describe("getSenderHistory — sparse + empty cases", () => {
  test("address never seen → totalSeen 0, no suggestion", () => {
    const db = makeDb();
    const h = getSenderHistory(db, "stranger@nowhere.test");
    expect(h.totalSeen).toBe(0);
    expect(h.mostCommonAction).toBeNull();
    expect(h.isFrequent).toBe(false);
    expect(h.suggestion).toBeNull();
    expect(h.firstSeen).toBeNull();
  });

  test("single archive → counted, but no suggestion (< 5 threshold)", () => {
    const db = makeDb();
    seed(db, [{ domain: "x.test", address: "foo@x.test", date: "2026-05-18", action: "A" }]);
    const h = getSenderHistory(db, "foo@x.test");
    expect(h.totalSeen).toBe(1);
    expect(h.actions.archive).toBe(1);
    expect(h.mostCommonAction).toBe("archive");
    expect(h.isFrequent).toBe(false);
    expect(h.suggestion).toBeNull();
  });
});

describe("getSenderHistory — suggestion thresholds", () => {
  test("5 archives → auto-archive suggestion at 100%", () => {
    const db = makeDb();
    seed(db, Array.from({ length: 5 }, (_, i) => ({
      domain: "n.test", address: "n@n.test", date: `2026-05-${10 + i}`, action: "A",
    })));
    const h = getSenderHistory(db, "n@n.test");
    expect(h.isFrequent).toBe(true);
    expect(h.suggestion?.kind).toBe("auto-archive");
    expect(h.suggestion?.confidencePct).toBe(100);
  });

  test("4 trashes + 1 archive (5 total, 80% trash) → auto-trash suggestion", () => {
    const db = makeDb();
    seed(db, [
      { domain: "junk.test", address: "j@j.test", date: "2026-05-10", action: "T" },
      { domain: "junk.test", address: "j@j.test", date: "2026-05-11", action: "T" },
      { domain: "junk.test", address: "j@j.test", date: "2026-05-12", action: "T" },
      { domain: "junk.test", address: "j@j.test", date: "2026-05-13", action: "T" },
      { domain: "junk.test", address: "j@j.test", date: "2026-05-14", action: "A" },
    ]);
    const h = getSenderHistory(db, "j@j.test");
    expect(h.suggestion?.kind).toBe("auto-trash");
    expect(h.suggestion?.confidencePct).toBe(80);
  });

  test("3 trash + 2 archive (5 total, 60% trash) → no suggestion (below 80%)", () => {
    const db = makeDb();
    seed(db, [
      { domain: "mixed.test", address: "m@m.test", date: "2026-05-10", action: "T" },
      { domain: "mixed.test", address: "m@m.test", date: "2026-05-11", action: "T" },
      { domain: "mixed.test", address: "m@m.test", date: "2026-05-12", action: "T" },
      { domain: "mixed.test", address: "m@m.test", date: "2026-05-13", action: "A" },
      { domain: "mixed.test", address: "m@m.test", date: "2026-05-14", action: "A" },
    ]);
    const h = getSenderHistory(db, "m@m.test");
    expect(h.isFrequent).toBe(true);
    expect(h.suggestion).toBeNull();
  });

  test("4 unsubs → no suggestion yet (need >= 5)", () => {
    const db = makeDb();
    seed(db, Array.from({ length: 4 }, (_, i) => ({
      domain: "spam.test", address: "s@spam.test", date: `2026-05-${10 + i}`, action: "U",
    })));
    const h = getSenderHistory(db, "s@spam.test");
    expect(h.isFrequent).toBe(false);
    expect(h.suggestion).toBeNull();
  });
});

describe("getDomainHistory", () => {
  test("aggregates across all addresses in the domain", () => {
    const db = makeDb();
    seed(db, [
      { domain: "shared.test", address: "a@shared.test", date: "2026-05-10", action: "A" },
      { domain: "shared.test", address: "b@shared.test", date: "2026-05-11", action: "A" },
      { domain: "shared.test", address: "c@shared.test", date: "2026-05-12", action: "T" },
    ]);
    const h = getDomainHistory(db, "shared.test");
    expect(h.totalSeen).toBe(3);
    expect(h.actions.archive).toBe(2);
    expect(h.actions.trash).toBe(1);
    expect(h.domain).toBe("shared.test");
  });

  test("case-insensitive domain match", () => {
    const db = makeDb();
    seed(db, [{ domain: "Mixed-Case.Test", address: "x@x.test", date: "2026-05-10", action: "A" }]);
    expect(getDomainHistory(db, "mixed-case.test").totalSeen).toBe(1);
    expect(getDomainHistory(db, "MIXED-CASE.TEST").totalSeen).toBe(1);
  });
});

describe("Phase 22 v1 — reply affinity", () => {
  test("sender with 3+ replies + >= 50% reply rate → isReplyAffinity true", () => {
    const db = makeDb();
    seed(db, [
      { domain: "x.test", address: "boss@x.test", date: "2026-05-10", action: "R" },
      { domain: "x.test", address: "boss@x.test", date: "2026-05-11", action: "R" },
      { domain: "x.test", address: "boss@x.test", date: "2026-05-12", action: "R" },
      { domain: "x.test", address: "boss@x.test", date: "2026-05-13", action: "A" },
    ]);
    const h = getSenderHistory(db, "boss@x.test");
    expect(h.replyAffinity).toBe(0.75);
    expect(h.isReplyAffinity).toBe(true);
  });

  test("sender with only 1 reply → not flagged regardless of rate", () => {
    const db = makeDb();
    seed(db, [{ domain: "x.test", address: "a@x.test", date: "2026-05-10", action: "R" }]);
    const h = getSenderHistory(db, "a@x.test");
    expect(h.replyAffinity).toBe(1.0);
    expect(h.isReplyAffinity).toBe(false);
  });

  test("mostly-archived sender → replyAffinity low", () => {
    const db = makeDb();
    seed(db, [
      { domain: "x.test", address: "n@x.test", date: "2026-05-10", action: "A" },
      { domain: "x.test", address: "n@x.test", date: "2026-05-11", action: "A" },
      { domain: "x.test", address: "n@x.test", date: "2026-05-12", action: "R" },
    ]);
    const h = getSenderHistory(db, "n@x.test");
    expect(h.replyAffinity).toBeLessThan(0.5);
    expect(h.isReplyAffinity).toBe(false);
  });
});

describe("date tracking", () => {
  test("firstSeen + lastSeen reflect the date range", () => {
    const db = makeDb();
    seed(db, [
      { domain: "t.test", address: "t@t.test", date: "2026-03-15", action: "A" },
      { domain: "t.test", address: "t@t.test", date: "2026-05-01", action: "T" },
      { domain: "t.test", address: "t@t.test", date: "2026-04-10", action: "A" },
    ]);
    const h = getSenderHistory(db, "t@t.test");
    expect(h.firstSeen).toBe("2026-03-15");
    expect(h.lastSeen).toBe("2026-05-01");
  });
});
