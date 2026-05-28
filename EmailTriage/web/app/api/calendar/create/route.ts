// POST /api/calendar/create
//
// Phase 23 v1 / UX-2 (Phase 27.2) — creates a Google Calendar event.
//
// Two payload shapes are accepted:
//
//   Structured (preferred, UX-2):
//     { summary, start, end, location?, description?, attendees?[], calendarId?, meet? }
//     → runs `gws calendar +insert` with each field passed explicitly.
//
//   Legacy text (kept for backwards compat):
//     { text, calendarId? }
//     → runs `gws calendar events quickAdd` (natural-language parse).
//
// Returns: { success, eventId?, htmlLink?, error? }

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

declare const Bun: {
  spawn(args: string[], opts?: { stdout?: string; stderr?: string }): {
    stdout: ReadableStream;
    stderr: ReadableStream;
    exited: Promise<number>;
  };
};

async function runGws(args: string[]): Promise<{ exitCode: number; out: string; err: string }> {
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [out, err, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, out, err };
}

function parseEventJson(out: string): { eventId?: string; htmlLink?: string; raw?: string } {
  // gws prints status banner lines + JSON; the JSON line starts with '{'.
  const jsonLine = out.split("\n").find(l => l.trim().startsWith("{"));
  if (!jsonLine) return { raw: out.slice(0, 500) };
  try {
    const event = JSON.parse(jsonLine) as { id?: string; htmlLink?: string };
    return { eventId: event.id, htmlLink: event.htmlLink };
  } catch {
    return { raw: out.slice(0, 500) };
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const calendarId = typeof body.calendarId === "string" && body.calendarId.trim()
      ? body.calendarId.trim()
      : "primary";

    // ── Structured path (UX-2) ──
    const summary = typeof body.summary === "string" ? body.summary.trim() : "";
    const start = typeof body.start === "string" ? body.start.trim() : "";
    const end = typeof body.end === "string" ? body.end.trim() : "";

    if (summary && start && end) {
      const args = [
        "gws", "calendar", "+insert",
        "--calendar", calendarId,
        "--summary", summary,
        "--start", start,
        "--end", end,
        "--format", "json",
      ];
      const location = typeof body.location === "string" ? body.location.trim() : "";
      const description = typeof body.description === "string" ? body.description.trim() : "";
      if (location) args.push("--location", location);
      if (description) args.push("--description", description);
      if (Array.isArray(body.attendees)) {
        for (const a of body.attendees) {
          if (typeof a === "string" && a.includes("@")) args.push("--attendee", a.trim());
        }
      }
      if (body.meet === true) args.push("--meet");

      const { exitCode, out, err } = await runGws(args);
      if (exitCode !== 0) {
        return NextResponse.json(
          { success: false, error: `gws +insert exited ${exitCode}: ${err.trim() || out.trim()}` },
          { status: 500 },
        );
      }
      const parsed = parseEventJson(out);
      return NextResponse.json({ success: true, ...parsed });
    }

    // ── Legacy text path (quickAdd natural-language parse) ──
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) {
      return NextResponse.json(
        { success: false, error: "Provide either {summary,start,end} or {text}" },
        { status: 400 },
      );
    }
    const params = JSON.stringify({ calendarId, text });
    const { exitCode, out, err } = await runGws(
      ["gws", "calendar", "events", "quickAdd", "--params", params, "--format", "json"],
    );
    if (exitCode !== 0) {
      return NextResponse.json(
        { success: false, error: `gws quickAdd exited ${exitCode}: ${err.trim() || out.trim()}` },
        { status: 500 },
      );
    }
    const parsed = parseEventJson(out);
    return NextResponse.json({ success: true, ...parsed });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
