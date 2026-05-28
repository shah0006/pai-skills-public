// tests/cross-account-threads.test.ts — Phase 24 cross-account merging.
import { describe, test, expect } from "bun:test";
import { findCrossAccountThreads, normalizeSubject } from "../Tools/CrossAccountThreads";

describe("normalizeSubject", () => {
  test("strips Re: / Fwd: / FW: prefix chains", () => {
    expect(normalizeSubject("Re: Q3 review")).toBe("q3 review");
    expect(normalizeSubject("RE: RE: Q3 review")).toBe("q3 review");
    expect(normalizeSubject("Fwd: Q3 review")).toBe("q3 review");
    expect(normalizeSubject("FW: Q3 review")).toBe("q3 review");
    expect(normalizeSubject("Re: FW: Q3 review")).toBe("q3 review");
  });

  test("strips [EXTERNAL] tag", () => {
    expect(normalizeSubject("[EXTERNAL] Q3 review")).toBe("q3 review");
    expect(normalizeSubject("Re: [External] Q3 review")).toBe("q3 review");
  });

  test("collapses whitespace + lowercases", () => {
    expect(normalizeSubject("  Q3   Review  ")).toBe("q3 review");
  });
});

describe("findCrossAccountThreads", () => {
  test("same subject across two accounts is a thread", () => {
    const threads = findCrossAccountThreads([
      { emailId: "g1", account: "g", subject: "Q3 review", fromAddress: "a@x.test", date: "2026-05-15" },
      { emailId: "i1", account: "i", subject: "Re: Q3 review", fromAddress: "b@x.test", date: "2026-05-16" },
    ]);
    expect(threads).toHaveLength(1);
    expect(threads[0].emails).toHaveLength(2);
    expect(threads[0].accountsTouched).toEqual(["g", "i"]);
  });

  test("same subject in only ONE account → not a cross-account thread", () => {
    const threads = findCrossAccountThreads([
      { emailId: "g1", account: "g", subject: "Q3 review", fromAddress: "a@x.test", date: "2026-05-15" },
      { emailId: "g2", account: "g", subject: "Re: Q3 review", fromAddress: "b@x.test", date: "2026-05-16" },
    ]);
    expect(threads).toHaveLength(0);
  });

  test("multiple cross-account threads sorted by size descending", () => {
    const threads = findCrossAccountThreads([
      // Big thread (3 emails, both accounts)
      { emailId: "g1", account: "g", subject: "Big project", fromAddress: "a@x.test", date: "2026-05-15" },
      { emailId: "g2", account: "g", subject: "Re: Big project", fromAddress: "b@x.test", date: "2026-05-16" },
      { emailId: "i1", account: "i", subject: "Re: Re: Big project", fromAddress: "c@x.test", date: "2026-05-17" },
      // Smaller thread (2 emails, both accounts)
      { emailId: "g3", account: "g", subject: "Small thread", fromAddress: "d@x.test", date: "2026-05-15" },
      { emailId: "i2", account: "i", subject: "Re: Small thread", fromAddress: "e@x.test", date: "2026-05-16" },
    ]);
    expect(threads).toHaveLength(2);
    expect(threads[0].emails).toHaveLength(3);
    expect(threads[1].emails).toHaveLength(2);
  });

  test("emails within a thread are sorted by date (oldest first)", () => {
    const threads = findCrossAccountThreads([
      { emailId: "g1", account: "g", subject: "Q3 plan", fromAddress: "a@x.test", date: "2026-05-17" },  // newest
      { emailId: "g2", account: "g", subject: "Re: Q3 plan", fromAddress: "b@x.test", date: "2026-05-15" },  // oldest
      { emailId: "i1", account: "i", subject: "Re: Re: Q3 plan", fromAddress: "c@x.test", date: "2026-05-16" },
    ]);
    expect(threads[0].emails.map(e => e.emailId)).toEqual(["g2", "i1", "g1"]);
  });

  test("empty subjects are filtered out", () => {
    const threads = findCrossAccountThreads([
      { emailId: "g1", account: "g", subject: "", fromAddress: "a@x.test", date: "2026-05-15" },
      { emailId: "i1", account: "i", subject: "", fromAddress: "b@x.test", date: "2026-05-16" },
    ]);
    expect(threads).toHaveLength(0);
  });

  test("Message-ID join (Phase 24 v1) wins over subject mismatch", () => {
    // Same Message-ID across two accounts, but DIFFERENT subjects (e.g.
    // forward with subject rewrite) — Message-ID should still cluster them.
    const threads = findCrossAccountThreads([
      { emailId: "g1", account: "g", subject: "Forwarded: weird subject", fromAddress: "a@x.test", date: "2026-05-15", messageId: "abc123@host.test" },
      { emailId: "i1", account: "i", subject: "Original subject line",    fromAddress: "b@x.test", date: "2026-05-16", messageId: "abc123@host.test" },
    ]);
    expect(threads).toHaveLength(1);
    expect(threads[0].emails).toHaveLength(2);
    expect(threads[0].accountsTouched).toEqual(["g", "i"]);
  });

  test("Message-ID join is case-insensitive", () => {
    const threads = findCrossAccountThreads([
      { emailId: "g1", account: "g", subject: "subj a", fromAddress: "a@x.test", date: "2026-05-15", messageId: "ABC@HOST.test" },
      { emailId: "i1", account: "i", subject: "subj b", fromAddress: "b@x.test", date: "2026-05-16", messageId: "abc@host.TEST" },
    ]);
    expect(threads).toHaveLength(1);
  });

  test("Message-ID-matched emails don't double-count in subject layer", () => {
    // Two emails matched by Message-ID; a third email has subject matching
    // one of them. Without de-dup the third would form a 2-email subject-thread
    // including the already-claimed email.
    const threads = findCrossAccountThreads([
      { emailId: "g1", account: "g", subject: "Q3 plan", fromAddress: "a@x.test", date: "2026-05-15", messageId: "msg1@h.test" },
      { emailId: "i1", account: "i", subject: "Q3 plan", fromAddress: "b@x.test", date: "2026-05-16", messageId: "msg1@h.test" },
      { emailId: "i2", account: "i", subject: "Re: Q3 plan", fromAddress: "c@x.test", date: "2026-05-17" },
    ]);
    // Layer 1: { g1, i1 } via msg1
    // Layer 2: i2 alone has subject "q3 plan" but it's the only one not claimed → no thread
    expect(threads).toHaveLength(1);
    expect(threads[0].emails.map(e => e.emailId).sort()).toEqual(["g1", "i1"]);
  });

  test("very short subjects (< 4 chars) are filtered out as noise", () => {
    const threads = findCrossAccountThreads([
      { emailId: "g1", account: "g", subject: "Hi", fromAddress: "a@x.test", date: "2026-05-15" },
      { emailId: "i1", account: "i", subject: "Re: Hi", fromAddress: "b@x.test", date: "2026-05-16" },
    ]);
    expect(threads).toHaveLength(0);
  });
});
