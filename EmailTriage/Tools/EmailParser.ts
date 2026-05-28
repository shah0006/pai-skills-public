import type { RawEmail } from "./Types";

export function parseEmailAddress(from: string): string {
  const match = from.match(/<([^>]+)>/);
  return match ? match[1].trim() : from.trim();
}

export function parseDomain(email: string): string {
  const at = email.lastIndexOf("@");
  return at >= 0 ? email.slice(at + 1) : "";
}

// Fix UTF-8/Latin-1 encoding mismatch from Apple Mail AppleScript.
// Apple Mail returns UTF-8 text that gets misinterpreted as Latin-1,
// causing em dashes, smart quotes, and accented chars to appear corrupted.
export function fixEncoding(str: string): string {
  try {
    return Buffer.from(str, "binary").toString("utf8");
  } catch {
    return str;
  }
}

/** Extract total inbox count from apple-mail.sh list header line: "Mailbox: inbox (82 total)" */
export function parseInboxTotal(raw: string): number | null {
  const match = raw.match(/\((\d+) total\)/);
  return match ? parseInt(match[1], 10) : null;
}

export function parseEmailList(raw: string): RawEmail[] {
  if (!raw.trim()) return [];

  return raw
    .split("\n")
    .map(line => line.trim())
    .filter(line => line.length > 0)
    // Skip header lines from apple-mail.sh (e.g. "Mailbox: inbox (18 total)" and "===...")
    .filter(line => !line.startsWith("Mailbox:") && !/^=+/.test(line))
    .map(line => {
      // apple-mail.sh format:
      //   ID:79640 [ ]         | Sunday, March 1, 2026 at 12:04 PM | Sender <email> | Subject
      //   ID:79665 [READ] [📎] | date | from | subject
      const parts = line.split("|").map(p => p.trim());
      const meta = parts[0] || "";

      // Extract numeric ID from "ID:12345" prefix
      const idMatch = meta.match(/^ID:(\d+)/i);
      if (!idMatch) return null;
      const id = idMatch[1];

      // Read/unread status and attachment are in the meta field
      const isRead = meta.includes("[READ]");
      const hasAttachment = meta.includes("📎");

      const date = parts[1] || "";
      const fromRaw = fixEncoding(parts[2] || "");
      // Remaining parts form subject, except the last might be "ACCT:<name>"
      const remaining = parts.slice(3);
      let account: string | undefined;
      if (remaining.length > 0 && remaining[remaining.length - 1].startsWith("ACCT:")) {
        const acctStr = remaining.pop()!.slice(5).trim();
        if (acctStr) account = acctStr;
      }
      const subjectRaw = fixEncoding(remaining.join("|").trim());
      const subject = subjectRaw.replace(/📎/g, "").trim();

      const fromAddress = parseEmailAddress(fromRaw);
      const fromDomain = parseDomain(fromAddress);

      return {
        id,
        subject,
        from: fromRaw,
        fromAddress,
        fromDomain,
        date,
        isRead,
        hasAttachment,
        snippet: "",
        account: account ?? "unknown",
      };
    })
    .filter((email): email is RawEmail => email !== null && email.id.length > 0);
}
