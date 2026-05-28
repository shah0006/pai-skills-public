// tests/ai-classifier.test.ts — TDD tests for AI classifier module (funnel stage version)
import { describe, test, expect, mock, beforeEach } from "bun:test";
import type { RawEmail } from "../Tools/Types";

import {
  buildClassificationPrompt,
  parseAIClassificationResponse,
  batchClassifyEmails,
  actionTypeToFunnelStage,
  actionTypeToPriority,
  type AIClassificationResult,
} from "../Tools/AiClassifier";

// ── Test fixtures ──────────────────────────────────────────────

function makeEmail(overrides: Partial<RawEmail> = {}): RawEmail {
  return {
    id: "test-001",
    subject: "Test Subject",
    from: "Test User <test@example.com>",
    fromAddress: "test@example.com",
    fromDomain: "example.com",
    date: "2026-03-01",
    isRead: false,
    hasAttachment: false,
    snippet: "This is a test email body snippet.",
    account: "iCloud",
    ...overrides,
  };
}

const sampleEmails: RawEmail[] = [
  makeEmail({ id: "e1", from: "Alice <alice@work.com>", fromAddress: "alice@work.com", subject: "Q1 Budget Review" }),
  makeEmail({ id: "e2", from: "Bob <bob@vendor.com>", fromAddress: "bob@vendor.com", subject: "Invoice #4521" }),
  makeEmail({ id: "e3", from: "news@substack.com", fromAddress: "news@substack.com", subject: "Weekly Digest" }),
];

// ── actionTypeToFunnelStage mapping tests ─────────────────────

describe("actionTypeToFunnelStage", () => {
  test("reply_needed → action", () => expect(actionTypeToFunnelStage("reply_needed")).toBe("action"));
  test("decision_needed → action", () => expect(actionTypeToFunnelStage("decision_needed")).toBe("action"));
  test("deadline → action", () => expect(actionTypeToFunnelStage("deadline")).toBe("action"));
  test("financial → financial", () => expect(actionTypeToFunnelStage("financial")).toBe("financial"));
  test("document_review → financial", () => expect(actionTypeToFunnelStage("document_review")).toBe("financial"));
  test("educational → informational", () => expect(actionTypeToFunnelStage("educational")).toBe("informational"));
  test("newsletter → informational", () => expect(actionTypeToFunnelStage("newsletter")).toBe("informational"));
  test("marketing → bulk_dispose", () => expect(actionTypeToFunnelStage("marketing")).toBe("bulk_dispose"));
  test("transactional → bulk_dispose", () => expect(actionTypeToFunnelStage("transactional")).toBe("bulk_dispose"));
  test("junk → auto_processed", () => expect(actionTypeToFunnelStage("junk")).toBe("auto_processed"));
});

// ── actionTypeToPriority mapping tests ────────────────────────

describe("actionTypeToPriority", () => {
  test("reply_needed → action", () => expect(actionTypeToPriority("reply_needed")).toBe("action"));
  test("financial → review", () => expect(actionTypeToPriority("financial")).toBe("review"));
  test("newsletter → review", () => expect(actionTypeToPriority("newsletter")).toBe("review"));
  test("marketing → archive", () => expect(actionTypeToPriority("marketing")).toBe("archive"));
  test("junk → trash", () => expect(actionTypeToPriority("junk")).toBe("trash"));
});

// ── buildClassificationPrompt tests ────────────────────────────

describe("buildClassificationPrompt", () => {
  test("includes all email IDs in the prompt", () => {
    const prompt = buildClassificationPrompt(sampleEmails);
    expect(prompt).toContain('"e1"');
    expect(prompt).toContain('"e2"');
    expect(prompt).toContain('"e3"');
  });

  test("includes from and subject for each email", () => {
    const prompt = buildClassificationPrompt(sampleEmails);
    expect(prompt).toContain("alice@work.com");
    expect(prompt).toContain("Q1 Budget Review");
  });

  test("includes 10-category type instructions", () => {
    const prompt = buildClassificationPrompt(sampleEmails);
    expect(prompt).toContain("reply_needed");
    expect(prompt).toContain("decision_needed");
    expect(prompt).toContain("deadline");
    expect(prompt).toContain("financial");
    expect(prompt).toContain("document_review");
    expect(prompt).toContain("educational");
    expect(prompt).toContain("newsletter");
    expect(prompt).toContain("marketing");
    expect(prompt).toContain("transactional");
    expect(prompt).toContain("junk");
  });

  test("truncates snippet to 200 chars", () => {
    const longSnippet = "A".repeat(300);
    const email = makeEmail({ id: "long", snippet: longSnippet });
    const prompt = buildClassificationPrompt([email]);
    expect(prompt).not.toContain(longSnippet);
    expect(prompt).toContain("A".repeat(200));
  });

  test("handles empty email array", () => {
    const prompt = buildClassificationPrompt([]);
    expect(prompt).toContain("[]");
  });
});

// ── parseAIClassificationResponse tests ────────────────────────

