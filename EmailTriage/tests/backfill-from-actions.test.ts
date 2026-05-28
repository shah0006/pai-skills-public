// tests/backfill-from-actions.test.ts — Phase 22 deep-backfill coverage.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { backfillFromActions, buildSenderIndex } from "../Tools/BackfillFromActions";

let tmpVault = "";
let tmpDb = "";

beforeEach(() => {
  tmpVault = mkdtempSync(join(tmpdir(), "et-bfa-"));
  mkdirSync(join(tmpVault, "Email Triage"), { recursive: true });
  tmpDb = join(tmpVault, "triage.db");
  const db = new Database(tmpDb);
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
    CREATE TABLE email_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email_id TEXT NOT NULL,
      date TEXT NOT NULL,
      action TEXT NOT NULL,
      folder TEXT,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  db.close();
});

afterEach(() => {
  if (tmpVault) rmSync(tmpVault, { recursive: true, force: true });
});

describe("buildSenderIndex", () => {
  test("extracts sender from mini-block VIP entries", () => {
    const note = `
## [] Stage 1: VIP (1)
*People who matter most.*
#### [12345](message://x) sender@vip.test [VIP] [i] -- 2026-05-18
**Subject**
`;
    const idx = buildSenderIndex(note);
    expect(idx.get("12345")?.fromAddress).toBe("sender@vip.test");
    expect(idx.get("12345")?.domain).toBe("vip.test");
  });

  test("extracts sender from Stage 5 table rows", () => {
    const note = `
## [] Stage 5: Bulk Dispose (1)
| ID | Sender | Subject |
| --- | --- | --- |
| [67890](message://y) [i] | bulk@spammer.test | Junk subject |
`;
    const idx = buildSenderIndex(note);
    expect(idx.get("67890")?.fromAddress).toBe("bulk@spammer.test");
    expect(idx.get("67890")?.domain).toBe("spammer.test");
  });

  test("handles angle-bracket sender format <addr@host>", () => {
    const note = `
## [] Stage 5: Bulk Dispose (1)
| [11111](message://z) [i] | Display Name <real@addr.test> | Subj |
`;
    const idx = buildSenderIndex(note);
    expect(idx.get("11111")?.fromAddress).toBe("real@addr.test");
  });

  test("first occurrence wins when the same id appears twice", () => {
    const note = `
## [] Stage 1: VIP (1)
#### [12345](message://x) first@addr.test [VIP] [i] -- 2026-05-18
**Subject**

## [] Stage 5: Bulk Dispose (1)
| [12345](message://x) [i] | second@addr.test | Subj |
`;
    const idx = buildSenderIndex(note);
    expect(idx.get("12345")?.fromAddress).toBe("first@addr.test");
  });
});

describe("backfillFromActions", () => {
  test("populates domain_activity from email_actions + sender lookup", () => {
    const note = `---
date: 2026-05-10
---
# Email Triage -- May 10, 2026

## [] Stage 5: Bulk Dispose (2)
| ID | Sender | Subject |
| --- | --- | --- |
| [55001](message://a) [i] | promo@retail.test | Sale |
| [55002](message://b) [i] | digest@newsletter.test | Digest |
`;
    writeFileSync(join(tmpVault, "Email Triage", "Email Triage -- May 10, 2026.md"), note);
    const db = new Database(tmpDb);
    db.exec(`
      INSERT INTO email_actions (email_id, date, action) VALUES
        ('55001', '2026-05-10', 'trash'),
        ('55002', '2026-05-10', 'archive');
    `);
    db.close();

    const summary = backfillFromActions({ dbPath: tmpDb, vaultRoot: tmpVault });
    expect(summary.sendersIndexed).toBe(2);
    expect(summary.actionsScanned).toBe(2);
    expect(summary.actionsMatched).toBe(2);
    expect(summary.rowsInserted).toBe(2);
    expect(summary.byAction.T).toBe(1);
    expect(summary.byAction.A).toBe(1);
  });

  test("skips actions whose email_id has no sender in any note", () => {
    const note = `---
date: 2026-05-10
---
## [] Stage 5: Bulk Dispose (1)
| [55001](message://a) [i] | known@sender.test | Subj |
`;
    writeFileSync(join(tmpVault, "Email Triage", "Email Triage -- May 10, 2026.md"), note);
    const db = new Database(tmpDb);
    db.exec(`
      INSERT INTO email_actions (email_id, date, action) VALUES
        ('55001', '2026-05-10', 'trash'),
        ('99999', '2026-05-10', 'trash');
    `);
    db.close();

    const summary = backfillFromActions({ dbPath: tmpDb, vaultRoot: tmpVault });
    expect(summary.actionsScanned).toBe(2);
    expect(summary.actionsMatched).toBe(1);  // only 55001 has a sender
  });

  test("dry-run does not write", () => {
    const note = `## [] Stage 5: Bulk Dispose (1)\n| [55001](message://a) [i] | x@y.test | Subj |\n`;
    writeFileSync(join(tmpVault, "Email Triage", "Email Triage -- May 10, 2026.md"), note);
    const db = new Database(tmpDb);
    db.exec("INSERT INTO email_actions (email_id, date, action) VALUES ('55001', '2026-05-10', 'trash')");
    db.close();

    const summary = backfillFromActions({ dbPath: tmpDb, vaultRoot: tmpVault, dryRun: true });
    expect(summary.actionsMatched).toBe(1);
    expect(summary.rowsInserted).toBe(0);

    const db2 = new Database(tmpDb);
    const count = (db2.prepare("SELECT COUNT(*) AS n FROM domain_activity").get() as { n: number }).n;
    expect(count).toBe(0);
    db2.close();
  });

  test("maps all action codes correctly (archive/trash/reply/keep/etc)", () => {
    const note = `
## [] Stage 5: Bulk Dispose (5)
| [1001](message://a) [i] | a@t.test | A |
| [1002](message://b) [i] | b@t.test | B |
| [1003](message://c) [i] | c@t.test | C |
| [1004](message://d) [i] | d@t.test | D |
| [1005](message://e) [i] | e@t.test | E |
`;
    writeFileSync(join(tmpVault, "Email Triage", "Email Triage -- May 10, 2026.md"), note);
    const db = new Database(tmpDb);
    db.exec(`
      INSERT INTO email_actions (email_id, date, action) VALUES
        ('1001', '2026-05-10', 'archive'),
        ('1002', '2026-05-10', 'trash'),
        ('1003', '2026-05-10', 'reply'),
        ('1004', '2026-05-10', 'keep'),
        ('1005', '2026-05-10', 'unsub');
    `);
    db.close();

    const summary = backfillFromActions({ dbPath: tmpDb, vaultRoot: tmpVault });
    expect(summary.byAction.A).toBe(1);
    expect(summary.byAction.T).toBe(1);
    expect(summary.byAction.R).toBe(1);
    expect(summary.byAction.K).toBe(1);
    expect(summary.byAction.U).toBe(1);
  });
});
