// POST /api/generate
// Body: { test?: boolean, date?: string }
// Returns: SSE stream with `event: progress` updates + final `event: result`
// (matching the client's generateWithProgress() reader at page.tsx:2081).

export const dynamic = "force-dynamic";
export const maxDuration = 300; // 5 minutes for AI classification

function sse(eventType: string, data: unknown): string {
  return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({} as { test?: boolean; date?: string }));
  const testMode = body.test ?? false;
  const date = body.date ?? new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const enqueue = (chunk: string) => controller.enqueue(encoder.encode(chunk));
      try {
        const { generateTriage } = await import("../../../../Tools/GenerateTriage");
        const result = await generateTriage({
          testMode,
          date,
          onProgress: (step: string, detail: string) => {
            enqueue(sse("progress", { step, detail }));
          },
        });
        enqueue(sse("result", { session: result.session }));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        enqueue(sse("error", { error: message }));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
