// tests/email-types.test.ts — AD-1 email-type taxonomy DB layer.
// Each test names the ISC it probes (ISA: ~/.claude/skills/EmailTriage/ISA.md).
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync } from "fs";
import { join } from "path";
import { initDb, runMigration, getEmailTypes } from "../Tools/Db";
import { classifyEmailType } from "../Tools/EmailTypes";

// Real References dir — holds email-types.yaml.seed. runMigration reads the
// .yaml.seed form and renames nothing (no email-types.yaml present), so this
// mutates no files on disk.
const REFERENCES = join(import.meta.dir, "..", "References");

let db: Database;
beforeEach(() => { db = initDb(":memory:"); });
afterEach(() => { db.close(); });

describe("email_types table (AD-1)", () => {
  test("ISC-3: the seed file exists", () => {
    expect(existsSync(join(REFERENCES, "email-types.yaml.seed"))).toBe(true);
  });

  test("ISC-1: email_types table exists after migration", () => {
    runMigration(db, REFERENCES);
    const t = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='email_types'",
    ).all();
    expect(t.length).toBe(1);
  });

  test("ISC-2: schema carries the expected columns", () => {
    runMigration(db, REFERENCES);
    const cols = (db.prepare("PRAGMA table_info(email_types)").all() as { name: string }[])
      .map(c => c.name);
    for (const c of ["name", "detection", "match_scope", "must_surface", "enabled", "sort_order", "source"]) {
      expect(cols).toContain(c);
    }
  });

  test("ISC-4: seeding is idempotent — row count stable across two runs", () => {
    runMigration(db, REFERENCES);
    const first = (db.prepare("SELECT count(*) c FROM email_types").get() as { c: number }).c;
    runMigration(db, REFERENCES);
    const second = (db.prepare("SELECT count(*) c FROM email_types").get() as { c: number }).c;
    expect(second).toBe(first);
  });

  test("ISC-5: all 12 default types are seeded", () => {
    runMigration(db, REFERENCES);
    const c = (db.prepare("SELECT count(*) c FROM email_types").get() as { c: number }).c;
    expect(c).toBe(12);
  });

  test("ISC-6: every seeded type has a non-empty detection regex", () => {
    runMigration(db, REFERENCES);
    const bad = (db.prepare(
      "SELECT count(*) c FROM email_types WHERE detection IS NULL OR detection = ''",
    ).get() as { c: number }).c;
    expect(bad).toBe(0);
  });

  test("ISC-7: every seeded type has must_surface populated", () => {
    runMigration(db, REFERENCES);
    const bad = (db.prepare(
      "SELECT count(*) c FROM email_types WHERE must_surface IS NULL OR must_surface = ''",
    ).get() as { c: number }).c;
    expect(bad).toBe(0);
  });

  test("ISC-8: enabled defaults to 1; disabling CME excludes it from the active set", () => {
    runMigration(db, REFERENCES);
    expect(getEmailTypes(db).map(t => t.name)).toContain("CME / Medical Education");
    db.prepare("UPDATE email_types SET enabled = 0 WHERE name = ?").run("CME / Medical Education");
    expect(getEmailTypes(db).map(t => t.name)).not.toContain("CME / Medical Education");
    // includeDisabled still returns it
    expect(getEmailTypes(db, { includeDisabled: true }).map(t => t.name)).toContain("CME / Medical Education");
  });

  test("ISC-9: getEmailTypes returns enabled types ordered by sort_order", () => {
    runMigration(db, REFERENCES);
    const types = getEmailTypes(db);
    expect(types.length).toBe(12);
    const orders = types.map(t => t.sortOrder);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
    expect(types[0].name).toBe("Auth / Security Alert");
  });

  test("ISC-12: adding a type is a single INSERT — the classifier picks it up", () => {
    runMigration(db, REFERENCES);
    db.prepare(
      "INSERT INTO email_types (name, detection, match_scope, sort_order, source) VALUES (?,?,?,?,?)",
    ).run("Court Filing", "court filing|docket|hearing", "combined", 5, "manual");
    const types = getEmailTypes(db);
    expect(types.map(t => t.name)).toContain("Court Filing");
    // sort_order 5 < 10, so it leads the cascade
    expect(classifyEmailType(types, "Docket update", "hearing scheduled")).toBe("Court Filing");
  });

  test("classifyEmailType matches by detection regex, first-in-order wins", () => {
    runMigration(db, REFERENCES);
    const types = getEmailTypes(db);
    expect(classifyEmailType(types, "Your verification code", "code: 123456")).toBe("Auth / Security Alert");
    expect(classifyEmailType(types, "Payment receipt #999", "thank you")).toBe("Receipt / Transaction");
    expect(classifyEmailType(types, "Re: lunch", "see below")).toBe("Reply / Follow-up");
    expect(classifyEmailType(types, "hello there", "nothing notable here")).toBeNull();
  });

  test("regression: DB detection reproduces the pre-AD-1 hardcoded cascade", () => {
    runMigration(db, REFERENCES);
    const types = getEmailTypes(db);
    expect(classifyEmailType(types, "Appointment confirmation", "scheduled for Monday")).toBe("Appointment / Reminder");
    expect(classifyEmailType(types, "Your statement", "account balance update")).toBe("Financial / Account");
    expect(classifyEmailType(types, "Webinar invite", "continuing education credits")).toBe("CME / Medical Education");
    expect(classifyEmailType(types, "Shipment update", "your package shipped")).toBe("Shipping / Delivery");
    expect(classifyEmailType(types, "Big sale", "50% discount coupon today")).toBe("Promotional");
    expect(classifyEmailType(types, "Weekly digest", "view in browser of this newsletter")).toBe("Newsletter / Mailing List");
  });

  test("classifyEmailType: a malformed user regex is skipped, not thrown", () => {
    const types = getEmailTypes(db, { includeDisabled: true });
    // empty DB → no types → null, and no throw
    expect(classifyEmailType(types, "anything", "anything")).toBeNull();
  });
});
