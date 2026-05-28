#!/usr/bin/env bun
/**
 * Systematic pre-handoff quality check for today's triage. Designed to be
 * run after every Generate so we never claim "fully fixed" without checking
 * the same set of regressions that have bitten before.
 *
 * Exit code is non-zero if any check fails — usable in CI or as a gate
 * before flipping the doc to status=ready.
 *
 * Usage:
 *   bun run Tools/QualityCheck.ts [--date YYYY-MM-DD]
 */
import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

const VAULT_ROOT = process.env.EMAILTRIAGE_VAULT_ROOT
  ?? "/Volumes/Hyperdrive 4 Tb/Main Obsidian (Sync)";
const APPLE_MAIL_SH = `${process.env.HOME}/.claude/skills/AppleMail/Tools/apple-mail.sh`;

function fmtDate(d: Date): string {
  const m = d.toLocaleString("en-US", { month: "long" });
  return `${m} ${d.getDate()}, ${d.getFullYear()}`;
}

function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

function parseArgs(): { date: Date } {
  const argv = process.argv.slice(2);
  let date = new Date();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--date" && argv[i+1]) {
      date = new Date(argv[++i] + "T12:00:00");
    }
  }
  return { date };
}

function appleCount(mailbox: string): number {
  try {
    const out = execSync(`bash "${APPLE_MAIL_SH}" count "${mailbox}"`, { encoding: "utf-8", timeout: 30_000 });
    const m = out.match(/(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
  } catch { return -1; }
}

function gmailLabelCount(labelId: string): number {
  try {
    const out = execSync(`gws gmail users messages list --params '{"userId":"me","labelIds":["${labelId}"]}' 2>/dev/null`, { encoding: "utf-8", timeout: 30_000 });
    const m = out.match(/"resultSizeEstimate":\s*(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
  } catch { return -1; }
}

function gmailLabelIdByName(name: string): string | null {
  try {
    const out = execSync(`gws gmail users labels list --params '{"userId":"me"}' 2>/dev/null`, { encoding: "utf-8", timeout: 30_000 });
    const json = JSON.parse(out.split("\n").filter(l => !l.startsWith("Using keyring") && !l.startsWith("[account:")).join("\n"));
    const found = (json.labels ?? []).find((l: { id: string; name: string }) => l.name === name);
    return found?.id ?? null;
  } catch { return null; }
}

async function fetchParsedSession(date: string): Promise<{ emails: Array<{ id: string; account?: string; priority: string }>; raw: string }> {
  const triageRes = await fetch(`http://localhost:9988/api/triage?date=${date}`);
  const triageJson = await triageRes.json() as { noteContent: string };
  const parseRes = await fetch("http://localhost:9988/api/parse-note", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ noteContent: triageJson.noteContent, date }),
  });
  const parseJson = await parseRes.json() as { session: { emails: Array<{ id: string; account?: string; priority: string }> } };
  return { emails: parseJson.session.emails, raw: triageJson.noteContent };
}

async function probeEmailLookup(id: string, mailbox: string): Promise<number> {
  try {
    const res = await fetch(`http://localhost:9988/api/email/${id}?mailbox=${encodeURIComponent(mailbox)}`);
    return res.status;
  } catch { return -1; }
}

async function main() {
  const { date } = parseArgs();
  const isoStr = isoDate(date);
  const notePath = join(VAULT_ROOT, "Email Triage", `Email Triage -- ${fmtDate(date)}.md`);

  console.log(`\n=== QualityCheck for ${isoStr} ===\n`);

  const results: CheckResult[] = [];
  const STAGES = [
    { name: "Stage 1 - VIP", iCount: -1, gCount: -1, gLabel: "Stages/Stage 1 - VIP" },
    { name: "Stage 2 - Action Required", iCount: -1, gCount: -1, gLabel: "Stages/Stage 2 - Action Required" },
    { name: "Stage 3 - Financial", iCount: -1, gCount: -1, gLabel: "Stages/Stage 3 - Financial" },
    { name: "Stage 4 - Informational", iCount: -1, gCount: -1, gLabel: "Stages/Stage 4 - Informational" },
    { name: "Stage 5 - Bulk Dispose", iCount: -1, gCount: -1, gLabel: "Stages/Stage 5 - Bulk Dispose" },
    { name: "Stage 6 - Auto-Processed", iCount: -1, gCount: -1, gLabel: "Stages/Stage 6 - Auto-Processed" },
  ];

  // ─── Check 1: doc file exists ───
  if (!existsSync(notePath)) {
    results.push({ name: "doc-file-exists", ok: false, detail: `Missing: ${notePath}` });
    printAndExit(results);
    return;
  }
  results.push({ name: "doc-file-exists", ok: true, detail: notePath });

  const docContent = readFileSync(notePath, "utf-8");

  // ─── Check 2: every #### block header has [i] or [g] account marker ───
  const blockHeaders = docContent.match(/^#### .+$/gm) ?? [];
  const headersWithoutAccount = blockHeaders.filter(h => !/\[(i|g)\]/.test(h));
  results.push({
    name: "block-headers-have-account",
    ok: headersWithoutAccount.length === 0,
    detail: `${blockHeaders.length} headers; ${headersWithoutAccount.length} missing [i]/[g]${headersWithoutAccount.length > 0 ? `: ${headersWithoutAccount.slice(0,3).join(" | ")}` : ""}`,
  });

  // ─── Check 3: every table row has [i] or [g] account marker ───
  const tableRows = docContent.split("\n").filter(l => l.startsWith("| ["));
  const rowsWithoutAccount = tableRows.filter(r => !/\[(i|g)\]/.test(r));
  results.push({
    name: "table-rows-have-account",
    ok: rowsWithoutAccount.length === 0,
    detail: `${tableRows.length} rows; ${rowsWithoutAccount.length} missing [i]/[g]`,
  });

  // ─── Check 4: parser returns same N as doc summary ───
  const totalMatch = docContent.match(/^total:\s*(\d+)/m);
  const docTotal = totalMatch ? parseInt(totalMatch[1], 10) : 0;
  let parsedEmails: Array<{ id: string; account?: string; priority: string }> = [];
  try {
    const session = await fetchParsedSession(isoStr);
    parsedEmails = session.emails;
  } catch (err) {
    results.push({ name: "parse-note-api", ok: false, detail: `fetch failed: ${err instanceof Error ? err.message : String(err)}` });
  }
  results.push({
    name: "parser-count-matches-doc-total",
    ok: parsedEmails.length === docTotal,
    detail: `doc says ${docTotal}, parser returned ${parsedEmails.length}`,
  });

  // ─── Check 5: every parsed email has a valid-format ID and account ───
  const idHex = /^[a-fA-F0-9]+$/;
  const badIds = parsedEmails.filter(e => !e.id || !idHex.test(e.id) || e.id.length < 4);
  const missingAccount = parsedEmails.filter(e => !e.account);
  results.push({
    name: "every-email-has-valid-id",
    ok: badIds.length === 0,
    detail: `${badIds.length} emails with invalid ID${badIds.length > 0 ? `: ${badIds.slice(0,3).map(e => e.id).join(", ")}` : ""}`,
  });
  results.push({
    name: "every-email-has-account",
    ok: missingAccount.length === 0,
    detail: `${missingAccount.length} emails missing account${missingAccount.length > 0 ? `: ${missingAccount.slice(0,3).map(e => e.id).join(", ")}` : ""}`,
  });

  // ─── Check 6: Gmail emails have hex IDs (not Apple-numeric) ───
  const gmailWithApple = parsedEmails.filter(e => (e.account ?? "").toLowerCase() === "google" && /^\d+$/.test(e.id));
  results.push({
    name: "gmail-emails-have-hex-ids",
    ok: gmailWithApple.length === 0,
    detail: `${gmailWithApple.length} Gmail emails with numeric (Apple) IDs${gmailWithApple.length > 0 ? `: ${gmailWithApple.slice(0,3).map(e => e.id).join(", ")}` : ""}`,
  });

  // ─── Check 7: each stage's doc count == physical count ───
  for (const s of STAGES) {
    s.iCount = appleCount(`i/Stages/${s.name}`);
    const lid = gmailLabelIdByName(s.gLabel);
    s.gCount = lid ? gmailLabelCount(lid) : 0;
  }
  const stageNames = ["Stage 1: VIP", "Stage 2: Action Required", "Stage 3: Financial", "Stage 4: Informational", "Stage 5: Bulk Dispose", "Stage 6: Auto-Processed"];
  for (let i = 0; i < stageNames.length; i++) {
    const docCountMatch = docContent.match(new RegExp(`^## \\[[ x]?\\] ${stageNames[i].replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}.*?\\((\\d+)\\)`, "m"));
    const docCount = docCountMatch ? parseInt(docCountMatch[1], 10) : -1;
    const physCount = (STAGES[i].iCount === -1 ? 0 : STAGES[i].iCount) + (STAGES[i].gCount === -1 ? 0 : STAGES[i].gCount);
    results.push({
      name: `stage-${i+1}-doc-vs-physical`,
      ok: docCount === physCount,
      detail: `${stageNames[i]}: doc=${docCount}, physical=${physCount} (i=${STAGES[i].iCount}, g=${STAGES[i].gCount})`,
    });
  }

  // ─── Check 8: sample-probe — pick one email per account, call /api/email/<id> ───
  const sampleApple = parsedEmails.find(e => (e.account ?? "").toLowerCase() === "icloud");
  const sampleGmail = parsedEmails.find(e => (e.account ?? "").toLowerCase() === "google");

  if (sampleApple) {
    const status = await probeEmailLookup(sampleApple.id, "i/Stages/Stage 1 - VIP");
    results.push({
      name: "sample-icloud-email-lookup",
      ok: status === 200 || status === 404,
      detail: `id=${sampleApple.id} → ${status}`,
    });
  }
  if (sampleGmail) {
    const status = await probeEmailLookup(sampleGmail.id, "Stages/Stage 5 - Bulk Dispose");
    results.push({
      name: "sample-gmail-email-lookup",
      ok: status === 200 || status === 404,
      detail: `id=${sampleGmail.id} → ${status}`,
    });
  }

  printAndExit(results);
}

function printAndExit(results: CheckResult[]): void {
  let failed = 0;
  for (const r of results) {
    const icon = r.ok ? "✓" : "✗";
    console.log(`${icon} ${r.name.padEnd(40)} ${r.detail}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${failed === 0 ? "ALL CHECKS PASSED" : `${failed} CHECK(S) FAILED`}\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => {
  console.error(err);
  process.exit(2);
});
