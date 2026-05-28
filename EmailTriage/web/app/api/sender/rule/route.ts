// POST /api/sender/rule
//
// Closed-loop counterpart to /api/sender/history: when SenderMemory's
// suggestion fires (e.g. "you've trashed this sender 8 times — suggest
// auto-trash rule"), the UI can POST here to actually create the rule
// without forcing the user to detour through the Instructions text box.
//
// Body: { address?: string; domain?: string; action: 'archive' | 'trash' | 'unsub' | 'block' | 'approve' }
//   - Exactly one of address / domain required (whichever the suggestion
//     was scoped to)
//   - action maps to a routing_rules / vip_senders / junk_senders insert
//
// Returns: { success: boolean; ruleId?: number; kind: string; error?: string }

import { NextResponse } from "next/server";
import { initDb, addRoutingRule, addVipSender, addJunkSender } from "../../../../../Tools/Db";

export const dynamic = "force-dynamic";

type Action = "archive" | "trash" | "unsub" | "block" | "approve";

function isAction(s: unknown): s is Action {
  return typeof s === "string" && ["archive", "trash", "unsub", "block", "approve"].includes(s);
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const address = typeof body.address === "string" && body.address.trim() ? body.address.trim().toLowerCase() : undefined;
    const domain  = typeof body.domain  === "string" && body.domain.trim()  ? body.domain.trim().toLowerCase()  : undefined;
    const action  = isAction(body.action) ? body.action : undefined;

    if (!action) {
      return NextResponse.json({ success: false, error: "action must be one of: archive, trash, unsub, block, approve" }, { status: 400 });
    }
    if (!address && !domain) {
      return NextResponse.json({ success: false, error: "address or domain required" }, { status: 400 });
    }

    const db = initDb();

    // VIP / block route through dedicated tables (not routing_rules)
    if (action === "approve") {
      if (!address) return NextResponse.json({ success: false, error: "approve requires an address" }, { status: 400 });
      addVipSender(db, address);
      return NextResponse.json({ success: true, kind: "vip", target: address });
    }
    if (action === "block") {
      if (address) {
        addJunkSender(db, { address, reason: "user-clicked block from SenderMemory suggestion" });
        return NextResponse.json({ success: true, kind: "junk:address", target: address });
      }
      if (domain) {
        addJunkSender(db, { domain, reason: "user-clicked block from SenderMemory suggestion" });
        return NextResponse.json({ success: true, kind: "junk:domain", target: domain });
      }
    }

    // archive / trash / unsub → routing_rules table
    const ruleType = address ? "sender" : "domain";
    const matchValue = address ?? domain!;
    const ruleId = addRoutingRule(db, {
      ruleType,
      matchValue,
      action,
      source: "sender-memory-suggestion",
    });
    return NextResponse.json({ success: true, kind: `${ruleType}:${action}`, target: matchValue, ruleId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
