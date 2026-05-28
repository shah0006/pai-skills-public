// ~/.claude/skills/EmailTriage/unsubscribe.ts
// RFC 8058 List-Unsubscribe handler
// Parses List-Unsubscribe headers and executes unsubscribe via HTTP POST or mailto

import type { Database } from "bun:sqlite";
import { recordUnsubscribe } from "./Db";

export enum UnsubscribeMethod {
  HTTP = "http",
  MAILTO = "mailto",
}

export interface UnsubscribeTarget {
  method: UnsubscribeMethod;
  url?: string;
  email?: string;
  subject?: string;
  requiresPost: boolean;
}

export interface UnsubscribeResult {
  success: boolean;
  method: UnsubscribeMethod;
  error?: string;
}

/**
 * Parse a List-Unsubscribe header value into an actionable target.
 * Prefers HTTP (RFC 8058 one-click) over mailto when both are present.
 */
export function parseListUnsubscribeHeader(header: string | null | undefined): UnsubscribeTarget | null {
  if (!header) return null;

  const matches = [...header.matchAll(/<([^>]+)>/g)];
  if (matches.length === 0) return null;

  const urls: string[] = [];
  const mailtos: string[] = [];

  for (const match of matches) {
    const value = match[1];
    if (value.startsWith("https://") || value.startsWith("http://")) {
      urls.push(value);
    } else if (value.startsWith("mailto:")) {
      mailtos.push(value);
    }
  }

  // Prefer HTTP (RFC 8058 one-click unsubscribe)
  if (urls.length > 0) {
    return {
      method: UnsubscribeMethod.HTTP,
      url: urls[0],
      requiresPost: true,
    };
  }

  if (mailtos.length > 0) {
    const mailto = mailtos[0];
    const emailMatch = mailto.match(/^mailto:([^?]+)/);
    const subjectMatch = mailto.match(/[?&]subject=([^&]+)/);
    return {
      method: UnsubscribeMethod.MAILTO,
      email: emailMatch ? emailMatch[1] : undefined,
      subject: subjectMatch ? decodeURIComponent(subjectMatch[1]) : "unsubscribe",
      requiresPost: false,
    };
  }

  return null;
}

/**
 * Execute an unsubscribe action against the parsed target.
 * HTTP targets use POST with List-Unsubscribe=One-Click body (RFC 8058).
 * Mailto targets send an email via apple-mail.sh.
 * If db is provided, records the unsubscribe to the unsubscribed table on success.
 */
export async function executeUnsubscribe(
  target: UnsubscribeTarget,
  opts?: { db?: Database; address?: string; domain?: string },
): Promise<UnsubscribeResult> {
  let result: UnsubscribeResult;

  if (target.method === UnsubscribeMethod.HTTP && target.url) {
    try {
      const response = await fetch(target.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "List-Unsubscribe": "One-Click",
        },
        body: "List-Unsubscribe=One-Click",
        redirect: "follow",
        signal: AbortSignal.timeout(10_000),
      });
      result = {
        success: response.ok,
        method: UnsubscribeMethod.HTTP,
        error: response.ok ? undefined : `HTTP ${response.status} ${response.statusText}`,
      };
    } catch (e) {
      result = {
        success: false,
        method: UnsubscribeMethod.HTTP,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  } else if (target.method === UnsubscribeMethod.MAILTO && target.email) {
    const { execSync } = await import("child_process");
    const mailScript = `${process.env.HOME}/.claude/skills/AppleMail/Tools/apple-mail.sh`;
    const subject = (target.subject ?? "unsubscribe").replace(/"/g, '\\"');
    const email = target.email.replace(/"/g, '\\"');
    try {
      execSync(
        `"${mailScript}" send --to "${email}" --subject "${subject}" --body "Please unsubscribe me from this mailing list."`,
        { stdio: "pipe", timeout: 15_000 },
      );
      result = { success: true, method: UnsubscribeMethod.MAILTO };
    } catch (e) {
      result = {
        success: false,
        method: UnsubscribeMethod.MAILTO,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  } else {
    result = {
      success: false,
      method: target.method,
      error: "No valid unsubscribe target",
    };
  }

  // Record to DB on success
  if (result.success && opts?.db) {
    recordUnsubscribe(opts.db, opts.address ?? null, opts.domain ?? null, result.method);
  }

  return result;
}

/**
 * Extract the List-Unsubscribe header value from raw email content
 * as returned by apple-mail.sh read.
 */
export function extractListUnsubscribeFromEmailContent(emailContent: string): string | null {
  const match = emailContent.match(/^List-Unsubscribe:\s*(.+)$/im);
  return match ? match[1].trim() : null;
}
