// tests/receipt-handling.test.ts — Phase 28 stage-independent receipt handling.
// Each test names the ISC it probes (ISA: ~/.claude/skills/EmailTriage/ISA.md).
// Pure fixtures only — no live-mailbox call (ISC-26).
import { describe, test, expect } from "bun:test";
import { classifyEmail } from "../Tools/RulesEngine";
import type { ClassificationCache } from "../Tools/RulesEngine";
import type { RawEmail } from "../Tools/Types";
import {
  isReceiptOrFinancial,
  shouldExtractFinancial,
  extractFinancialMetadata,
} from "../Tools/GenerateTriage";

const makeEmail = (o: Partial<RawEmail>): RawEmail => ({
  id: "T1",
  subject: "Test",
  from: "sender@example.com",
  fromAddress: "sender@example.com",
  fromDomain: "example.com",
  date: "May 19",
  isRead: false,
  hasAttachment: false,
  snippet: "",
  account: "iCloud",
  ...o,
});

const cache: ClassificationCache = {
  vipSenders: new Set(["vip@example.com"]),
  junkAddresses: new Set(),
  junkDomains: new Set(),
  routingRules: [],
  knownSenders: new Set(),
};

describe("Phase 28 — stage-independent receipt handling", () => {
  test("ISC-16 (regression): a VIP sender still classifies as VIP with isVip true", () => {
    const e = classifyEmail(
      makeEmail({ fromAddress: "vip@example.com", subject: "Payment receipt #849559099" }),
      cache,
    );
    expect(e.funnelStage).toBe("vip");
    expect(e.isVip).toBe(true);
  });

  test("ISC-15: a VIP-staged receipt still gets funnelStage vip AND is eligible for extraction", () => {
    const e = classifyEmail(
      makeEmail({ fromAddress: "vip@example.com", subject: "Payment receipt #849559099" }),
      cache,
    );
    expect(e.funnelStage).toBe("vip");            // VIP stays a stage (Q14)
    expect(shouldExtractFinancial(e)).toBe(true); // ...but financial extraction still runs
  });

  test("ISC-23: receipt detection is driven by the FINANCIAL_TYPE_PATTERNS set", () => {
    expect(isReceiptOrFinancial(classifyEmail(makeEmail({ subject: "Payment receipt #1" }), cache))).toBe(true);
    expect(isReceiptOrFinancial(classifyEmail(makeEmail({ subject: "Your statement is ready" }), cache))).toBe(true);
    expect(isReceiptOrFinancial(classifyEmail(makeEmail({ fromDomain: "stripe.com", subject: "x" }), cache))).toBe(true);
    expect(isReceiptOrFinancial(classifyEmail(makeEmail({ subject: "lunch tomorrow?" }), cache))).toBe(false);
  });

  test("ISC-17/18/19: a VIP-sender receipt gets financialType, Vendor, and Amount", () => {
    const e = classifyEmail(
      makeEmail({
        fromAddress: "vip@example.com",
        from: "Dayton Dental <vip@example.com>",
        subject: "Payment receipt #849559099 for $200.00",
        snippet: "Thank you for your payment of $200.00",
      }),
      cache,
    );
    expect(shouldExtractFinancial(e)).toBe(true);
    extractFinancialMetadata(e);
    expect(e.financialType).toBe("Receipt");          // ISC-17
    expect(e.financialVendor).toBe("Dayton Dental");  // ISC-18
    expect(e.financialAmount).toBe("$200.00");        // ISC-19
  });

  test("ISC-20: a VIP-staged receipt carries the financial classification (folder routing is the Receipt card's job — see Decisions)", () => {
    const e = classifyEmail(
      makeEmail({ fromAddress: "vip@example.com", subject: "Receipt for your order", snippet: "$12.00" }),
      cache,
    );
    extractFinancialMetadata(e);
    // The backend makes the VIP receipt eligible — it carries financialType so
    // the Receipt card / Project 56 can route it. Stage 3 itself uses the You
    // column, not an auto-folder, so the backend assigns no folder here.
    expect(e.financialType).toBe("Receipt");
  });

  test("ISC-21 (regression): a Stage 3 non-VIP receipt still gets the financial treatment", () => {
    const e = classifyEmail(
      makeEmail({ subject: "Your invoice is ready", snippet: "amount due $45.50" }),
      cache,
    );
    e.funnelStage = "financial"; // model a Stage 3 email
    expect(shouldExtractFinancial(e)).toBe(true);
    extractFinancialMetadata(e);
    expect(e.financialType).toBe("Invoice");
    expect(e.financialAmount).toBe("$45.50");
  });

  test("ISC-22 (regression): a VIP non-receipt email stays VIP-only, no financial extraction", () => {
    const e = classifyEmail(
      makeEmail({ fromAddress: "vip@example.com", subject: "Are we still on for lunch?" }),
      cache,
    );
    expect(e.funnelStage).toBe("vip");
    expect(shouldExtractFinancial(e)).toBe(false);
    expect(e.financialType).toBeFalsy();
    expect(e.financialVendor).toBeFalsy();
  });
});
