// Tests for fetchMessageIds() and fetchMessageIdsFromEnvelopeIndex().
// SDOC-2026-04-23_14-45 regression test: the triage note generator must
// produce clickable message:// links for 100% of rows in a mixed iCloud +
// Gmail batch (previously only ~20% rendered as clickable).
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  fetchMessageIds,
  fetchMessageIdsFromEnvelopeIndex,
  ENVELOPE_INDEX_PATH,
} from "../Tools/GenerateTriage";

// Fixture DB mirrors Apple Mail's minimal schema: messages + message_global_data
// joined via messages.global_message_id -> message_global_data.ROWID, with the
// message_id_header column holding the RFC 2822 header (including angle brackets).

function buildFixtureDb(path: string): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE message_global_data (
      ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id_header TEXT
    );
    CREATE TABLE messages (
      ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
      global_message_id INTEGER NOT NULL
    );
  `);

  const rows: Array<{ numId: number; header: string }> = [
    { numId: 91500, header: "<abc-icloud-001@mac.com>" },
    { numId: 91501, header: "<def-gmail-001@mail.gmail.com>" },
    { numId: 91502, header: "<ghi-icloud-002@icloud.com>" },
    { numId: 91503, header: "<jkl-gmail-002@mail.gmail.com>" },
    { numId: 91504, header: "<mno-icloud-003@mac.com>" },
    { numId: 91505, header: "<pqr-gmail-003@mail.gmail.com>" },
    { numId: 91506, header: "<stu-icloud-004@icloud.com>" },
    { numId: 91507, header: "<vwx-gmail-004@mail.gmail.com>" },
    { numId: 91508, header: "<yza-icloud-005@mac.com>" },
    { numId: 91509, header: "<bcd-gmail-005@mail.gmail.com>" },
    { numId: 91510, header: "" },  // NULL header edge case
  ];

  const insGlobal = db.prepare(
    "INSERT INTO message_global_data (ROWID, message_id_header) VALUES (?, ?)"
  );
  const insMsg = db.prepare(
    "INSERT INTO messages (ROWID, global_message_id) VALUES (?, ?)"
  );

  for (const row of rows) {
    insGlobal.run(row.numId, row.header || null);
    insMsg.run(row.numId, row.numId);
  }
  db.close();
}

describe("fetchMessageIdsFromEnvelopeIndex", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "emailtriage-msgid-test-"));
    dbPath = join(tmpDir, "Envelope Index");
    buildFixtureDb(dbPath);
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns full coverage for a mixed iCloud + Gmail batch (SDOC-2026-04-23_14-45)", () => {
    const requestedIds = [
      "91500", "91501", "91502", "91503", "91504",
      "91505", "91506", "91507", "91508", "91509",
    ];
    const result = fetchMessageIdsFromEnvelopeIndex(requestedIds, dbPath);

    // Core ticket assertion: 100% coverage, not just ~20%
    expect(result.size).toBe(requestedIds.length);
    for (const id of requestedIds) {
      expect(result.has(id)).toBe(true);
      expect(result.get(id)).toBeTruthy();
    }
  });

  test("strips angle brackets from message_id_header", () => {
    const result = fetchMessageIdsFromEnvelopeIndex(["91500"], dbPath);
    const msgId = result.get("91500");
    expect(msgId).toBe("abc-icloud-001@mac.com");
    expect(msgId?.startsWith("<")).toBe(false);
    expect(msgId?.endsWith(">")).toBe(false);
  });

  test("iCloud and Gmail IDs both resolve (no account-dependent filtering)", () => {
    const icloudIds = ["91500", "91502", "91504", "91506", "91508"];
    const gmailIds  = ["91501", "91503", "91505", "91507", "91509"];
    const result = fetchMessageIdsFromEnvelopeIndex(
      [...icloudIds, ...gmailIds],
      dbPath,
    );
    for (const id of icloudIds) expect(result.has(id)).toBe(true);
    for (const id of gmailIds)  expect(result.has(id)).toBe(true);

    // Spot-check format differentiation between the two account types.
    expect(result.get("91501")).toContain("mail.gmail.com");
    expect(result.get("91500")).toContain("mac.com");
    expect(result.get("91500")).not.toContain("gmail.com");
  });

  test("returns empty map for empty input", () => {
    const result = fetchMessageIdsFromEnvelopeIndex([], dbPath);
    expect(result.size).toBe(0);
  });

  test("skips rows with NULL message_id_header without throwing", () => {
    // 91510 has NULL header; the query's "AND mgd.message_id_header IS NOT NULL"
    // clause filters it out.
    const result = fetchMessageIdsFromEnvelopeIndex(["91510", "91500"], dbPath);
    expect(result.has("91510")).toBe(false);
    expect(result.has("91500")).toBe(true);
  });

  test("handles unknown IDs gracefully (no row => no map entry)", () => {
    const result = fetchMessageIdsFromEnvelopeIndex(["99999999"], dbPath);
    expect(result.size).toBe(0);
  });

  test("batches requests larger than the SQLite chunk size", () => {
    // 600 IDs exercises the CHUNK=500 loop; only 10 real rows so 10 hits.
    const ids = Array.from({ length: 600 }, (_, i) => String(91500 + i));
    const result = fetchMessageIdsFromEnvelopeIndex(ids, dbPath);
    // 91500..91509 are real (91510 has NULL header so excluded)
    expect(result.size).toBe(10);
    expect(result.has("91500")).toBe(true);
    expect(result.has("91509")).toBe(true);
  });
});

describe("fetchMessageIds (SQLite primary path)", () => {
  test("ENVELOPE_INDEX_PATH points at Apple Mail data file", () => {
    expect(ENVELOPE_INDEX_PATH).toContain("Library/Mail/V10/MailData/Envelope Index");
  });

  test("returns empty map for empty input", async () => {
    const result = await fetchMessageIds([]);
    expect(result.size).toBe(0);
  });
});
