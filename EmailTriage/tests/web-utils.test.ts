// tests/web-utils.test.ts — coverage for web/app/utils.ts pure helpers.
import { describe, test, expect } from "bun:test";
import { subjectConveysFullAsk, extractSenderName } from "../web/app/utils";

describe("extractSenderName", () => {
  test("pulls the display name out of 'Name <email>'", () => {
    expect(extractSenderName("Jane Doe <jane@example.com>")).toBe("Jane Doe");
  });
  test("falls back to the raw string when there is no angle-bracket form", () => {
    expect(extractSenderName("jane@example.com")).toBe("jane@example.com");
  });
});

describe("subjectConveysFullAsk (UX-3 auto-summary gate)", () => {
  test("short subject never counts as conveying the full ask", () => {
    expect(subjectConveysFullAsk("Quick question", "some body text here")).toBe(false);
  });

  test("long subject with no date/time does not count", () => {
    expect(
      subjectConveysFullAsk(
        "Following up on our earlier conversation about the project roadmap",
        "Here are the details we discussed in depth over several paragraphs ...",
      ),
    ).toBe(false);
  });

  test("long subject carrying a concrete date + boilerplate body → conveys the ask", () => {
    const subject = "Your dental appointment with Dayton Dental is confirmed for Nov 17";
    const body = "This is an automated reminder. Reply STOP to opt out.";
    expect(subjectConveysFullAsk(subject, body)).toBe(true);
  });

  test("long subject with a date but a substantial body → does NOT skip (body adds detail)", () => {
    const subject = "Your appointment is confirmed for Nov 17 — please review the details";
    const body = "word ".repeat(120); // body far longer than the subject
    expect(subjectConveysFullAsk(subject, body)).toBe(false);
  });

  test("long subject with a time cue and boilerplate body → conveys the ask", () => {
    const subject = "Reminder: your pharmacy pickup window closes today at 6pm sharp";
    const body = "Visit your local store. Thank you.";
    expect(subjectConveysFullAsk(subject, body)).toBe(true);
  });
});
