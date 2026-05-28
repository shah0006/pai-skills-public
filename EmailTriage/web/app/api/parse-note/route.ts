// POST /api/parse-note
// Body: { noteContent: string, date: string }
// Returns: { session: TriageSession } parsed from existing markdown triage note

import { NextResponse } from "next/server";
import { parseTriageNoteToSession } from "../../../server/parse-triage-note";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const { noteContent, date } = await req.json();
    if (!noteContent || !date) {
      return NextResponse.json({ error: "noteContent and date required" }, { status: 400 });
    }

    const session = parseTriageNoteToSession(noteContent, date);
    return NextResponse.json({ session });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
