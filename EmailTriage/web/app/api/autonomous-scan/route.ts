// POST /api/autonomous-scan
//
// Phase 24 — runs scanForAutonomousActions against the session's
// emails (either provided directly or parsed from today's triage note)
// and returns the recommendation list + skip breakdown. Read-only —
// surfaces "autopilot would do X" transparency without executing.
//
// Body: { emails?: Array<EmailInput> } - if omitted, no scan possible
// Returns: { result: AutonomousScanResult }

import { NextResponse } from "next/server";
import { Database } from "bun:sqlite";
import { join } from "path";
import { existsSync, readFileSync } from "fs";
import { scanForAutonomousActions } from "../../../../Tools/AutonomousActions";
import { getTriageNotePath } from "../../../server/paths";
import { parseTriageNoteToSession } from "../../../server/parse-triage-note";

export const dynamic = "force-dynamic";

const DB_PATH = join(process.env.HOME ?? "", ".claude/skills/EmailTriage/triage.db");

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({})) as { emails?: unknown; date?: string };

    let emailInputs: Parameters<typeof scanForAutonomousActions>[1];

    if (Array.isArray(body.emails)) {
      emailInputs = body.emails as typeof emailInputs;
    } else if (typeof body.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
      // Parse today's note and derive email inputs from it
      const notePath = getTriageNotePath(body.date);
      if (!existsSync(notePath)) {
        return NextResponse.json({ error: `no triage note for ${body.date}` }, { status: 404 });
      }
      const session = parseTriageNoteToSession(readFileSync(notePath, "utf8"), body.date);
      emailInputs = session.emails.map(e => ({
        emailId: e.id,
        fromAddress: e.fromAddress,
        fromDomain: e.fromDomain,
        isVip: e.isVip,
        funnelStage: e.funnelStage,
      }));
    } else {
      return NextResponse.json({ error: "emails[] or date (YYYY-MM-DD) required" }, { status: 400 });
    }

    const db = new Database(DB_PATH);
    const result = scanForAutonomousActions(db, emailInputs);
    db.close();
    return NextResponse.json({ result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
