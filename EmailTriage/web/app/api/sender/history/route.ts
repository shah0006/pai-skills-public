// GET /api/sender/history?address=<email>&domain=<host>
//
// Returns the user's historical decisions for a sender (address) or domain,
// sourced from domain_activity via Tools/SenderMemory. Both address and
// domain are optional; supply at least one. When both are given, the
// response includes both keyed under `address` and `domain`.
//
// Phase 22 v0 (Intelligence — sender memory).

import { NextResponse } from "next/server";
import { initDb } from "../../../../../Tools/Db";
import { getSenderHistory, getDomainHistory, type SenderHistory } from "../../../../../Tools/SenderMemory";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const address = url.searchParams.get("address")?.trim() || undefined;
    const domain  = url.searchParams.get("domain")?.trim()  || undefined;

    if (!address && !domain) {
      return NextResponse.json({ error: "address or domain required" }, { status: 400 });
    }

    const db = initDb();
    const result: { address?: SenderHistory; domain?: SenderHistory } = {};
    if (address) result.address = getSenderHistory(db, address);
    if (domain)  result.domain  = getDomainHistory(db, domain);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
