// Tools/AutonomousActions.ts — Phase 24: autonomous Stage 5/6 execution.
//
// Reads HistoricalClassifier predictions for a batch of emails and returns
// the subset that meet the auto-execute threshold. Safety boundaries:
//   - Only auto-executes archive / trash / unsub (never reply, never block,
//     never approve — those are intent-bearing)
//   - VIP-classified emails are NEVER auto-actioned regardless of confidence
//   - Action must come from the SENDER layer (not just domain) for very
//     high confidence (>= 0.85), domain layer requires >= 0.95 confidence
//   - Min historical sample size enforced (>= 5 for sender, >= 10 for
//     domain) — the classifier already enforces lower bounds but autonomous
//     execution gets a stricter gate
//
// The output is a recommendation list — the caller (GenerateTriage) decides
// whether to apply it directly or pre-mark the doc for human review.
//
// CLI: bun Tools/AutonomousActions.ts <date> [--threshold 0.85] [--apply]

import { Database } from "bun:sqlite";
import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { classifyFromHistory, type ActionCode } from "./HistoricalClassifier";
import { getSenderHistory, getDomainHistory } from "./SenderMemory";

interface EmailInput {
  emailId: string;
  fromAddress: string;
  fromDomain: string;
  isVip?: boolean;
  /** Current funnel stage as classified by AiClassifier — used to refuse
   *  auto-action on already-VIP/already-action stages. */
  funnelStage?: string;
}

export interface AutonomousRecommendation {
  emailId: string;
  fromAddress: string;
  action: "A" | "T" | "U";
  confidence: number;
  basis: string;
  reason: string;
}

export interface AutonomousScanResult {
  scanned: number;
  recommendations: AutonomousRecommendation[];
  skipped: { vip: number; nonExecutableAction: number; lowConfidence: number; weakSampleSize: number };
}

const SENDER_MIN_CONFIDENCE = 0.85;
const DOMAIN_MIN_CONFIDENCE = 0.95;
const SENDER_MIN_SAMPLES = 5;
const DOMAIN_MIN_SAMPLES = 10;

const EXECUTABLE_ACTIONS = new Set<ActionCode>(["A", "T", "U"]);

export function scanForAutonomousActions(db: Database, emails: EmailInput[]): AutonomousScanResult {
  const result: AutonomousScanResult = {
    scanned: emails.length,
    recommendations: [],
    skipped: { vip: 0, nonExecutableAction: 0, lowConfidence: 0, weakSampleSize: 0 },
  };

  for (const email of emails) {
    // Safety boundary 1: never auto-action VIP
    if (email.isVip || email.funnelStage === "vip") {
      result.skipped.vip++;
      continue;
    }

    const prediction = classifyFromHistory(db, {
      address: email.fromAddress,
      domain: email.fromDomain,
    });

    // Safety boundary 2a: classifier said 'no clear pattern' → low confidence
    if (!prediction.predictedAction || prediction.source === "none") {
      result.skipped.lowConfidence++;
      continue;
    }
    // Safety boundary 2b: classifier picked a non-executable action (R/D/K/J/BL/AP)
    if (!EXECUTABLE_ACTIONS.has(prediction.predictedAction)) {
      result.skipped.nonExecutableAction++;
      continue;
    }

    // Safety boundary 3: sample-size + confidence gate
    if (prediction.source === "sender") {
      const sh = getSenderHistory(db, email.fromAddress);
      if (sh.totalSeen < SENDER_MIN_SAMPLES) { result.skipped.weakSampleSize++; continue; }
      if (prediction.confidence < SENDER_MIN_CONFIDENCE) { result.skipped.lowConfidence++; continue; }
    } else if (prediction.source === "domain") {
      const dh = getDomainHistory(db, email.fromDomain);
      if (dh.totalSeen < DOMAIN_MIN_SAMPLES) { result.skipped.weakSampleSize++; continue; }
      if (prediction.confidence < DOMAIN_MIN_CONFIDENCE) { result.skipped.lowConfidence++; continue; }
    } else {
      result.skipped.lowConfidence++;
      continue;
    }

    result.recommendations.push({
      emailId: email.emailId,
      fromAddress: email.fromAddress,
      action: prediction.predictedAction as "A" | "T" | "U",
      confidence: prediction.confidence,
      basis: prediction.basis,
      reason: `${prediction.source}-layer prediction (${Math.round(prediction.confidence * 100)}% confidence)`,
    });
  }

  return result;
}

