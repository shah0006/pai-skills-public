// GET /api/email-types
//
// AD-1: serves the email-type taxonomy from the `email_types` DB table so the
// web client classifier derives its types from the single source of truth
// rather than a hardcoded regex cascade.
//
// Returns: { types: EmailType[] } — enabled types, ordered by sort_order.
// Self-healing: if the table is empty (a triage.db that predates the AD-1
// migration), runMigration is invoked once to create + seed it.

import { NextResponse } from "next/server";
import {
  initDb, getEmailTypes, runMigration,
  addEmailType, updateEmailType, deleteEmailType,
} from "../../../../Tools/Db";

export const dynamic = "force-dynamic";

// GET → enabled types only (the classifier must not classify with a disabled
// type). GET ?all=1 → every type including disabled, for the Settings Categories
// editor.
export async function GET(req: Request) {
  try {
    const includeDisabled = new URL(req.url).searchParams.get("all") === "1";
    const db = initDb();
    let types = getEmailTypes(db, { includeDisabled });
    if (types.length === 0) {
      runMigration(db);
      types = getEmailTypes(db, { includeDisabled });
    }
    db.close();
    return NextResponse.json({ types });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ types: [], error: message }, { status: 500 });
  }
}

// POST { name, detection, matchScope?, mustSurface?, sortOrder? } — add a type.
export async function POST(req: Request) {
  try {
    const b = await req.json().catch(() => ({})) as Record<string, unknown>;
    const name = typeof b.name === "string" ? b.name.trim() : "";
    const detection = typeof b.detection === "string" ? b.detection.trim() : "";
    if (!name || !detection) {
      return NextResponse.json({ error: "name and detection required" }, { status: 400 });
    }
    const db = initDb();
    addEmailType(db, {
      name, detection,
      matchScope: b.matchScope === "subject" ? "subject" : "combined",
      mustSurface: typeof b.mustSurface === "string" ? b.mustSurface : null,
      sortOrder: typeof b.sortOrder === "number" ? b.sortOrder : undefined,
    });
    const types = getEmailTypes(db, { includeDisabled: true });
    db.close();
    return NextResponse.json({ success: true, types });
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

// PATCH { id, ...fields } — update a type (incl. enable/disable via { enabled }).
export async function PATCH(req: Request) {
  try {
    const b = await req.json().catch(() => ({})) as Record<string, unknown>;
    const id = typeof b.id === "number" ? b.id : Number(b.id);
    if (!Number.isInteger(id)) return NextResponse.json({ error: "numeric id required" }, { status: 400 });
    const db = initDb();
    updateEmailType(db, id, {
      name: typeof b.name === "string" ? b.name : undefined,
      detection: typeof b.detection === "string" ? b.detection : undefined,
      matchScope: b.matchScope === "subject" || b.matchScope === "combined" ? b.matchScope : undefined,
      mustSurface: typeof b.mustSurface === "string" ? b.mustSurface : undefined,
      sortOrder: typeof b.sortOrder === "number" ? b.sortOrder : undefined,
      enabled: typeof b.enabled === "boolean" ? b.enabled : undefined,
    });
    const types = getEmailTypes(db, { includeDisabled: true });
    db.close();
    return NextResponse.json({ success: true, types });
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

// DELETE { id } — delete a type.
export async function DELETE(req: Request) {
  try {
    const b = await req.json().catch(() => ({})) as Record<string, unknown>;
    const id = typeof b.id === "number" ? b.id : Number(b.id);
    if (!Number.isInteger(id)) return NextResponse.json({ error: "numeric id required" }, { status: 400 });
    const db = initDb();
    deleteEmailType(db, id);
    const types = getEmailTypes(db, { includeDisabled: true });
    db.close();
    return NextResponse.json({ success: true, types });
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
