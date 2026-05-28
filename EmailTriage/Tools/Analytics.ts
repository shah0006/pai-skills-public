// ~/.claude/skills/EmailTriage/analytics.ts
// Usage: bun run analytics.ts [--days N] [--save]
// Shows triage analytics from the database

import { Database } from "bun:sqlite";
import { initDb } from "./Db";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";

// ─── Types ───

export interface AnalyticsData {
  period: { days: number; start: string; end: string };
  sessions: {
    total: number;
    avgEmails: number;
    avgDurationSec: number;
  };
  actionDistribution: {
    archived: number;
    trashed: number;
    replied: number;
    kept: number;
    unsubscribed: number;
    blocked: number;
  };
  junkRate: {
    current: number;
    trend: number;
  };
  topSenders: Array<{
    sender: string;
    count: number;
    lastSeen: string;
  }>;
  weeklyTrend: Array<{
    week: string;
    total: number;
    autoProcessed: number;
    junkRate: number;
  }>;
}

// ─── Core analytics query ───

export function getAnalytics(db: Database, days: number): AnalyticsData {
  const now = new Date();
  const start = new Date(now);
  start.setDate(start.getDate() - days);

  const fmt = (d: Date) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const h = String(d.getHours()).padStart(2, "0");
    const min = String(d.getMinutes()).padStart(2, "0");
    return `${y}-${m}-${day}_${h}:${min}`;
  };

  const endStr = fmt(now);
  const startStr = fmt(start);

  // Session stats from triage_history
  const sessions = db.prepare(`
    SELECT * FROM triage_history
    WHERE date >= ? AND date <= ?
    ORDER BY date DESC
  `).all(startStr.slice(0, 10), endStr.slice(0, 10)) as Array<{
    id: number; date: string; total: number; archived: number;
    trashed: number; replied: number; unsubscribed: number;
    blocked: number; duration_sec: number;
  }>;

  const totalSessions = sessions.length;
  const avgEmails = totalSessions > 0
    ? Math.round(sessions.reduce((s, r) => s + r.total, 0) / totalSessions)
    : 0;
  const avgDurationSec = totalSessions > 0
    ? Math.round(sessions.reduce((s, r) => s + r.duration_sec, 0) / totalSessions)
    : 0;

  // Action distribution (aggregate across sessions)
  const totalArchived = sessions.reduce((s, r) => s + r.archived, 0);
  const totalTrashed = sessions.reduce((s, r) => s + r.trashed, 0);
  const totalReplied = sessions.reduce((s, r) => s + r.replied, 0);
  const totalUnsubscribed = sessions.reduce((s, r) => s + r.unsubscribed, 0);
  const totalBlocked = sessions.reduce((s, r) => s + r.blocked, 0);
  const totalEmails = sessions.reduce((s, r) => s + r.total, 0);
  const totalKept = totalEmails - totalArchived - totalTrashed - totalReplied - totalUnsubscribed - totalBlocked;

  // Junk rate: (trashed + unsubscribed + blocked) / total
  const junkActions = totalTrashed + totalUnsubscribed + totalBlocked;
  const currentJunkRate = totalEmails > 0 ? Math.round((junkActions / totalEmails) * 100) : 0;

  // Trend: compare first half vs second half of period
  const midpoint = Math.floor(sessions.length / 2);
  let trendValue = 0;
  if (sessions.length >= 2) {
    const recentHalf = sessions.slice(0, midpoint || 1);
    const olderHalf = sessions.slice(midpoint || 1);

    const recentTotal = recentHalf.reduce((s, r) => s + r.total, 0);
    const recentJunk = recentHalf.reduce((s, r) => s + r.trashed + r.unsubscribed + r.blocked, 0);
    const olderTotal = olderHalf.reduce((s, r) => s + r.total, 0);
    const olderJunk = olderHalf.reduce((s, r) => s + r.trashed + r.unsubscribed + r.blocked, 0);

    const recentRate = recentTotal > 0 ? (recentJunk / recentTotal) * 100 : 0;
    const olderRate = olderTotal > 0 ? (olderJunk / olderTotal) * 100 : 0;
    trendValue = Math.round(recentRate - olderRate);
  }

  // Top senders from email_actions (by email_id pattern) and known_senders
  const topSenders = db.prepare(`
    SELECT address AS sender, times_seen AS count, last_seen AS lastSeen
    FROM known_senders
    ORDER BY times_seen DESC
    LIMIT 10
  `).all() as Array<{ sender: string; count: number; lastSeen: string }>;

  // Weekly trend — group sessions by ISO week
  const weeklyMap = new Map<string, { total: number; junk: number }>();
  for (const session of sessions) {
    // Use date string directly — first 10 chars is YYYY-MM-DD
    const dateStr = session.date.slice(0, 10);
    const d = new Date(dateStr + "T00:00:00");
    const weekStart = new Date(d);
    weekStart.setDate(d.getDate() - d.getDay()); // Sunday start
    const weekKey = `${weekStart.getFullYear()}-${String(weekStart.getMonth() + 1).padStart(2, "0")}-${String(weekStart.getDate()).padStart(2, "0")}`;

    const existing = weeklyMap.get(weekKey) ?? { total: 0, junk: 0 };
    existing.total += session.total;
    existing.junk += session.trashed + session.unsubscribed + session.blocked;
    weeklyMap.set(weekKey, existing);
  }

  const weeklyTrend = Array.from(weeklyMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([week, data]) => ({
      week,
      total: data.total,
      autoProcessed: data.junk,
      junkRate: data.total > 0 ? Math.round((data.junk / data.total) * 100) : 0,
    }));

  return {
    period: { days, start: startStr, end: endStr },
    sessions: { total: totalSessions, avgEmails, avgDurationSec },
    actionDistribution: {
      archived: totalArchived,
      trashed: totalTrashed,
      replied: totalReplied,
      kept: Math.max(0, totalKept),
      unsubscribed: totalUnsubscribed,
      blocked: totalBlocked,
    },
    junkRate: { current: currentJunkRate, trend: trendValue },
    topSenders,
    weeklyTrend,
  };
}

