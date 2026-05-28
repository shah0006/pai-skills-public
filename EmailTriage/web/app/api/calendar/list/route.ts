// GET /api/calendar/list
//
// UX-2 (Phase 27.2) — lists the user's writable Google Calendars so the
// CalendarSuggestionCard can offer a destination picker. Runs
// `gws calendar calendarList list`.
//
// Returns: { calendars: Array<{ id, summary, primary }> }
// Falls back to a single 'primary' entry if gws is unavailable.

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

declare const Bun: {
  spawn(args: string[], opts?: { stdout?: string; stderr?: string }): {
    stdout: ReadableStream;
    stderr: ReadableStream;
    exited: Promise<number>;
  };
};

type CalendarEntry = { id: string; summary: string; primary: boolean };

const FALLBACK: CalendarEntry[] = [{ id: "primary", summary: "Primary", primary: true }];

export async function GET() {
  try {
    const proc = Bun.spawn(
      ["gws", "calendar", "calendarList", "list", "--format", "json"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [out, , exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      return NextResponse.json({ calendars: FALLBACK });
    }

    // gws prints banner lines + a JSON object; the payload line starts with '{'.
    const jsonLine = out.split("\n").find(l => l.trim().startsWith("{"));
    if (!jsonLine) return NextResponse.json({ calendars: FALLBACK });

    const parsed = JSON.parse(jsonLine) as {
      items?: Array<{ id?: string; summary?: string; primary?: boolean; accessRole?: string }>;
    };
    const calendars: CalendarEntry[] = (parsed.items ?? [])
      // Only calendars the user can write to can host a new event.
      .filter(c => c.id && (c.accessRole === "owner" || c.accessRole === "writer"))
      .map(c => ({ id: c.id!, summary: c.summary ?? c.id!, primary: c.primary === true }));

    if (calendars.length === 0) return NextResponse.json({ calendars: FALLBACK });

    // Primary first, then alphabetical.
    calendars.sort((a, b) =>
      a.primary === b.primary ? a.summary.localeCompare(b.summary) : a.primary ? -1 : 1,
    );
    return NextResponse.json({ calendars });
  } catch {
    return NextResponse.json({ calendars: FALLBACK });
  }
}
