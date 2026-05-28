// ~/.claude/skills/EmailTriage/tests/rules-engine.test.ts
import { describe, test, expect } from "bun:test";
import { classifyEmail } from "../Tools/RulesEngine";
import type { ClassificationCache } from "../Tools/RulesEngine";
import type { RawEmail } from "../Tools/Types";

const makeEmail = (overrides: Partial<RawEmail>): RawEmail => ({
  id: "TEST001",
  subject: "Test Email",
  from: "sender@example.com",
  fromAddress: "sender@example.com",
  fromDomain: "example.com",
  date: "Mar 1",
  isRead: false,
  hasAttachment: false,
  snippet: "",
  account: "iCloud",
  ...overrides,
});

function makeCache(overrides?: Partial<ClassificationCache>): ClassificationCache {
  return {
    vipSenders: new Set(["vip-attorney@example.com", "vip-family@example.com"]),
    junkAddresses: new Set(["spammer@junksite.com"]),
    junkDomains: new Set(["wholejunkdomain.com"]),
    routingRules: [
      { id: 1, ruleType: "sender", matchValue: "receipts@stripe.com", action: "archive", folder: "Receipts", stop: true, addedAt: "", source: "seed" },
      { id: 2, ruleType: "domain", matchValue: "substack.com", action: "archive", folder: "Subscriptions", stop: true, addedAt: "", source: "seed" },
      { id: 3, ruleType: "domain", matchValue: "shortform.com", action: "archive", folder: "ShortForm", stop: true, addedAt: "", source: "seed" },
      { id: 4, ruleType: "subject", matchValue: "receipt", action: "archive", folder: "Receipts", stop: true, addedAt: "", source: "seed" },
      { id: 5, ruleType: "subject", matchValue: "statement is ready", action: "archive", folder: "Financial", stop: true, addedAt: "", source: "seed" },
    ],
    knownSenders: new Set(["sender@example.com"]),
    ...overrides,
  };
}

describe("classifyEmail - VIP", () => {
  test("VIP sender -> priority action, funnelStage vip", () => {
    const email = makeEmail({ fromAddress: "vip-attorney@example.com" });
    const result = classifyEmail(email, makeCache());
    expect(result.priority).toBe("action");
    expect(result.funnelStage).toBe("vip");
    expect(result.isVip).toBe(true);
    expect(result.matchedRule).toBe("vip");
  });
});

describe("classifyEmail - Junk", () => {
  test("junk by address -> priority trash", () => {
    const email = makeEmail({ fromAddress: "spammer@junksite.com" });
    const result = classifyEmail(email, makeCache());
    expect(result.priority).toBe("trash");
    expect(result.isJunk).toBe(true);
    expect(result.matchedRule).toContain("junk:address");
  });

  test("junk by domain -> priority trash", () => {
    const email = makeEmail({ fromAddress: "anyone@wholejunkdomain.com", fromDomain: "wholejunkdomain.com" });
    const result = classifyEmail(email, makeCache());
    expect(result.priority).toBe("trash");
    expect(result.isJunk).toBe(true);
    expect(result.matchedRule).toContain("junk:domain");
  });
});

describe("classifyEmail - Sender rules", () => {
  test("exact sender match -> archive with folder", () => {
    const email = makeEmail({ fromAddress: "receipts@stripe.com" });
    const result = classifyEmail(email, makeCache());
    expect(result.priority).toBe("archive");
    expect(result.folder).toBe("Receipts");
    expect(result.matchedRule).toContain("sender:");
  });
});

describe("classifyEmail - Domain rules", () => {
  test("domain match -> archive with folder", () => {
    const email = makeEmail({ fromAddress: "nate@substack.com", fromDomain: "substack.com" });
    const result = classifyEmail(email, makeCache());
    expect(result.priority).toBe("archive");
    expect(result.folder).toBe("Subscriptions");
    expect(result.matchedRule).toContain("domain:");
  });
});

