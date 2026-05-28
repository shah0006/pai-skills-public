// POST /api/threads/cross-account
//
// Phase 24 — given the session's emails, returns the subset that form
// cross-account threads (same conversation present in both Gmail + iCloud).
// Subject-based v0 matching via Tools/CrossAccountThreads.
//
// Body: { emails: Array<{ emailId, account, subject, fromAddress, date }> }
// Returns: { threads: CrossAccountThread[] }

import { NextResponse } from "next/server";
import { findCrossAccountThreads, type ThreadEmail } from "../../../../../Tools/CrossAccountThreads";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({})) as { emails?: unknown };
    if (!Array.isArray(body.emails)) {
      return NextResponse.json({ error: "emails array required" }, { status: 400 });
    }
    const threads = findCrossAccountThreads(body.emails as ThreadEmail[]);
    return NextResponse.json({ threads });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
