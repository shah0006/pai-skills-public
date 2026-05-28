// web/server/transcribe.ts — R2 voice end-to-end.
//
// Server-side audio transcription via the OpenAI audio API. Used by
// /api/draft/from-voice when a voice memo arrives as an audio file rather
// than as pre-transcribed text. This module only calls the OpenAI API —
// it performs no live-mailbox interaction.

const OPENAI_TRANSCRIBE_URL = "https://api.openai.com/v1/audio/transcriptions";
const TRANSCRIBE_MODEL = process.env.OPENAI_TRANSCRIBE_MODEL?.trim() || "whisper-1";

export interface TranscriptionResult {
  text: string;
  model: string;
}

/** Distinct error type so the route can map transcription failures to a 502. */
export class TranscriptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranscriptionError";
  }
}

/**
 * Transcribe an audio clip to text via the OpenAI audio API.
 * @param audio    the audio file (a Blob / File from multipart form data)
 * @param filename original filename — its extension tells OpenAI the format
 */
export async function transcribeAudio(audio: Blob, filename: string): Promise<TranscriptionResult> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new TranscriptionError("OPENAI_API_KEY is not configured");
  }
  if (!audio || audio.size === 0) {
    throw new TranscriptionError("audio file is empty");
  }

  const form = new FormData();
  form.append("file", audio, filename || "audio.wav");
  form.append("model", TRANSCRIBE_MODEL);
  form.append("response_format", "json");

  let res: Response;
  try {
    res = await fetch(OPENAI_TRANSCRIBE_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
  } catch (err) {
    throw new TranscriptionError(`could not reach the OpenAI API: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new TranscriptionError(`OpenAI transcription failed (${res.status}): ${detail.slice(0, 300)}`);
  }

  const json = await res.json().catch(() => null) as { text?: string } | null;
  const text = json?.text?.trim() ?? "";
  if (!text) {
    throw new TranscriptionError("transcription returned empty text");
  }
  return { text, model: TRANSCRIBE_MODEL };
}
