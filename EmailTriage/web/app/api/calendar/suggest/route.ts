// POST /api/calendar/suggest
//
// Phase 23 — given an email's subject + body, returns a calendar event
// suggestion if the email looks like a meeting/scheduling cue.
//
// Two-pass: Pass 1 (sync regex heuristics) → Pass 2 (async Haiku enrichment).
// Pass 2 is skipped gracefully if ANTHROPIC_API_KEY is absent or the call fails.
//
// Body: { subject: string; body: string; emailId?: string; fromAddress?: string }
// Returns: { suggestion: CalendarSuggestion | null }

import { NextResponse } from "next/server";
import { suggestCalendarFromEmail, enrichCalendarSuggestionWithAI } from "../../../../../Tools/CalendarSuggest";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const subject = typeof body.subject === "string" ? body.subject : "";
    const bodyText = typeof body.body === "string" ? body.body : "";
    const emailId = typeof body.emailId === "string" ? body.emailId : undefined;
    const fromAddress = typeof body.fromAddress === "string" ? body.fromAddress : undefined;

    // Pass 1: regex heuristics (sync, always runs)
    const base = suggestCalendarFromEmail({ subject, body: bodyText, emailId, fromAddress });
    if (!base) return NextResponse.json({ suggestion: null });

    // Pass 2: AI enrichment (async, graceful fallback on any failure)
    const suggestion = await enrichCalendarSuggestionWithAI(base, subject, bodyText);
    return NextResponse.json({ suggestion });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
