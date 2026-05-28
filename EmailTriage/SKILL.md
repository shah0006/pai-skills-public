---
name: EmailTriage
version: 5.0.0
description: "Morning email triage pipeline with 6-stage classification, review-gated execution, scheduled sends, and one-click unsubscribe. 3-stage pipeline: generate (AI classify), review (web UI), execute (batch decisions). SQLite-backed rules engine. USE WHEN running morning email triage, classifying inbox, batch-processing decisions, or unsubscribing. NOT FOR generic Apple Mail send/read (use AppleMail), iMessage triage (use AppleMessages), or Gmail-only workflows (use GoogleWorkspaceCLI). Differentiator -- generate-review-execute pipeline with SQLite rules engine, staged drafts, and scheduled sends."
modified: 2026-05-24T05:00:00-04:00
---

# EmailTriage

## Customization

Before executing, check for user customizations at:

`~/.claude/PAI/USER/SKILLCUSTOMIZATIONS/EmailTriage/preferences.yaml`

Recognized keys (each also overridable via env var):

| Key | Env var | Effect |
|---|---|---|
| `vault_root` | `EMAILTRIAGE_VAULT_ROOT` | Where the triage notes are written. |
| `self_address` | `EMAILTRIAGE_SELF_ADDRESS` | Routing target for iMessage urgent alerts. |
| `first_name` | `EMAILTRIAGE_FIRST_NAME` | First name used in AI reply prompts. |
| `persona` | `EMAILTRIAGE_PERSONA` | Full persona description used in AI prompts ("Yourname Lastname (your role)"). |

If neither preferences nor env var is set, the skill runs with neutral defaults (no PII baked into the source).

## 🚨 MANDATORY: Voice Notification (REQUIRED BEFORE ANY ACTION)
**You MUST send this notification BEFORE doing anything else when this skill is invoked.**

1. Send voice notification:
   ```bash
   curl -s -X POST http://localhost:31337/notify \
     -H "Content-Type: application/json" \
     -d '{"message": "Running the WORKFLOWNAME workflow in the EmailTriage skill to ACTION"}' \
     > /dev/null 2>&1 &
   ```

2. Output text notification:
   ```
   Running the **WorkflowName** workflow in the **EmailTriage** skill to ACTION...
   ```


## Pipeline (3 stages)

Morning inbox processing pipeline that fetches emails, classifies them with a DB-backed rules engine + AI, generates a V2 vault triage note with mark-column tables and review gates, and executes decisions in batch. SQLite (`triage.db`) is the single source of truth — no YAML config files at runtime.

1. **Generate** (`/generate-email-triage`): `bun run ~/.claude/skills/EmailTriage/Tools/GenerateTriage.ts [--test] [--date YYYY-MM-DD] [--account i|g] [--force] [--all]` — full procedure in `Workflows/Generate.md`.
2. **Review** (`/start-email-triage`): `cd ~/.claude/skills/EmailTriage/web && bun run dev` → `http://localhost:9988` — `Workflows/Review.md`.
3. **Execute** (`/process-email`): `bun run ~/.claude/skills/EmailTriage/Tools/ExecuteTriage.ts [--date YYYY-MM-DD] [--dry-run]` — `Workflows/Execute.md`.

## 6-Stage Triage Funnel

Six stages (VIP → Auto-Processed): H4 blocks, expanded financial table, mark-column tables, optional Rule column, and per-stage review gates (`[x]` / `[]`; only checked stages run in Execute). Full stage table and classification order: `References/ClassificationFunnel.md`.

## Workflows

