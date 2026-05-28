// tests/reconciler-icloud.test.ts — Phase 21 iCloud-side reconciler coverage.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initDb, getRecentReconciliation } from "../Tools/Db";
import { reconcileAccountDrift } from "../Tools/Reconciler";
import type { FunnelStage } from "../Tools/Types";

const MIXED_NOTE = `---
date: 2026-05-18
account-map: "12345:i,67890:i,aaa111:g"
---
# Email Triage

## [] Stage 1: VIP (1)
*People who matter most.*
#### [12345](message://x) sender@test [VIP] [i] -- 2026-05-18
**Subject Z**

## [] Stage 5: Bulk Dispose (1)
| ID | Sender | Subject |
| --- | --- | --- |
| [67890](message://y) [i] | bulk@test | Subj Y |

## [] Stage 6: Auto-Processed (1)
| ID | Sender | Subject |
| --- | --- | --- |
| [aaa111](message://z) [g] | gmail@test | Subj Z |
`;

describe("reconcileAccountDrift — iCloud (account 'i')", () => {
  let db: Database;
  beforeEach(() => { db = initDb(":memory:"); });
  afterEach(() => { db.close(); });

  test("detects stage_mismatch on iCloud-tagged emails only", () => {
    // iCloud remote says 12345 (note: vip) is actually in bulk_dispose
    const remote = new Map<string, { stage: FunnelStage; isRead: boolean }>([
      ["12345", { stage: "bulk_dispose", isRead: true }],
      ["67890", { stage: "bulk_dispose", isRead: true }],  // matches
    ]);
    const result = reconcileAccountDrift({
      noteContent: MIXED_NOTE, remoteStages: remote, db, accountAlias: "i",
    });
    expect(result.driftCount).toBeGreaterThan(0);
    expect(result.banner).toContain("Reconciler drift (iCloud)");
    const rows = getRecentReconciliation(db, 10);
    expect(rows.find(r => r.emailId ==="12345" && r.conflictType === "stage_mismatch")).toBeDefined();
  });

  test("does not flag Gmail-only emails when reconciling iCloud", () => {
    // aaa111 is Gmail per account-map. iCloud reconciler should ignore it.
    const remote = new Map<string, { stage: FunnelStage; isRead: boolean }>([
      ["12345", { stage: "vip", isRead: true }],   // matches
      ["67890", { stage: "bulk_dispose", isRead: true }],  // matches
    ]);
    const result = reconcileAccountDrift({
      noteContent: MIXED_NOTE, remoteStages: remote, db, accountAlias: "i",
    });
    expect(result.driftCount).toBe(0);
    expect(result.banner).toBeUndefined();
  });

  test("logs drift_remote_new when iCloud has an email not in note", () => {
    const remote = new Map<string, { stage: FunnelStage; isRead: boolean }>([
      ["12345", { stage: "vip", isRead: true }],
      ["67890", { stage: "bulk_dispose", isRead: true }],
      ["99999", { stage: "action", isRead: false }],   // new on iCloud, not in note
    ]);
    const result = reconcileAccountDrift({
      noteContent: MIXED_NOTE, remoteStages: remote, db, accountAlias: "i",
    });
    expect(result.driftCount).toBeGreaterThan(0);
    const rows = getRecentReconciliation(db, 10);
    expect(rows.find(r => r.emailId ==="99999" && r.conflictType === "drift_remote_new")).toBeDefined();
  });

  test("flags note-but-missing-remote for iCloud emails", () => {
    // Note says 12345 is VIP; remote says nothing about it (no folder hit)
    const remote = new Map<string, { stage: FunnelStage; isRead: boolean }>([
      ["67890", { stage: "bulk_dispose", isRead: true }],
    ]);
    const result = reconcileAccountDrift({
      noteContent: MIXED_NOTE, remoteStages: remote, db, accountAlias: "i",
    });
    expect(result.driftCount).toBe(1);
    expect(result.banner).toContain("`12345`");
    expect(result.banner).toContain("not found in iCloud");
  });

  test("respects custom accountLabel in banner text", () => {
    const remote = new Map<string, { stage: FunnelStage; isRead: boolean }>([
      ["12345", { stage: "bulk_dispose", isRead: true }],
    ]);
    const result = reconcileAccountDrift({
      noteContent: MIXED_NOTE, remoteStages: remote, db,
      accountAlias: "i", accountLabel: "iCloud Mail",
    });
    expect(result.banner).toContain("Reconciler drift (iCloud Mail)");
  });
});
