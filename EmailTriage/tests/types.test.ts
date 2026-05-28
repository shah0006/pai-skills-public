// ~/.claude/skills/EmailTriage/tests/types.test.ts
import { describe, test, expect } from "bun:test";
import type { RawEmail, ClassifiedEmail, EmailAction, TriageSession } from "../Tools/Types";
import { ACCOUNT_MAP, resolveAccountAlias, getStageFolderPath, STAGE_FOLDER_NAMES, FOLDER_STAGE_MAP } from "../Tools/Types";

describe("types", () => {
  test("RawEmail has required fields", () => {
    const email: RawEmail = {
      id: "12345",
      subject: "Test",
      from: "John <john@example.com>",
      fromAddress: "john@example.com",
      fromDomain: "example.com",
      date: "2026-03-01",
      isRead: false,
      hasAttachment: false,
      snippet: "Hello...",
      account: "iCloud",
    };
    expect(email.id).toBe("12345");
    expect(email.fromDomain).toBe("example.com");
  });

  test("EmailAction covers all action types", () => {
    const actions: EmailAction["action"][] = [
      "archive", "trash", "reply", "defer", "keep", "junk", "block", "unsub", "approve"
    ];
    expect(actions.length).toBe(9);
  });
});

describe("ACCOUNT_MAP", () => {
  test("resolves single-letter aliases", () => {
    expect(resolveAccountAlias("i")).toBe("i");
    expect(resolveAccountAlias("g")).toBe("g");
  });

  test("resolves full names case-insensitively", () => {
    expect(resolveAccountAlias("iCloud")).toBe("i");
    expect(resolveAccountAlias("ICLOUD")).toBe("i");
    expect(resolveAccountAlias("Gmail")).toBe("g");
    expect(resolveAccountAlias("gmail")).toBe("g");
    expect(resolveAccountAlias("Google")).toBe("g");
    expect(resolveAccountAlias("google")).toBe("g");
  });

  test("returns null for unknown alias", () => {
    expect(resolveAccountAlias("unknown")).toBeNull();
    expect(resolveAccountAlias("")).toBeNull();
  });
});

describe("getStageFolderPath", () => {
  test("returns account-prefixed path for iCloud", () => {
    expect(getStageFolderPath("vip", "i")).toBe("i/Stages/Stage 1 - VIP");
    expect(getStageFolderPath("action", "i")).toBe("i/Stages/Stage 2 - Action Required");
    expect(getStageFolderPath("auto_processed", "i")).toBe("i/Stages/Stage 6 - Auto-Processed");
  });

  test("returns account-prefixed path for Gmail", () => {
    expect(getStageFolderPath("vip", "g")).toBe("g/Stages/Stage 1 - VIP");
  });

  test("returns null for follow_up_due", () => {
    expect(getStageFolderPath("follow_up_due", "i")).toBeNull();
  });
});

describe("STAGE_FOLDER_NAMES and FOLDER_STAGE_MAP consistency", () => {
  test("every folder name maps back to a stage", () => {
    for (const [stage, name] of Object.entries(STAGE_FOLDER_NAMES)) {
      if (name === null) continue;
      expect(FOLDER_STAGE_MAP[name]).toBe(stage);
    }
  });

  test("every mapped folder resolves to a valid stage name", () => {
    for (const [name, stage] of Object.entries(FOLDER_STAGE_MAP)) {
      expect(STAGE_FOLDER_NAMES[stage]).toBe(name);
    }
  });
});
