// /api/settings/rules — Phase 29 Routing rules panel (replaces the read-only
// Active Rules view that lived in the Analytics tab; adds edit + delete).
//   GET    → { rules: RoutingRuleRow[] }
//   POST   { ruleType, matchValue, action, folder?, stop? } → adds
//   PATCH  { id, ...fields }                                → updates
//   DELETE { id }                                           → removes

import { NextResponse } from "next/server";
import {
  initDb, getRoutingRules, addRoutingRule, updateRoutingRule, removeRoutingRule,
} from "../../../../../Tools/Db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const db = initDb();
    const rules = getRoutingRules(db);
    db.close();
    return NextResponse.json({ rules });
  } catch (e) {
    return NextResponse.json({ rules: [], error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const b = await req.json().catch(() => ({})) as Record<string, unknown>;
    const ruleType = typeof b.ruleType === "string" ? b.ruleType : "";
    const matchValue = typeof b.matchValue === "string" ? b.matchValue.trim() : "";
    const action = typeof b.action === "string" ? b.action : "";
    if (!ruleType || !matchValue || !action) {
      return NextResponse.json({ error: "ruleType, matchValue, action required" }, { status: 400 });
    }
    const db = initDb();
    addRoutingRule(db, {
      ruleType, matchValue, action,
      folder: typeof b.folder === "string" ? b.folder : undefined,
      stop: b.stop !== false,
    });
    const rules = getRoutingRules(db);
    db.close();
    return NextResponse.json({ success: true, rules });
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const b = await req.json().catch(() => ({})) as Record<string, unknown>;
    const id = typeof b.id === "number" ? b.id : Number(b.id);
    if (!Number.isInteger(id)) return NextResponse.json({ error: "numeric id required" }, { status: 400 });
    const db = initDb();
    updateRoutingRule(db, id, {
      ruleType: typeof b.ruleType === "string" ? b.ruleType : undefined,
      matchValue: typeof b.matchValue === "string" ? b.matchValue : undefined,
      action: typeof b.action === "string" ? b.action : undefined,
      folder: typeof b.folder === "string" ? b.folder : undefined,
      stop: typeof b.stop === "boolean" ? b.stop : undefined,
    });
    const rules = getRoutingRules(db);
    db.close();
    return NextResponse.json({ success: true, rules });
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const b = await req.json().catch(() => ({})) as Record<string, unknown>;
    const id = typeof b.id === "number" ? b.id : Number(b.id);
    if (!Number.isInteger(id)) return NextResponse.json({ error: "numeric id required" }, { status: 400 });
    const db = initDb();
    removeRoutingRule(db, id);
    const rules = getRoutingRules(db);
    db.close();
    return NextResponse.json({ success: true, rules });
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
