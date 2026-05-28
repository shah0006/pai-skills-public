// ~/.claude/skills/EmailTriage/path-resolver.ts
// Unified path convention library for mail folder and disk path resolution
// Every file that handles folder paths imports from here.

import { type AccountAlias, ACCOUNT_MAP } from "./Types";

export interface ParsedPath {
  account: AccountAlias | null;
  parts: string[];
}

/**
 * Parse a unified path string into account alias and folder parts.
 * Case-insensitive account resolution.
 *
 * Examples:
 *   "" -> { account: null, parts: [] }
 *   "i" -> { account: 'i', parts: [] }  (iCloud inbox)
 *   "g/Stages/Stage 1 - VIP" -> { account: 'g', parts: ['Stages', 'Stage 1 - VIP'] }
 *   "Gmail/Receipts" -> { account: 'g', parts: ['Receipts'] }
 */
export function parsePath(input: string): ParsedPath {
  if (!input || !input.trim()) {
    return { account: null, parts: [] };
  }

  const segments = input.split("/").filter(Boolean);
  if (segments.length === 0) {
    return { account: null, parts: [] };
  }

  const firstLower = segments[0].toLowerCase();
  const alias = Object.hasOwn(ACCOUNT_MAP, firstLower) ? ACCOUNT_MAP[firstLower] : null;

  if (alias) {
    return { account: alias, parts: segments.slice(1) };
  }

  // Not a recognized account prefix -- return as-is with no account
  return { account: null, parts: segments };
}

/**
 * Resolve a unified path to AppleScript-compatible account name + mailbox path.
 * Validates against the actual folder tree.
 * Throws on non-existent path with closest matches.
 */
export function resolveToAppleScript(
  path: string,
  folderTree: string[]
): { accountName: string; mailboxPath: string } {
  const parsed = parsePath(path);
  if (!parsed.account) {
    throw new Error(`Cannot resolve path without account prefix: "${path}"`);
  }

  const accountNames: Record<AccountAlias, string> = {
    i: "iCloud",
    g: "Google",
    y: "Yahoo",
    h: "Hotmail",
    a: "AOL",
    p: "ProtonMail",
  };

  const accountName = accountNames[parsed.account];
  const mailboxPath = parsed.parts.join("/");

  if (mailboxPath && folderTree.length > 0) {
    // Validate against folder tree (case-insensitive)
    const mailboxLower = mailboxPath.toLowerCase();
    const match = folderTree.find(f => f.toLowerCase() === mailboxLower);
    if (!match) {
      // Find closest matches for error message
      const candidates = folderTree
        .filter(f => f.toLowerCase().includes(parsed.parts[parsed.parts.length - 1].toLowerCase()))
        .slice(0, 5);
      const hint = candidates.length > 0
        ? ` Did you mean: ${candidates.join(", ")}?`
        : "";
      throw new Error(`Mailbox "${mailboxPath}" not found in ${accountName}.${hint}`);
    }
    return { accountName, mailboxPath: match }; // Use the actual-case version
  }

  return { accountName, mailboxPath };
}

/**
 * Normalize a path for comparison (lowercase).
 * Display formatting preserves original case.
 */
export function normalizePath(path: string): string {
  return path.toLowerCase();
}

/**
 * Format a display path from account alias and folder segments.
 * Example: formatDisplayPath('i', 'Personal', 'Subscriptions', 'Alo')
 *   -> "i/Personal/Subscriptions/Alo"
 */
export function formatDisplayPath(account: AccountAlias, ...folders: string[]): string {
  if (folders.length === 0) return account;
  return `${account}/${folders.join("/")}`;
}

/**
 * Returns true if the path starts with a known account alias.
 * Used to distinguish mail folder paths from disk paths.
 */
export function isMailFolderPath(path: string): boolean {
  if (!path || !path.trim()) return false;
  const first = path.split("/")[0].toLowerCase();
  return Object.hasOwn(ACCOUNT_MAP, first);
}

/**
 * Returns true if the path is a disk/filesystem path.
 * Disk paths start with ~/, /, or don't match any account alias.
 */
export function isDiskPath(path: string): boolean {
  if (!path || !path.trim()) return false;
  if (path.startsWith("~/") || path.startsWith("/")) return true;
  return !isMailFolderPath(path);
}
