// GET /api/analytics?days=30
// Returns: AnalyticsData JSON

import { NextResponse } from "next/server";
import { Database } from "bun:sqlite";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const SKILL_DIR = join(
  (process.env.HOME ?? (() => { throw new Error("HOME env var not set"); })()),
  ".claude/skills/EmailTriage",
);
const DB_PATH = join(SKILL_DIR, "triage.db");
const SCHEMA_PATH = join(SKILL_DIR, "References", "schema.sql");

function openDb(): Database {
  const db = new Database(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  if (existsSync(SCHEMA_PATH)) {
    const schema = readFileSync(SCHEMA_PATH, "utf-8");
    db.exec(schema);
  }
  return db;
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const daysParam = url.searchParams.get("days");
    const days = daysParam ? parseInt(daysParam, 10) : 30;

    if (isNaN(days) || days < 1 || days > 365) {
      return NextResponse.json(
        { error: "days must be a number between 1 and 365" },
        { status: 400 },
      );
    }

    const db = openDb();

    // Inline analytics query — avoids import resolution issues with Next.js bundler
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

    const totalArchived = sessions.reduce((s, r) => s + r.archived, 0);
    const totalTrashed = sessions.reduce((s, r) => s + r.trashed, 0);
    const totalReplied = sessions.reduce((s, r) => s + r.replied, 0);
    const totalUnsubscribed = sessions.reduce((s, r) => s + r.unsubscribed, 0);
    const totalBlocked = sessions.reduce((s, r) => s + r.blocked, 0);
    const totalEmails = sessions.reduce((s, r) => s + r.total, 0);
    const totalKept = totalEmails - totalArchived - totalTrashed - totalReplied - totalUnsubscribed - totalBlocked;

    const junkActions = totalTrashed + totalUnsubscribed + totalBlocked;
    const currentJunkRate = totalEmails > 0 ? Math.round((junkActions / totalEmails) * 100) : 0;

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

    const topSenders = db.prepare(`
      SELECT address AS sender, times_seen AS count, last_seen AS lastSeen
      FROM known_senders
      ORDER BY times_seen DESC
      LIMIT 10
    `).all() as Array<{ sender: string; count: number; lastSeen: string }>;

    const weeklyMap = new Map<string, { total: number; junk: number }>();
    for (const session of sessions) {
      const dateStr = session.date.slice(0, 10);
      const d = new Date(dateStr + "T00:00:00");
      const weekStart = new Date(d);
      weekStart.setDate(d.getDate() - d.getDay());
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

    db.close();

    return NextResponse.json({
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
    });
  } catch (err) {
    console.error("Analytics API error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
