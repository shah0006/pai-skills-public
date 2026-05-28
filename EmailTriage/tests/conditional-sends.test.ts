// tests/conditional-sends.test.ts — Phase 21 conditional follow-up sends.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { registerConditional, loadRegistry, checkPendingConditionals, cancelConditional } from "../Tools/ConditionalSends";

let tmpDir = "";
let regPath = "";

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "et-cond-"));
  regPath = join(tmpDir, "conditional-sends.json");
});

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe("registerConditional", () => {
  test("adds entry to registry", () => {
    registerConditional({
      id: "c1", recipient: "boss@x.test",
      originalSentAt: "2026-05-16_10:00", followUpSendAt: "2026-05-19_10:00",
    }, regPath);
    const reg = loadRegistry(regPath);
    expect(reg.entries).toHaveLength(1);
    expect(reg.entries[0].recipient).toBe("boss@x.test");
  });

  test("replaces entry on same id", () => {
    registerConditional({ id: "c1", recipient: "a@x.test", originalSentAt: "2026-05-16_10:00", followUpSendAt: "2026-05-19_10:00" }, regPath);
    registerConditional({ id: "c1", recipient: "b@x.test", originalSentAt: "2026-05-16_10:00", followUpSendAt: "2026-05-19_10:00" }, regPath);
    const reg = loadRegistry(regPath);
    expect(reg.entries).toHaveLength(1);
    expect(reg.entries[0].recipient).toBe("b@x.test");
  });
});

describe("cancelConditional", () => {
  test("marks entry cancelled with reason", () => {
    registerConditional({ id: "c1", recipient: "x@x.test", originalSentAt: "2026-05-16_10:00", followUpSendAt: "2026-05-19_10:00" }, regPath);
    const ok = cancelConditional("c1", "manual", regPath);
    expect(ok).toBe(true);
    expect(loadRegistry(regPath).entries[0].cancelled).toBe(true);
    expect(loadRegistry(regPath).entries[0].cancelReason).toBe("manual");
  });

  test("returns false for unknown id", () => {
    expect(cancelConditional("nope", "manual", regPath)).toBe(false);
  });

  test("returns false if already cancelled (idempotent)", () => {
    registerConditional({ id: "c1", recipient: "x@x.test", originalSentAt: "2026-05-16_10:00", followUpSendAt: "2026-05-19_10:00" }, regPath);
    cancelConditional("c1", "manual", regPath);
    expect(cancelConditional("c1", "manual", regPath)).toBe(false);
  });
});

describe("checkPendingConditionals", () => {
  test("recipient replied → entry gets cancelled, decision='cancel'", async () => {
    registerConditional({ id: "c1", recipient: "x@x.test", originalSentAt: "2026-05-16_10:00", followUpSendAt: "2026-05-19_10:00" }, regPath);
    const result = await checkPendingConditionals({
      path: regPath,
      now: new Date("2026-05-19T11:00:00"),
      replyChecker: async () => true,
    });
    expect(result.decided).toHaveLength(1);
    expect(result.decided[0].action).toBe("cancel");
    expect(loadRegistry(regPath).entries[0].cancelled).toBe(true);
  });

  test("no reply → entry remains pending, decision='fire'", async () => {
    registerConditional({ id: "c1", recipient: "x@x.test", originalSentAt: "2026-05-16_10:00", followUpSendAt: "2026-05-19_10:00" }, regPath);
    const result = await checkPendingConditionals({
      path: regPath,
      now: new Date("2026-05-19T11:00:00"),
      replyChecker: async () => false,
    });
    expect(result.decided).toHaveLength(1);
    expect(result.decided[0].action).toBe("fire");
    expect(loadRegistry(regPath).entries[0].cancelled).toBeUndefined();
  });

  test("not yet at follow-up date → counted as pending, no decision", async () => {
    registerConditional({ id: "c1", recipient: "x@x.test", originalSentAt: "2026-05-16_10:00", followUpSendAt: "2026-05-25_10:00" }, regPath);
    const result = await checkPendingConditionals({
      path: regPath,
      now: new Date("2026-05-19T11:00:00"),
      replyChecker: async () => { throw new Error("checker should not be called for future dates"); },
    });
    expect(result.pending).toBe(1);
    expect(result.decided).toHaveLength(0);
  });

  test("already cancelled entries are skipped, counted separately", async () => {
    registerConditional({ id: "c1", recipient: "x@x.test", originalSentAt: "2026-05-16_10:00", followUpSendAt: "2026-05-19_10:00", cancelled: true, cancelReason: "manual" }, regPath);
    const result = await checkPendingConditionals({
      path: regPath,
      now: new Date("2026-05-19T11:00:00"),
      replyChecker: async () => { throw new Error("checker should not be called for cancelled entries"); },
    });
    expect(result.alreadyCancelled).toBe(1);
    expect(result.decided).toHaveLength(0);
  });

  test("mixed batch handled correctly", async () => {
    registerConditional({ id: "c1", recipient: "replied@x.test", originalSentAt: "2026-05-16_10:00", followUpSendAt: "2026-05-19_10:00" }, regPath);
    registerConditional({ id: "c2", recipient: "ignored@x.test", originalSentAt: "2026-05-16_10:00", followUpSendAt: "2026-05-19_10:00" }, regPath);
    registerConditional({ id: "c3", recipient: "future@x.test", originalSentAt: "2026-05-16_10:00", followUpSendAt: "2026-05-25_10:00" }, regPath);
    const result = await checkPendingConditionals({
      path: regPath,
      now: new Date("2026-05-19T11:00:00"),
      replyChecker: async (recipient: string) => recipient === "replied@x.test",
    });
    expect(result.decided).toHaveLength(2);
    expect(result.pending).toBe(1);
    expect(result.decided.find(d => d.recipient === "replied@x.test")?.action).toBe("cancel");
    expect(result.decided.find(d => d.recipient === "ignored@x.test")?.action).toBe("fire");
  });
});
