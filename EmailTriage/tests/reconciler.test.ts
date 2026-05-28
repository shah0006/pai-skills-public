import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initDb, getRecentReconciliation } from "../Tools/Db";
import { reconcileGmailDrift, fetchGmailRemoteStages } from "../Tools/Reconciler";
import { parseTriageNoteStages } from "../Tools/TriageNoteParser";
import { probeGmailAuth } from "../Tools/PreCronAuthCheck";
import { formatWarningBanner } from "../Tools/Banner";
import { _setExecutor, _resetExecutor, type Executor } from "../Tools/Transport";
import type { FunnelStage } from "../Tools/Types";

const SAMPLE_NOTE = `---
date: 2026-05-18
account-map: "aaa111:g,bbb222:g"
---
# Email Triage

## [] Stage 5: Bulk Dispose (1)
| ID | Sender | Subject |
| --- | --- | --- |
| [aaa111](message://x) [g] | A | Subj A |

## [] Stage 6: Auto-Processed (1)
| ID | Sender | Subject |
| --- | --- | --- |
| [bbb222](message://y) [g] | B | Subj B |
`;

describe("TriageNoteParser", () => {
  test("parses Gmail hex ids with stage", () => {
    const map = parseTriageNoteStages(SAMPLE_NOTE);
    expect(map.get("aaa111")?.stage).toBe("bulk_dispose");
    expect(map.get("bbb222")?.stage).toBe("auto_processed");
    expect(map.get("aaa111")?.account).toBe("g");
  });
});

describe("reconcileGmailDrift", () => {
  let db: Database;
  beforeEach(() => { db = initDb(":memory:"); });
  afterEach(() => { db.close(); });

  test("detects stage_mismatch and logs reconciliation", () => {
    const remote = new Map<string, { stage: FunnelStage; isRead: boolean }>([
      ["aaa111", { stage: "auto_processed", isRead: true }],
      ["bbb222", { stage: "auto_processed", isRead: true }],
    ]);
    const result = reconcileGmailDrift({ noteContent: SAMPLE_NOTE, remoteStages: remote, db });
    expect(result.logged).toBeGreaterThan(0);
    expect(result.banner).toContain("Reconciler drift");
    const rows = getRecentReconciliation(db, 10);
    expect(rows.some(r => r.conflictType === "stage_mismatch")).toBe(true);
  });

  test("detects drift_remote_new", () => {
    const remote = new Map<string, { stage: FunnelStage; isRead: boolean }>([
      ["aaa111", { stage: "bulk_dispose", isRead: true }],
      ["bbb222", { stage: "auto_processed", isRead: true }],
      ["ccc333", { stage: "vip", isRead: false }],
    ]);
    const result = reconcileGmailDrift({ noteContent: SAMPLE_NOTE, remoteStages: remote, db });
    expect(result.driftCount).toBeGreaterThan(0);
    const rows = getRecentReconciliation(db, 10);
    expect(rows.some(r => r.emailId === "ccc333" && r.conflictType === "drift_remote_new")).toBe(true);
  });
});

describe("fetchGmailRemoteStages (mocked)", () => {
  afterEach(() => { _resetExecutor(); });

  test("aggregates messages from stage label listings", async () => {
    const exec: Executor = (cmd, args) => {
      if (args.some(a => a.endsWith("List.ts"))) {
        const labelArg = args.find(a => a.startsWith("--label=")) ?? "";
        if (labelArg.includes("Stage 5")) {
          return JSON.stringify([{ id: "m1", labelIds: [], payload: { headers: [] } }]);
        }
        if (labelArg.includes("Stage 6")) {
          return JSON.stringify([{ id: "m2", labelIds: [], payload: { headers: [] } }]);
        }
        return "[]";
      }
      return "[]";
    };
    _setExecutor(exec);
    const { transportFor } = await import("../Tools/Transport");
    const remote = await fetchGmailRemoteStages(transportFor("g"));
    expect(remote.get("m1")?.stage).toBe("bulk_dispose");
    expect(remote.get("m2")?.stage).toBe("auto_processed");
  });
});

describe("probeGmailAuth", () => {
  test("returns ok=false on gws failure (synthetic)", () => {
    const orig = process.env.GWS_BIN;
    process.env.GWS_BIN = "/usr/bin/false";
    const r = probeGmailAuth(1000);
    expect(r.ok).toBe(false);
    if (orig) process.env.GWS_BIN = orig;
    else delete process.env.GWS_BIN;
  });
});

describe("formatWarningBanner", () => {
  test("produces Obsidian callout", () => {
    const b = formatWarningBanner("Gmail auth failure (pre-cron)", ["line one"]);
    expect(b).toContain("> [!warning]");
    expect(b).toContain("line one");
  });
});
