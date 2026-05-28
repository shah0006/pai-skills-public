// POST /api/draft/from-voice
//
// Voice-to-draft. Two accepted request shapes:
//
//  1. multipart/form-data with an `audio` file (R2 voice end-to-end) — the
//     audio is transcribed server-side via the OpenAI audio API, and the
//     transcript becomes the draft body.
//  2. application/json `{ recipient, subject, transcript, account?, inReplyTo? }`
//     (the original v0 path) — the transcript is supplied pre-made.
//
// Either way the result is a staged draft file in the Email Triage/Staged/
// workflow, ready for human review + send. No live-mailbox interaction.
//
// Returns: { success, path, emailId, transcript } or { success:false, error }.

import { NextResponse } from "next/server";
import { stageDraft } from "../../../../../Tools/StagedDrafts";
import { transcribeAudio, TranscriptionError } from "../../../../server/transcribe";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const contentType = req.headers.get("content-type") ?? "";

    let recipient = "";
    let subject = "";
    let transcript = "";
    let account = "iCloud";
    let inReplyTo: string | undefined;
    let transcribedFrom: string | undefined;

    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      recipient = String(form.get("recipient") ?? "").trim();
      subject = String(form.get("subject") ?? "").trim();
      const acct = String(form.get("account") ?? "").trim();
      if (acct) account = acct;
      const irt = String(form.get("inReplyTo") ?? "").trim();
      if (irt) inReplyTo = irt;

      const audio = form.get("audio");
      const textTranscript = String(form.get("transcript") ?? "").trim();

      if (audio instanceof Blob && audio.size > 0) {
        // The OpenAI audio API rejects files over 25 MB — guard with a clear
        // 400 rather than letting the upload fail downstream as an opaque 502.
        if (audio.size > 25 * 1024 * 1024) {
          return NextResponse.json({ success: false, error: "audio file too large (max 25 MB)" }, { status: 400 });
        }
        const filename = audio instanceof File && audio.name ? audio.name : "voice.wav";
        try {
          const result = await transcribeAudio(audio, filename);
          transcript = result.text;
          transcribedFrom = filename;
        } catch (err) {
          const message = err instanceof TranscriptionError ? err.message : String(err);
          return NextResponse.json({ success: false, error: `transcription failed: ${message}` }, { status: 502 });
        }
      } else if (textTranscript) {
        transcript = textTranscript;
      }
    } else {
      const body = await req.json().catch(() => ({})) as Record<string, unknown>;
      recipient  = typeof body.recipient === "string" ? body.recipient.trim() : "";
      subject    = typeof body.subject === "string" ? body.subject.trim() : "";
      transcript = typeof body.transcript === "string" ? body.transcript.trim() : "";
      const acct = typeof body.account === "string" ? body.account.trim() : "";
      if (acct) account = acct;
      inReplyTo  = typeof body.inReplyTo === "string" && body.inReplyTo.trim() ? body.inReplyTo.trim() : undefined;
    }

    if (!recipient)  return NextResponse.json({ success: false, error: "recipient required" }, { status: 400 });
    if (!subject)    return NextResponse.json({ success: false, error: "subject required"   }, { status: 400 });
    if (!transcript) return NextResponse.json({ success: false, error: "transcript or audio required" }, { status: 400 });

    // Compose a draft. emailId is a synthetic 'voice-<timestamp>' marker so it
    // doesn't collide with real Gmail/iCloud numeric IDs in the staged dir.
    const emailId = `voice-${Date.now()}`;
    const path = stageDraft({
      emailId,
      to: recipient,
      subject,
      inReplyTo,
      account,
      body: transcript,
      stagedAt: new Date().toISOString(),
    });

    return NextResponse.json({ success: true, path, emailId, transcript, transcribedFrom });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
