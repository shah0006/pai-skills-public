import { describe, test, expect } from "bun:test";
import { detectUrgentEmails, formatAlertMessage, parseFuzzyDate, type UrgentItem } from "../Tools/AlertSender";
import type { ClassifiedEmail } from "../Tools/Types";

function makeEmail(overrides: Partial<ClassifiedEmail> = {}): ClassifiedEmail {
  return {
    id: "99001",
    subject: "Regular email",
    from: "sender@example.com",
    fromAddress: "sender@example.com",
    fromDomain: "example.com",
    date: "2026-04-05",
    isRead: false,
    hasAttachment: false,
    snippet: "",
    priority: "review",
    funnelStage: "informational",
    matchedRule: null,
    folder: null,
    replyDraft: null,
    isVip: false,
    isJunk: false,
    isUnknownSender: false,
    ...overrides,
  };
}

describe("detectUrgentEmails", () => {
  test("returns empty for non-urgent emails", () => {
    const emails = [makeEmail({ subject: "Weekly newsletter" })];
    const result = detectUrgentEmails(emails, "2026-04-05");
    expect(result).toHaveLength(0);
  });

  test("detects VIP + urgent keyword", () => {
    const emails = [makeEmail({
      isVip: true,
      subject: "URGENT: Credentialing deadline",
      from: "cred@hospital.com",
    })];
    const result = detectUrgentEmails(emails, "2026-04-05");
    expect(result).toHaveLength(1);
    expect(result[0].reason).toContain("VIP");
    expect(result[0].reason).toContain("urgent");
  });

  test("does not flag VIP without urgent keywords", () => {
    const emails = [makeEmail({
      isVip: true,
      subject: "Monthly report attached",
    })];
    const result = detectUrgentEmails(emails, "2026-04-05");
    expect(result).toHaveLength(0);
  });

  test("detects deadline date today", () => {
    const emails = [makeEmail({
      subject: "Peer Reference DUE 4/5/2026",
    })];
    const result = detectUrgentEmails(emails, "2026-04-05");
    expect(result).toHaveLength(1);
    expect(result[0].reason).toContain("Deadline");
  });

  test("detects deadline date tomorrow", () => {
    const emails = [makeEmail({
      subject: "Form due 4/6",
    })];
    const result = detectUrgentEmails(emails, "2026-04-05");
    expect(result).toHaveLength(1);
  });

  test("ignores deadline date next week", () => {
    const emails = [makeEmail({
      subject: "Form due 4/12/2026",
    })];
    const result = detectUrgentEmails(emails, "2026-04-05");
    expect(result).toHaveLength(0);
  });

  test("detects financial + urgent keyword", () => {
    const emails = [makeEmail({
      funnelStage: "financial",
      subject: "DocuSign: Contract expires today",
    })];
    const result = detectUrgentEmails(emails, "2026-04-05");
    expect(result).toHaveLength(1);
    expect(result[0].reason).toContain("Financial");
  });

  test("does not flag financial without urgent keywords", () => {
    const emails = [makeEmail({
      funnelStage: "financial",
      subject: "Your statement is ready",
    })];
    const result = detectUrgentEmails(emails, "2026-04-05");
    expect(result).toHaveLength(0);
  });

  test("detects named month deadline", () => {
    const emails = [makeEmail({
      subject: "Report due April 5",
    })];
    const result = detectUrgentEmails(emails, "2026-04-05");
    expect(result).toHaveLength(1);
  });
});

describe("parseFuzzyDate — year rollover (V2 I2 fix)", () => {
  test("explicit year is honored, no rollover", () => {
    const ref = new Date(2026, 11, 15); // Dec 15, 2026
    const result = parseFuzzyDate("1/5/2027", ref);
    expect(result?.getFullYear()).toBe(2027);
    expect(result?.getMonth()).toBe(0);
    expect(result?.getDate()).toBe(5);
  });

  test("MM/DD without year, date already past in current year → bumps to next year", () => {
    const ref = new Date(2026, 11, 15); // Dec 15, 2026 — 'due 1/5' means Jan 5, 2027
    const result = parseFuzzyDate("1/5", ref);
    expect(result?.getFullYear()).toBe(2027);
    expect(result?.getMonth()).toBe(0);
    expect(result?.getDate()).toBe(5);
  });

  test("MM/DD without year, date still future this year → keeps current year", () => {
    const ref = new Date(2026, 2, 1); // Mar 1, 2026 — 'due 5/10' is May 10, 2026
    const result = parseFuzzyDate("5/10", ref);
    expect(result?.getFullYear()).toBe(2026);
  });

  test("Named month in past → bumps to next year", () => {
    const ref = new Date(2026, 11, 15); // Dec 15, 2026
    const result = parseFuzzyDate("Apr 5", ref);
    expect(result?.getFullYear()).toBe(2027);
    expect(result?.getMonth()).toBe(3);
  });

  test("Named month in future → keeps current year", () => {
    const ref = new Date(2026, 1, 1); // Feb 1, 2026
    const result = parseFuzzyDate("Apr 5", ref);
    expect(result?.getFullYear()).toBe(2026);
  });

  test("2-digit year is honored without rollover", () => {
    const ref = new Date(2026, 5, 1);
    expect(parseFuzzyDate("1/5/27", ref)?.getFullYear()).toBe(2027);
  });
});

describe("detectUrgentEmails — local YYYY-MM-DD parsing (V2 I3 fix)", () => {
  test("'due 5/18' on today=2026-05-18 flags urgent regardless of host tz", () => {
    // Pre-fix `new Date("2026-05-18")` parsed as UTC midnight, which in
    // EDT (UTC-4) is May 17 23:00 local — shifting today by a day and
    // making deadline comparisons fire on the wrong calendar day.
    const emails = [
      makeEmail({ id: "tz-1", subject: "due 5/18 contract review" }),
    ];
    const urgent = detectUrgentEmails(emails, "2026-05-18");
    expect(urgent.find(u => u.id === "tz-1")).toBeDefined();
  });

  test("'due 5/19' (tomorrow) on today=2026-05-18 still flags urgent", () => {
    const emails = [
      makeEmail({ id: "tz-2", subject: "due 5/19 form submission" }),
    ];
    const urgent = detectUrgentEmails(emails, "2026-05-18");
    expect(urgent.find(u => u.id === "tz-2")).toBeDefined();
  });

  test("'due 5/25' (next week) on today=2026-05-18 does NOT flag urgent", () => {
    const emails = [
      makeEmail({ id: "tz-3", subject: "due 5/25 follow-up" }),
    ];
    const urgent = detectUrgentEmails(emails, "2026-05-18");
    expect(urgent.find(u => u.id === "tz-3")).toBeUndefined();
  });
});

describe("formatAlertMessage", () => {
  test("returns empty for no items", () => {
    expect(formatAlertMessage([])).toBe("");
  });

  test("single item format", () => {
    const items: UrgentItem[] = [{
      id: "1", sender: "Dr. Jones", subject: "Lab results due today", reason: "deadline",
    }];
    const msg = formatAlertMessage(items);
    expect(msg).toContain("PAI Alert:");
    expect(msg).toContain("Lab results due today");
    expect(msg).toContain("Dr. Jones");
  });

  test("multiple items format", () => {
    const items: UrgentItem[] = [
      { id: "1", sender: "A", subject: "Subj A", reason: "r1" },
      { id: "2", sender: "B", subject: "Subj B", reason: "r2" },
    ];
    const msg = formatAlertMessage(items);
    expect(msg).toContain("2 urgent emails");
    expect(msg).toContain("Subj A");
    expect(msg).toContain("Subj B");
  });
});
