import { describe, test, expect } from "bun:test";
import {
  priorityColor,
  truncate,
  extractSenderName,
  actionLabel,
  formatHeaderDate,
} from "../app/utils";

describe("priorityColor", () => {
  test("action returns warning color", () => {
    expect(priorityColor("action")).toBe("var(--warning)");
  });

  test("review returns accent color", () => {
    expect(priorityColor("review")).toBe("var(--accent)");
  });

  test("trash returns danger color", () => {
    expect(priorityColor("trash")).toBe("var(--danger)");
  });

  test("archive returns muted color", () => {
    expect(priorityColor("archive")).toBe("var(--muted)");
  });

  test("unknown returns muted color", () => {
    expect(priorityColor("unknown")).toBe("var(--muted)");
  });
});

describe("truncate", () => {
  test("returns full string if within limit", () => {
    expect(truncate("Hello", 10)).toBe("Hello");
  });

  test("truncates and adds ellipsis when over limit", () => {
    expect(truncate("Hello World", 5)).toBe("Hello\u2026");
  });

  test("exact length returns as-is", () => {
    expect(truncate("Hello", 5)).toBe("Hello");
  });

  test("trims trailing space before ellipsis", () => {
    expect(truncate("Hello World Foo", 6)).toBe("Hello\u2026");
  });
});

describe("extractSenderName", () => {
  test("extracts name from angle-bracket format", () => {
    expect(extractSenderName("Test User <test.user@example.com>")).toBe(
      "Test User",
    );
  });

  test("returns full string when no angle brackets", () => {
    expect(extractSenderName("accounts@mg.mailer.intelius.com")).toBe(
      "accounts@mg.mailer.intelius.com",
    );
  });

  test("handles name with extra spaces", () => {
    expect(extractSenderName("  Dr. Nick  <drnick@ecg.com>")).toBe("Dr. Nick");
  });
});

describe("actionLabel", () => {
  test("maps known codes", () => {
    expect(actionLabel("A")).toBe("Archive");
    expect(actionLabel("T")).toBe("Trash");
    expect(actionLabel("R")).toBe("Reply");
    expect(actionLabel("BL")).toBe("Block");
  });

  test("returns code for unknown", () => {
    expect(actionLabel("X")).toBe("X");
  });
});

describe("formatHeaderDate", () => {
  test("formats YYYY-MM-DD to long date", () => {
    expect(formatHeaderDate("2026-03-01")).toBe("March 1, 2026");
  });

  test("handles December correctly", () => {
    expect(formatHeaderDate("2025-12-25")).toBe("December 25, 2025");
  });
});
