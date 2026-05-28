// ~/.claude/skills/EmailTriage/tests/send-later.test.ts
import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  initDb,
  recordScheduledSend,
  getDueSends,
  markSendComplete,
  markSendFailed,
} from "../Tools/Db";
import { parseActionsCell, buildExecutionPlan } from "../Tools/ExecuteTriage";
import {
  createSendPackage, cancelScheduledSend, listPendingSends,
  listFailedSends, listSentSends, catchupOverdueSends,
  cleanupOldSent, type SendPackage,
} from "../Tools/SendLater";

let db: Database;

beforeEach(() => {
  db = initDb(":memory:");
});

afterEach(() => {
  db.close();
});

// --- DB layer: scheduled_sends ---

describe("recordScheduledSend", () => {
  test("stores a scheduled send with all fields", () => {
    recordScheduledSend(db, {
      emailId: "msg-100",
      sendAt: "2026-03-28_09:00",
      replyContent: "Thanks for reaching out.",
      recipient: "boss@example.com",
      subject: "Re: Project Update",
    });
    const rows = db.prepare("SELECT * FROM scheduled_sends WHERE email_id = ?").all("msg-100") as any[];
    expect(rows.length).toBe(1);
    expect(rows[0].email_id).toBe("msg-100");
    expect(rows[0].send_at).toBe("2026-03-28_09:00");
    expect(rows[0].reply_content).toBe("Thanks for reaching out.");
    expect(rows[0].recipient).toBe("boss@example.com");
    expect(rows[0].subject).toBe("Re: Project Update");
    expect(rows[0].status).toBe("pending");
    expect(rows[0].sent_at).toBeNull();
  });
});

describe("getDueSends", () => {
  test("returns pending sends where send_at <= now", () => {
    recordScheduledSend(db, {
      emailId: "msg-200",
      sendAt: "2026-03-28_09:00",
      replyContent: "Hello",
      recipient: "a@x.com",
      subject: "Re: Test",
    });
    recordScheduledSend(db, {
      emailId: "msg-201",
      sendAt: "2026-03-29_15:00",
      replyContent: "Goodbye",
      recipient: "b@x.com",
      subject: "Re: Later",
    });

    // Query at 2026-03-28_12:00 -- only msg-200 is due
    const due = getDueSends(db, "2026-03-28_12:00");
    expect(due.length).toBe(1);
    expect(due[0].emailId).toBe("msg-200");
    expect(due[0].replyContent).toBe("Hello");
  });

  test("returns nothing when no sends are due", () => {
    recordScheduledSend(db, {
      emailId: "msg-300",
      sendAt: "2026-04-01_08:00",
      replyContent: "Future",
      recipient: "c@x.com",
      subject: "Re: Future",
    });
    const due = getDueSends(db, "2026-03-28_12:00");
    expect(due.length).toBe(0);
  });

  test("excludes already-sent items", () => {
    recordScheduledSend(db, {
      emailId: "msg-400",
      sendAt: "2026-03-27_08:00",
      replyContent: "Already sent",
      recipient: "d@x.com",
      subject: "Re: Done",
    });
    markSendComplete(db, 1);
    const due = getDueSends(db, "2026-03-28_12:00");
    expect(due.length).toBe(0);
  });

  test("excludes failed items", () => {
    recordScheduledSend(db, {
      emailId: "msg-500",
      sendAt: "2026-03-27_08:00",
      replyContent: "Failed",
      recipient: "e@x.com",
      subject: "Re: Fail",
    });
    markSendFailed(db, 1);
    const due = getDueSends(db, "2026-03-28_12:00");
    expect(due.length).toBe(0);
  });
});

describe("markSendComplete", () => {
  test("updates status to sent and sets sent_at", () => {
    recordScheduledSend(db, {
      emailId: "msg-600",
      sendAt: "2026-03-28_09:00",
      replyContent: "Done",
      recipient: "f@x.com",
      subject: "Re: Complete",
    });
    markSendComplete(db, 1);
    const row = db.prepare("SELECT status, sent_at FROM scheduled_sends WHERE id = 1").get() as any;
    expect(row.status).toBe("sent");
    expect(row.sent_at).toBeTruthy();
  });
});

describe("markSendFailed", () => {
  test("updates status to failed", () => {
    recordScheduledSend(db, {
      emailId: "msg-700",
      sendAt: "2026-03-28_09:00",
      replyContent: "Broken",
      recipient: "g@x.com",
      subject: "Re: Error",
    });
    markSendFailed(db, 1);
    const row = db.prepare("SELECT status FROM scheduled_sends WHERE id = 1").get() as any;
    expect(row.status).toBe("failed");
  });
});

// --- SEND_AT parsing in execute-triage ---

