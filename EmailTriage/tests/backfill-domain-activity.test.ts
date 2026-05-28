// tests/backfill-domain-activity.test.ts — Phase 22 backfill regression.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { backfillDomainActivity } from "../Tools/BackfillDomainActivity";

function fixtureNote(opts: { date: string; stage5?: string[]; stage6?: string[] }): string {
  const stage5 = (opts.stage5 ?? []).join("\n");
  const stage6 = (opts.stage6 ?? []).join("\n");
  const monthNames = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  const [y, m, d] = opts.date.split("-").map(Number);
  return `---
date: ${opts.date}
status: pending
---
# Email Triage -- ${monthNames[m - 1]} ${d}, ${y}

## [] Stage 5: Bulk Dispose (${opts.stage5?.length ?? 0})
*Bulk archive or trash.*

| ID | Sender | Subject | 📎 | Archive To | A | T | J | U | BD | BS | You |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${stage5}

## [] Stage 6: Auto-Processed (${opts.stage6?.length ?? 0})
*Pre-classified.*

| ID | Sender | Subject | 📎 | Rule | Archive To | A | T | K | J | U | BD | BS | You |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${stage6}

## Execution Log
*(empty)*
`;
}

let tmpVault = "";
let tmpDb = "";

beforeEach(() => {
  tmpVault = mkdtempSync(join(tmpdir(), "et-backfill-"));
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
  `);
  db.close();
});

afterEach(() => {
  if (tmpVault) rmSync(tmpVault, { recursive: true, force: true });
});

describe("backfillDomainActivity", () => {
  test("parses Stage 5 trash + archive rows", () => {
    const note = fixtureNote({
      date: "2026-05-10",
      stage5: [
        "| [90001](message://abc) [i] | spammer@junk.test | Subject 1 |  |  |  | x |  |  |  |  |  |",
        "| [90002](message://def) [i] | promo@retail.test | Subject 2 |  | Promotions | x |  |  |  |  |  |  |",
      ],
    });
    writeFileSync(join(tmpVault, "Email Triage", "Email Triage -- May 10, 2026.md"), note);
    const summary = backfillDomainActivity({ dbPath: tmpDb, vaultRoot: tmpVault });
    expect(summary.rowsParsed).toBe(2);
    expect(summary.rowsInserted).toBe(2);
    expect(summary.byAction.T).toBe(1);
    expect(summary.byAction.A).toBe(1);
  });

  test("idempotent — second run does not double-count", () => {
    const note = fixtureNote({
      date: "2026-05-10",
      stage5: ["| [90001](message://abc) [i] | spammer@junk.test | Subject |  |  |  | x |  |  |  |  |  |"],
    });
    writeFileSync(join(tmpVault, "Email Triage", "Email Triage -- May 10, 2026.md"), note);
    backfillDomainActivity({ dbPath: tmpDb, vaultRoot: tmpVault });
    backfillDomainActivity({ dbPath: tmpDb, vaultRoot: tmpVault });
    const db = new Database(tmpDb);
    const count = (db.prepare("SELECT COUNT(*) AS n FROM domain_activity").get() as { n: number }).n;
    expect(count).toBe(1);
    db.close();
  });

  test("dry-run does not write to DB", () => {
    const note = fixtureNote({
      date: "2026-05-10",
      stage5: ["| [90001](message://abc) [i] | spammer@junk.test | Subject |  |  |  | x |  |  |  |  |  |"],
    });
    writeFileSync(join(tmpVault, "Email Triage", "Email Triage -- May 10, 2026.md"), note);
    const summary = backfillDomainActivity({ dbPath: tmpDb, vaultRoot: tmpVault, dryRun: true });
    expect(summary.rowsParsed).toBe(1);
    expect(summary.rowsInserted).toBe(0);
    const db = new Database(tmpDb);
    const count = (db.prepare("SELECT COUNT(*) AS n FROM domain_activity").get() as { n: number }).n;
    expect(count).toBe(0);
    db.close();
  });

  test("skips rows without an 'x' in any action column", () => {
    const note = fixtureNote({
      date: "2026-05-10",
      stage5: [
        "| [90001](message://abc) [i] | foo@bar.test | Unmarked subject |  |  |  |  |  |  |  |  |  |",
        "| [90002](message://def) [i] | bar@bar.test | Marked subject |  |  |  | x |  |  |  |  |  |",
      ],
    });
    writeFileSync(join(tmpVault, "Email Triage", "Email Triage -- May 10, 2026.md"), note);
    const summary = backfillDomainActivity({ dbPath: tmpDb, vaultRoot: tmpVault });
    expect(summary.rowsParsed).toBe(1);
  });

  test("parses Stage 6 action codes including K (keep)", () => {
    const note = fixtureNote({
      date: "2026-05-10",
      stage6: ["| [90099](message://kept) [i] | important@vendor.test | Keep this |  | staged |  |  |  | x |  |  |  |  |  |"],
    });
    writeFileSync(join(tmpVault, "Email Triage", "Email Triage -- May 10, 2026.md"), note);
    const summary = backfillDomainActivity({ dbPath: tmpDb, vaultRoot: tmpVault });
    expect(summary.rowsParsed).toBe(1);
    expect(summary.byAction.K).toBe(1);
  });

  test("returns 0 rows for notes without action sections", () => {
    writeFileSync(
      join(tmpVault, "Email Triage", "Email Triage -- May 10, 2026.md"),
      "---\ndate: 2026-05-10\nstatus: pending\n---\n# Note without action sections\n"
    );
    const summary = backfillDomainActivity({ dbPath: tmpDb, vaultRoot: tmpVault });
    expect(summary.notesSkipped).toBe(1);
    expect(summary.rowsParsed).toBe(0);
  });
});
