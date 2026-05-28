import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initDb } from "../Tools/Db";
import {
  getDateRange,
  formatDisplayDate,
  getNewJunkDomainsInRange,
  getNewJunkAddressesInRange,
  getUnsubscribeAttemptsInRange,
  getRepeatOffenders,
  getTotals,
  generateReport,
  type ReportData,
} from "../Tools/UnsubReport";

let db: Database;

beforeEach(() => {
  db = initDb(":memory:");
});

afterEach(() => {
  db.close();
});

describe("getDateRange", () => {
  test("returns same date for start and end", () => {
    const range = getDateRange("2026-03-27");
    expect(range.start).toBe("2026-03-27");
    expect(range.end).toBe("2026-03-27");
  });

  test("throws on invalid format", () => {
    expect(() => getDateRange("2026-W13")).toThrow("Invalid date format");
    expect(() => getDateRange("not-a-date")).toThrow("Invalid date format");
  });
});

describe("formatDisplayDate", () => {
  test("formats date as human-readable string", () => {
    expect(formatDisplayDate("2026-03-27")).toBe("March 27, 2026");
    expect(formatDisplayDate("2026-01-01")).toBe("January 1, 2026");
    expect(formatDisplayDate("2026-12-25")).toBe("December 25, 2026");
  });
});

describe("getNewJunkDomainsInRange", () => {
  test("returns domains added on the target date", () => {
    db.prepare("INSERT INTO junk_senders (domain, added_at) VALUES (?, ?)").run("spam.com", "2026-03-27_10:00");
    db.prepare("INSERT INTO junk_senders (domain, added_at) VALUES (?, ?)").run("old.com", "2026-03-26_10:00");
    db.prepare("INSERT INTO junk_senders (domain, added_at) VALUES (?, ?)").run("new.com", "2026-03-27_14:00");

    const results = getNewJunkDomainsInRange(db, "2026-03-27", "2026-03-27");
    expect(results.length).toBe(2);
    expect(results.map(r => r.domain)).toContain("spam.com");
    expect(results.map(r => r.domain)).toContain("new.com");
  });

  test("excludes address-only entries (no domain)", () => {
    db.prepare("INSERT INTO junk_senders (address, added_at) VALUES (?, ?)").run("user@x.com", "2026-03-27_10:00");
    db.prepare("INSERT INTO junk_senders (domain, added_at) VALUES (?, ?)").run("spam.com", "2026-03-27_10:00");

    const results = getNewJunkDomainsInRange(db, "2026-03-27", "2026-03-27");
    expect(results.length).toBe(1);
    expect(results[0].domain).toBe("spam.com");
  });

  test("returns empty array when no matches", () => {
    const results = getNewJunkDomainsInRange(db, "2026-03-27", "2026-03-27");
    expect(results).toEqual([]);
  });
});

describe("getNewJunkAddressesInRange", () => {
  test("returns addresses added on the target date", () => {
    db.prepare("INSERT INTO junk_senders (address, added_at) VALUES (?, ?)").run("spam@x.com", "2026-03-27_10:00");
    db.prepare("INSERT INTO junk_senders (address, added_at) VALUES (?, ?)").run("old@y.com", "2026-03-26_10:00");

    const results = getNewJunkAddressesInRange(db, "2026-03-27", "2026-03-27");
    expect(results.length).toBe(1);
    expect(results[0].address).toBe("spam@x.com");
  });
});

describe("getUnsubscribeAttemptsInRange", () => {
  test("returns unsub attempts on the target date", () => {
    db.prepare("INSERT INTO unsubscribed (address, domain, method, unsubscribed_at) VALUES (?, ?, ?, ?)").run("a@x.com", "x.com", "http", "2026-03-27_10:00");
    db.prepare("INSERT INTO unsubscribed (address, domain, method, unsubscribed_at) VALUES (?, ?, ?, ?)").run("b@y.com", "y.com", "mailto", "2026-03-27_11:00");
    db.prepare("INSERT INTO unsubscribed (address, domain, method, unsubscribed_at) VALUES (?, ?, ?, ?)").run("c@z.com", "z.com", "http", "2026-03-26_08:00");

    const results = getUnsubscribeAttemptsInRange(db, "2026-03-27", "2026-03-27");
    expect(results.length).toBe(2);
  });

  test("returns empty array when no matches", () => {
    const results = getUnsubscribeAttemptsInRange(db, "2026-03-27", "2026-03-27");
    expect(results).toEqual([]);
  });
});

