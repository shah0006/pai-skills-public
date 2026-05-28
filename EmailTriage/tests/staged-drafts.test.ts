import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { stageDraft, getApprovedDrafts, markDraftSent, type StagedDraft } from "../Tools/StagedDrafts";

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "staged-test-"));
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const sampleDraft: StagedDraft = {
  emailId: "87123",
  to: "recipient-test@example.com",
  subject: "Re: Reference Letter for Dr. Example",
  inReplyTo: "msg-id-123@example.com",
  account: "g",
  body: "Hi Recipient,\n\nI would be happy to provide a reference letter.\n\nBest,\nDr. Example",
  stagedAt: "2026-04-05_08:30",
};

describe("stageDraft", () => {
  test("creates draft file in staged directory", () => {
    const path = stageDraft(sampleDraft, tmpDir);
    expect(existsSync(path)).toBe(true);
    expect(path).toContain("recipient-test");
    expect(path).toContain("Reference Letter");
  });

  test("draft file contains frontmatter", () => {
    const path = stageDraft(sampleDraft, tmpDir);
    const content = readFileSync(path, "utf-8");
    expect(content).toContain('email-id: "87123"');
    expect(content).toContain('to: "recipient-test@example.com"');
    expect(content).toContain('account: "g"');
    expect(content).toContain("status: draft");
  });

  test("draft file contains body after frontmatter", () => {
    const path = stageDraft(sampleDraft, tmpDir);
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("Hi Recipient,");
    expect(content).toContain("Dr. Example");
  });
});

describe("getApprovedDrafts", () => {
  test("returns empty when no approved drafts", () => {
    const emptyDir = join(tmpDir, "empty");
    mkdirSync(emptyDir, { recursive: true });
    const drafts = getApprovedDrafts(emptyDir);
    expect(drafts).toHaveLength(0);
  });

  test("finds approved drafts only", () => {
    const approveDir = join(tmpDir, "approve-test");
    mkdirSync(approveDir, { recursive: true });

    // Stage a draft then manually mark as approved
    stageDraft(sampleDraft, approveDir);
    const files = require("fs").readdirSync(approveDir).filter((f: string) => f.endsWith(".md"));
    const filePath = join(approveDir, files[0]);
    let content = readFileSync(filePath, "utf-8");
    content = content.replace("status: draft", "status: approved");
    writeFileSync(filePath, content);

    const approved = getApprovedDrafts(approveDir);
    expect(approved).toHaveLength(1);
    expect(approved[0].emailId).toBe("87123");
    expect(approved[0].to).toBe("recipient-test@example.com");
    expect(approved[0].body).toContain("Hi Recipient");
  });

  test("skips draft status files", () => {
    const skipDir = join(tmpDir, "skip-test");
    mkdirSync(skipDir, { recursive: true });
    stageDraft(sampleDraft, skipDir);
    const drafts = getApprovedDrafts(skipDir);
    expect(drafts).toHaveLength(0);
  });
});

describe("markDraftSent", () => {
  test("moves approved draft to Sent/", () => {
    const sentDir = join(tmpDir, "sent-test");
    const sentSubDir = join(sentDir, "Sent");
    mkdirSync(sentDir, { recursive: true });

    // Stage and approve
    const path = stageDraft(sampleDraft, sentDir);
    let content = readFileSync(path, "utf-8");
    content = content.replace("status: draft", "status: approved");
    writeFileSync(path, content);

    // Mark as sent
    markDraftSent("87123", sentDir);

    // Original file should be gone
    expect(existsSync(path)).toBe(false);

    // Sent/ should have the file with status: sent
    expect(existsSync(sentSubDir)).toBe(true);
    const sentFiles = require("fs").readdirSync(sentSubDir);
    expect(sentFiles.length).toBeGreaterThan(0);
    const sentContent = readFileSync(join(sentSubDir, sentFiles[0]), "utf-8");
    expect(sentContent).toContain("status: sent");
  });
});
