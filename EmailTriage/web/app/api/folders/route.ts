// GET /api/folders
// Returns structured folder list from apple-mail.sh folders
// Each entry: { name, account, depth, parent, displayLabel }
// depth=1 = top-level folder; depth=2 = sub-folder (name is "Parent/Child")

import { NextResponse } from "next/server";
import { execSync } from "child_process";
import { join } from "path";

export const dynamic = "force-dynamic";

const APPLE_MAIL_SH = join(
  (process.env.HOME ?? (() => { throw new Error("HOME env var not set"); })()),
  ".claude/skills/AppleMail/Tools/apple-mail.sh",
);

export interface FolderEntry {
  name: string;           // Full path: "Evicore/Archive" or "Evicore"
  account: string | null; // "iCloud", "Google", null for system folders
  depth: number;          // 1 = top-level, 2 = sub-folder
  parent: string | null;  // Parent folder name for sub-folders, else null
  displayLabel: string;   // Used for dedup and display
}

// Standard system mailboxes that appear before account sections
const SYSTEM_FOLDERS = new Set(["inbox", "sent", "drafts", "trash", "junk"]);

export async function GET() {
  try {
    const raw = execSync(`bash "${APPLE_MAIL_SH}" folders`, {
      encoding: "utf-8",
      timeout: 45_000,
    });

    const folders: FolderEntry[] = [];
    let currentAccount: string | null = null;

    for (const line of raw.split("\n")) {
      // Detect account section header: ── Account Name ──
      const accountHeader = line.match(/^──\s+(.+?)\s+──\s*$/);
      if (accountHeader) {
        currentAccount = accountHeader[1].trim();
        continue;
      }

      // Skip separators and blank lines
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (/^=+$/.test(trimmed)) continue;
      if (trimmed.startsWith("Mailbox Folders")) continue;

      // Detect indentation depth from leading spaces:
      // 2 spaces = depth 1, 4 = depth 2, 6 = depth 3, 8 = depth 4
      const leadingSpaces = line.match(/^(\s*)/)?.[1].length ?? 0;
      const depth = leadingSpaces >= 8 ? 4 : leadingSpaces >= 6 ? 3 : leadingSpaces >= 4 ? 2 : 1;

      // Strip trailing count suffixes
      const name = trimmed
        .replace(/\s*\(\d[^)]*\)\s*$/, "")
        .replace(/\s+\d+\s+(unread|messages?)[^$]*$/, "")
        .trim();

      if (!name) continue;

      const isSystem = SYSTEM_FOLDERS.has(name.toLowerCase());
      const account = isSystem ? null : currentAccount;

      // For sub-folders, name is "Parent/Child" — extract parent
      const parent = depth === 2 && name.includes("/")
        ? name.split("/")[0]
        : null;

      // displayLabel: "Evicore/Archive — iCloud" or "Archive — iCloud" or "inbox"
      const displayLabel = account ? `${name} — ${account}` : name;

      folders.push({ name, account, depth, parent, displayLabel });
    }

    // Deduplicate by displayLabel
    const seen = new Set<string>();
    const unique = folders.filter((f) => {
      if (seen.has(f.displayLabel)) return false;
      seen.add(f.displayLabel);
      return true;
    });

    return NextResponse.json({ folders: unique });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
