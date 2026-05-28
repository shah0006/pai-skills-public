// /api/settings — Phase 29 key/value settings (AI summarizer prompt, model,
// provider, receipt-folder path, and other per-user tunables).
//   GET  → { settings: Record<string,string|null> }
//   POST { key, value } | { settings: Record<string,string> } → persists, returns the full set.

import { NextResponse } from "next/server";
import { initDb, getAllSettings, setSetting } from "../../../../Tools/Db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const db = initDb();
    const settings = getAllSettings(db);
    db.close();
    return NextResponse.json({ settings });
  } catch (e) {
    return NextResponse.json({ settings: {}, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const db = initDb();
    if (body.settings && typeof body.settings === "object") {
      for (const [k, v] of Object.entries(body.settings as Record<string, unknown>)) {
        if (typeof v === "string") setSetting(db, k, v);
      }
    } else if (typeof body.key === "string" && typeof body.value === "string") {
      setSetting(db, body.key, body.value);
    } else {
      db.close();
      return NextResponse.json({ error: "Body must be { key, value } or { settings: {...} }" }, { status: 400 });
    }
    const settings = getAllSettings(db);
    db.close();
    return NextResponse.json({ success: true, settings });
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
