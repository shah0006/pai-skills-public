import { describe, test, expect } from "bun:test";
import { parseEmailList, parseEmailAddress, parseDomain, fixEncoding, parseInboxTotal } from "../Tools/EmailParser";

describe("parseEmailAddress", () => {
  test("extracts email from 'Name <email>' format", () => {
    expect(parseEmailAddress("John Smith <john@example.com>")).toBe("john@example.com");
  });

  test("returns bare email unchanged", () => {
    expect(parseEmailAddress("john@example.com")).toBe("john@example.com");
  });

  test("handles empty string", () => {
    expect(parseEmailAddress("")).toBe("");
  });
});

describe("parseDomain", () => {
  test("extracts domain from email", () => {
    expect(parseDomain("john@example.com")).toBe("example.com");
  });

  test("handles subdomains", () => {
    expect(parseDomain("noreply@mail.substack.com")).toBe("mail.substack.com");
  });
});

describe("fixEncoding", () => {
  test("returns original string unchanged when no encoding issue", () => {
    const result = fixEncoding("Hello world");
    expect(result).toBe("Hello world");
  });

  test("returns original string on empty input", () => {
    expect(fixEncoding("")).toBe("");
  });
});

describe("parseEmailList", () => {
  // apple-mail.sh format: ID:NNNNN [READ]/[ ]/[⚑] [📎] | date | from | subject [| ACCT:name]
  const sampleOutput = `ID:79665 [ ] | Mar 1  | no-reply@identogo.com | TSA PreCheck Confirmation
ID:79640 [READ] | Mar 1  | nate@substack.com | AI Executive Briefing
ID:77013 [⚑] [📎] | Feb 19 | vip-family@example.com | Document`;

  test("parses 3 emails from sample output", () => {
    const emails = parseEmailList(sampleOutput);
    expect(emails.length).toBe(3);
  });

  test("parses unread flag correctly", () => {
    const emails = parseEmailList(sampleOutput);
    expect(emails[0].isRead).toBe(false);
    expect(emails[1].isRead).toBe(true);
  });

  test("parses email ID", () => {
    const emails = parseEmailList(sampleOutput);
    expect(emails[0].id).toBe("79665");
  });

  test("parses from address", () => {
    const emails = parseEmailList(sampleOutput);
    expect(emails[0].fromAddress).toBe("no-reply@identogo.com");
    expect(emails[0].fromDomain).toBe("identogo.com");
  });

  test("parses subject", () => {
    const emails = parseEmailList(sampleOutput);
    expect(emails[0].subject).toBe("TSA PreCheck Confirmation");
  });

  test("detects attachment emoji", () => {
    const emails = parseEmailList(sampleOutput);
    expect(emails[2].hasAttachment).toBe(true);
    expect(emails[0].hasAttachment).toBe(false);
  });

  test("returns empty array for empty input", () => {
    expect(parseEmailList("")).toEqual([]);
  });
});

describe("parseInboxTotal", () => {
  test("extracts total from apple-mail.sh header", () => {
    const raw = `Mailbox: inbox (82 total)\n======================================\nID:83721 [ ] [📎] | Friday, March 27, 2026 | Bina Shah | Cigna bill`;
    expect(parseInboxTotal(raw)).toBe(82);
  });

  test("returns null when header is missing", () => {
    expect(parseInboxTotal("ID:83721 [ ] | Friday | Bina | Subject")).toBeNull();
  });

  test("returns null for empty input", () => {
    expect(parseInboxTotal("")).toBeNull();
  });
});
