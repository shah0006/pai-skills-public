// tests/new-api.test.ts — coverage for the Phase 22/23/24 API routes
// shipped overnight 2026-05-18 → 2026-05-19. Route-level smoke + shape tests.
import { describe, test, expect } from "bun:test";

// ─── POST /api/sender/history ─────────────────────────────────────────────
describe("POST /api/sender/history (read-only)", () => {
  test("400 when neither address nor domain supplied", async () => {
    const { GET } = await import("../app/api/sender/history/route");
    const req = new Request("http://localhost:9988/api/sender/history");
    const res = await GET(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("required");
  });

  test("returns history shape for unknown address", async () => {
    const { GET } = await import("../app/api/sender/history/route");
    const req = new Request("http://localhost:9988/api/sender/history?address=nobody@unknown.test");
    const res = await GET(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.address).toBeDefined();
    expect(data.address.totalSeen).toBe(0);
  });
});

// ─── POST /api/sender/rule ─────────────────────────────────────────────
describe("POST /api/sender/rule", () => {
  test("400 when action missing", async () => {
    const { POST } = await import("../app/api/sender/rule/route");
    const req = new Request("http://localhost:9988/api/sender/rule", {
      method: "POST",
      body: JSON.stringify({ address: "x@x.test" }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  test("400 when action is non-recognized", async () => {
    const { POST } = await import("../app/api/sender/rule/route");
    const req = new Request("http://localhost:9988/api/sender/rule", {
      method: "POST",
      body: JSON.stringify({ address: "x@x.test", action: "nonsense" }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});

// ─── POST /api/sender/batch-history ─────────────────────────────────────────────
describe("POST /api/sender/batch-history", () => {
  test("400 when senders missing", async () => {
    const { POST } = await import("../app/api/sender/batch-history/route");
    const req = new Request("http://localhost:9988/api/sender/batch-history", {
      method: "POST", body: JSON.stringify({}), headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  test("returns results array matching input length", async () => {
    const { POST } = await import("../app/api/sender/batch-history/route");
    const req = new Request("http://localhost:9988/api/sender/batch-history", {
      method: "POST",
      body: JSON.stringify({ senders: [{ address: "a@b.test" }, { address: "c@d.test" }] }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.results).toBeArray();
    expect(data.results).toHaveLength(2);
  });
});

// ─── POST /api/calendar/suggest ─────────────────────────────────────────────
describe("POST /api/calendar/suggest", () => {
  test("returns suggestion for meeting-cue email", async () => {
    const { POST } = await import("../app/api/calendar/suggest/route");
    const req = new Request("http://localhost:9988/api/calendar/suggest", {
      method: "POST",
      body: JSON.stringify({ subject: "Quick call Tuesday", body: "Are you free at 2pm?" }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.suggestion).toBeDefined();
    expect(data.suggestion.confidence).toBeGreaterThan(0);
  });

  test("returns suggestion: null for receipt-style email", async () => {
    const { POST } = await import("../app/api/calendar/suggest/route");
    const req = new Request("http://localhost:9988/api/calendar/suggest", {
      method: "POST",
      body: JSON.stringify({ subject: "Your receipt", body: "Paid $42.50." }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req);
    const data = await res.json();
    expect(data.suggestion).toBeNull();
  });
});

// ─── POST /api/threads/cross-account ─────────────────────────────────────────────
describe("POST /api/threads/cross-account", () => {
  test("400 when emails missing", async () => {
    const { POST } = await import("../app/api/threads/cross-account/route");
    const req = new Request("http://localhost:9988/api/threads/cross-account", {
      method: "POST", body: JSON.stringify({}), headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  test("identifies a cross-account thread", async () => {
    const { POST } = await import("../app/api/threads/cross-account/route");
    const req = new Request("http://localhost:9988/api/threads/cross-account", {
      method: "POST",
      body: JSON.stringify({
        emails: [
          { emailId: "g1", account: "g", subject: "Q3 plan", fromAddress: "a@x.test", date: "2026-05-15" },
          { emailId: "i1", account: "i", subject: "Re: Q3 plan", fromAddress: "b@x.test", date: "2026-05-16" },
        ],
      }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.threads).toHaveLength(1);
    expect(data.threads[0].emails).toHaveLength(2);
  });
});

// ─── POST /api/draft/from-voice ─────────────────────────────────────────────
describe("POST /api/draft/from-voice", () => {
  test("400 on missing recipient", async () => {
    const { POST } = await import("../app/api/draft/from-voice/route");
    const req = new Request("http://localhost:9988/api/draft/from-voice", {
      method: "POST",
      body: JSON.stringify({ subject: "s", transcript: "t" }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  test("400 on missing subject", async () => {
    const { POST } = await import("../app/api/draft/from-voice/route");
    const req = new Request("http://localhost:9988/api/draft/from-voice", {
      method: "POST",
      body: JSON.stringify({ recipient: "r", transcript: "t" }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});

// ─── GET /api/rules ─────────────────────────────────────────────
describe("GET /api/rules", () => {
  test("returns routing/vip/junk structure", async () => {
    const { GET } = await import("../app/api/rules/route");
    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.routingRules).toBeArray();
    expect(data.vipSenders).toBeArray();
    expect(data.junkAddresses).toBeArray();
    expect(data.summary.routing).toBeNumber();
  });
});
