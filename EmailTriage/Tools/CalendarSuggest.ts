// Tools/CalendarSuggest.ts — Phase 23: calendar bidirectionality.
//
// Two-pass architecture:
//   Pass 1 (sync): regex heuristics detect meeting/appointment cues and
//     extract structured fields (date, time, location, attendees).
//   Pass 2 (async, UX-3): enrichCalendarSuggestionWithAI() sends the email
//     to claude-haiku and merges any field improvements back into the base
//     suggestion. Fields already well-extracted by regex are preserved; only
//     fields where AI produces a better value are updated. Graceful fallback
//     if ANTHROPIC_API_KEY is absent or the call fails — returns regex result.
//
// The API route (web/app/api/calendar/suggest/route.ts) runs both passes.
// suggestCalendarFromEmail() remains synchronous so existing tests are unaffected.
//
// CLI usage:
//   bun Tools/CalendarSuggest.ts --email "<subject>" "<body>"

export interface CalendarSuggestion {
  emailId?: string;
  fromAddress?: string;
  /** Plain-English summary the user can copy into a calendar invite. `[att]` marker stripped. */
  summary: string;
  /** ISO 8601 start time if parseable, else null. */
  start: string | null;
  /** ISO 8601 end time. Defaults to start + 30 min when start is known. */
  end: string | null;
  /** Free-text location (address, conference room, "Zoom", etc) if found. */
  location: string | null;
  /** Multi-line description seed (body excerpt or matched cue context). */
  description: string | null;
  /** Attendees parsed from the body — email addresses, deduplicated, sender excluded. */
  attendees: string[];
  /** Confidence 0..1 — higher when subject explicitly mentions meeting cues. */
  confidence: number;
  /** Free-text rationale: what cues matched. */
  basis: string;
  /** Legacy field kept for backwards compat — human-readable raw match text. */
  proposedTime: string | null;
}

const MEETING_SUBJECT_CUES = [
  /\b(meeting|call|appointment|schedule[d]?|invite|invitation)\b/i,
  /\b(reschedule|reschedul[ei])\b/i,
  /\bquick (chat|sync|catchup|call)\b/i,
  /\bzoom\b/i,
  /\bteams meeting\b/i,
  /\bgoogle meet\b/i,
];

const BODY_TIME_PATTERNS: RegExp[] = [
  /\b(\d{1,2}:\d{2}\s*(?:am|pm|AM|PM)?)\b/,
  /\b(\d{1,2}\s*(?:am|pm|AM|PM))\b/,
];

const BODY_DATE_PATTERNS: RegExp[] = [
  /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+(?:at\s+)?(\d{1,2}:?\d{0,2}\s*(?:am|pm|AM|PM)?)\b/i,
  /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{1,2}(?:[,\s]+\d{4})?\b/i,
  /\b(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\b/,
];

const CALENDAR_LINK_PATTERNS: RegExp[] = [
  /calendar\.google\.com\/calendar\/u\/0\/r\/eventedit\?[^"\s)]+/i,
  /https?:\/\/calendar\.app\.google\/[^\s)>]+/i,
  /https?:\/\/zoom\.us\/[a-z]\/[A-Za-z0-9?=&_-]+/i,
  /https?:\/\/teams\.microsoft\.com\/l\/meetup-join\/[^\s)>]+/i,
  /https?:\/\/meet\.google\.com\/[a-z-]+/i,
];

const LOCATION_PATTERNS: RegExp[] = [
  // Label on its own line followed by address on the next line — common in
  // appointment confirmation emails (e.g. "Where\nCVS Pharmacy counter...").
  /\b(?:location|where|venue|address|meeting\s+room|conf(?:erence)?\s+room)\s*:?\s*[\r\n]+\s*([^\n\r]{10,200})/i,
  // Label + content on the same line ("Where: <address>", "Location — <room>").
  /\b(?:location|where|venue|address|meeting\s+room|conf(?:erence)?\s+room)\s*[:\-]\s*([^\n\r.]{3,120}?)(?=[.\n\r]|$)/i,
  // Street address heuristic — handles hyphenated city names (e.g. Miamisburg-Centerville).
  /\b(\d{1,5}\s+[A-Za-z]+(?:[\s-][A-Za-z]+)*(?:\s+(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Ln|Lane|Dr|Drive|Way|Pl|Place|Ct|Court))[,.\s]*(?:[A-Z][a-z]+[,\s]+)?(?:[A-Z]{2}\s+)?(?:\d{5})?)\b/,
];