describe("parseActionsCell with SEND_AT", () => {
  test("parses SEND_AT with datetime", () => {
    const result = parseActionsCell("SEND_AT:2026-03-28_09:00");
    expect(result).toEqual(["SEND_AT:2026-03-28_09:00"]);
  });

  test("parses SEND_AT combined with other actions", () => {
    const result = parseActionsCell("R, SEND_AT:2026-03-28_09:00");
    expect(result).toEqual(["R", "SEND_AT:2026-03-28_09:00"]);
  });
});

describe("buildExecutionPlan with SEND_AT", () => {
  test("counts SEND_AT in summary.sendLater", () => {
    const note = `---
date: 2026-03-27
status: pending
---
# Email Triage

## Instructions

## Stage 2: Action Required
#### \`20001\` colleague@work.com
**Project Update**
**Action:** [SEND_AT:2026-03-28_09:00]
**You:** Thanks for the update, will review tomorrow.

## Execution Log
`;
    const plan = buildExecutionPlan(note);
    expect(plan.summary.sendLater).toBe(1);
    const item = plan.actions.find(a => a.id === "20001");
    expect(item).toBeDefined();
    expect(item!.actionCodes).toContain("SEND_AT:2026-03-28_09:00");
  });
});

// --- File-based send package tests ---

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "send-later-pkg-"));
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const baseSendOpts = {
  recipient: "recipient-test@example.com",
  subject: "Re: Reference Letter for Dr. Example",
  body: "Hi Recipient,\n\nI'd be happy to provide a peer reference.\n\nBest,\nDr. Shah",
  account: "g",
  sendAt: "2026-04-07_08:00",
};

describe("createSendPackage", () => {
  test("creates JSON file in scheduled directory", () => {
    const pkg = createSendPackage(baseSendOpts, tmpDir);
    const jsonPath = join(tmpDir, `${pkg.id}.json`);
    expect(existsSync(jsonPath)).toBe(true);
  });

  test("JSON contains all required fields", () => {
    const pkg = createSendPackage(baseSendOpts, tmpDir);
    const data = JSON.parse(readFileSync(join(tmpDir, `${pkg.id}.json`), "utf-8"));
    expect(data.recipient).toBe("recipient-test@example.com");
    expect(data.subject).toBe("Re: Reference Letter for Dr. Example");
    expect(data.body).toContain("peer reference");
    expect(data.account).toBe("g");
    expect(data.sendAt).toBe("2026-04-07_08:00");
    expect(data.plistLabel).toContain("com.pai.send.");
    expect(data.createdAt).toBeTruthy();
  });

  test("generates unique IDs", () => {
    const pkg1 = createSendPackage(baseSendOpts, tmpDir);
    const pkg2 = createSendPackage(baseSendOpts, tmpDir);
    expect(pkg1.id).not.toBe(pkg2.id);
  });

  test("optional fields stored correctly", () => {
    const pkg = createSendPackage({
      ...baseSendOpts,
      inReplyTo: "msg-id-456@example.com",
      sourceEmailId: "87123",
    }, tmpDir);
    const data = JSON.parse(readFileSync(join(tmpDir, `${pkg.id}.json`), "utf-8"));
    expect(data.inReplyTo).toBe("msg-id-456@example.com");
    expect(data.sourceEmailId).toBe("87123");
  });

  test("defaults account to 'i' when not specified", () => {
    const pkg = createSendPackage({
      recipient: "test@test.com",
      subject: "Test",
      body: "Body",
      sendAt: "2026-04-07_08:00",
    }, tmpDir);
    const data = JSON.parse(readFileSync(join(tmpDir, `${pkg.id}.json`), "utf-8"));
    expect(data.account).toBe("i");
  });
});

describe("cancelScheduledSend", () => {
  test("removes JSON file", () => {
    const pkg = createSendPackage(baseSendOpts, tmpDir);
    const jsonPath = join(tmpDir, `${pkg.id}.json`);
    expect(existsSync(jsonPath)).toBe(true);
    const result = cancelScheduledSend(pkg.id, tmpDir);
    expect(result).toBe(true);
    expect(existsSync(jsonPath)).toBe(false);
  });

  test("returns false for non-existent send", () => {
    const result = cancelScheduledSend("send-nonexistent-1234", tmpDir);
    expect(result).toBe(false);
  });
});

