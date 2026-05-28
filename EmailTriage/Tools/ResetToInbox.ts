#!/usr/bin/env bun
/**
 * Reset every email currently sitting in a Stages/Stage N folder back to its
 * account's INBOX, leaving no duplicates. Use as the cleanup phase before a
 * full end-to-end Generate test, so the staging routing code is exercised
 * against a clean inbox state.
 *
 * Per the EmailTriage Phase 1 single-writer-per-account invariant:
 *   - iCloud → apple-mail.sh (AppleMail skill)
 *   - Gmail  → gws (GoogleWorkspaceCLI), label add/remove via the Gmail API
 *
 * Usage:
 *   bun run Tools/ResetToInbox.ts [--account i|g] [--dry-run]
 */
import { execSync } from "node:child_process";
import type { AccountAlias, FunnelStage } from "./Types";

const APPLE_MAIL_SH = `${process.env.HOME}/.claude/skills/AppleMail/Tools/apple-mail.sh`;

const STAGE_FOLDER_NAMES: Record<FunnelStage, string | null> = {
  vip: "Stage 1 - VIP",
  action: "Stage 2 - Action Required",
  financial: "Stage 3 - Financial",
  informational: "Stage 4 - Informational",
  bulk_dispose: "Stage 5 - Bulk Dispose",
  auto_processed: "Stage 6 - Auto-Processed",
};

interface Args {
  account?: AccountAlias;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--account") {
      const v = argv[++i];
      if (v === "i" || v === "g") out.account = v;
    } else if (a === "--dry-run") {
      out.dryRun = true;
    }
  }
  return out;
}

// ─── iCloud via AppleMail ───

function listIcloudStageIds(stageFolder: string): string[] {
  const folder = `i/Stages/${stageFolder}`;
  let raw: string;
  try {
    raw = execSync(`bash "${APPLE_MAIL_SH}" list "${folder}" --limit 500`, {
      encoding: "utf-8",
      timeout: 60_000,
    });
  } catch {
    return [];
  }
  const ids: string[] = [];
  for (const line of raw.split("\n")) {
    const m = line.match(/^ID:(\d+)/);
    if (m) ids.push(m[1]);
  }
  return ids;
}

async function resetIcloud(dryRun: boolean): Promise<{ moved: number; errors: number }> {
  let moved = 0, errors = 0;
  for (const stageFolder of Object.values(STAGE_FOLDER_NAMES)) {
    if (!stageFolder) continue;
    const ids = listIcloudStageIds(stageFolder);
    if (ids.length === 0) continue;
    console.log(`[i] ${stageFolder}: ${ids.length} emails`);
    for (const id of ids) {
      if (dryRun) { moved++; continue; }
      try {
        execSync(
          `bash "${APPLE_MAIL_SH}" move "${id}" "INBOX" --account "iCloud" --mailbox "Stages/${stageFolder}"`,
          { encoding: "utf-8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] },
        );
        moved++;
      } catch (err) {
        console.warn(`  ✗ ${id}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
        errors++;
      }
    }
  }
  return { moved, errors };
}

// ─── Gmail via gws ───

interface GmailLabel { id: string; name: string }

function fetchGmailLabels(): GmailLabel[] {
  const out = execSync(`gws gmail users labels list --params '{"userId":"me"}'`, {
    encoding: "utf-8",
    timeout: 30_000,
  });
  const json = JSON.parse(out.split("\n").filter(l => !l.startsWith("Using keyring") && !l.startsWith("[account:")).join("\n"));
  return (json.labels ?? []).map((l: { id: string; name: string }) => ({ id: l.id, name: l.name }));
}

function listGmailIdsByLabel(labelId: string): string[] {
  // Page through results in case >100
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const params: Record<string, unknown> = { userId: "me", labelIds: [labelId], maxResults: 500 };
    if (pageToken) params.pageToken = pageToken;
    const raw = execSync(
      `gws gmail users messages list --params '${JSON.stringify(params).replace(/'/g, "'\\''")}'`,
      { encoding: "utf-8", timeout: 60_000 },
    );
    const json = JSON.parse(raw.split("\n").filter(l => !l.startsWith("Using keyring") && !l.startsWith("[account:")).join("\n"));
    for (const m of (json.messages ?? [])) ids.push(m.id);
    pageToken = json.nextPageToken;
  } while (pageToken);
  return ids;
}

async function resetGmail(dryRun: boolean): Promise<{ moved: number; errors: number }> {
  const labels = fetchGmailLabels();
  const stageLabels = labels.filter(l => l.name.startsWith("Stages/Stage "));
  let moved = 0, errors = 0;
  for (const label of stageLabels) {
    const ids = listGmailIdsByLabel(label.id);
    if (ids.length === 0) continue;
    console.log(`[g] ${label.name} (${label.id}): ${ids.length} emails`);
    for (const id of ids) {
      if (dryRun) { moved++; continue; }
      try {
        // Gmail labels are NON-EXCLUSIVE — adding INBOX without removing the Stages/*
        // label leaves the email duplicated in both views. We must explicitly remove
        // the source Stages label AND add INBOX in one atomic modify call.
        // (2026-05-19 bug: prior version used GoogleWorkspaceCLI/Move.ts which is
        // family-aware on the DESTINATION family; INBOX has no family so siblings
        // weren't stripped — producing duplicates.)
        // gws CLI shape: --params for URL path params, --json for request body.
        // addLabelIds/removeLabelIds are body fields, NOT URL params.
        const urlParams = JSON.stringify({ userId: "me", id });
        const body = JSON.stringify({
          addLabelIds: ["INBOX"],
          removeLabelIds: [label.id],
        });
        execSync(
          `gws gmail users messages modify --params '${urlParams.replace(/'/g, "'\\''")}' --json '${body.replace(/'/g, "'\\''")}' >/dev/null`,
          { encoding: "utf-8", timeout: 30_000 },
        );
        moved++;
      } catch (err) {
        console.warn(`  ✗ ${id}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
        errors++;
      }
    }
  }
  return { moved, errors };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`ResetToInbox: account=${args.account ?? "ALL"} dryRun=${args.dryRun}`);

  const totals = { moved: 0, errors: 0 };
  if (!args.account || args.account === "i") {
    const r = await resetIcloud(args.dryRun);
    totals.moved += r.moved;
    totals.errors += r.errors;
  }
  if (!args.account || args.account === "g") {
    const r = await resetGmail(args.dryRun);
    totals.moved += r.moved;
    totals.errors += r.errors;
  }
  console.log(`\n${args.dryRun ? "[DRY RUN] would move" : "Moved"}: ${totals.moved} | errors: ${totals.errors}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
