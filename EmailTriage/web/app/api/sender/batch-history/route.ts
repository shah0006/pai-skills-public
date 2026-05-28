// POST /api/sender/batch-history
//
// Batched variant of /api/sender/history — accepts an array of
// { address, domain } pairs and returns a map of sender → SenderHistory.
// Used by the EmailListItem to render compact 'NT' / 'NA' badges
// without firing N parallel single-sender requests on session load.
//
// Body: { senders: Array<{ address?: string; domain?: string }> }
// Returns: { results: Array<{ address?, domain?, history }> }

import { NextResponse } from "next/server";
import { initDb } from "../../../../../Tools/Db";
import { getSenderHistory, getDomainHistory, type SenderHistory } from "../../../../../Tools/SenderMemory";

export const dynamic = "force-dynamic";

interface SenderQuery {
  address?: string;
  domain?: string;
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({})) as { senders?: unknown };
    if (!Array.isArray(body.senders)) {
      return NextResponse.json({ error: "senders array required" }, { status: 400 });
    }
    const db = initDb();
    const results = body.senders.map((s: unknown) => {
      const q = s as SenderQuery;
      const address = typeof q.address === "string" && q.address.trim() ? q.address.trim().toLowerCase() : undefined;
      const domain  = typeof q.domain  === "string" && q.domain.trim()  ? q.domain.trim().toLowerCase()  : undefined;
      const history: { address?: SenderHistory; domain?: SenderHistory } = {};
      if (address) history.address = getSenderHistory(db, address);
      if (domain)  history.domain  = getDomainHistory(db, domain);
      return { address, domain, history };
    });
    return NextResponse.json({ results });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
