import { describe, test, expect } from "bun:test";
import { isGmailMessageId, isIcloudMessageId, getTriageNotePath } from "../web/server/paths";

describe("web/server/paths", () => {
  test("isGmailMessageId accepts hex gmail ids", () => {
    expect(isGmailMessageId("19e3c49e48816478")).toBe(true);
    expect(isGmailMessageId("87126")).toBe(false);
  });

  test("isIcloudMessageId accepts numeric mail ids", () => {
    expect(isIcloudMessageId("87126")).toBe(true);
    expect(isIcloudMessageId("19e3c49e48816478")).toBe(false);
  });

  test("getTriageNotePath uses canonical filename", () => {
    const p = getTriageNotePath("2026-05-18", "/tmp/vault");
    expect(p).toContain("Email Triage -- May 18, 2026.md");
  });
});
