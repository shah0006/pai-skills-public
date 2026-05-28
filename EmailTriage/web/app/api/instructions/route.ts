// POST /api/instructions
// Body: { instructions: string }
// Uses AI to parse natural language instructions into rule changes,
// then applies them to the SQLite database.

import { NextResponse } from "next/server";
import { join } from "path";
import { initDb, addRoutingRule, addVipSender, addJunkSender, isVipSender, isJunkSender, getRoutingRules } from "../../../../Tools/Db";

export const dynamic = "force-dynamic";

const SKILL_DIR = join(
  (process.env.HOME ?? (() => { throw new Error("HOME env var not set"); })()),
  ".claude/skills/EmailTriage",
);
const DB_PATH = join(SKILL_DIR, "triage.db");
const API_URL = "https://api.anthropic.com/v1/messages";

interface ParsedInstruction {
  type: "add_sender_rule" | "add_domain_rule" | "add_subject_rule" | "add_vip" | "add_junk_domain" | "add_junk_address" | "unknown";
  match_field?: string;   // from, from_contains, from_domain, subject_contains
  match_value?: string;   // the value to match
  action?: string;        // archive, trash, etc.
  folder?: string;        // destination folder
  value?: string;         // for VIP/junk: the email/domain
  original: string;       // the original instruction text
  explanation: string;    // AI explanation of what it will do
}

async function parseWithAI(instructionsText: string): Promise<ParsedInstruction[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

  // Read current routing rules for context
  const db = initDb(DB_PATH);
  const rules = getRoutingRules(db);
  db.close();

  const rulesContext = rules.map(r => `${r.ruleType}: ${r.matchValue} -> ${r.action}${r.folder ? ` (${r.folder})` : ""}`).join("\n");

  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      system: `You parse email triage instructions into structured rule changes. Return ONLY valid JSON array.

Current routing rules for context:
${rulesContext}

Available rule types:
- add_sender_rule: match by sender email (from) or partial match (from_contains). Fields: match_field ("from" or "from_contains"), match_value, action, folder
- add_domain_rule: match by sender domain. Fields: match_field ("from_domain"), match_value, action, folder
- add_subject_rule: match by subject keyword. Fields: match_field ("subject_contains"), match_value, action, folder
- add_vip: add sender to VIP list. Fields: value (email address)
- add_junk_domain: block entire domain. Fields: value (domain)
- add_junk_address: block specific address. Fields: value (email address)

Apple Mail folders that exist: Subscriptions, Receipts, Financial, Work, Personal, Medical Education, Later, Nate, Yang, Sebastian, ShortForm, Amboss, Kayur, Anand, Roshan, Sandip, Sean Harmon, Kittleson, Michele Torti, Ali Adaal, Goldie, BASB, Obsidian

Default action is "archive" unless the user says trash/junk/block.
If the user says "file in X folder" or "move to X", the action is "archive" with folder set to X.
If the user mentions a person name like "Nate", infer the sender pattern from context or from existing rules.`,
      messages: [{
        role: "user",
        content: `Parse these instructions into rule changes. For each, include an "explanation" field describing what the rule will do in plain English. Return JSON array of objects with fields: type, match_field, match_value, action, folder, value, original, explanation.

Instructions:
${instructionsText}`,
      }],
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(`AI parse failed: ${response.status}`);
  }

  const data = await response.json() as {
    content: Array<{ type: string; text?: string }>;
  };

  const text = data.content
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text!)
    .join("\n")
    .trim();

  // Strip code fences
  const cleaned = text.replace(/^```(?:json)?\s*\n?/m, "").replace(/\n?```\s*$/m, "").trim();

  try {
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    return [];
  }
}

function applyInstructions(instructions: ParsedInstruction[]): string[] {
  const results: string[] = [];
  const db = initDb(DB_PATH);

  db.exec("BEGIN");
  try {
    for (const inst of instructions) {
      switch (inst.type) {
        case "add_sender_rule": {
          if (!inst.match_value) break;
          const action = inst.action ?? "archive";
          addRoutingRule(db, {
            ruleType: "sender",
            matchValue: inst.match_value,
            action,
            folder: inst.folder,
            source: "web-ui",
          });
          results.push(`Added sender rule: ${inst.match_value} -> ${action}${inst.folder ? ` (${inst.folder})` : ""}`);
          break;
        }

        case "add_domain_rule": {
          if (!inst.match_value) break;
          const action = inst.action ?? "archive";
          addRoutingRule(db, {
            ruleType: "domain",
            matchValue: inst.match_value,
            action,
            folder: inst.folder,
            source: "web-ui",
          });
          results.push(`Added domain rule: ${inst.match_value} -> ${action}${inst.folder ? ` (${inst.folder})` : ""}`);
          break;
        }

        case "add_subject_rule": {
          if (!inst.match_value) break;
          const action = inst.action ?? "archive";
          addRoutingRule(db, {
            ruleType: "subject",
            matchValue: inst.match_value,
            action,
            folder: inst.folder,
            source: "web-ui",
          });
          results.push(`Added subject rule: "${inst.match_value}" -> ${action}${inst.folder ? ` (${inst.folder})` : ""}`);
          break;
        }

        case "add_vip": {
          if (!inst.value) break;
          if (isVipSender(db, inst.value)) {
            results.push(`Already VIP: ${inst.value}`);
          } else {
            addVipSender(db, inst.value);
            results.push(`Added VIP: ${inst.value}`);
          }
          break;
        }

        case "add_junk_domain": {
          if (!inst.value) break;
          if (isJunkSender(db, "", inst.value)) {
            results.push(`Already junk: ${inst.value}`);
          } else {
            addJunkSender(db, { domain: inst.value });
            results.push(`Added junk domain: ${inst.value}`);
          }
          break;
        }

        case "add_junk_address": {
          if (!inst.value) break;
          if (isJunkSender(db, inst.value, "")) {
            results.push(`Already junk: ${inst.value}`);
          } else {
            addJunkSender(db, { address: inst.value });
            results.push(`Added junk address: ${inst.value}`);
          }
          break;
        }

        default:
          results.push(`Could not parse: "${inst.original}"`);
      }
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  } finally {
    db.close();
  }

  return results;
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { instructions } = body;

    if (!instructions || typeof instructions !== "string" || !instructions.trim()) {
      return NextResponse.json({ error: "No instructions provided" }, { status: 400 });
    }

    // Step 1: Parse with AI
    const parsed = await parseWithAI(instructions);
    if (parsed.length === 0) {
      return NextResponse.json({
        success: false,
        error: "Could not parse any instructions. Try formats like: 'add @domain.com to junk', 'VIP add email@x.com', 'create rule for Nate emails -> Nate folder'",
        parsed: [],
        results: [],
      });
    }

    // Step 2: Apply to database
    const results = applyInstructions(parsed);

    return NextResponse.json({
      success: true,
      parsed: parsed.map((p) => ({
        type: p.type,
        explanation: p.explanation,
        original: p.original,
      })),
      results,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
