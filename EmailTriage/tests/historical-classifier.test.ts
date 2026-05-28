// tests/historical-classifier.test.ts — Phase 22 heuristic classifier.
import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { classifyFromHistory } from "../Tools/HistoricalClassifier";

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

describe("classifyFromHistory — sender layer", () => {
  test("3+ sightings, 75%+ same action → strong prediction", () => {
    seed([
      { domain: "spam.test", address: "x@spam.test", date: "2026-05-10", action: "T" },
      { domain: "spam.test", address: "x@spam.test", date: "2026-05-11", action: "T" },
      { domain: "spam.test", address: "x@spam.test", date: "2026-05-12", action: "T" },
      { domain: "spam.test", address: "x@spam.test", date: "2026-05-13", action: "A" },
    ]);
    const p = classifyFromHistory(db, { address: "x@spam.test", domain: "spam.test" });
    expect(p.predictedAction).toBe("T");
    expect(p.source).toBe("sender");
    expect(p.confidence).toBeGreaterThan(0.4);
    expect(p.basis).toContain("trashed");
  });

  test("2 unanimous sightings → moderate confidence (0.6)", () => {
    seed([
      { domain: "x.test", address: "a@x.test", date: "2026-05-10", action: "A" },
      { domain: "x.test", address: "a@x.test", date: "2026-05-11", action: "A" },
    ]);
    const p = classifyFromHistory(db, { address: "a@x.test" });
    expect(p.predictedAction).toBe("A");
    expect(p.confidence).toBe(0.6);
  });

  test("mixed history below threshold → no prediction from sender", () => {
    seed([
      { domain: "x.test", address: "m@x.test", date: "2026-05-10", action: "T" },
      { domain: "x.test", address: "m@x.test", date: "2026-05-11", action: "A" },
      { domain: "x.test", address: "m@x.test", date: "2026-05-12", action: "R" },
    ]);
    const p = classifyFromHistory(db, { address: "m@x.test" });
    expect(p.predictedAction).toBeNull();
  });
});

describe("classifyFromHistory — domain fallback", () => {
  test("unknown address but known domain with strong signal", () => {
    seed([
      { domain: "newsletter.test", address: "a@newsletter.test", date: "2026-05-10", action: "T" },
      { domain: "newsletter.test", address: "b@newsletter.test", date: "2026-05-11", action: "T" },
      { domain: "newsletter.test", address: "c@newsletter.test", date: "2026-05-12", action: "T" },
      { domain: "newsletter.test", address: "d@newsletter.test", date: "2026-05-13", action: "T" },
      { domain: "newsletter.test", address: "e@newsletter.test", date: "2026-05-14", action: "T" },
    ]);
    const p = classifyFromHistory(db, { address: "new@newsletter.test", domain: "newsletter.test" });
    expect(p.predictedAction).toBe("T");
    expect(p.source).toBe("domain");
    expect(p.basis).toContain("5 of 5");
  });

  test("domain with weak signal → no prediction", () => {
    seed([
      { domain: "mixed.test", address: "a@mixed.test", date: "2026-05-10", action: "T" },
      { domain: "mixed.test", address: "b@mixed.test", date: "2026-05-11", action: "A" },
      { domain: "mixed.test", address: "c@mixed.test", date: "2026-05-12", action: "R" },
      { domain: "mixed.test", address: "d@mixed.test", date: "2026-05-13", action: "T" },
      { domain: "mixed.test", address: "e@mixed.test", date: "2026-05-14", action: "A" },
    ]);
    const p = classifyFromHistory(db, { address: "new@mixed.test", domain: "mixed.test" });
    expect(p.predictedAction).toBeNull();
  });

  test("sender layer takes precedence over domain layer", () => {
    seed([
      // Sender says trash 3x (strong)
      { domain: "company.test", address: "a@company.test", date: "2026-05-10", action: "T" },
      { domain: "company.test", address: "a@company.test", date: "2026-05-11", action: "T" },
      { domain: "company.test", address: "a@company.test", date: "2026-05-12", action: "T" },
      // Domain also says reply (5 OTHER addresses replied)
      { domain: "company.test", address: "b@company.test", date: "2026-05-10", action: "R" },
      { domain: "company.test", address: "c@company.test", date: "2026-05-11", action: "R" },
      { domain: "company.test", address: "d@company.test", date: "2026-05-12", action: "R" },
      { domain: "company.test", address: "e@company.test", date: "2026-05-13", action: "R" },
      { domain: "company.test", address: "f@company.test", date: "2026-05-14", action: "R" },
    ]);
    const p = classifyFromHistory(db, { address: "a@company.test", domain: "company.test" });
    expect(p.predictedAction).toBe("T");  // sender wins
    expect(p.source).toBe("sender");
  });
});

describe("classifyFromHistory — empty / no-data cases", () => {
  test("no inputs → null prediction", () => {
    const p = classifyFromHistory(db, {});
    expect(p.predictedAction).toBeNull();
    expect(p.source).toBe("none");
  });

  test("no history → null prediction", () => {
    const p = classifyFromHistory(db, { address: "stranger@nowhere.test", domain: "nowhere.test" });
    expect(p.predictedAction).toBeNull();
  });
});