// ─── Markdown formatter ───

export function formatAnalyticsMarkdown(data: AnalyticsData): string {
  const lines: string[] = [];
  lines.push(`# Email Triage Analytics`);
  lines.push(`Period: ${data.period.start.slice(0, 10)} to ${data.period.end.slice(0, 10)} (${data.period.days} days)`);
  lines.push("");

  lines.push(`## Session Summary`);
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Total Sessions | ${data.sessions.total} |`);
  lines.push(`| Avg Emails/Session | ${data.sessions.avgEmails} |`);
  lines.push(`| Avg Duration | ${formatDuration(data.sessions.avgDurationSec)} |`);
  lines.push("");

  lines.push(`## Action Distribution`);
  lines.push(`| Action | Count |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Archived | ${data.actionDistribution.archived} |`);
  lines.push(`| Trashed | ${data.actionDistribution.trashed} |`);
  lines.push(`| Replied | ${data.actionDistribution.replied} |`);
  lines.push(`| Kept | ${data.actionDistribution.kept} |`);
  lines.push(`| Unsubscribed | ${data.actionDistribution.unsubscribed} |`);
  lines.push(`| Blocked | ${data.actionDistribution.blocked} |`);
  lines.push("");

  lines.push(`## Junk Rate`);
  lines.push(`- Current: ${data.junkRate.current}%`);
  lines.push(`- Trend: ${data.junkRate.trend > 0 ? "+" : ""}${data.junkRate.trend}%`);
  lines.push("");

  if (data.topSenders.length > 0) {
    lines.push(`## Top Senders`);
    lines.push(`| Sender | Count | Last Seen |`);
    lines.push(`|--------|-------|-----------|`);
    for (const s of data.topSenders) {
      lines.push(`| ${s.sender} | ${s.count} | ${s.lastSeen} |`);
    }
    lines.push("");
  }

  if (data.weeklyTrend.length > 0) {
    lines.push(`## Weekly Trend`);
    lines.push(`| Week | Total | Auto-Processed | Junk Rate |`);
    lines.push(`|------|-------|-----------------|-----------|`);
    for (const w of data.weeklyTrend) {
      lines.push(`| ${w.week} | ${w.total} | ${w.autoProcessed} | ${w.junkRate}% |`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ─── Console formatter ───

export function formatAnalyticsConsole(data: AnalyticsData): string {
  const lines: string[] = [];
  lines.push(`Email Triage Analytics (${data.period.days} days)`);
  lines.push(`${"=".repeat(50)}`);
  lines.push("");

  lines.push(`Sessions: ${data.sessions.total}`);
  lines.push(`Avg Emails/Session: ${data.sessions.avgEmails}`);
  lines.push(`Avg Duration: ${formatDuration(data.sessions.avgDurationSec)}`);
  lines.push("");

  lines.push(`Action Distribution:`);
  const dist = data.actionDistribution;
  const total = dist.archived + dist.trashed + dist.replied + dist.kept + dist.unsubscribed + dist.blocked;
  if (total > 0) {
    const bar = (n: number, label: string) => {
      const pct = Math.round((n / total) * 100);
      const blocks = Math.round(pct / 5);
      return `  ${label.padEnd(14)} ${"#".repeat(blocks).padEnd(20)} ${n} (${pct}%)`;
    };
    lines.push(bar(dist.archived, "Archived"));
    lines.push(bar(dist.trashed, "Trashed"));
    lines.push(bar(dist.replied, "Replied"));
    lines.push(bar(dist.kept, "Kept"));
    lines.push(bar(dist.unsubscribed, "Unsubscribed"));
    lines.push(bar(dist.blocked, "Blocked"));
  } else {
    lines.push("  No data");
  }
  lines.push("");

  lines.push(`Junk Rate: ${data.junkRate.current}% (${data.junkRate.trend > 0 ? "+" : ""}${data.junkRate.trend}% trend)`);
  lines.push("");

  if (data.topSenders.length > 0) {
    lines.push(`Top Senders:`);
    for (const s of data.topSenders.slice(0, 10)) {
      lines.push(`  ${s.sender.padEnd(40)} ${String(s.count).padStart(4)}x  ${s.lastSeen}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ─── Helpers ───

function formatDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

// ─── CLI entry point ───

if (import.meta.main) {
  const args = process.argv.slice(2);
  const daysIdx = args.indexOf("--days");
  const days = daysIdx >= 0 && args[daysIdx + 1] ? parseInt(args[daysIdx + 1], 10) : 30;
  const save = args.includes("--save");

  const db = initDb();
  const data = getAnalytics(db, days);

  if (save) {
    const now = new Date();
    const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const vaultRoot = (function(){
  if (process.env.EMAILTRIAGE_VAULT_ROOT) return process.env.EMAILTRIAGE_VAULT_ROOT;
  try {
    const home = process.env.HOME;
    if (!home) return "";
    const fs = require("fs");
    const path = require("path");
    const prefs = path.join(home, ".claude/PAI/USER/SKILLCUSTOMIZATIONS/EmailTriage/preferences.yaml");
    if (!fs.existsSync(prefs)) return "";
    const raw = fs.readFileSync(prefs, "utf8");
    const m = raw.match(/^\s*vault_root\s*:\s*["']?([^"'#\n]+?)["']?\s*(?:#.*)?\$/m);
    return m ? m[1].trim() : "";
  } catch { return ""; }
})();
    const reportDir = join(vaultRoot, "30 - Areas/Productivity/Email Triage/Reports");
    mkdirSync(reportDir, { recursive: true });
    const reportPath = join(reportDir, `analytics-${dateStr}.md`);
    writeFileSync(reportPath, formatAnalyticsMarkdown(data));
    console.log(`Saved report to: ${reportPath}`);
  } else {
    console.log(formatAnalyticsConsole(data));
  }

  db.close();
}
