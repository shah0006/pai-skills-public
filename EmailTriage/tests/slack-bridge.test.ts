// tests/slack-bridge.test.ts — Phase 23 Slack/Discord webhook scaffold.
import { describe, test, expect } from "bun:test";
import { postToSlack, formatTriageSummary } from "../Tools/SlackBridge";

describe("postToSlack", () => {
  test("returns { sent: false, error } when no webhook configured", async () => {
    delete process.env.SLACK_WEBHOOK_URL;
    delete process.env.DISCORD_WEBHOOK_URL;
    const r = await postToSlack({ text: "hi" });
    expect(r.sent).toBe(false);
    expect(r.error).toContain("no webhook configured");
  });
});

describe("formatTriageSummary", () => {
  test("renders all four counts in the expected lines", () => {
    const msg = formatTriageSummary({ date: "2026-05-19", total: 41, toProcess: 6, automated: 35, vip: 11 });
    expect(msg).toContain("2026-05-19");
    expect(msg).toContain("41 emails");
    expect(msg).toContain("6 to process");
    expect(msg).toContain("35 automated");
    expect(msg).toContain("11 VIP");
  });
});