describe("getRepeatOffenders", () => {
  test("finds domains in email_actions that are already in junk_senders", () => {
    db.prepare("INSERT INTO junk_senders (domain, added_at) VALUES (?, ?)").run("spam.com", "2026-03-14_10:00");
    db.prepare("INSERT INTO email_actions (email_id, date, action, notes) VALUES (?, ?, ?, ?)").run("msg1", "2026-03-27", "junk", "from:user@spam.com");
    db.prepare("INSERT INTO email_actions (email_id, date, action, notes) VALUES (?, ?, ?, ?)").run("msg2", "2026-03-27", "junk", "from:other@spam.com");
    db.prepare("INSERT INTO email_actions (email_id, date, action, notes) VALUES (?, ?, ?, ?)").run("msg3", "2026-03-27", "block", "from:x@spam.com");

    const results = getRepeatOffenders(db, "2026-03-27", "2026-03-27");
    expect(results.length).toBe(1);
    expect(results[0].domain).toBe("spam.com");
    expect(results[0].count).toBe(3);
  });

  test("returns empty when no repeat offenders", () => {
    const results = getRepeatOffenders(db, "2026-03-27", "2026-03-27");
    expect(results).toEqual([]);
  });
});

describe("getTotals", () => {
  test("counts total junk domains and addresses", () => {
    db.prepare("INSERT INTO junk_senders (domain, added_at) VALUES (?, ?)").run("a.com", "2026-03-01_10:00");
    db.prepare("INSERT INTO junk_senders (domain, added_at) VALUES (?, ?)").run("b.com", "2026-03-02_10:00");
    db.prepare("INSERT INTO junk_senders (address, added_at) VALUES (?, ?)").run("x@c.com", "2026-03-03_10:00");

    const totals = getTotals(db);
    expect(totals.totalJunkDomains).toBe(2);
    expect(totals.totalJunkAddresses).toBe(1);
  });

  test("counts total unsubscribed", () => {
    db.prepare("INSERT INTO unsubscribed (address, method, unsubscribed_at) VALUES (?, ?, ?)").run("a@x.com", "http", "2026-03-01_10:00");
    db.prepare("INSERT INTO unsubscribed (domain, method, unsubscribed_at) VALUES (?, ?, ?)").run("y.com", "mailto", "2026-03-02_10:00");

    const totals = getTotals(db);
    expect(totals.totalUnsubscribed).toBe(2);
  });
});

describe("generateReport", () => {
  test("generates valid markdown report", () => {
    const data: ReportData = {
      date: "2026-03-27",
      displayDate: "March 27, 2026",
      generatedAt: "2026-03-27_14:00",
      newJunkDomains: [
        { domain: "spam.com", addedAt: "2026-03-27_10:00" },
        { domain: "junk.org", addedAt: "2026-03-27_11:00" },
      ],
      newJunkAddresses: [
        { address: "bad@evil.com", addedAt: "2026-03-27_09:00" },
      ],
      unsubAttempts: [
        { address: "a@x.com", domain: "x.com", method: "http", unsubscribedAt: "2026-03-27_10:00" },
        { address: "b@y.com", domain: "y.com", method: "mailto", unsubscribedAt: "2026-03-27_11:00" },
      ],
      repeatOffenders: [
        { domain: "persistent.com", count: 3, blockedSince: "2026-03-14_10:00" },
      ],
      totals: {
        totalJunkDomains: 22,
        totalJunkAddresses: 8,
        totalUnsubscribed: 51,
      },
    };

    const md = generateReport(data);

    // Check YAML frontmatter
    expect(md).toContain("date: 2026-03-27_14:00");
    expect(md).toContain("document-type: unsub-report");
    expect(md).toContain("report-date: 2026-03-27");

    // Check title
    expect(md).toContain("# Unsubscribe Report - March 27, 2026");

    // Check summary table
    expect(md).toContain("| New junk domains added | 2 |");
    expect(md).toContain("| New junk addresses added | 1 |");
    expect(md).toContain("| Unsubscribe attempts | 2 |");

    // Check new junk domains section
    expect(md).toContain("- spam.com (added 2026-03-27_10:00)");
    expect(md).toContain("- junk.org (added 2026-03-27_11:00)");

    // Check new junk addresses section
    expect(md).toContain("- bad@evil.com (added 2026-03-27_09:00)");

    // Check repeat offenders
    expect(md).toContain("- persistent.com (3 emails today, blocked since 2026-03-14_10:00)");

    // Check totals
    expect(md).toContain("- Total junk domains: 22");
    expect(md).toContain("- Total junk addresses: 8");
    expect(md).toContain("- Total confirmed unsubscribes: 51");
  });

  test("handles empty data gracefully", () => {
    const data: ReportData = {
      date: "2026-03-27",
      displayDate: "March 27, 2026",
      generatedAt: "2026-03-27_14:00",
      newJunkDomains: [],
      newJunkAddresses: [],
      unsubAttempts: [],
      repeatOffenders: [],
      totals: {
        totalJunkDomains: 0,
        totalJunkAddresses: 0,
        totalUnsubscribed: 0,
      },
    };

    const md = generateReport(data);
    expect(md).toContain("| New junk domains added | 0 |");
    expect(md).toContain("*None today*");
  });
});
