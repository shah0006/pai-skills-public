// /api/settings/junk — Phase 29 Junk senders panel.
//   GET    → { junk: Array<{id,address,domain,reason}> }
//   POST   { address? , domain?, reason? } → adds
//   DELETE { id }                          → removes

import { NextResponse } from "next/server";
import { initDb, getJunkSenderRows, addJunkSender, removeJunkSender } from "../../../../../Tools/Db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const db = initDb();
    const junk = getJunkSenderRows(db);
    db.close();
    return NextResponse.json({ junk });
  } catch (e) {
    return NextResponse.json({ junk: [], error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const address = typeof body.address === "string" ? body.address.trim().toLowerCase() : "";
    const domain = typeof body.domain === "string" ? body.domain.trim().toLowerCase() : "";
    if (!address && !domain) {
      return NextResponse.json({ error: "address or domain required" }, { status: 400 });
    }
    const db = initDb();
    addJunkSender(db, {
      address: address || undefined,
      domain: domain || undefined,
      reason: typeof body.reason === "string" ? body.reason : "manual",
    });
    const junk = getJunkSenderRows(db);
    db.close();
    return NextResponse.json({ success: true, junk });
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const id = typeof body.id === "number" ? body.id : Number(body.id);
    if (!Number.isInteger(id)) return NextResponse.json({ error: "numeric id required" }, { status: 400 });
    const db = initDb();
    removeJunkSender(db, id);
    const junk = getJunkSenderRows(db);
    db.close();
    return NextResponse.json({ success: true, junk });
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