describe("listPendingSends", () => {
  test("returns empty for empty directory", () => {
    const emptyDir = join(tmpDir, "empty-list");
    mkdirSync(emptyDir, { recursive: true });
    expect(listPendingSends(emptyDir)).toHaveLength(0);
  });

  test("lists pending sends sorted by sendAt", () => {
    const listDir = join(tmpDir, "list-test");
    mkdirSync(listDir, { recursive: true });
    createSendPackage({ ...baseSendOpts, sendAt: "2026-04-09_10:00" }, listDir);
    createSendPackage({ ...baseSendOpts, sendAt: "2026-04-07_08:00" }, listDir);
    createSendPackage({ ...baseSendOpts, sendAt: "2026-04-08_14:00" }, listDir);
    const sends = listPendingSends(listDir);
    expect(sends).toHaveLength(3);
    expect(sends[0].sendAt).toBe("2026-04-07_08:00");
    expect(sends[1].sendAt).toBe("2026-04-08_14:00");
    expect(sends[2].sendAt).toBe("2026-04-09_10:00");
  });

  test("excludes .failed.json files", () => {
    const failDir = join(tmpDir, "fail-exclude");
    mkdirSync(failDir, { recursive: true });
    const pkg = createSendPackage(baseSendOpts, failDir);
    renameSync(join(failDir, `${pkg.id}.json`), join(failDir, `${pkg.id}.failed.json`));
    expect(listPendingSends(failDir)).toHaveLength(0);
  });
});

describe("listFailedSends", () => {
  test("finds .failed.json files", () => {
    const failDir = join(tmpDir, "failed-list");
    mkdirSync(failDir, { recursive: true });
    const pkg = createSendPackage(baseSendOpts, failDir);
    renameSync(join(failDir, `${pkg.id}.json`), join(failDir, `${pkg.id}.failed.json`));
    const failed = listFailedSends(failDir);
    expect(failed).toHaveLength(1);
    expect(failed[0].id).toBe(pkg.id);
  });
});

describe("catchupOverdueSends", () => {
  test("dry run identifies overdue sends without sending", () => {
    const catchDir = join(tmpDir, "catchup-test");
    mkdirSync(catchDir, { recursive: true });
    mkdirSync(join(catchDir, "sent"), { recursive: true });
    createSendPackage({ ...baseSendOpts, sendAt: "2020-01-01_08:00" }, catchDir);
    const result = catchupOverdueSends(catchDir, true);
    expect(result.sent).toHaveLength(1);
    expect(result.failed).toHaveLength(0);
    // File still in place (dry run)
    expect(listPendingSends(catchDir)).toHaveLength(1);
  });

  test("skips future sends", () => {
    const futureDir = join(tmpDir, "catchup-future");
    mkdirSync(futureDir, { recursive: true });
    mkdirSync(join(futureDir, "sent"), { recursive: true });
    createSendPackage({ ...baseSendOpts, sendAt: "2099-12-31_23:59" }, futureDir);
    const result = catchupOverdueSends(futureDir, true);
    expect(result.sent).toHaveLength(0);
  });
});

describe("listSentSends", () => {
  test("finds files in sent/ subdirectory", () => {
    const sentTestDir = join(tmpDir, "sent-list-test");
    const sentSubDir = join(sentTestDir, "sent");
    mkdirSync(sentSubDir, { recursive: true });
    const pkg = createSendPackage(baseSendOpts, sentTestDir);
    renameSync(join(sentTestDir, `${pkg.id}.json`), join(sentSubDir, `${pkg.id}.json`));
    const sent = listSentSends(sentTestDir);
    expect(sent).toHaveLength(1);
    expect(sent[0].recipient).toBe("recipient-test@example.com");
  });
});

describe("cleanupOldSent", () => {
  test("removes old sent packages", () => {
    const cleanDir = join(tmpDir, "cleanup-test");
    const sentSubDir = join(cleanDir, "sent");
    mkdirSync(sentSubDir, { recursive: true });
    const oldPkg: SendPackage = {
      id: "send-old-1", recipient: "old@test.com", subject: "Old",
      body: "Old body", account: "i", sendAt: "2020-01-01_08:00",
      plistLabel: "com.pai.send.send-old-1", createdAt: "2020-01-01_08:00",
    };
    writeFileSync(join(sentSubDir, "send-old-1.json"), JSON.stringify(oldPkg));
    const removed = cleanupOldSent(30, cleanDir);
    expect(removed).toBe(1);
    expect(existsSync(join(sentSubDir, "send-old-1.json"))).toBe(false);
  });

  test("keeps recent sent packages", () => {
    const keepDir = join(tmpDir, "cleanup-keep");
    const sentSubDir = join(keepDir, "sent");
    mkdirSync(sentSubDir, { recursive: true });
    // Use a date 5 days before today so the 30-day cutoff keeps it regardless of when the test runs
    const recent = new Date();
    recent.setDate(recent.getDate() - 5);
    const recentDateStr = recent.toISOString().slice(0, 10) + "_08:00";
    const recentPkg: SendPackage = {
      id: "send-recent-1", recipient: "new@test.com", subject: "Recent",
      body: "Recent body", account: "i", sendAt: recentDateStr,
      plistLabel: "com.pai.send.send-recent-1", createdAt: recentDateStr,
    };
    writeFileSync(join(sentSubDir, "send-recent-1.json"), JSON.stringify(recentPkg));
    expect(cleanupOldSent(30, keepDir)).toBe(0);
    expect(existsSync(join(sentSubDir, "send-recent-1.json"))).toBe(true);
  });
});
