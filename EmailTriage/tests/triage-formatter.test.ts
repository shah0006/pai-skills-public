// ~/.claude/skills/EmailTriage/tests/triage-formatter.test.ts
import { describe, test, expect } from "bun:test";
import { formatTriageNote, formatToNewYorkTimestamp } from "../Tools/TriageFormatter";
import type { TriageSession, ClassifiedEmail, FunnelStage } from "../Tools/Types";

const makeClassified = (overrides: Partial<ClassifiedEmail>): ClassifiedEmail => ({
  id: "99001",
  subject: "Test Email",
  from: "Sender <sender@example.com>",
  fromAddress: "sender@example.com",
  fromDomain: "example.com",
  date: "Mar 1",
  isRead: false,
  hasAttachment: false,
  snippet: "",
  account: "iCloud",
  priority: "review",
  funnelStage: "informational",
  matchedRule: null,
  folder: null,
  replyDraft: null,
  isVip: false,
  isJunk: false,
  isUnknownSender: false,
  ...overrides,
});

const makeSession = (emails: ClassifiedEmail[], overrides?: Partial<TriageSession>): TriageSession => ({
  date: "2026-03-01",
  generatedAt: "2026-03-01T07:40:00-05:00",
  total: emails.length,
  inboxTotal: null,
  unread: emails.filter(e => !e.isRead).length,
  emails,
  estimatedMinutes: Math.max(2, Math.ceil(emails.length * 0.4)),
  ...overrides,
});

