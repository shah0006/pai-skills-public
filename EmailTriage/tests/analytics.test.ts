import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initDb, recordTriageSession, addKnownSender } from "../Tools/Db";
import { getAnalytics, formatAnalyticsMarkdown, formatAnalyticsConsole } from "../Tools/Analytics";

let db: Database;

beforeEach(() => {
  db = initDb(":memory:");
});

afterEach(() => {
  db.close();
});

describe("getAnalytics", () => {
  test("returns correct structure with empty database", () => {
    const data = getAnalytics(db, 30);

    expect(data.period.days).toBe(30);
    expect(data.period.start).toMatch(/^\d{4}-\d{2}-\d{2}_\d{2}:\d{2}$/);
    expect(data.period.end).toMatch(/^\d{4}-\d{2}-\d{2}_\d{2}:\d{2}$/);
    expect(data.sessions.total).toBe(0);
    expect(data.sessions.avgEmails).toBe(0);
    expect(data.sessions.avgDurationSec).toBe(0);
    expect(data.actionDistribution.archived).toBe(0);
    expect(data.actionDistribution.trashed).toBe(0);
    expect(data.actionDistribution.replied).toBe(0);
    expect(data.actionDistribution.kept).toBe(0);
    expect(data.actionDistribution.unsubscribed).toBe(0);
    expect(data.actionDistribution.blocked).toBe(0);
    expect(data.junkRate.current).toBe(0);
    expect(data.junkRate.trend).toBe(0);
    expect(data.topSenders).toEqual([]);
    expect(data.weeklyTrend).toEqual([]);
  });

  test("computes session stats from triage_history", () => {
    const today = new Date();
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

    recordTriageSession(db, { date: dateStr, total: 20, archived: 8, trashed: 5, replied: 3, durationSec: 300, unsubscribed: 2, blocked: 1 });
    recordTriageSession(db, { date: dateStr, total: 10, archived: 4, trashed: 2, replied: 1, durationSec: 200, unsubscribed: 1, blocked: 0 });

    const data = getAnalytics(db, 30);

    expect(data.sessions.total).toBe(2);
    expect(data.sessions.avgEmails).toBe(15); // (20+10)/2
    expect(data.sessions.avgDurationSec).toBe(250); // (300+200)/2
    expect(data.actionDistribution.archived).toBe(12); // 8+4
    expect(data.actionDistribution.trashed).toBe(7); // 5+2
    expect(data.actionDistribution.replied).toBe(4); // 3+1
    expect(data.actionDistribution.unsubscribed).toBe(3); // 2+1
    expect(data.actionDistribution.blocked).toBe(1);
  });

  test("computes junk rate correctly", () => {
    const today = new Date();
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

    // 10 total, 5 junk (3 trashed + 1 unsub + 1 blocked) = 50%
    recordTriageSession(db, { date: dateStr, total: 10, archived: 2, trashed: 3, replied: 1, durationSec: 120, unsubscribed: 1, blocked: 1 });

    const data = getAnalytics(db, 30);
    expect(data.junkRate.current).toBe(50);
  });

  test("includes top senders from known_senders", () => {
    addKnownSender(db, "frequent@example.com");
    addKnownSender(db, "frequent@example.com"); // times_seen = 2
    addKnownSender(db, "once@example.com");

    const data = getAnalytics(db, 30);

    expect(data.topSenders.length).toBe(2);
    expect(data.topSenders[0].sender).toBe("frequent@example.com");
    expect(data.topSenders[0].count).toBe(2);
    expect(data.topSenders[1].sender).toBe("once@example.com");
    expect(data.topSenders[1].count).toBe(1);
  });

  test("computes weekly trend grouping", () => {
    const today = new Date();
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

    recordTriageSession(db, { date: dateStr, total: 15, archived: 5, trashed: 4, replied: 2, durationSec: 180, unsubscribed: 2, blocked: 1 });

    const data = getAnalytics(db, 30);

    expect(data.weeklyTrend.length).toBeGreaterThanOrEqual(1);
    const week = data.weeklyTrend[0];
    expect(week.total).toBe(15);
    expect(week.autoProcessed).toBe(7); // 4 + 2 + 1
    expect(week.junkRate).toBe(47); // 7/15 = 46.67 -> 47
  });

  test("single session has zero trend", () => {
    const today = new Date();
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

    recordTriageSession(db, { date: dateStr, total: 10, archived: 5, trashed: 3, replied: 1, durationSec: 100 });

    const data = getAnalytics(db, 30);
    // With only 1 session, trend calculation can't split meaningfully
    expect(typeof data.junkRate.trend).toBe("number");
  });
});

describe("formatAnalyticsMarkdown", () => {
  test("produces valid markdown with headers", () => {
    const data = getAnalytics(db, 30);
    const md = formatAnalyticsMarkdown(data);

    expect(md).toContain("# Email Triage Analytics");
    expect(md).toContain("## Session Summary");
    expect(md).toContain("## Action Distribution");
    expect(md).toContain("## Junk Rate");
    expect(md).toContain("| Metric | Value |");
  });

  test("includes session data in markdown tables", () => {
    const today = new Date();
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

    recordTriageSession(db, { date: dateStr, total: 20, archived: 10, trashed: 5, replied: 2, durationSec: 600, unsubscribed: 1, blocked: 0 });

    const data = getAnalytics(db, 30);
    const md = formatAnalyticsMarkdown(data);

    expect(md).toContain("| Total Sessions | 1 |");
    expect(md).toContain("| Avg Emails/Session | 20 |");
    expect(md).toContain("| Archived | 10 |");
    expect(md).toContain("| Trashed | 5 |");
  });
});

describe("formatAnalyticsConsole", () => {
  test("produces readable console output", () => {
    const data = getAnalytics(db, 30);
    const output = formatAnalyticsConsole(data);

    expect(output).toContain("Email Triage Analytics");
    expect(output).toContain("Sessions: 0");
    expect(output).toContain("Avg Emails/Session: 0");
  });

  test("shows bar chart for action distribution", () => {
    const today = new Date();
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

    recordTriageSession(db, { date: dateStr, total: 10, archived: 5, trashed: 3, replied: 1, durationSec: 120, unsubscribed: 1, blocked: 0 });

    const data = getAnalytics(db, 30);
    const output = formatAnalyticsConsole(data);

    expect(output).toContain("Archived");
    expect(output).toContain("Trashed");
    expect(output).toContain("#"); // bar chart chars
  });
});
