// /api/settings/vip — Phase 29 VIP senders panel.
//   GET    → { vip: string[] }
//   POST   { address, name? } → adds
//   DELETE { address }        → removes

import { NextResponse } from "next/server";
import { initDb, getVipSenders, addVipSender, removeVipSender } from "../../../../../Tools/Db";

export const dynamic = "force-dynamic";

function list(db: ReturnType<typeof initDb>) {
  return [...getVipSenders(db)].sort();
}

export async function GET() {
  try {
    const db = initDb();
    const vip = list(db);
    db.close();
    return NextResponse.json({ vip });
  } catch (e) {
    return NextResponse.json({ vip: [], error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const address = typeof body.address === "string" ? body.address.trim().toLowerCase() : "";
    if (!address || !address.includes("@")) {
      return NextResponse.json({ error: "Valid email address required" }, { status: 400 });
    }
    const db = initDb();
    addVipSender(db, address, typeof body.name === "string" ? body.name : undefined);
    const vip = list(db);
    db.close();
    return NextResponse.json({ success: true, vip });
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const address = typeof body.address === "string" ? body.address.trim().toLowerCase() : "";
    if (!address) return NextResponse.json({ error: "address required" }, { status: 400 });
    const db = initDb();
    removeVipSender(db, address);
    const vip = list(db);
    db.close();
    return NextResponse.json({ success: true, vip });
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
