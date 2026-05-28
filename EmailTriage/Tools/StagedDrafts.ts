// staged-drafts.ts -- Write reply drafts to Email Triage/Staged/ for review
// Replaces direct apple-mail.sh reply with a review-in-vault workflow.

import { writeFileSync, readFileSync, existsSync, readdirSync, renameSync, mkdirSync, unlinkSync } from "fs";
import { join, basename } from "path";

const VAULT_ROOT = (function(){
  if (process.env.EMAILTRIAGE_VAULT_ROOT) return process.env.EMAILTRIAGE_VAULT_ROOT;
  try {
    const home = process.env.HOME;
    if (!home) return "";
    const fs = require("fs");
    const path = require("path");
    const prefs = path.join(home, ".claude/PAI/USER/SKILLCUSTOMIZATIONS/EmailTriage/preferences.yaml");
    if (!fs.existsSync(prefs)) return "";
    const raw = fs.readFileSync(prefs, "utf8");
    const m = raw.match(/^\s*vault_root\s*:\s*["']?([^"'#\n]+?)["']?\s*(?:#.*)?$/m);
    return m ? m[1].trim() : "";
  } catch { return ""; }
})();
const STAGED_DIR = join(VAULT_ROOT, "Email Triage/Staged");
const SENT_DIR = join(STAGED_DIR, "Sent");

export interface StagedDraft {
  emailId: string;
  to: string;
  subject: string;
  inReplyTo?: string;
  account: string;
  body: string;
  stagedAt: string;
}

function ensureDirs(): void {
  if (!existsSync(STAGED_DIR)) mkdirSync(STAGED_DIR, { recursive: true });
  if (!existsSync(SENT_DIR)) mkdirSync(SENT_DIR, { recursive: true });
}

function sanitizeFilename(s: string): string {
  return s.replace(/[<>:"/\\|?*]/g, "").replace(/\s+/g, " ").trim().slice(0, 80);
}

export function stageDraft(draft: StagedDraft, dir?: string): string {
  const outDir = dir ?? STAGED_DIR;
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  const recipientName = sanitizeFilename(draft.to.split("@")[0]);
  const subjectClean = sanitizeFilename(draft.subject.replace(/^Re:\s*/i, ""));
  const filename = `${recipientName} - ${subjectClean}.md`;
  const outPath = join(outDir, filename);

  // Escape double quotes in frontmatter values to prevent invalid YAML
  const esc = (s: string) => s.replace(/"/g, '\\"');

  const md = `---
email-id: "${esc(draft.emailId)}"
to: "${esc(draft.to)}"
subject: "${esc(draft.subject)}"
in-reply-to: "${esc(draft.inReplyTo ?? "")}"
account: "${esc(draft.account)}"
staged-at: "${esc(draft.stagedAt)}"
status: draft
---

${draft.body}
`;

  writeFileSync(outPath, md);
  return outPath;
}

export function getApprovedDrafts(dir?: string): StagedDraft[] {
  const stagedDir = dir ?? STAGED_DIR;
  if (!existsSync(stagedDir)) return [];

  const files = readdirSync(stagedDir).filter(f => f.endsWith(".md"));
  const approved: StagedDraft[] = [];

  for (const file of files) {
    const content = readFileSync(join(stagedDir, file), "utf-8");
    // Check for status: approved in frontmatter only (not body)
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch || !fmMatch[1].match(/^status:\s*approved$/m)) continue;

    const fm = parseFrontmatter(content);
    if (!fm["email-id"] || !fm.to || !fm.subject) continue;

    const body = content.replace(/^---[\s\S]*?---\s*/, "").trim();
    approved.push({
      emailId: fm["email-id"],
      to: fm.to,
      subject: fm.subject,
      inReplyTo: fm["in-reply-to"] || undefined,
      account: fm.account || "i",
      body,
      stagedAt: fm["staged-at"] || "",
    });
  }

  return approved;
}

export function markDraftSent(emailId: string, dir?: string): void {
  const stagedDir = dir ?? STAGED_DIR;
  const sentDir = dir ? join(dir, "Sent") : SENT_DIR;
  if (!existsSync(sentDir)) mkdirSync(sentDir, { recursive: true });

  if (!existsSync(stagedDir)) return;
  const files = readdirSync(stagedDir).filter(f => f.endsWith(".md"));
  for (const file of files) {
    const content = readFileSync(join(stagedDir, file), "utf-8");
    if (content.includes(`email-id: "${emailId}"`)) {
      // Update status to sent
      const updated = content.replace(/^status:\s*\w+$/m, "status: sent");
      writeFileSync(join(sentDir, file), updated);
      // Remove from staged
      unlinkSync(join(stagedDir, file));
      return;
    }
  }
}

function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const result: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^(\S+):\s*"?([^"]*)"?$/);
    if (kv) result[kv[1]] = kv[2];
  }
  return result;
}
