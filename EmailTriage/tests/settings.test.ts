// tests/settings.test.ts — Phase 29 settings key/value persistence.
// ISA: ~/.claude/skills/EmailTriage/ISA.md.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initDb, getSetting, setSetting, getAllSettings } from "../Tools/Db";

let db: Database;
beforeEach(() => { db = initDb(":memory:"); });
afterEach(() => { db.close(); });

describe("settings table (Phase 29)", () => {
  test("getSetting returns the fallback for an unset key", () => {
    expect(getSetting(db, "missing")).toBeNull();
    expect(getSetting(db, "missing", "default")).toBe("default");
  });

  test("setSetting then getSetting round-trips a value", () => {
    setSetting(db, "summarizer.model", "claude-haiku-4-5-20251001");
    expect(getSetting(db, "summarizer.model")).toBe("claude-haiku-4-5-20251001");
  });

  test("setSetting upserts — a second write replaces the value", () => {
    setSetting(db, "summarizer.provider", "anthropic");
    setSetting(db, "summarizer.provider", "ollama");
    expect(getSetting(db, "summarizer.provider")).toBe("ollama");
    const count = (db.prepare("SELECT count(*) c FROM settings WHERE key = ?").get("summarizer.provider") as { c: number }).c;
    expect(count).toBe(1);
  });

  test("getAllSettings returns every key/value pair", () => {
    setSetting(db, "a", "1");
    setSetting(db, "b", "2");
    const all = getAllSettings(db);
    expect(all.a).toBe("1");
    expect(all.b).toBe("2");
  });
});
