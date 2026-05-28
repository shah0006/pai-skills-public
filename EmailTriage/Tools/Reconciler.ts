// Reconciler.ts — Nightly Gmail drift detection (Phase 2, Gmail-only per AQ-2.6)

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "fs";
import { join } from "path";
import { Database } from "bun:sqlite";
import { initDb, logReconciliation } from "./Db";
import { getOutputPath } from "./GenerateTriage";
import { parseTriageNoteStages } from "./TriageNoteParser";
import { formatWarningBanner } from "./Banner";
import { transportFor, type Transport } from "./Transport";
import { STAGE_FOLDER_NAMES, type FunnelStage, type AccountAlias } from "./Types";

const RECONCILER_STAGES: FunnelStage[] = [
  "vip", "action", "financial", "informational", "bulk_dispose", "auto_processed",
];

export function getSkillTmpDir(): string {
  const root = join(process.env.HOME ?? "", ".claude/skills/EmailTriage", "tmp");
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
  return root;
}

export function getReconcilerLockPath(): string {
  return join(getSkillTmpDir(), "reconciler.lock");
}

export function getReconcilerBannerPath(): string {
  return join(getSkillTmpDir(), "reconciler-banner.txt");
}

function todayEt(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
}

export interface ReconcileResult {
  driftCount: number;
  banner?: string;
  logged: number;
}

/**
 * Build remote (account-side) id → stage map from per-stage folder listings.
 * Works for any Transport whose `list({ mailbox: "Stages/Stage N - X" })`
 * returns the expected RawEmail rows — Gmail (label-based) and iCloud
 * (folder-based) both qualify.
 */
export async function fetchRemoteStages(
  transport: Transport,
  listFn: (label: string) => Promise<Array<{ id: string; isRead: boolean }>> = async (label) => {
    const rows = await transport.list({ mailbox: label, limit: 500 });
    return rows.map(r => ({ id: r.id, isRead: r.isRead }));
  },
): Promise<Map<string, { stage: FunnelStage; isRead: boolean }>> {
  const remote = new Map<string, { stage: FunnelStage; isRead: boolean }>();
  for (const stage of RECONCILER_STAGES) {
    const folder = STAGE_FOLDER_NAMES[stage];
    if (!folder) continue;
    const label = `Stages/${folder}`;
    try {
      const messages = await listFn(label);
      for (const msg of messages) {
        remote.set(msg.id, { stage, isRead: msg.isRead });
      }
    } catch {
      // Stage folder may not exist on this account (e.g. iCloud user never
      // created Stages/Stage 4 - Informational). Treat as empty and move on.
    }
  }
  return remote;
}

/** @deprecated — use `fetchRemoteStages`. Kept for any external callers. */
export const fetchGmailRemoteStages = fetchRemoteStages;

/**
 * Account-agnostic drift reconciliation. Compares the per-message stage
 * recorded in the triage note (via parseTriageNoteStages) against the
 * actual stage-folder occupancy fetched from the remote account.
 *
 * Filters the note's entries by `accountAlias` so a single reconciler
 * run only touches messages belonging to the account being reconciled.
 * Run once per account (Gmail-side + iCloud-side, in parallel from
 * runReconciler).
 */
export function reconcileAccountDrift(options: {
  noteContent: string;
  remoteStages: Map<string, { stage: FunnelStage; isRead: boolean }>;
  db: Database;
  accountAlias: AccountAlias;
  accountLabel?: string;  // Human label for banner + log ("Gmail", "iCloud", ...)
}): ReconcileResult {
  const { noteContent, remoteStages, db, accountAlias } = options;
  const accountLabel = options.accountLabel ?? (accountAlias === "g" ? "Gmail" : accountAlias === "i" ? "iCloud" : accountAlias);
  const expected = parseTriageNoteStages(noteContent);
  const driftLines: string[] = [];
  let logged = 0;

  for (const [id, remote] of remoteStages) {
    const exp = expected.get(id);
    if (!exp) {
      logReconciliation(db, {
        account: accountAlias,
        emailId: id,
        conflictType: "drift_remote_new",
        remoteValue: remote.stage,
        resolution: remote.stage,
        detail: `Message in ${accountLabel} stage folder but absent from triage note`,
      });
      logged++;
      driftLines.push(`- ${accountLabel} message \`${id}\` in **${remote.stage}** but not in triage note`);
      continue;
    }
    if (exp.account && exp.account !== accountAlias) continue;

    if (exp.stage !== remote.stage) {
      logReconciliation(db, {
        account: accountAlias,
        emailId: id,
        conflictType: "stage_mismatch",
        sqliteValue: exp.stage,
        remoteValue: remote.stage,
        resolution: remote.stage,
      });
      logged++;
      driftLines.push(`- \`${id}\`: note **${exp.stage}** → ${accountLabel} **${remote.stage}** (remote wins)`);
    }
  }

  for (const [id, exp] of expected) {
    if (exp.account && exp.account !== accountAlias) continue;
    if (!remoteStages.has(id)) {
      driftLines.push(`- \`${id}\`: in note as **${exp.stage}** but not found in ${accountLabel} stage folders`);
    }
  }

  const banner = driftLines.length > 0
    ? formatWarningBanner(`Reconciler drift (${accountLabel})`, [
        `${driftLines.length} drift event(s) detected at 05:00 — rendered snapshot reconciled to remote authority.`,
        ...driftLines.slice(0, 8),
        driftLines.length > 8 ? `…and ${driftLines.length - 8} more (see reconciliation_log)` : "",
      ])
    : undefined;

  return { driftCount: driftLines.length, banner, logged };
}

