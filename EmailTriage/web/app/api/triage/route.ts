// GET /api/triage?date=YYYY-MM-DD
// Returns: { noteContent: string | null, exists: boolean }

import { NextResponse } from "next/server";
import { readFileSync, existsSync } from "fs";
import { getTriageNotePath, getVaultRoot } from "../../../server/paths";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const date = url.searchParams.get("date");

    if (!date) {
      return NextResponse.json(
        { error: "date query parameter is required (YYYY-MM-DD)" },
        { status: 400 },
      );
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json(
        { error: "date must be in YYYY-MM-DD format" },
        { status: 400 },
      );
    }

    const filePath = getTriageNotePath(date);

    if (!existsSync(filePath)) {
      return NextResponse.json({ noteContent: null, exists: false });
    }

    const noteContent = readFileSync(filePath, "utf-8");
    return NextResponse.json({ noteContent, exists: true, notePath: filePath });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
