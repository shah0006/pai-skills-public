// GET /api/rules
//
// Read-only listing of all active routing rules + VIP senders + junk
// senders. Powers the 'Active Rules' transparency view in the web UI:
// "what auto-routing does PAI have on my behalf?"
//
// Returns:
//   {
//     routingRules: Array<{ id, ruleType, matchValue, action, folder?, source }>,
//     vipSenders:   string[],   // addresses
//     junkAddresses: string[],
//     junkDomains:   string[],
//     summary: { routing: N, vip: N, junkAddresses: N, junkDomains: N },
//   }

import { NextResponse } from "next/server";
import { initDb, getRoutingRules } from "../../../../Tools/Db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const db = initDb();
    const routingRules = getRoutingRules(db);
    const vipAddresses = (db.prepare("SELECT address FROM vip_senders ORDER BY address").all() as { address: string }[])
      .map(r => r.address.toLowerCase());
    const junkRows = db.prepare("SELECT address, domain FROM junk_senders ORDER BY id").all() as Array<{ address: string | null; domain: string | null }>;
    const junkAddresses = junkRows.filter(r => r.address).map(r => r.address!.toLowerCase());
    const junkDomains   = junkRows.filter(r => r.domain).map(r => r.domain!.toLowerCase());
    return NextResponse.json({
      routingRules,
      vipSenders: vipAddresses,
      junkAddresses,
      junkDomains,
      summary: {
        routing: routingRules.length,
        vip: vipAddresses.length,
        junkAddresses: junkAddresses.length,
        junkDomains: junkDomains.length,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
