// GET /api/email/:id
// Returns: { id, body } — iCloud via apple-mail.sh; Gmail via gws

import { NextResponse } from "next/server";
import { readEmailBody } from "../../../../server/email-read";
import { isGmailMessageId, isIcloudMessageId } from "../../../../server/paths";

export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    if (!id || (!isIcloudMessageId(id) && !isGmailMessageId(id))) {
      return NextResponse.json({ error: "Invalid email ID" }, { status: 400 });
    }

    const url = new URL(req.url);
    const mailbox = url.searchParams.get("mailbox")?.trim() || undefined;
    const subject = url.searchParams.get("subject")?.trim() || undefined;
    const from = url.searchParams.get("from")?.trim() || undefined;

    const result = readEmailBody(id, { mailbox, subject, from });
    return NextResponse.json({
      id: result.resolvedId ?? id,
      body: result.body,
      resolvedFromOldId: !!result.resolvedId,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