describe("formatTriageNote", () => {
  test("generates valid YAML frontmatter", () => {
    const note = formatTriageNote(makeSession([]));
    expect(note).toContain("document-type: email-triage");
    expect(note).toContain("status: pending");
    expect(note).toContain("date: 2026-03-01");
  });

  test("includes Instructions section", () => {
    const note = formatTriageNote(makeSession([]));
    expect(note).toContain("## Instructions");
  });

  // ── Funnel stage sections ──

  test("Stage 1 VIP section shows VIP email in mini-block format", () => {
    const emails = [makeClassified({
      id: "101", priority: "action", funnelStage: "vip", isVip: true,
      subject: "Urgent Matter", fromAddress: "boss@firm.com", replyDraft: "I'll handle it.",
    })];
    const note = formatTriageNote(makeSession(emails));
    expect(note).toContain("## [] Stage 1: VIP");
    // Mini-block format: #### `ID` sender
    expect(note).toContain("#### `101` boss@firm.com");
    expect(note).toContain("[VIP]");
    expect(note).toContain("-- Mar");  // date included in heading
    expect(note).toContain("**Urgent Matter**");
    expect(note).toContain("**Draft reply:**");
    expect(note).toContain("**Action:** [R]");
    expect(note).toContain("**You:**");
  });

  test("Stage 2 Action Required shows action emails in mini-block format", () => {
    const emails = [makeClassified({
      id: "102", priority: "action", funnelStage: "action",
      subject: "Reply Needed", aiSummary: "Needs your response by Friday",
    })];
    const note = formatTriageNote(makeSession(emails));
    expect(note).toContain("## [] Stage 2: Action Required");
    expect(note).toContain("#### `102`");
    expect(note).toContain("**Reply Needed**");
    expect(note).toContain("*AI: Needs your response by Friday*");
    expect(note).toContain("**Action:** [R]");
  });

  test("Stage 3 Financial shows financial emails in compact table", () => {
    const emails = [makeClassified({
      id: "103", priority: "review", funnelStage: "financial",
      subject: "Your Invoice", aiSummary: "Invoice for March services",
    })];
    const note = formatTriageNote(makeSession(emails));
    expect(note).toContain("## [] Stage 3: Financial & Documents");
    expect(note).toContain("| ID | Date | Sender | Type | Vendor | Amount | Subject | 📎 | Action | Archive To | You |");
    expect(note).toContain("| 103 [i] |");
  });

  test("Stage 4 Informational shows educational and newsletter emails in compact table", () => {
    const emails = [makeClassified({
      id: "104", priority: "review", funnelStage: "informational",
      subject: "CME Update",
    })];
    const note = formatTriageNote(makeSession(emails));
    expect(note).toContain("## [] Stage 4: Informational");
    expect(note).toContain("| 104 [i] |");
    expect(note).toContain("| Date |");
    expect(note).toContain("| Archive To |");
  });

  test("Stage 5 Bulk Dispose uses table with action columns", () => {
    const emails = [makeClassified({
      id: "105", priority: "archive", funnelStage: "bulk_dispose",
      matchedRule: "ai:marketing",
    })];
    const note = formatTriageNote(makeSession(emails));
    expect(note).toContain("## [] Stage 5: Bulk Dispose");
    expect(note).toContain("| ID | Sender | Subject | 📎 | Archive To | A | T | J | U | BD | BS | You |");
    expect(note).toContain("| 105 [i] |");
  });

  test("Stage 6 Auto-Processed uses table format", () => {
    const emails = [makeClassified({
      id: "106", priority: "trash", funnelStage: "auto_processed",
      isJunk: true, matchedRule: "junk:address",
    })];
    const note = formatTriageNote(makeSession(emails));
    expect(note).toContain("## [] Stage 6: Auto-Processed");
    expect(note).toContain("| ID | Sender | Subject | 📎 | Rule | Archive To | A | T | K | J | U | BD | BS | You |");
    expect(note).toContain("| 106 [i] |");
  });

  // ── Cross-cutting features ──

  test("[NEW] badge appears for unknown senders", () => {
    const emails = [makeClassified({
      id: "107", priority: "review", funnelStage: "informational",
      isUnknownSender: true,
    })];
    const note = formatTriageNote(makeSession(emails));
    expect(note).toContain("`[NEW]`");
  });

  test("reply drafts appear inline in VIP mini-blocks", () => {
    const emails = [makeClassified({
      id: "101", priority: "action", funnelStage: "vip", isVip: true,
      replyDraft: "Thank you for reaching out.",
    })];
    const note = formatTriageNote(makeSession(emails));
    expect(note).toContain("**Draft reply:** Thank you for reaching out.");
  });

  test("header shows counts and estimate", () => {
    const emails = [
      makeClassified({ isRead: false, funnelStage: "vip" }),
      makeClassified({ id: "200", isRead: true, funnelStage: "informational" }),
    ];
    const note = formatTriageNote(makeSession(emails));
    expect(note).toContain("2 emails");
    expect(note).toContain("1 unread");
    expect(note).toContain("need review");
  });

  test("header includes per-stage breakdown line", () => {
    const emails = [
      makeClassified({ id: "1", funnelStage: "vip", isVip: true }),
      makeClassified({ id: "2", funnelStage: "action" }),
      makeClassified({ id: "3", funnelStage: "action" }),
      makeClassified({ id: "4", funnelStage: "financial" }),
      makeClassified({ id: "5", funnelStage: "informational" }),
      makeClassified({ id: "6", funnelStage: "bulk_dispose", matchedRule: "ai:marketing" }),
      makeClassified({ id: "7", funnelStage: "bulk_dispose", matchedRule: "ai:promo" }),
      makeClassified({ id: "8", funnelStage: "auto_processed", matchedRule: "junk:x" }),
    ];
    const note = formatTriageNote(makeSession(emails));
    expect(note).toContain("1 VIP | 2 Action | 1 Financial | 1 Info | 2 Bulk | 1 Auto-processed");
  });

  test("per-stage breakdown includes follow-up due when present", () => {
    const emails = [
      makeClassified({ id: "1", funnelStage: "vip", isVip: true }),
      makeClassified({ id: "2", funnelStage: "follow_up_due" }),
    ];
    const note = formatTriageNote(makeSession(emails));
    expect(note).toContain("| 1 Follow-up Due");
  });

  test("per-stage breakdown omits follow-up due when zero", () => {
    const emails = [
      makeClassified({ id: "1", funnelStage: "vip", isVip: true }),
    ];
    const note = formatTriageNote(makeSession(emails));
    expect(note).not.toContain("Follow-up Due");
  });

  test("Triage Overview table present with stage counts", () => {
    const emails = [
      makeClassified({ id: "1", funnelStage: "vip", isVip: true }),
      makeClassified({ id: "2", funnelStage: "action" }),
      makeClassified({ id: "3", funnelStage: "financial" }),
      makeClassified({ id: "4", funnelStage: "informational" }),
      makeClassified({ id: "5", funnelStage: "bulk_dispose", matchedRule: "ai:x" }),
      makeClassified({ id: "6", funnelStage: "auto_processed", matchedRule: "junk:x" }),
    ];
    const note = formatTriageNote(makeSession(emails));
    expect(note).toContain("## Triage Overview");
    expect(note).toContain("| VIP | 1 | |");
    expect(note).toContain("| Action Required | 1 | |");
    expect(note).toContain("| Financial | 1 | |");
    expect(note).toContain("| Informational | 1 | |");
    expect(note).toContain("| Bulk Dispose | 1 | |");
    expect(note).toContain("| Auto-Processed | 1 | |");
    expect(note).toContain("| **Total** | **6** | **4 need review** |");
  });

  test("Triage Overview includes Follow-Up Due when present", () => {
    const emails = [
      makeClassified({ id: "1", funnelStage: "follow_up_due" }),
      makeClassified({ id: "2", funnelStage: "vip", isVip: true }),
    ];
    const note = formatTriageNote(makeSession(emails));
    expect(note).toContain("| Follow-Up Due | 1 | |");
  });

  test("Triage Overview omits Follow-Up Due row when zero", () => {
    const emails = [
      makeClassified({ id: "1", funnelStage: "vip", isVip: true }),
    ];
    const note = formatTriageNote(makeSession(emails));
    expect(note).not.toContain("Follow-Up Due |");
  });

  test("Execution Log section present", () => {
    const note = formatTriageNote(makeSession([]));
    expect(note).toContain("## Execution Log");
  });

  test("multiple emails sort into correct funnel stages", () => {
    const emails = [
      makeClassified({ id: "1", priority: "action", funnelStage: "vip", isVip: true }),
      makeClassified({ id: "2", priority: "action", funnelStage: "action" }),
      makeClassified({ id: "3", priority: "review", funnelStage: "financial" }),
      makeClassified({ id: "4", priority: "review", funnelStage: "informational" }),
      makeClassified({ id: "5", priority: "archive", funnelStage: "bulk_dispose", matchedRule: "ai:marketing" }),
      makeClassified({ id: "6", priority: "trash", funnelStage: "auto_processed", isJunk: true, matchedRule: "junk:address" }),
    ];
    const note = formatTriageNote(makeSession(emails));
    // VIP/Action use mini-blocks
    expect(note).toContain("#### `1`");
    expect(note).toContain("#### `2`");
    // Financial/Informational use compact tables
    expect(note).toContain("| 3 [i] |");
    expect(note).toContain("| 4 [i] |");
    // Stage 5 uses table format
    expect(note).toContain("| 5 [i] |");
    // Stage 6 uses table format
    expect(note).toContain("| 6 [i] |");
  });

  // ── message:// clickable links ──

  test("VIP email with messageId renders clickable link in mini-block heading", () => {
    const emails = [makeClassified({
      id: "101", priority: "action", funnelStage: "vip", isVip: true,
      subject: "Urgent", fromAddress: "boss@firm.com",
      messageId: "abc123@mail.firm.com",
    })];
    const note = formatTriageNote(makeSession(emails));
    // Should contain markdown link with message:// URL
    expect(note).toContain("[101](message://%3Cabc123%40mail.firm.com%3E)");
    // Should NOT contain backtick-wrapped ID
    expect(note).not.toContain("`101`");
  });

  test("action email with messageId renders clickable link", () => {
    const emails = [makeClassified({
      id: "102", priority: "action", funnelStage: "action",
      subject: "Reply Needed",
      messageId: "def456@example.com",
    })];
    const note = formatTriageNote(makeSession(emails));
    expect(note).toContain("[102](message://%3Cdef456%40example.com%3E)");
  });

  test("financial email with messageId renders clickable link in table", () => {
    const emails = [makeClassified({
      id: "103", priority: "review", funnelStage: "financial",
      subject: "Invoice",
      messageId: "inv789@stripe.com",
    })];
    const note = formatTriageNote(makeSession(emails));
    expect(note).toContain("[103](message://%3Cinv789%40stripe.com%3E)");
  });

  test("bulk dispose email with messageId renders clickable link in table", () => {
    const emails = [makeClassified({
      id: "105", priority: "archive", funnelStage: "bulk_dispose",
      matchedRule: "ai:marketing",
      messageId: "promo@marketing.com",
    })];
    const note = formatTriageNote(makeSession(emails));
    expect(note).toContain("[105](message://%3Cpromo%40marketing.com%3E)");
  });

  test("auto-processed email with messageId renders clickable link in table", () => {
    const emails = [makeClassified({
      id: "106", priority: "trash", funnelStage: "auto_processed",
      isJunk: true, matchedRule: "junk:address",
      messageId: "spam@junk.com",
    })];
    const note = formatTriageNote(makeSession(emails));
    expect(note).toContain("[106](message://%3Cspam%40junk.com%3E)");
    expect(note).not.toContain("`106`");
  });

  test("email WITHOUT messageId falls back to plain ID", () => {
    const emails = [makeClassified({
      id: "107", priority: "action", funnelStage: "vip", isVip: true,
      subject: "No Message-ID",
    })];
    const note = formatTriageNote(makeSession(emails));
    expect(note).toContain("`107`");
    expect(note).not.toContain("message://");
  });

  test("messageId with special characters is URL-encoded", () => {
    const emails = [makeClassified({
      id: "108", priority: "action", funnelStage: "action",
      messageId: "msg+special/chars@example.com",
    })];
    const note = formatTriageNote(makeSession(emails));
    // encodeURIComponent encodes + as %2B and / as %2F
    expect(note).toContain("message://%3Cmsg%2Bspecial%2Fchars%40example.com%3E");
  });

  test("empty sections show None placeholder", () => {
    const note = formatTriageNote(makeSession([]));
    expect(note).toContain("*None*");
  });

  test("action codes documented in header", () => {
    const note = formatTriageNote(makeSession([]));
    expect(note).toContain("K=Keep");
    expect(note).toContain("A=Archive");
    expect(note).toContain("T=Trash");
    expect(note).toContain("R=Reply");
    expect(note).toContain("D=Defer");
    expect(note).toContain("FU=Follow-up");
    expect(note).toContain("J=Junk");
    expect(note).toContain("U=Unsub");
    expect(note).toContain("AP=Approve");
    expect(note).toContain("BL=Block");
  });

  test("Follow-Up Due section renders when follow_up_due emails exist", () => {
    const emails = [makeClassified({
      id: "301", priority: "action", funnelStage: "follow_up_due",
      subject: "Overdue Follow-Up", fromAddress: "boss@firm.com",
      aiSummary: "Follow-up due 2026-03-15 -- no reply detected",
    })];
    const note = formatTriageNote(makeSession(emails));
    expect(note).toContain("## [] Follow-Up Due (1)");
    expect(note).toContain("no reply detected");
    expect(note).toContain("#### `301` boss@firm.com");
    expect(note).toContain("**Overdue Follow-Up**");
  });

  test("Follow-Up Due section hidden when no follow_up_due emails", () => {
    const emails = [makeClassified({
      id: "302", funnelStage: "action",
    })];
    const note = formatTriageNote(makeSession(emails));
    expect(note).not.toContain("Follow-Up Due");
  });

  test("follow_up_due emails count toward review-count", () => {
    const emails = [
      makeClassified({ funnelStage: "follow_up_due" }),
      makeClassified({ id: "2", funnelStage: "action" }),
    ];
    const note = formatTriageNote(makeSession(emails));
    expect(note).toContain("review-count: 2");
  });

  test("frontmatter includes review-count and auto-count", () => {
    const emails = [
      makeClassified({ funnelStage: "vip" }),
      makeClassified({ id: "2", funnelStage: "action" }),
      makeClassified({ id: "3", funnelStage: "auto_processed", matchedRule: "junk:address" }),
    ];
    const note = formatTriageNote(makeSession(emails));
    expect(note).toContain("review-count: 2");
    expect(note).toContain("auto-count: 1");
  });

  test("AI summary shows in mini-block for action emails", () => {
    const emails = [makeClassified({
      id: "201", funnelStage: "action",
      aiSummary: "Urgent deadline approaching",
    })];
    const note = formatTriageNote(makeSession(emails));
    expect(note).toContain("*AI: Urgent deadline approaching*");
  });

  test("attachment badge shows in mini-block subject", () => {
    const emails = [makeClassified({
      id: "202", funnelStage: "vip", isVip: true,
      hasAttachment: true, subject: "Tax Document",
    })];
    const note = formatTriageNote(makeSession(emails));
    expect(note).toContain("**Tax Document [att]**");
  });

  // ── Header transparency (inboxTotal) ──

  describe("formatTriageNote header transparency", () => {
    test("shows 'X of Y inbox emails' when inboxTotal > total", () => {
      const emails = Array.from({ length: 50 }, (_, i) =>
        makeClassified({ id: String(1000 + i) })
      );
      const note = formatTriageNote(makeSession(emails, { inboxTotal: 82 }));
      expect(note).toContain("50 of 82 inbox emails");
    });

    test("shows plain count when inboxTotal equals total", () => {
      const emails = Array.from({ length: 43 }, (_, i) =>
        makeClassified({ id: String(1000 + i) })
      );
      const note = formatTriageNote(makeSession(emails, { inboxTotal: 43 }));
      expect(note).toContain("43 emails");
      expect(note).not.toContain("of 43 inbox");
    });

    test("shows plain count when inboxTotal is null", () => {
      const emails = Array.from({ length: 50 }, (_, i) =>
        makeClassified({ id: String(1000 + i) })
      );
      const note = formatTriageNote(makeSession(emails, { inboxTotal: null }));
      expect(note).toContain("50 emails");
    });

    test("YAML frontmatter includes inbox-total", () => {
      const emails = [makeClassified({ id: "301" })];
      const note = formatTriageNote(makeSession(emails, { inboxTotal: 82 }));
      expect(note).toContain("inbox-total: 82");
    });

    test("YAML frontmatter inbox-total falls back to total when null", () => {
      const emails = [makeClassified({ id: "302" })];
      const note = formatTriageNote(makeSession(emails, { inboxTotal: null }));
      expect(note).toContain("inbox-total: 1");
    });
  });
});

describe("formatToNewYorkTimestamp", () => {
  test("formats standard ISO string", () => {
    expect(formatToNewYorkTimestamp("2026-05-20T17:15:00Z")).toBe("2026-05-20_13:15");
  });

  test("formats RFC 2822 date string", () => {
    expect(formatToNewYorkTimestamp("Wed, 20 May 2026 13:15:00 -0400")).toBe("2026-05-20_13:15");
  });

  test("handles undefined or invalid dates gracefully", () => {
    expect(formatToNewYorkTimestamp(undefined)).toBeNull();
    expect(formatToNewYorkTimestamp("invalid-date")).toBeNull();
  });
});

describe("arrival-map frontmatter generation", () => {
  test("generates arrival-map key in frontmatter", () => {
    const emails = [
      makeClassified({ id: "1001", date: "2026-05-20T17:15:00Z" }),
      makeClassified({ id: "1002", date: "2026-05-20T17:30:00Z" }),
    ];
    const note = formatTriageNote(makeSession(emails));
    expect(note).toContain('arrival-map: "1001:2026-05-20_13:15,1002:2026-05-20_13:30"');
  });
});