// ─── CLI: dry-run scan against a triage note ─────────────────────────────

const VAULT_ROOT = (() => {
  if (process.env.EMAILTRIAGE_VAULT_ROOT) return process.env.EMAILTRIAGE_VAULT_ROOT;
  const home = process.env.HOME;
  if (!home) return "";
  const prefs = join(home, ".claude/PAI/USER/SKILLCUSTOMIZATIONS/EmailTriage/preferences.yaml");
  if (!existsSync(prefs)) return "";
  const raw = readFileSync(prefs, "utf8");
  const m = raw.match(/^\s*vault_root\s*:\s*["']?([^"'#\n]+?)["']?\s*(?:#.*)?$/m);
  return m ? m[1].trim() : "";
})();
const SKILL_ROOT = join(process.env.HOME ?? "", ".claude/skills/EmailTriage");

function emailsFromNote(notePath: string): EmailInput[] {
  if (!existsSync(notePath)) return [];
  const content = readFileSync(notePath, "utf8");
  const out: EmailInput[] = [];
  const lines = content.split("\n");
  let currentStage: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^## \[\] Stage 1: VIP/.test(line)) currentStage = "vip";
    else if (/^## \[\] Stage 2: Action Required/.test(line)) currentStage = "action";
    else if (/^## \[\] Stage 3: Financial/.test(line)) currentStage = "financial";
    else if (/^## \[\] Stage 4: Informational/.test(line)) currentStage = "informational";
    else if (/^## \[\] Stage 5: Bulk Dispose/.test(line)) currentStage = "bulk_dispose";
    else if (/^## \[\] Stage 6: Auto-Processed/.test(line)) currentStage = "auto_processed";
    else if (/^## /.test(line)) currentStage = null;
    if (!currentStage) continue;
    // Table row
    if (line.startsWith("|") && !line.includes("---") && !line.includes("ID |")) {
      const cells = line.split("|").map(c => c.trim());
      if (cells.length < 3) continue;
      const idMatch = cells[1].match(/\[`?(\d{4,})`?\]/) ?? cells[1].match(/(\d{4,})/);
      const addrMatch = cells[2].match(/<([^>]+)>/) ?? cells[2].match(/(\S+@\S+)/);
      if (!idMatch || !addrMatch) continue;
      const address = addrMatch[1].toLowerCase();
      const domain = address.includes("@") ? address.split("@")[1] : "";
      out.push({ emailId: idMatch[1], fromAddress: address, fromDomain: domain, isVip: currentStage === "vip", funnelStage: currentStage });
    }
  }
  return out;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const dateArg = argv.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
  let notePath: string;
  if (dateArg) {
    const [y, m, d] = dateArg.split("-").map(Number);
    const monthNames = ["January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December"];
    notePath = join(VAULT_ROOT, "Email Triage", `Email Triage -- ${monthNames[m - 1]} ${d}, ${y}.md`);
  } else {
    // Find most-recent note
    const files = readdirSync(join(VAULT_ROOT, "Email Triage")).filter(f => /^Email Triage -- .+\.md$/.test(f));
    files.sort();
    notePath = join(VAULT_ROOT, "Email Triage", files[files.length - 1] ?? "");
  }
  if (!notePath || !existsSync(notePath)) {
    console.error(`note not found: ${notePath}`);
    process.exit(1);
  }
  const emails = emailsFromNote(notePath);
  const db = new Database(join(SKILL_ROOT, "triage.db"));
  const result = scanForAutonomousActions(db, emails);
  db.close();
  console.log(`Scanned: ${result.scanned}`);
  console.log(`Recommendations: ${result.recommendations.length}`);
  console.log(`Skipped: ${JSON.stringify(result.skipped)}`);
  for (const r of result.recommendations) {
    console.log(`  ${r.action}  ${r.fromAddress.padEnd(40)} (${Math.round(r.confidence * 100)}%) — ${r.basis}`);
  }
  console.log("");
  console.log("(scan is read-only; no actions applied. Integrate into GenerateTriage to pre-mark the doc.)");
}
