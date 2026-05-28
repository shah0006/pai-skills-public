// POST /api/email/batch
// Body: { ids: string[] }
// Returns: { bodies: Record<string, string> }

import { NextResponse } from "next/server";
import { readEmailBodyAsync } from "../../../../server/email-read";
import { isGmailMessageId, isIcloudMessageId } from "../../../../server/paths";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const bodyJson = await req.json() as {
      ids?: unknown;
      mailboxById?: Record<string, string>;
      defaultMailbox?: string;
    };
    const { ids, mailboxById, defaultMailbox } = bodyJson;
    if (!Array.isArray(ids) || ids.length === 0) {
      return NextResponse.json({ bodies: {} });
    }

    const validIds = ids
      .slice(0, 10)
      .filter((id: unknown): id is string =>
        typeof id === "string" && (isIcloudMessageId(id) || isGmailMessageId(id)));

    const bodies: Record<string, string> = {};
    // BATCH_SIZE bounds concurrency — gentle on Mail.app / gws while still
    // running the window of reads in parallel (readEmailBodyAsync is true-async).
    const BATCH_SIZE = 3;
    for (let i = 0; i < validIds.length; i += BATCH_SIZE) {
      const batch = validIds.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(batch.map(async (id) => {
          try {
            const mb = mailboxById?.[id]?.trim() || defaultMailbox?.trim() || undefined;
            const { body } = await readEmailBodyAsync(id, { mailbox: mb });
            return { id, body };
          } catch {
            return { id, body: "" };
          }
        }));
      for (const { id, body } of results) {
        if (body) bodies[id] = body;
      }
    }

    return NextResponse.json({ bodies });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
