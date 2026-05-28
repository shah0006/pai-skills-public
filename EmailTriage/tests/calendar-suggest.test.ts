// tests/calendar-suggest.test.ts — Phase 23 calendar v0 coverage.
import { describe, test, expect } from "bun:test";
import { suggestCalendarFromEmail } from "../Tools/CalendarSuggest";

describe("suggestCalendarFromEmail", () => {
  test("subject with meeting cue + body date+time → suggestion", () => {
    const s = suggestCalendarFromEmail({
      subject: "Quick call to discuss Q3 plan",
      body: "Are you free Tuesday at 2pm?",
    });
    expect(s).not.toBeNull();
    expect(s!.confidence).toBeGreaterThan(0.3);
    expect(s!.basis).toContain("meeting cue");
  });

  test("calendar URL in body alone yields high confidence", () => {
    const s = suggestCalendarFromEmail({
      subject: "Re: catch up",
      body: "Here's the link: https://meet.google.com/abc-defg-hij",
    });
    expect(s).not.toBeNull();
    expect(s!.confidence).toBeGreaterThanOrEqual(0.6);
    expect(s!.basis).toContain("URL");
  });

  test("zoom link is detected", () => {
    const s = suggestCalendarFromEmail({
      subject: "Tomorrow",
      body: "Join zoom: https://zoom.us/j/1234567890?pwd=xyz",
    });
    expect(s).not.toBeNull();
    expect(s!.basis).toContain("URL");
  });

  test("plain transactional email → null (no calendar suggestion)", () => {
    const s = suggestCalendarFromEmail({
      subject: "Your receipt from Stripe",
      body: "You paid $42.50 on Tuesday. Thanks.",
    });
    expect(s).toBeNull();
  });

  test("subject 'reschedule' triggers cue", () => {
    const s = suggestCalendarFromEmail({
      subject: "Need to reschedule Thursday",
      body: "Can we move it?",
    });
    expect(s).not.toBeNull();
    expect(s!.basis).toContain("meeting cue");
  });

  test("appointment with explicit date+time", () => {
    const s = suggestCalendarFromEmail({
      subject: "Appointment confirmation",
      body: "Confirmed: Monday at 10:00 AM",
    });
    expect(s).not.toBeNull();
    expect(s!.proposedTime).toContain("Monday");
  });

  test("low-signal email (date only, no time, no cue) → null", () => {
    const s = suggestCalendarFromEmail({
      subject: "Newsletter — May 18",
      body: "This week's stories...",
    });
    expect(s).toBeNull();
  });

  // ── UX-2 (Phase 27.2) structured-field coverage ──

  test("strips the [att] triage marker from the summary", () => {
    const s = suggestCalendarFromEmail({
      subject: "Quick call to discuss Q3 plan [att]",
      body: "Are you free Tuesday at 2pm?",
    });
    expect(s).not.toBeNull();
    expect(s!.summary).toBe("Quick call to discuss Q3 plan");
    expect(s!.summary).not.toContain("[att]");
  });

  test("date+time produces an ISO start and a +30min ISO end", () => {
    const s = suggestCalendarFromEmail({
      subject: "Appointment confirmation",
      body: "Confirmed: Monday at 10:00 AM",
      now: new Date("2026-05-19T12:00:00Z"),
    });
    expect(s).not.toBeNull();
    expect(s!.start).not.toBeNull();
    expect(s!.end).not.toBeNull();
    expect(() => new Date(s!.start!).toISOString()).not.toThrow();
    const span = new Date(s!.end!).getTime() - new Date(s!.start!).getTime();
    expect(span).toBe(30 * 60 * 1000);
  });

  test("extracts a location from a 'Location:' line", () => {
    const s = suggestCalendarFromEmail({
      subject: "Team meeting Thursday",
      body: "Location: Conference Room B\nSee you Thursday at 3pm.",
    });
    expect(s).not.toBeNull();
    expect(s!.location).toContain("Conference Room B");
  });

  test("location capture stops at the sentence boundary on a single-line body", () => {
    const s = suggestCalendarFromEmail({
      subject: "Quick call Tuesday",
      body: "Can we meet Tuesday at 2pm? Location: Conference Room B. Looping in alice@example.com.",
    });
    expect(s).not.toBeNull();
    expect(s!.location).toBe("Conference Room B");
    expect(s!.location).not.toContain("@");
  });

  test("derives a Zoom location when a zoom link is present", () => {
    const s = suggestCalendarFromEmail({
      subject: "Sync tomorrow",
      body: "Join zoom: https://zoom.us/j/1234567890?pwd=xyz",
    });
    expect(s).not.toBeNull();
    expect(s!.location).toContain("Zoom");
  });

  test("parses attendee emails from the body, excluding the sender", () => {
    const s = suggestCalendarFromEmail({
      subject: "Project kickoff call",
      fromAddress: "sender@example.com",
      body: "Looping in alice@example.com and bob@example.com. Tuesday at 2pm.",
    });
    expect(s).not.toBeNull();
    expect(s!.attendees).toContain("alice@example.com");
    expect(s!.attendees).toContain("bob@example.com");
    expect(s!.attendees).not.toContain("sender@example.com");
  });

  test("skips no-reply addresses when collecting attendees", () => {
    const s = suggestCalendarFromEmail({
      subject: "Meeting invite",
      body: "Sent by noreply@calendar.com. Real contact: carol@example.com. Friday at 9am.",
    });
    expect(s).not.toBeNull();
    expect(s!.attendees).toContain("carol@example.com");
    expect(s!.attendees.some(a => /noreply/i.test(a))).toBe(false);
  });
});
