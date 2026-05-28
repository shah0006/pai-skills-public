// tests/path-resolver.test.ts
import { describe, test, expect } from "bun:test";
import {
  parsePath,
  resolveToAppleScript,
  normalizePath,
  formatDisplayPath,
  isMailFolderPath,
  isDiskPath,
} from "../Tools/PathResolver";

describe("parsePath", () => {
  test("empty string -> null account, empty parts", () => {
    expect(parsePath("")).toEqual({ account: null, parts: [] });
  });

  test("null-ish input -> null account, empty parts", () => {
    expect(parsePath("  ")).toEqual({ account: null, parts: [] });
  });

  test("bare alias 'i' -> iCloud inbox", () => {
    expect(parsePath("i")).toEqual({ account: "i", parts: [] });
  });

  test("bare alias 'g' -> Gmail inbox", () => {
    expect(parsePath("g")).toEqual({ account: "g", parts: [] });
  });

  test("nested path 'g/Stages/Stage 1 - VIP'", () => {
    expect(parsePath("g/Stages/Stage 1 - VIP")).toEqual({
      account: "g",
      parts: ["Stages", "Stage 1 - VIP"],
    });
  });

  test("full name 'Gmail' resolves to 'g'", () => {
    expect(parsePath("Gmail")).toEqual({ account: "g", parts: [] });
  });

  test("full name 'Gmail/Receipts' resolves correctly", () => {
    expect(parsePath("Gmail/Receipts")).toEqual({ account: "g", parts: ["Receipts"] });
  });

  test("case-insensitive: 'GMAIL', 'gmail', 'Gmail' all resolve to 'g'", () => {
    expect(parsePath("GMAIL").account).toBe("g");
    expect(parsePath("gmail").account).toBe("g");
    expect(parsePath("Gmail").account).toBe("g");
  });

  test("case-insensitive: 'iCloud', 'ICLOUD', 'icloud' all resolve to 'i'", () => {
    expect(parsePath("iCloud").account).toBe("i");
    expect(parsePath("ICLOUD").account).toBe("i");
    expect(parsePath("icloud").account).toBe("i");
  });

  test("'Google' alias resolves to 'g'", () => {
    expect(parsePath("Google/Inbox").account).toBe("g");
  });

  test("unrecognized prefix -> null account, full path as parts", () => {
    expect(parsePath("Unknown/Folder")).toEqual({
      account: null,
      parts: ["Unknown", "Folder"],
    });
  });

  test("deep nested path", () => {
    expect(parsePath("i/Personal/Subscriptions/Alo")).toEqual({
      account: "i",
      parts: ["Personal", "Subscriptions", "Alo"],
    });
  });
});

describe("resolveToAppleScript", () => {
  const folderTree = [
    "Stages/Stage 1 - VIP",
    "Stages/Stage 2 - Action Required",
    "Receipts",
    "Financial",
    "Personal/Subscriptions/Alo",
  ];

  test("resolves valid path to account + mailbox", () => {
    const result = resolveToAppleScript("i/Receipts", folderTree);
    expect(result.accountName).toBe("iCloud");
    expect(result.mailboxPath).toBe("Receipts");
  });

  test("case-insensitive folder matching", () => {
    const result = resolveToAppleScript("i/receipts", folderTree);
    expect(result.mailboxPath).toBe("Receipts"); // returns actual case
  });

  test("resolves Gmail paths", () => {
    const result = resolveToAppleScript("g/Financial", folderTree);
    expect(result.accountName).toBe("Google");
    expect(result.mailboxPath).toBe("Financial");
  });

  test("throws on non-existent folder with suggestions", () => {
    expect(() => resolveToAppleScript("i/NonExistent", folderTree)).toThrow("not found");
  });

  test("throws on path without account prefix", () => {
    expect(() => resolveToAppleScript("NoAccount/Folder", [])).toThrow("without account prefix");
  });

  test("bare account alias returns empty mailbox path", () => {
    const result = resolveToAppleScript("i", []);
    expect(result.accountName).toBe("iCloud");
    expect(result.mailboxPath).toBe("");
  });
});

describe("normalizePath", () => {
  test("lowercases the entire path", () => {
    expect(normalizePath("i/Personal/Subscriptions/Alo")).toBe("i/personal/subscriptions/alo");
  });
});

describe("formatDisplayPath", () => {
  test("formats with account and folders", () => {
    expect(formatDisplayPath("i", "Personal", "Subscriptions", "Alo")).toBe("i/Personal/Subscriptions/Alo");
  });

  test("bare account returns just the alias", () => {
    expect(formatDisplayPath("g")).toBe("g");
  });

  test("single folder", () => {
    expect(formatDisplayPath("i", "Receipts")).toBe("i/Receipts");
  });
});

describe("isMailFolderPath", () => {
  test("returns true for account alias prefix", () => {
    expect(isMailFolderPath("i/Receipts")).toBe(true);
    expect(isMailFolderPath("g/Stages/Stage 1 - VIP")).toBe(true);
  });

  test("returns true for full account name prefix", () => {
    expect(isMailFolderPath("Gmail/Receipts")).toBe(true);
    expect(isMailFolderPath("iCloud/Financial")).toBe(true);
  });

  test("returns false for disk paths", () => {
    expect(isMailFolderPath("~/Documents/Tax")).toBe(false);
    expect(isMailFolderPath("/tmp/file.pdf")).toBe(false);
  });

  test("returns false for empty input", () => {
    expect(isMailFolderPath("")).toBe(false);
    expect(isMailFolderPath("  ")).toBe(false);
  });
});

describe("isDiskPath", () => {
  test("returns true for ~/ prefix", () => {
    expect(isDiskPath("~/Documents/Tax")).toBe(true);
  });

  test("returns true for / prefix", () => {
    expect(isDiskPath("/tmp/file.pdf")).toBe(true);
  });

  test("returns true for unrecognized prefix", () => {
    expect(isDiskPath("save to vault")).toBe(true);
  });

  test("returns false for mail folder paths", () => {
    expect(isDiskPath("i/Receipts")).toBe(false);
    expect(isDiskPath("Gmail/Financial")).toBe(false);
  });

  test("returns false for empty input", () => {
    expect(isDiskPath("")).toBe(false);
  });
});