const EMAIL_ADDRESS_REGEX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

/**
 * Strip the `[att]` (attachment) triage marker and common email subject prefixes
 * ("Confirmed:", "RE:", "FW:", "Reminder:", etc.) that shouldn't appear verbatim
 * in a calendar event title.
 */
function stripTriageMarkers(subject: string): string {
  return subject
    .replace(/\s*\[att\]\s*$/i, "")
    // Strip leading confirmation/reply/forward/reminder prefixes (case-insensitive,
    // one or more separated by spaces or colons, e.g. "Confirmed: RE: Reminder:").
    .replace(/^(?:(?:confirmed|re|fw|fwd|reminder|alert|notice|notification|appt|appointment)\s*:\s*)+/i, "")
    .trim();
}

/**
 * Best-effort ISO 8601 conversion from a free-text date+time match. Returns
 * null if a confident parse isn't possible — UI then surfaces an inline
 * editable placeholder.
 */
function toIsoDateTime(date: string | undefined, time: string | undefined, now = new Date()): string | null {
  if (!date && !time) return null;
  let target = new Date(now.getTime());

  if (date) {
    const dayMatch = date.match(/^(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i);
    if (dayMatch) {
      const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
      const targetDow = days.indexOf(dayMatch[1].toLowerCase());
      const currentDow = target.getDay();
      let delta = targetDow - currentDow;
      if (delta <= 0) delta += 7;
      target.setDate(target.getDate() + delta);
    } else {
      // Month+day without year (e.g. "July 20", "Jul 20"). JS engines like Bun
      // parse "July 20" as year 2001. Inject the current year explicitly, then
      // advance by one year if the result is already in the past.
      const monthDayRe = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+(\d{1,2})(?:[,\s]+(\d{4}))?/i;
      const md = date.match(monthDayRe);
      if (md) {
        const explicitYear = md[3] ? parseInt(md[3], 10) : null;
        const year = explicitYear ?? now.getFullYear();
        // Build unambiguous string: "Jul 20 2026"
        const parsed = new Date(`${md[1]} ${md[2]} ${year}`);
        if (!isNaN(parsed.getTime())) {
          // If no year was specified and the date is in the past, the appointment
          // is likely next year (e.g. "July 20" referenced in December 2026).
          if (!explicitYear && parsed < now) {
            parsed.setFullYear(year + 1);
          }
          target = parsed;
        } else return null;
      } else {
        const parsed = new Date(date);
        if (!isNaN(parsed.getTime())) target = parsed;
        else return null;
      }
    }
  }

  if (time) {
    const timeMatch = time.match(/^(\d{1,2}):?(\d{2})?\s*(am|pm)?$/i);
    if (timeMatch) {
      let hours = parseInt(timeMatch[1], 10);
      const minutes = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
      const meridiem = timeMatch[3]?.toLowerCase();
      if (meridiem === "pm" && hours < 12) hours += 12;
      if (meridiem === "am" && hours === 12) hours = 0;
      target.setHours(hours, minutes, 0, 0);
    } else {
      target.setHours(9, 0, 0, 0);
    }
  } else {
    target.setHours(9, 0, 0, 0);
  }

  return target.toISOString();
}

export function suggestCalendarFromEmail(args: {
  emailId?: string;
  fromAddress?: string;
  subject: string;
  body: string;
  now?: Date;
}): CalendarSuggestion | null {
  const { subject, body, fromAddress } = args;
  const combined = `${subject}\n${body}`;

  const subjectHasMeetingCue = MEETING_SUBJECT_CUES.some(p => p.test(subject));

  let calendarLink: string | undefined;
  for (const p of CALENDAR_LINK_PATTERNS) {
    const m = combined.match(p);
    if (m) { calendarLink = m[0]; break; }
  }

  let dateMatch: string | undefined;
  let timeMatch: string | undefined;
  for (const p of BODY_DATE_PATTERNS) {
    const m = combined.match(p);
    if (m) { dateMatch = m[0]; break; }
  }
  for (const p of BODY_TIME_PATTERNS) {
    const m = combined.match(p);
    if (m) { timeMatch = m[1] ?? m[0]; break; }
  }

  if (!subjectHasMeetingCue && !calendarLink && !(dateMatch && timeMatch)) {
    return null;
  }

  let confidence = 0;
  const bases: string[] = [];
  if (calendarLink) { confidence += 0.6; bases.push("calendar/meeting URL in body"); }
  if (subjectHasMeetingCue) { confidence += 0.25; bases.push("meeting cue in subject"); }
  if (dateMatch && timeMatch) { confidence += 0.2; bases.push(`date+time "${dateMatch} ${timeMatch}"`); }
  if (dateMatch && !timeMatch) { confidence += 0.05; bases.push(`date "${dateMatch}"`); }
  confidence = Math.min(1, confidence);

  if (confidence < 0.25) return null;

  const proposedTime = dateMatch && timeMatch
    ? `${dateMatch} ${timeMatch}`
    : dateMatch ?? timeMatch ?? null;

  const start = toIsoDateTime(dateMatch, timeMatch, args.now);
  const end = start ? new Date(new Date(start).getTime() + 30 * 60 * 1000).toISOString() : null;

  let location: string | null = null;
  for (const p of LOCATION_PATTERNS) {
    const m = combined.match(p);
    if (m) { location = (m[1] ?? m[0]).trim().replace(/\s+/g, " "); break; }
  }
  if (!location && calendarLink) {
    if (/zoom\.us/.test(calendarLink)) location = "Zoom (link in description)";
    else if (/meet\.google\.com/.test(calendarLink)) location = "Google Meet (link in description)";
    else if (/teams\.microsoft\.com/.test(calendarLink)) location = "Microsoft Teams (link in description)";
  }

  const attendees: string[] = [];
  const seenAttendees = new Set<string>();
  if (fromAddress) seenAttendees.add(fromAddress.toLowerCase());
  for (const m of combined.matchAll(EMAIL_ADDRESS_REGEX)) {
    const addr = m[0].toLowerCase();
    if (seenAttendees.has(addr)) continue;
    if (/(noreply|no-reply|donotreply|notification|alert|auto|mailer)/i.test(addr)) continue;
    seenAttendees.add(addr);
    attendees.push(m[0]);
    if (attendees.length >= 5) break;
  }

  const bodyLines = body.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const descriptionSeed = bodyLines.slice(0, 3).join(" ").slice(0, 240);
  const description = calendarLink
    ? `${descriptionSeed}\n\nLink: ${calendarLink}`.trim()
    : descriptionSeed || null;

  return {
    emailId: args.emailId,
    fromAddress,
    summary: stripTriageMarkers(subject).slice(0, 100),
    start,
    end,
    location,
    description,
    attendees,
    confidence,
    basis: bases.join(" + "),
    proposedTime,
  };
}

// ─── AI enrichment layer (Pass 2) ────────────────────────────────────────────

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const AI_ENRICH_MODEL = "claude-haiku-4-5-20251001"; // fast + cheap for structured extraction
const AI_ENRICH_TIMEOUT = 12_000; // 12 s — must fit inside Next.js 30 s edge budget

/**
 * LLM-powered enrichment: takes a base CalendarSuggestion (from the regex pass)
 * and the original email, sends them to Haiku, and merges any improved fields
 * back into the suggestion. Fields are only overwritten when the AI produces a
 * non-empty, non-null value that is strictly better (i.e. different from the
 * regex result or filling a gap the regex left null).
 *
 * Returns the original `base` unchanged on any error or missing API key.
 */
export async function enrichCalendarSuggestionWithAI(
  base: CalendarSuggestion,
  subject: string,
  body: string,
): Promise<CalendarSuggestion> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return base; // graceful fallback — regex result is still useful

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD for year anchor

  const systemPrompt = `You extract calendar event fields from appointment/meeting emails.
Today is ${today}. Return ONLY a JSON object — no prose, no markdown fences.

Required fields (use null when genuinely unknown):
{
  "title": string,          // concise human event name, e.g. "Vaccine appointment" not the full subject line
  "start": string | null,   // ISO 8601 full datetime with correct year (${today.slice(0, 4)} unless stated otherwise)
  "end":   string | null,   // ISO 8601; default start + 1 h if duration not given (appointments) or + 30 min (calls)
  "location": string | null,// full address or venue name; null if not mentioned
  "description": string | null // 1-2 sentence summary of what the event is; null if nothing useful
}

Rules:
- Title: drop email prefixes like "Confirmed:", "RE:", "Reminder:". Use the appointment type as the noun ("Vaccine appointment", "Cardiology consultation", "Team standup").
- Dates: always include the full year. If only month+day given, use ${today.slice(0, 4)} unless that date is already past, then use ${parseInt(today.slice(0, 4)) + 1}.
- Times: convert to UTC ISO 8601. If timezone given (e.g. EDT = UTC-4), apply the offset.
- Location: include full street address when present. For pharmacies/clinics, include the chain name AND full address.
- If the email is a Zoom/Teams/Meet link, set location to the URL.
- Do NOT invent information not present in the email.`;

  const userPrompt = `Subject: ${subject}\n\n${body.slice(0, 2000)}`;

  try {
    const response = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: AI_ENRICH_MODEL,
        max_tokens: 512,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      }),
      signal: AbortSignal.timeout(AI_ENRICH_TIMEOUT),
    });

    if (!response.ok) return base; // API error → fall back to regex

    const data = await response.json() as { content: Array<{ type: string; text?: string }> };
    const rawText = data.content.filter(b => b.type === "text" && b.text).map(b => b.text!).join("\n").trim();

    // Strip accidental markdown code fences
    const jsonText = rawText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    const ai = JSON.parse(jsonText) as {
      title?: string | null;
      start?: string | null;
      end?: string | null;
      location?: string | null;
      description?: string | null;
    };

    // Merge: only accept AI values that are non-empty strings
    const merged: CalendarSuggestion = { ...base };
    if (typeof ai.title === "string" && ai.title.trim()) {
      merged.summary = ai.title.trim().slice(0, 100);
    }
    if (typeof ai.start === "string" && ai.start.trim() && !isNaN(new Date(ai.start).getTime())) {
      merged.start = new Date(ai.start).toISOString();
      // Recompute end from new start if AI didn't give end or gave a bad end
      if (typeof ai.end !== "string" || isNaN(new Date(ai.end).getTime())) {
        merged.end = new Date(new Date(merged.start).getTime() + 60 * 60 * 1000).toISOString();
      }
    }
    if (typeof ai.end === "string" && ai.end.trim() && !isNaN(new Date(ai.end).getTime())) {
      merged.end = new Date(ai.end).toISOString();
    }
    if (typeof ai.location === "string" && ai.location.trim()) {
      merged.location = ai.location.trim();
    }
    if (typeof ai.description === "string" && ai.description.trim()) {
      merged.description = ai.description.trim();
    }

    return merged;
  } catch {
    return base; // parse error, timeout, network issue → regex result is fine
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  if (argv.length < 2 || argv[0] !== "--email") {
    console.log("Usage: bun Tools/CalendarSuggest.ts --email \"<subject>\" \"<body>\"");
    process.exit(0);
  }
  const subject = argv[1];
  const body = argv[2] ?? "";
  const s = suggestCalendarFromEmail({ subject, body });
  console.log(JSON.stringify(s, null, 2));
}
