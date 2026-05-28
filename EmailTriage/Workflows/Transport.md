---
document-type: workflow
status: active
summary: "Transport layer onboarding — per-account routing, gws vs apple-mail.sh, reconciler"
---

# Transport Layer (v5)

> Canonical reference for how EmailTriage moves mail. For trigger phrases and day-to-day commands, see [[SKILL#Workflow Routing]].

## Overview

EmailTriage uses a **single-writer-per-account** model:

| Account alias | Display name | Transport | Binary / API |
| --- | --- | --- | --- |
| `i` | iCloud | `AppleMailTransport` | `~/.claude/skills/AppleMail/Tools/apple-mail.sh` |
| `g` | Google / Gmail | `GwsGmailTransport` | `gws` CLI + `GoogleWorkspaceCLI/Tools/Gmail/*.ts` |

Yahoo, Hotmail, AOL, and ProtonMail aliases exist in `Types.ts` but are not active in the morning pipeline today.

**Invariant:** Gmail never goes through AppleScript/Mail.app for read, move, or send in v5. iCloud never goes through gws.

## The `Transport` interface

Defined in `Tools/Transport.ts`:

```typescript
interface Transport {
  readonly account: AccountAlias;
  list(opts?: ListOptions): Promise<RawEmail[]>;
  read(messageId: string): Promise<ReadResult>;
  moveToStage(messageId: string, stage: FunnelStage): Promise<void>;
  markRead(messageId: string, read: boolean): Promise<void>;
  trash(messageId: string): Promise<void>;
  archive(messageId: string): Promise<void>;
  send(draft: SendDraft): Promise<{ messageId: string }>;
}
```

Factory:

```typescript
import { transportFor } from "./Transport";
const t = transportFor("g"); // GwsGmailTransport
const i = transportFor("i"); // AppleMailTransport — throws if passed "g"
```

Contract tests: `tests/transport-gws.test.ts`, `tests/transport-applemail.test.ts` (mocked executor, no live network in CI).

## Gmail (`GwsGmailTransport`)

### List / read

- **List:** `bun run …/GoogleWorkspaceCLI/Tools/Gmail/List.ts [N] --json [--label=Stages/…] [-u]`
- **Read:** `gws gmail +read --id <id> --format json`
- Message IDs are **hex strings** (e.g. `19e3c49e48816478`), stable across label changes.

### moveToStage (atomic-ish)

For each classified Gmail message, Generate calls:

1. `Gmail/Move.ts` — apply stage label under `Stages/Stage N - …`
2. `Gmail/Archive.ts` — remove from INBOX (single-writer: label is authoritative placement)

This replaces the old Mail.app folder move for Google account mail.

### Stage labels

Mapped in `Types.STAGE_FOLDER_NAMES` → Gmail label `Stages/<folder name>`:

| Funnel stage | Gmail label suffix |
| --- | --- |
| vip | `Stages/Stage 1 - VIP` |
| action | `Stages/Stage 2 - Action Required` |
| financial | `Stages/Stage 3 - Financial` |
| informational | `Stages/Stage 4 - Informational` |
| bulk_dispose | `Stages/Stage 5 - Bulk Dispose` |
| auto_processed | `Stages/Stage 6 - Auto-Processed` |

Labels are verified by Doctor probe 9b (existence check).

### Auth

- Doctor: `gws gmail users getProfile` (probe 9b)
- Pre-cron (inside Generate): same probe, 5s timeout — see `Tools/PreCronAuthCheck.ts`
- User recovery: `gws gmail auth login` (browser OAuth; not automatable)

On auth failure, Generate **skips the Gmail half**, writes a `[!warning]` banner, and fires iMessage + optional voice (`EMAILTRIAGE_DISABLE_VOICE=1` in CI).

## iCloud (`AppleMailTransport`)

### List / read / move

All operations shell out to `apple-mail.sh` with **no modifications** to that script (out of scope for EmailTriage upgrades).

- **List:** `apple-mail.sh list [account] [limit] [-u]`
- **Read:** `apple-mail.sh read <numericId>` — then mark-unread restore (preview-only)
- **Move:** `apple-mail.sh move <id> --account iCloud --mailbox Stages/…`

Numeric Mail.app IDs can change after a move; Generate runs **post-sort ID reconciliation** for iCloud rows only.

### Coexistence with Gmail in Mail.app

Preference `mail_app_gmail_coexists: true` (see `preferences.yaml`) tells Doctor probe 10 not to FAIL when Google account remains in Mail.app. Operational Gmail traffic still uses gws only.

## Generate pipeline integration

`Tools/GenerateTriage.ts`:

1. **Pre-cron auth** — `runPreCronAuthCheck()` at entry (live mode)
2. **Fetch inbox** — `fetchEmails()` routes `accountFilter === "g"` to gws; else `apple-mail.sh`
3. **Fetch staged** — Gmail stage labels via gws; iCloud via AppleScript batch (single osascript)
4. **Sort** — `sortToStageFolders()` calls `transportFor(alias).moveToStage()`
5. **Banner** — optional `session.banner` → `TriageFormatter.formatTriageNote()` injects after YAML frontmatter

## Reconciler (Phase 2)

**Schedule:** 05:00 local via `com.pai.reconciler.plist.template` → `Tools/Reconciler.ts`

**Scope (Phase 2):** Gmail only. iCloud drift deferred to Phase 2.1.

**Protocol:**

- **Expected stage:** parsed from latest triage note (`Tools/TriageNoteParser.ts`)
- **Remote stage:** listed per Gmail stage label via `GwsGmailTransport.list({ mailbox })`
- **Authority:** remote wins on conflict; log to `reconciliation_log` (new table in `schema.sql`)
- **UX:** drift banner in `tmp/reconciler-banner.txt` → merged at next Generate

Design detail: `References/ReconcilerDesign.md`

## Web UI (Phase 3)

Review app (`web/`, port 9988) does **not** import `Transport.ts` into the client bundle.

| Route | Role |
| --- | --- |
| `GET /api/stage-review?date=` | Aggregator: parsed session + transport health + degraded flags |
| `GET /api/triage?date=` | Raw note markdown (canonical filename) |
| `GET /api/email/:id` | Body fetch — gws or apple-mail by id shape |
| `POST /api/parse-note` | Legacy parser (stage-review preferred) |

**Open in source client:**

- Gmail → `https://mail.google.com/mail/u/0/#inbox/{messageId}`
- iCloud → `message://%3c{id}%3e` (Mail.app)

**Degraded mode:** when `probeGmailTransport()` or iCloud list fails, UI shows page banner and per-row `⚠ sync` badge; rows still render from the triage note (rendered snapshot).

**Path fix (AQ-3.5):** all web routes use `AppleMail/Tools/apple-mail.sh`, not `AppleMail/apple-mail.sh`.

## SQLite vs remote authority

| Layer | Role |
| --- | --- |
| Triage note | Rendered snapshot the user reviews |
| `triage.db` | Rules, VIP/junk, history, `reconciliation_log` |
| Gmail labels / Mail.app folders | **Operational authority** for message placement after reconciler |

Wording: *rendered snapshot, reconciled to remote authority* — not "SQLite is source of truth" for label placement.

## Adding a new account (contributor checklist)

1. Add alias to `Types.ACCOUNT_MAP` and `APPLEMAIL_ACCOUNT_NAMES` / gws account mapping.
2. Implement or extend a `Transport` class; register in `transportFor()`.
3. Add contract tests with mocked executor (see `tests/transport-gws.test.ts`).
4. Update Doctor probes for the new path.
5. Document routing here and add a row to `SKILL.md` Workflow Routing if user-facing.

## Verification commands

```bash
# Contract tests (no live Gmail required for mocks)
cd ~/.claude/skills/EmailTriage && bun test tests/transport-gws.test.ts tests/transport-applemail.test.ts

# Live probes
bun run Tools/Doctor.ts
bun run Tools/PreCronAuthCheck.ts

# Nightly reconciler (dry run against today's note)
bun run Tools/Reconciler.ts

# apple-mail.sh untouched (checksum log for Phase 4 seal)
shasum -a 256 ~/.claude/skills/AppleMail/Tools/apple-mail.sh
```

## Related files

| Path | Purpose |
| --- | --- |
| `Tools/Transport.ts` | Interface + both implementations |
| `Tools/PreCronAuthCheck.ts` | 5s auth probe + alerts |
| `Tools/Reconciler.ts` | Gmail drift detection |
| `Tools/TriageNoteParser.ts` | Note → id/stage map |
| `Tools/Banner.ts` | Obsidian warning callouts |
| `web/server/transport-health.ts` | UI transport probes |
| `References/ReconcilerDesign.md` | Phase 2 design defaults |