describe("classifyEmail - Subject rules", () => {
  test("subject contains receipt -> archive", () => {
    const email = makeEmail({ subject: "Your receipt #1234" });
    const result = classifyEmail(email, makeCache());
    expect(result.priority).toBe("archive");
    expect(result.folder).toBe("Receipts");
    expect(result.matchedRule).toContain("subject:");
  });

  test("subject match is case-insensitive", () => {
    const email = makeEmail({ subject: "STATEMENT IS READY for March" });
    const result = classifyEmail(email, makeCache());
    expect(result.priority).toBe("archive");
    expect(result.folder).toBe("Financial");
  });
});

describe("classifyEmail - Unknown sender", () => {
  test("unknown sender -> priority unknown", () => {
    const email = makeEmail({ fromAddress: "newperson@company.com", fromDomain: "company.com" });
    const result = classifyEmail(email, makeCache({ knownSenders: new Set() }));
    expect(result.priority).toBe("unknown");
    expect(result.isUnknownSender).toBe(true);
  });

  test("known sender with no rule -> unknown priority but isUnknownSender false", () => {
    const email = makeEmail({ fromAddress: "known@company.com", fromDomain: "company.com" });
    const result = classifyEmail(email, makeCache({ knownSenders: new Set(["known@company.com"]) }));
    expect(result.priority).toBe("unknown");
    expect(result.isUnknownSender).toBe(false);
  });
});

describe("classifyEmail - Priority order", () => {
  test("VIP takes priority over domain rules", () => {
    const email = makeEmail({ fromAddress: "vip-attorney@example.com", fromDomain: "example.com" });
    const result = classifyEmail(email, makeCache());
    expect(result.isVip).toBe(true);
    expect(result.priority).toBe("action");
  });

  test("junk takes priority over sender rules", () => {
    const email = makeEmail({ fromAddress: "spammer@junksite.com" });
    const result = classifyEmail(email, makeCache());
    expect(result.isJunk).toBe(true);
    expect(result.priority).toBe("trash");
  });
});

describe("classifyEmail - DB-backed features", () => {
  test("adding VIP via cache makes classification recognize them", () => {
    const email = makeEmail({ fromAddress: "newvip@example.com" });
    const cache = makeCache({ vipSenders: new Set(["newvip@example.com"]) });
    const result = classifyEmail(email, cache);
    expect(result.isVip).toBe(true);
    expect(result.funnelStage).toBe("vip");
  });

  test("adding junk sender via cache flags them as junk", () => {
    const email = makeEmail({ fromAddress: "newjunk@spam.com", fromDomain: "spam.com" });
    const cache = makeCache({ junkAddresses: new Set(["newjunk@spam.com"]) });
    const result = classifyEmail(email, cache);
    expect(result.isJunk).toBe(true);
  });

  test("adding routing rule via cache routes matching email", () => {
    const email = makeEmail({ fromAddress: "nate@custom.com", fromDomain: "custom.com" });
    const cache = makeCache({
      routingRules: [
        { id: 99, ruleType: "domain", matchValue: "custom.com", action: "archive", folder: "Custom", stop: true, addedAt: "", source: "manual" },
      ],
    });
    const result = classifyEmail(email, cache);
    expect(result.folder).toBe("Custom");
    expect(result.priority).toBe("archive");
  });

  test("case-insensitive VIP matching", () => {
    const email = makeEmail({ fromAddress: "VIP@EXAMPLE.COM" });
    const cache = makeCache({ vipSenders: new Set(["vip@example.com"]) });
    const result = classifyEmail(email, cache);
    expect(result.isVip).toBe(true);
  });

  test("case-insensitive junk domain matching", () => {
    const email = makeEmail({ fromAddress: "anyone@JUNKDOMAIN.COM", fromDomain: "JUNKDOMAIN.COM" });
    const cache = makeCache({ junkDomains: new Set(["junkdomain.com"]) });
    const result = classifyEmail(email, cache);
    expect(result.isJunk).toBe(true);
  });
});