| Typical triggers | File | Operation |
| --- | --- | --- |
| (first run) | `Workflows/Setup.md` | First-run permissions and install |
| `/generate-email-triage`, "morning triage", "start triage" | `Workflows/Generate.md` | `/generate-email-triage` flow |
| `/start-email-triage`, "review UI", "web ui" | `Workflows/Review.md` | Web UI review flow |
| `/process-email`, "execute triage", "process decisions" | `Workflows/Execute.md` | `/process-email` flow |
| "scheduled send", "send later" | `Workflows/ScheduledSend.md` | launchd-driven send-later |
| "unsubscribe", "one-click unsubscribe" | `Workflows/Unsubscribe.md` | RFC 8058 one-click unsubscribe |
| (daily loop) | `Workflows/DailyOps.md` | Standard morning triage loop |
| (transport / reconciler / web) | `Workflows/Transport.md` | Per-account transport, reconciler, web UI integration |

## References

| File | Topic |
|---|---|
| `References/ClassificationFunnel.md` | 8-tier funnel order, stage mapping |
| `References/DatabaseSchema.md` | SQLite schema (11 tables incl. reconciliation_log) |
| `References/ReconcilerDesign.md` | Phase 2 reconciler + pre-cron defaults |
| `References/RulesYamlFormat.md` | `rules.yaml.seed` format |
| `References/JunkSendersFormat.md` | `junk-senders.yaml.seed` format |
| `References/LaunchdConfig.md` | `com.pai.send-later.plist.template` explanation |

Plus canonical seeds: `References/schema.sql`, `References/rules.yaml.seed`, `References/junk-senders.yaml.seed`, `References/snippets.yaml`. Self-test: see [References/SelfTest.md](References/SelfTest.md). Tests: see [References/Tests.md](References/Tests.md). Key source files (Tools/): see [References/KeySourceFiles.md](References/KeySourceFiles.md). Dependencies: see [References/Dependencies.md](References/Dependencies.md). Edge cases: see [References/EdgeCases.md](References/EdgeCases.md).

## Examples

### Example 1: Morning email triage generation
```
User: "Generate my morning email triage"
PAI:
1. Triggers `Workflows/Generate.md` workflow.
2. Runs `GenerateTriage.ts` to query local SQLite (`triage.db`) and query recent Gmail/iCloud inbox items.
3. Automatically classifies emails into a 6-stage funnel (VIP, Action Required, Financial, Info, etc.).
4. Writes the triage markdown note inside the Obsidian vault with mark-column tables ready for review.
```

