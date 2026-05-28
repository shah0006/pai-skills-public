// ~/.claude/skills/EmailTriage/tests/unsubscribe.test.ts
import { describe, test, expect } from "bun:test";
import { parseListUnsubscribeHeader, UnsubscribeMethod, extractListUnsubscribeFromEmailContent } from "../Tools/Unsubscribe";

describe("parseListUnsubscribeHeader", () => {
  test("parses HTTP URL from angle brackets", () => {
    const header = "<https://example.com/unsub?token=abc123>";
    const result = parseListUnsubscribeHeader(header);
    expect(result).not.toBeNull();
    expect(result!.method).toBe(UnsubscribeMethod.HTTP);
    expect(result!.url).toBe("https://example.com/unsub?token=abc123");
  });

  test("parses mailto from angle brackets", () => {
    const header = "<mailto:unsub@example.com?subject=unsubscribe>";
    const result = parseListUnsubscribeHeader(header);
    expect(result).not.toBeNull();
    expect(result!.method).toBe(UnsubscribeMethod.MAILTO);
    expect(result!.email).toBe("unsub@example.com");
  });

  test("prefers HTTP when both present", () => {
    const header = "<mailto:unsub@example.com>, <https://example.com/unsub>";
    const result = parseListUnsubscribeHeader(header);
    expect(result!.method).toBe(UnsubscribeMethod.HTTP);
  });

  test("handles only mailto", () => {
    const header = "<mailto:list-unsubscribe@newsletter.com>";
    const result = parseListUnsubscribeHeader(header);
    expect(result!.method).toBe(UnsubscribeMethod.MAILTO);
    expect(result!.email).toBe("list-unsubscribe@newsletter.com");
    expect(result!.subject).toBe("unsubscribe");
  });

  test("returns null for empty header", () => {
    expect(parseListUnsubscribeHeader("")).toBeNull();
    expect(parseListUnsubscribeHeader(null as any)).toBeNull();
  });

  test("returns null for undefined header", () => {
    expect(parseListUnsubscribeHeader(undefined as any)).toBeNull();
  });

  test("handles header with HTTP — requiresPost is true per RFC 8058", () => {
    const header = "<https://example.com/unsub>";
    const result = parseListUnsubscribeHeader(header);
    expect(result!.requiresPost).toBe(true);
  });

  test("mailto does not require POST", () => {
    const header = "<mailto:unsub@example.com>";
    const result = parseListUnsubscribeHeader(header);
    expect(result!.requiresPost).toBe(false);
  });

  test("parses mailto subject parameter", () => {
    const header = "<mailto:unsub@example.com?subject=Please%20Unsubscribe>";
    const result = parseListUnsubscribeHeader(header);
    expect(result!.subject).toBe("Please Unsubscribe");
  });

  test("handles multiple HTTP URLs — picks first", () => {
    const header = "<https://first.com/unsub>, <https://second.com/unsub>";
    const result = parseListUnsubscribeHeader(header);
    expect(result!.url).toBe("https://first.com/unsub");
  });

  test("ignores non-angle-bracket content", () => {
    const header = "https://example.com/unsub";
    const result = parseListUnsubscribeHeader(header);
    expect(result).toBeNull();
  });
});

describe("extractListUnsubscribeFromEmailContent", () => {
  test("extracts List-Unsubscribe header from email content", () => {
    const content = `From: sender@example.com
Subject: Newsletter
List-Unsubscribe: <https://example.com/unsub?token=abc>
Date: 2026-01-01

Body text here.`;
    const result = extractListUnsubscribeFromEmailContent(content);
    expect(result).toBe("<https://example.com/unsub?token=abc>");
  });

  test("returns null when no List-Unsubscribe header", () => {
    const content = `From: sender@example.com
Subject: No unsub header

Body text.`;
    const result = extractListUnsubscribeFromEmailContent(content);
    expect(result).toBeNull();
  });

  test("case-insensitive header matching", () => {
    const content = `list-unsubscribe: <https://example.com/unsub>`;
    const result = extractListUnsubscribeFromEmailContent(content);
    expect(result).toBe("<https://example.com/unsub>");
  });
});
