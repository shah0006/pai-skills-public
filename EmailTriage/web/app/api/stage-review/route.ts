// GET /api/stage-review?date=YYYY-MM-DD
// Aggregated session + transport health for Review UI (Phase 3, Q3=B)

import { NextResponse } from "next/server";
import { existsSync, readFileSync, statSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";
import { getTriageNotePath, getVaultRoot } from "../../../server/paths";
import { buildTransportStatus } from "../../../server/transport-health";
import { parseTriageNoteToSession } from "../../../server/parse-triage-note";

export const dynamic = "force-dynamic";

/** Query the email_actions table for today's processed email IDs (trashed/archived).
 *  Uses sqlite3 CLI to read triage.db — same DB that ExecuteTriage writes to.
 *  Avoids bun:sqlite which deadlocks under Next.js Turbopack. */
function getProcessedIdsForDate(date: string): Set<string> {
  const ids = new Set<string>();
  try {
    const dbPath = join(
      (process.env.HOME ?? ""),
      ".claude/skills/EmailTriage/triage.db",
    );
    if (!existsSync(dbPath)) return ids;
    const output = execSync(
      `sqlite3 "${dbPath}" "SELECT email_id FROM email_actions WHERE date = '${date}' AND action IN ('archive', 'trash')"`,
      { encoding: "utf-8", timeout: 5_000 },
    );
    for (const line of output.trim().split("\n")) {
      const id = line.trim();
      if (id) ids.add(id);
    }
  } catch {
    // If DB is locked or unavailable, return empty set (graceful degradation).
  }
  return ids;
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const date = url.searchParams.get("date");
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json({ error: "date required (YYYY-MM-DD)" }, { status: 400 });
    }

    if (!getVaultRoot()) {
      return NextResponse.json({ error: "EMAILTRIAGE_VAULT_ROOT not configured" }, { status: 500 });
    }

    const notePath = getTriageNotePath(date);
    const transports = buildTransportStatus(date);

    if (!existsSync(notePath)) {
      return NextResponse.json({
        exists: false,
        session: null,
        notePath,
        transports,
      });
    }

    const noteContent = readFileSync(notePath, "utf-8");
    const processedIds = getProcessedIdsForDate(date);
    const session = parseTriageNoteToSession(noteContent, date, processedIds);
    const noteMtime = statSync(notePath).mtime.toISOString();

    const emails = session.emails.map(e => {
      const acct = (e.account ?? "").toLowerCase();
      const gmailDegraded = transports.gmail.degraded && (acct.includes("google") || acct === "gmail");
      const icloudDegraded = transports.icloud.degraded && acct.includes("icloud");
      return {
        ...e,
        remoteUnreachable: gmailDegraded || icloudDegraded,
      };
    });

    return NextResponse.json({
      exists: true,
      notePath,
      noteMtime,
      session: { ...session, emails, inboxTotal: session.total || emails.length },
      transports,
      filteredCount: processedIds.size,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