/** @deprecated — use `reconcileAccountDrift` with `accountAlias: "g"`. */
export function reconcileGmailDrift(options: {
  noteContent: string;
  remoteStages: Map<string, { stage: FunnelStage; isRead: boolean }>;
  db: Database;
  account?: string;
}): ReconcileResult {
  return reconcileAccountDrift({
    noteContent: options.noteContent,
    remoteStages: options.remoteStages,
    db: options.db,
    accountAlias: "g",
  });
}

export async function runReconciler(options: {
  date?: string;
  notePath?: string;
  dbPath?: string;
  /** @deprecated single-transport mode (Gmail-only). Use accounts: ["g"] explicitly. */
  transport?: Transport;
  /** Which accounts to reconcile. Defaults to both Gmail + iCloud. */
  accounts?: AccountAlias[];
  dryRun?: boolean;
} = {}): Promise<ReconcileResult> {
  const date = options.date ?? todayEt();
  const accounts = options.accounts ?? (options.transport ? ["g"] as AccountAlias[] : ["g", "i"] as AccountAlias[]);
  const lockPath = getReconcilerLockPath();
  if (existsSync(lockPath) && !options.dryRun) {
    // Check if the lock is stale — read the PID, verify the process still exists
    let stale = false;
    try {
      const lockPid = parseInt(readFileSync(lockPath, "utf-8").trim(), 10);
      if (isNaN(lockPid)) {
        stale = true; // corrupted lock
      } else {
        try {
          process.kill(lockPid, 0); // signal 0 = existence check, never sends a real signal
        } catch {
          stale = true; // PID not running — lock is stale
        }
      }
    } catch {
      stale = true; // unreadable lock
    }
    if (stale) {
      console.warn(`[reconciler] stale lock from PID ${readFileSync(lockPath, "utf-8").trim() || "?"} — clearing and proceeding`);
      try { unlinkSync(lockPath); } catch { /* best effort */ }
    } else {
      console.warn("[reconciler] lock present — another run in progress; exiting");
      return { driftCount: 0, logged: 0 };
    }
  }
  if (!options.dryRun) writeFileSync(lockPath, String(process.pid));

  try {
    const notePath = options.notePath ?? getOutputPath(date);
    if (!existsSync(notePath)) {
      return { driftCount: 0, logged: 0 };
    }
    const noteContent = readFileSync(notePath, "utf-8");
    const db = options.dbPath ? initDb(options.dbPath) : initDb();

    let totalDrift = 0;
    let totalLogged = 0;
    const banners: string[] = [];

    for (const accountAlias of accounts) {
      const transport = options.transport ?? transportFor(accountAlias);
      try {
        const remoteStages = await fetchRemoteStages(transport);
        const result = reconcileAccountDrift({ noteContent, remoteStages, db, accountAlias });
        totalDrift += result.driftCount;
        totalLogged += result.logged;
        if (result.banner) banners.push(result.banner);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[reconciler] account ${accountAlias} failed: ${msg}`);
        // One account failing should not abort the other — partial drift
        // detection beats no drift detection.
      }
    }

    if (!options.dbPath) db.close();

    const combinedBanner = banners.length > 0 ? banners.join("\n\n") : undefined;
    if (combinedBanner && !options.dryRun) {
      writeFileSync(getReconcilerBannerPath(), combinedBanner, "utf-8");
    }
    return { driftCount: totalDrift, banner: combinedBanner, logged: totalLogged };
  } finally {
    if (!options.dryRun && existsSync(lockPath)) unlinkSync(lockPath);
  }
}

if (import.meta.main) {
  (async () => {
    try {
      // 1. Drift reconciliation (Gmail + iCloud)
      const r = await runReconciler();
      console.log(`Reconciler complete: ${r.logged} logged, drift=${r.driftCount}`);
      if (r.banner) console.log(r.banner);

      // 2. Phase 24 VIP SLA check — appended to the same nightly banner so
      //    tomorrow morning's triage doc surfaces both surfaces in one block.
      try {
        const { checkVipSla, formatSlaBanner } = await import("./VipSla");
        const sla = checkVipSla({ slaHours: 24 });
        if (sla.overdue.length > 0) {
          const slaBanner = formatSlaBanner(sla);
          if (slaBanner) {
            const existing = r.banner ? `${r.banner}\n\n` : "";
            const combined = existing + slaBanner;
            const { writeFileSync } = await import("fs");
            writeFileSync(getReconcilerBannerPath(), combined, "utf-8");
            console.log(`VIP SLA: ${sla.overdue.length} overdue (banner appended)`);
          }
        } else {
          console.log(`VIP SLA: 0 overdue / ${sla.totalVipsTracked} tracked`);
        }
      } catch (e) {
        console.warn(`[reconciler] VIP SLA check failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    } catch (e) {
      console.error("[reconciler] failed:", e);
      process.exit(1);
    }
  })();
}