### Example 2: Running the review UI
```
User: "Open the email triage web review panel"
PAI:
1. Triggers `Workflows/Review.md` workflow.
2. Checks to see if port 9988 is free.
3. Runs `cd web && bun run dev` to boot the local Next.js dashboard.
4. Opens the dashboard: `http://localhost:9988`, allowing interactive drag-and-drop classification review.
```

### Example 3: Executing triaged email decisions
```
User: "Process my triaged emails"
PAI:
1. Triggers `Workflows/Execute.md` workflow.
2. Reads the marked Obsidian triage note to determine user-approved actions (Archive, Reply Draft, Trash).
3. Executes batches via AppleMail/Gmail transports.
4. Cleans up folders and updates `triage.db` stats.
```

## Gotchas

- **Bun Runtime Lockout:** EmailTriage relies exclusively on the `bun` runtime. Always run commands using `bun install` and `bun run`, never `npm` or `npx`.
- **Dual Package Managers:** The repository contains two distinct `bun.lockb` files: the root directory (CLI pipeline) and `web/` (Next.js client interface). Both must be installed separately.
- **Web UI dev-only constraint:** Next.js can only be run in dev mode (`bun run dev`) due to how dynamic database queries map to `bun:sqlite`. Production compilation (`next build`) will fail.
- **SQLite Single Source of Truth:** Seed files (`rules.yaml.seed` and `junk-senders.yaml.seed`) migrate into SQLite on initial run. Thereafter, the local SQLite database is the *sole* source of truth; post-seeding modifications to YAML files are ignored.
- **iCloud Parity Reconciler:** Divergences between the vault triage doc and physical iCloud mailboxes are common because iCloud is the active human-manipulated mailbox. Ensure the Nightly Reconciler script runs continuously to repair drift.
- **VIP Post-Staging Sync:** If a sender is marked VIP *after* their emails are staged, run the reconciler to sync both the Obsidian document section and the physical iCloud folder, otherwise they will diverge.

**Related skills:** see [References/RelatedSkills.md](References/RelatedSkills.md).


## Phase 21 — Conditional follow-up sends

`Tools/ConditionalSends.ts` implements "follow up in 3 days if no response":

- `registerConditional({ id, recipient, originalSentAt, followUpSendAt, notes })` writes to `<skill_root>/conditional-sends.json`.
- `checkPendingConditionals({ now, replyChecker })` walks the registry; for each non-cancelled entry whose follow-up date has arrived, asks the injectable `replyChecker` (default: `apple-mail.sh search from:RECIPIENT after:DATE --mailbox all`) and either fires or cancels.
- `cancelConditional(id, reason)` for manual cancellation.

CLI: `bun Tools/ConditionalSends.ts register|check|list`.

## Phase 23 — Calendar bidirectionality v0

`Tools/CalendarSuggest.ts` heuristically detects emails that propose meetings (subject + body cues, calendar/meeting URLs, date+time patterns) and returns `{ summary, proposedTime, confidence, basis }`. Threshold 0.25 — single strong subject cue suffices.

API: `POST /api/calendar/suggest`. Web UI surfaces in `AiInsightPanel` right column as a gold-tinted "📅 Suggests calendar hold (NN%)" card. Read-only v0 — Phase 23 v1 will optionally auto-create via `gws calendar`.

## Phase 23 — Voice-to-draft v0

`POST /api/draft/from-voice` accepts `{ recipient, subject, transcript }` and stages an email draft via existing `StagedDrafts.ts` flow. Pulse handles upstream transcription; this endpoint is the receiving side. Drafts land in `Email Triage/Staged/` for human review + send through the existing approval workflow.

## Phase 24 — Cross-account thread merging v0

`Tools/CrossAccountThreads.ts` identifies threads spanning Gmail + iCloud via normalized-subject matching (`normalizeSubject` strips Re/Fwd/[EXTERNAL] prefixes). API: `POST /api/threads/cross-account`. Web UI renders a gold "🔗 N" chip in `EmailListItem`'s badge row when an email is part of a multi-account thread.

## Phase 24 — Per-sender VIP SLA enforcement

`Tools/VipSla.ts` walks all triage notes for Stage 1 VIPs without a recorded `email_actions` row within the SLA window (default 24h). Emits a banner via `formatSlaBanner` that the reconciler's nightly run appends to `tmp/reconciler-banner.txt`, picked up by GenerateTriage's `injectBannerAfterFrontmatter` next morning. Pulse notification optional via `notifyPulse`.

CLI: `bun Tools/VipSla.ts [--sla N] [--dry-run] [--json]`. Auto-runs after `Reconciler.ts` (5am launchd).

## Phase 24 — Autonomous Stage 5/6 execution scanner

`Tools/AutonomousActions.ts` reads `HistoricalClassifier` predictions for a batch of emails and returns the subset that meet the auto-execute threshold. Safety: only A/T/U auto-executable; VIP never auto-actioned; sender requires ≥ 5 samples + ≥ 0.85 confidence; domain requires ≥ 10 + ≥ 0.95. Read-only scanner — caller decides whether to apply.

## Phase 22 — Heuristic historical classifier

`Tools/HistoricalClassifier.ts` predicts the most-likely action for a new email from prior `domain_activity` history. Three layers: exact sender (strongest) → domain fallback → subject patterns (v2). Output `{ predictedAction, confidence, basis, source }`.

## Phase 22 — Sender memory (v0)

`Tools/SenderMemory.ts` exposes `getSenderHistory(db, address)` and `getDomainHistory(db, domain)` against the `domain_activity` table. Aggregates archive/trash/reply/defer/keep/junk/unsub/block/approve counts, surfaces `firstSeen` + `lastSeen`, marks `isFrequent` at >= 5 sightings, and returns a `suggestion` (auto-archive / auto-trash / auto-unsub / block) when one action dominates >= 80% of >= 5 sightings.

Web UI surfaces this in `EmailDetailPanel`'s right column (`AiInsightPanel` → "Sender History" section). API: `GET /api/sender/history?address=X&domain=Y` returns `{ address: SenderHistory, domain: SenderHistory }`.

### Backfill tools (populate `domain_activity` from history)

- **`bun Tools/BackfillDomainActivity.ts [--dry-run]`** — parses Stage 5 and Stage 6 table rows from all triage notes in the vault, extracts (domain, address, action_code) from the 'x' marks in named action columns. Idempotent.
- **`bun Tools/BackfillFromActions.ts [--dry-run]`** — JOINs the `email_actions` table against a sender index built from all triage notes. Yields rows for any email that was processed regardless of which stage section it lived in. Idempotent.

Run both on a fresh install; re-run periodically as triage notes accumulate.

## Changelog

- **2026-05-18 — iCloud-side drift reconciler (commit `b5c03ee`).**
  - Conjecture: Gmail drift detection was sufficient because iCloud is the user's primary client and any divergence between PAI's note and iCloud reality would be immediately visible to the user.
  - Refuted by: today's VIP-routing bug was an iCloud-side disagreement that went undetected for an unknown period — the doc said Stage 1, iCloud said Stage 2/3, and no reconciler ran on the iCloud side to surface the drift on next morning's banner.
  - Learned: drift detection is most valuable on whichever account is the *source of human action*, because that's where re-routing happens out-of-band. Skipping iCloud parity (V5 AQ-2.6 decision) was a false economy — Gmail drift is rare, iCloud drift is common.
  - Criterion now: `runReconciler` reconciles both Gmail AND iCloud by default; account-level failure on one does not abort the other; banners are joined and clearly labelled with the account name. iCloud divergence now produces a `Reconciler drift (iCloud)` banner inline on the next morning's triage note alongside any Gmail banner.
- **2026-05-18 — VIP routing + stale summary fix (commit `351b7f0`).**
  - Conjecture: triage doc and mailbox state are kept in sync by a single source-of-truth `funnelStage` field that drives both the doc section and the physical mailbox routing.
  - Refuted by: today's doc showed 11 emails under `## [] Stage 1: VIP` but `apple-mail.sh count "i/Stages/Stage 1 - VIP"` returned 0; the same 11 messages were physically in Stages 2 and 3.
  - Learned: `sortToStageFolders` only operated on NEW inbox emails. Already-staged emails read from existing stage folders kept their physical location even when re-classified into a different funnelStage by a new VIP rule. Separately, `mergeIntoExistingNote` reconciled section heading counts + frontmatter totals but not the human-readable `> N VIP | …` summary line, and the early-return (newEmails=0) branch skipped reconciliation entirely.
  - Criterion now: after every triage run, the count of messages in each `Stages/Stage N - <Name>` mailbox must equal the count rendered in the doc's `## [] Stage N` section heading; the `> N VIP | …` summary line must equal the section heading counts.

## Execution Log

After completing any workflow, append a single JSONL entry:

```bash
echo '{"ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","skill":"EmailTriage","workflow":"WORKFLOW_USED","input":"8_WORD_SUMMARY","status":"ok|error","duration_s":SECONDS}' >> ~/.claude/PAI/MEMORY/SKILLS/execution.jsonl
```


## Workflow Routing

| Workflow | Trigger | Target |
| --- | --- | --- |
| Unsubscribe | Invoke Unsubscribe workflow | Workflows/Unsubscribe.md |
| Setup | Invoke Setup workflow | Workflows/Setup.md |
| ScheduledSend | Invoke ScheduledSend workflow | Workflows/ScheduledSend.md |
| Generate | Invoke Generate workflow | Workflows/Generate.md |
| Transport | Invoke Transport workflow | Workflows/Transport.md |
| Review | Invoke Review workflow | Workflows/Review.md |
| DailyOps | Invoke DailyOps workflow | Workflows/DailyOps.md |
| Execute | Invoke Execute workflow | Workflows/Execute.md |
