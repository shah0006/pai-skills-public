// AlertSender.ts -- Send iMessage alerts for time-sensitive emails after triage generation
// Only fires when genuinely urgent items are found. Maximum 1 alert per triage run.

import { execSync } from "child_process";
import { join } from "path";
import type { ClassifiedEmail } from "./Types";

const IMESSAGE_SH = join(process.env.HOME ?? "~", ".claude/skills/iMessage/imessage.sh");
// SELF_ADDRESS is sourced from EMAILTRIAGE_SELF_ADDRESS env var or
// SKILLCUSTOMIZATIONS/EmailTriage/preferences.yaml `self_address` key.
// Falls back to empty string in dev/test (alerts are still detected; just not sent).
function loadSelfAddress(): string {
  if (process.env.EMAILTRIAGE_SELF_ADDRESS) return process.env.EMAILTRIAGE_SELF_ADDRESS;
  try {
    const home = process.env.HOME;
    if (!home) return "";
    const fs = require("fs");
    const prefsPath = join(home, ".claude/PAI/USER/SKILLCUSTOMIZATIONS/EmailTriage/preferences.yaml");
    if (!fs.existsSync(prefsPath)) return "";
    const raw = fs.readFileSync(prefsPath, "utf8");
    const m = raw.match(/^\s*self_address\s*:\s*["']?([^"'#\n]+?)["']?\s*(?:#.*)?$/m);
    return m ? m[1].trim() : "";
  } catch { return ""; }
}
const SELF_ADDRESS = loadSelfAddress();

// Keywords that indicate urgency in subject lines
const URGENT_KEYWORDS = [
  "urgent", "asap", "immediate", "deadline", "due today", "due tomorrow",
  "time-sensitive", "expires today", "expires tomorrow", "action required",
  "final notice", "last chance", "respond by", "overdue",
];

// Date patterns in subjects: "DUE 4/3/2026", "by April 5", "deadline 4/5"
const DATE_PATTERN = /(?:due|by|deadline|expires?)\s+(\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{1,2})/i;

export interface UrgentItem {
  id: string;
  sender: string;
  subject: string;
  reason: string;
}

export function detectUrgentEmails(emails: ClassifiedEmail[], today: string): UrgentItem[] {
  const urgent: UrgentItem[] = [];
  // Parse YYYY-MM-DD as LOCAL midnight, not UTC. `new Date("2026-05-18")`
  // produces UTC midnight, which in EDT (-04:00) is the *previous* day —
  // that off-by-one cascaded into deadline comparisons firing late by 4h.
  const [y, m, d] = today.split("-").map(Number);
  const todayDate = new Date(y, m - 1, d);
  const tomorrowDate = new Date(todayDate);
  tomorrowDate.setDate(tomorrowDate.getDate() + 1);

  for (const email of emails) {
    const subjectLower = email.subject.toLowerCase();

    // Check VIP + urgent keywords
    if (email.isVip) {
      const keyword = URGENT_KEYWORDS.find(k => subjectLower.includes(k));
      if (keyword) {
        urgent.push({
          id: email.id,
          sender: email.from,
          subject: email.subject,
          reason: `VIP + "${keyword}"`,
        });
        continue;
      }
    }

    // Check for deadline dates (today or tomorrow)
    const dateMatch = subjectLower.match(DATE_PATTERN);
    if (dateMatch) {
      const dateStr = dateMatch[1];
      // Try parsing various date formats
      const parsedDate = parseFuzzyDate(dateStr, todayDate);
      if (parsedDate && parsedDate <= tomorrowDate) {
        urgent.push({
          id: email.id,
          sender: email.from,
          subject: email.subject,
          reason: `Deadline ${parsedDate.toISOString().slice(0, 10)}`,
        });
        continue;
      }
    }

    // Check financial + urgent keywords (DocuSign expiring, payment due)
    if (email.funnelStage === "financial") {
      const financialUrgent = ["expir", "due today", "payment due", "sign by", "action required"];
      const match = financialUrgent.find(k => subjectLower.includes(k));
      if (match) {
        urgent.push({
          id: email.id,
          sender: email.from,
          subject: email.subject,
          reason: `Financial: "${match}"`,
        });
      }
    }
  }

  return urgent;
}

export function parseFuzzyDate(dateStr: string, reference: Date): Date | null {
  // Year rollover helper: if no year was given by the sender and the resulting
  // date is in the past relative to `reference`, bump to next year. "due 1/5"
  // sent in December almost certainly means next January, not last January.
  const rollover = (d: Date, explicitYear: boolean): Date =>
    !explicitYear && d < reference
      ? new Date(d.getFullYear() + 1, d.getMonth(), d.getDate())
      : d;

  // Try MM/DD/YYYY or MM-DD-YYYY
  const slashMatch = dateStr.match(/^(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?$/);
  if (slashMatch) {
    const month = parseInt(slashMatch[1]) - 1;
    const day = parseInt(slashMatch[2]);
    const explicitYear = !!slashMatch[3];
    const year = explicitYear
      ? parseInt(slashMatch[3]) < 100
        ? 2000 + parseInt(slashMatch[3])
        : parseInt(slashMatch[3])
      : reference.getFullYear();
    return rollover(new Date(year, month, day), explicitYear);
  }

  // Try "April 5" / "Apr 5"
  const monthNames: Record<string, number> = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
  };
  const namedMatch = dateStr.match(/^(\w{3})\w*\s+(\d{1,2})$/i);
  if (namedMatch) {
    const month = monthNames[namedMatch[1].toLowerCase()];
    if (month !== undefined) {
      // Named formats never carry a year here, so always candidate for rollover.
      return rollover(new Date(reference.getFullYear(), month, parseInt(namedMatch[2])), false);
    }
  }

  return null;
}

export function formatAlertMessage(items: UrgentItem[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) {
    return `PAI Alert: ${items[0].subject} (from ${items[0].sender})`;
  }
  const lines = items.map(i => `- ${i.subject} (${i.sender})`);
  return `PAI Alert: ${items.length} urgent emails need attention\n${lines.join("\n")}`;
}

export function sendUrgentAlert(items: UrgentItem[]): boolean {
  if (items.length === 0) return false;
  const message = formatAlertMessage(items);
  try {
    execSync(`bash "${IMESSAGE_SH}" send "${SELF_ADDRESS}" "${message.replace(/"/g, '\\"')}"`, {
      timeout: 15000,
    });
    return true;
  } catch {
    return false;
  }
}

const PAI_NOTIFY_URL = process.env.PAI_NOTIFY_URL ?? "http://localhost:31337/notify";

/** Voice + iMessage when Gmail auth fails before morning triage (AQ-2.4). */
export function sendAuthFailureAlert(detail?: string): void {
  const message = `PAI EmailTriage: Gmail auth failed before morning triage. Run: gws gmail auth login${detail ? ` (${detail})` : ""}`;
  if (SELF_ADDRESS) {
    try {
      execSync(`bash "${IMESSAGE_SH}" send "${SELF_ADDRESS}" "${message.replace(/"/g, '\\"')}"`, {
        timeout: 15000,
      });
    } catch { /* best-effort */ }
  }
  if (process.env.EMAILTRIAGE_DISABLE_VOICE === "1") return;
  try {
    execSync(
      `curl -sk -X POST "${PAI_NOTIFY_URL}" -H "Content-Type: application/json" -d ${JSON.stringify(JSON.stringify({
        message,
        voice_enabled: true,
        priority: "urgent",
      }))}`,
      { timeout: 5000 },
    );
  } catch { /* Pulse may be offline in CI */ }
}