describe("parseAIClassificationResponse", () => {
  test("correctly parses valid JSON array response into Map", () => {
    const response = JSON.stringify([
      { id: "e1", type: "reply_needed", reason: "Budget review needs approval", isUnsub: false },
      { id: "e2", type: "financial", reason: "Routine invoice", isUnsub: false },
      { id: "e3", type: "newsletter", reason: "Newsletter digest", isUnsub: true },
    ]);
    const results = parseAIClassificationResponse(response);
    expect(results.size).toBe(3);
    expect(results.get("e1")?.aiActionType).toBe("reply_needed");
    expect(results.get("e1")?.funnelStage).toBe("action");
    expect(results.get("e2")?.aiActionType).toBe("financial");
    expect(results.get("e2")?.funnelStage).toBe("financial");
    expect(results.get("e3")?.isUnsub).toBe(true);
    expect(results.get("e3")?.funnelStage).toBe("informational");
  });

  test("strips markdown code fences before parsing", () => {
    const response = '```json\n[{"id":"e1","type":"newsletter","reason":"Needs reading","isUnsub":false}]\n```';
    const results = parseAIClassificationResponse(response);
    expect(results.size).toBe(1);
    expect(results.get("e1")?.aiActionType).toBe("newsletter");
  });

  test("handles malformed JSON gracefully — returns empty map", () => {
    const results = parseAIClassificationResponse("This is not JSON at all");
    expect(results.size).toBe(0);
  });

  test("handles empty string — returns empty map", () => {
    const results = parseAIClassificationResponse("");
    expect(results.size).toBe(0);
  });

  test("truncates reason to 60 chars", () => {
    const longReason = "R".repeat(80);
    const response = JSON.stringify([
      { id: "e1", type: "newsletter", reason: longReason, isUnsub: false },
    ]);
    const results = parseAIClassificationResponse(response);
    expect(results.get("e1")!.reason.length).toBeLessThanOrEqual(80);
  });

  test("filters out items with invalid type values", () => {
    const response = JSON.stringify([
      { id: "e1", type: "reply_needed", reason: "Good" },
      { id: "e2", type: "invalid_value", reason: "Bad type" },
      { id: "e3", type: "junk", reason: "Good too" },
    ]);
    const results = parseAIClassificationResponse(response);
    expect(results.size).toBe(2);
    expect(results.has("e1")).toBe(true);
    expect(results.has("e2")).toBe(false);
    expect(results.has("e3")).toBe(true);
  });
});

// ── batchClassifyEmails tests (mocked fetch) ──────────────

// Mock global fetch for API calls
const originalFetch = globalThis.fetch;

function mockFetchResponse(body: unknown, ok = true) {
  return mock(() =>
    Promise.resolve({
      ok,
      status: ok ? 200 : 500,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    } as Response),
  );
}

describe("batchClassifyEmails", () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "test-key";
  });

  test("returns map keyed by email ID with funnel stages", async () => {
    const aiResponseText = JSON.stringify([
      { id: "e1", type: "reply_needed", reason: "Budget review", isUnsub: false },
      { id: "e2", type: "financial", reason: "Routine invoice", isUnsub: false },
      { id: "e3", type: "newsletter", reason: "Newsletter", isUnsub: true },
    ]);

    globalThis.fetch = mockFetchResponse({
      content: [{ type: "text", text: aiResponseText }],
    });

    const results = await batchClassifyEmails(sampleEmails);
    expect(results.size).toBe(3);
    expect(results.get("e1")?.funnelStage).toBe("action");
    expect(results.get("e2")?.funnelStage).toBe("financial");
    expect(results.get("e3")?.funnelStage).toBe("informational");
    expect(results.get("e3")?.isUnsub).toBe(true);

    globalThis.fetch = originalFetch;
  });

  test("returns fallback when AI is unavailable", async () => {
    globalThis.fetch = mockFetchResponse({ error: "timeout" }, false);

    const results = await batchClassifyEmails(sampleEmails);
    expect(results.size).toBe(3);
    for (const [_id, result] of results) {
      expect(result.funnelStage).toBe("bulk_dispose");
      expect(result.reason).toBe("AI unavailable");
    }

    globalThis.fetch = originalFetch;
  });

  test("handles empty email array", async () => {
    const results = await batchClassifyEmails([]);
    expect(results.size).toBe(0);
  });

  test("classify-only: no reply drafts in result (caller handles drafts)", async () => {
    const aiResponseText = JSON.stringify([
      { id: "e1", type: "reply_needed", reason: "Needs reply", isUnsub: false },
      { id: "e2", type: "junk", reason: "Junk mail", isUnsub: false },
      { id: "e3", type: "newsletter", reason: "Newsletter", isUnsub: true },
    ]);

    globalThis.fetch = mockFetchResponse({
      content: [{ type: "text", text: aiResponseText }],
    });

    const results = await batchClassifyEmails(sampleEmails);

    // batchClassifyEmails no longer generates drafts — caller does
    expect(results.get("e1")?.replyDraft).toBeUndefined();
    expect(results.get("e2")?.replyDraft).toBeUndefined();
    expect(results.get("e3")?.replyDraft).toBeUndefined();

    // But classification should be correct
    expect(results.get("e1")?.funnelStage).toBe("action");
    expect(results.get("e2")?.funnelStage).toBe("auto_processed");
    expect(results.get("e3")?.funnelStage).toBe("informational");

    globalThis.fetch = originalFetch;
  });
});
