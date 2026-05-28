// tests/vip-sla.test.ts — Phase 24 SLA enforcement.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { checkVipSla, extractVipEntries, formatSlaBanner } from "../Tools/VipSla";

let tmpVault = "";
let tmpDb = "";

beforeEach(() => {
  tmpVault = mkdtempSync(join(tmpdir(), "et-sla-"));
  mkdirSync(join(tmpVault, "Email Triage"), { recursive: true });
  tmpDb = join(tmpVault, "triage.db");
  const db = new Database(tmpDb);
  db.exec(`
    CREATE TABLE email_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email_id TEXT NOT NULL,
      date TEXT NOT NULL,
      action TEXT NOT NULL,
      folder TEXT,
      notes TEXT
    );
  `);
  db.close();
});

afterEach(() => {
  if (tmpVault) rmSync(tmpVault, { recursive: true, force: true });
});

function writeNote(date: string, vipBlocks: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const monthNames = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  const filename = `Email Triage -- ${monthNames[m - 1]} ${d}, ${y}.md`;
  const content = `---
date: ${date}
---
# Email Triage

## [] Stage 1: VIP (X)
*People who matter most.*
${vipBlocks}

## [] Stage 2: Action Required (0)
*None*
`;
  writeFileSync(join(tmpVault, "Email Triage", filename), content);
  return filename;
}

describe("extractVipEntries", () => {
  test("mini-block format", () => {
    const content = `
## [] Stage 1: VIP (1)
#### [12345](message://x) vip@boss.test [VIP] [i] -- 2026-05-15
**Quarterly review**

## [] Stage 2: Action Required (0)
`;
    const entries = extractVipEntries(content);
    expect(entries).toHaveLength(1);
    expect(entries[0].emailId).toBe("12345");
    expect(entries[0].fromAddress).toBe("vip@boss.test");
    expect(entries[0].subject).toBe("Quarterly review");
  });
});

describe("checkVipSla", () => {
  test("VIP from 48h ago with no action → overdue at 24h SLA", () => {
    writeNote("2026-05-15", "#### [12345](message://x) overdue@vip.test [VIP] [i] -- 2026-05-15\n**Urgent**");
    const now = new Date("2026-05-17T12:00:00");
    const result = checkVipSla({ dbPath: tmpDb, vaultRoot: tmpVault, slaHours: 24, now });
    expect(result.overdue).toHaveLength(1);
    expect(result.overdue[0].fromAddress).toBe("overdue@vip.test");
    expect(result.overdue[0].hoursOverdue).toBeGreaterThan(0);
  });

  test("VIP with email_action recorded → not overdue", () => {
    writeNote("2026-05-15", "#### [12345](message://x) responded@vip.test [VIP] [i] -- 2026-05-15\n**Done**");
    const db = new Database(tmpDb);
    db.exec("INSERT INTO email_actions (email_id, date, action) VALUES ('12345', '2026-05-15', 'reply')");
    db.close();
    const now = new Date("2026-05-17T12:00:00");
    const result = checkVipSla({ dbPath: tmpDb, vaultRoot: tmpVault, slaHours: 24, now });
    expect(result.overdue).toHaveLength(0);
  });

  test("VIP < 24h old (with 24h SLA) → not overdue", () => {
    writeNote("2026-05-17", "#### [99999](message://y) fresh@vip.test [VIP] [i] -- 2026-05-17\n**Just arrived**");
    const now = new Date("2026-05-17T15:00:00");  // 6h after 09:00 anchor
    const result = checkVipSla({ dbPath: tmpDb, vaultRoot: tmpVault, slaHours: 24, now });
    expect(result.overdue).toHaveLength(0);
  });

  test("Custom SLA window (48h) means stricter checking", () => {
    writeNote("2026-05-15", "#### [12345](message://x) tight@vip.test [VIP] [i] -- 2026-05-15");
    const now = new Date("2026-05-16T12:00:00");  // 27h old
    const result24 = checkVipSla({ dbPath: tmpDb, vaultRoot: tmpVault, slaHours: 24, now });
    const result48 = checkVipSla({ dbPath: tmpDb, vaultRoot: tmpVault, slaHours: 48, now });
    expect(result24.overdue).toHaveLength(1);
    expect(result48.overdue).toHaveLength(0);
  });

  test("multiple overdue VIPs sorted by most-overdue-first", () => {
    writeNote("2026-05-13", "#### [11111](message://a) older@vip.test [VIP] [i] -- 2026-05-13");
    writeNote("2026-05-15", "#### [22222](message://b) newer@vip.test [VIP] [i] -- 2026-05-15");
    const now = new Date("2026-05-17T12:00:00");
    const result = checkVipSla({ dbPath: tmpDb, vaultRoot: tmpVault, slaHours: 24, now });
    expect(result.overdue).toHaveLength(2);
    expect(result.overdue[0].fromAddress).toBe("older@vip.test");
    expect(result.overdue[1].fromAddress).toBe("newer@vip.test");
  });

  test("totalVipsTracked counts unique VIP entries across notes", () => {
    writeNote("2026-05-15", "#### [11111](message://a) a@vip.test [VIP] [i] -- 2026-05-15");
    writeNote("2026-05-16", "#### [22222](message://b) b@vip.test [VIP] [i] -- 2026-05-16");
    const result = checkVipSla({ dbPath: tmpDb, vaultRoot: tmpVault, now: new Date("2026-05-17T12:00:00") });
    expect(result.totalVipsTracked).toBe(2);
  });
});

describe("formatSlaBanner", () => {
  test("returns undefined when no overdue", () => {
    expect(formatSlaBanner({ overdue: [], totalVipsTracked: 5, slaHours: 24 })).toBeUndefined();
  });

  test("renders banner with overdue list", () => {
    const banner = formatSlaBanner({
      overdue: [
        { emailId: "1", fromAddress: "a@v.test", subject: "Subj A", firstSeenDate: "2026-05-15", hoursOverdue: 12 },
      ],
      totalVipsTracked: 3,
      slaHours: 24,
    });
    expect(banner).toContain("VIP SLA breach");
    expect(banner).toContain("a@v.test");
    expect(banner).toContain("+12h");
  });

  test("truncates to first 10 with overflow indicator", () => {
    const overdue = Array.from({ length: 15 }, (_, i) => ({
      emailId: String(i),
      fromAddress: `s${i}@v.test`,
      subject: `Subject ${i}`,
      firstSeenDate: "2026-05-15",
      hoursOverdue: i,
    }));
    const banner = formatSlaBanner({ overdue, totalVipsTracked: 15, slaHours: 24 });
    expect(banner).toContain("and 5 more");
  });
});
