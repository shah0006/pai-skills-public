---
document-type: reference
status: active
summary: "Phase 2 reconciler + pre-cron auth — design defaults (D3–D5, AQ-2.x)"
---

# Reconciler Design (Phase 2)

## Purpose
Nightly drift detection between **rendered triage note** (expected stage per message) and **Gmail label state** (remote authority). iCloud drift deferred to Phase 2.1 (Gmail-only per AQ-2.6).

## Drift protocol (D4)
- **Rendered truth for UX:** triage note + SQLite action history inform what the user last saw.
- **Remote authority for transport state:** when Gmail label placement disagrees with the note, **remote wins** for operational stage; log the event; surface a warning banner on the next Generate run.
- Reconciler does **not** mutate Gmail labels or existing SQLite tables — only `INSERT` into `reconciliation_log`.

## Conflict resolution (D5)
| Conflict | Resolution | Log `conflict_type` |
| --- | --- | --- |
| Stage mismatch (note vs label) | Remote stage wins | `stage_mismatch` |
| Read mismatch | Treat as unread (conservative) | `read_mismatch` |
| Message on Gmail, absent from note | Remote wins; flag new | `drift_remote_new` |

## SQLite stage source (AQ-2.1)
1. **Primary:** parse latest triage note (`Tools/TriageNoteParser.ts`) — same sections as Generate/Review UI.
2. **Secondary:** `email_actions.folder` when present (executed moves).
3. **Persist:** `reconciliation_log` only (no `staged_emails`; table was dropped in Db migration).

## `reconciliation_log` schema (AQ-2.2)
See `References/schema.sql`. Columns: `id`, `created_at`, `account`, `email_id`, `conflict_type`, `sqlite_value`, `remote_value`, `resolution`, `detail`.

## Schedule
| Job | Time | Tool | launchd |
| --- | --- | --- | --- |
| Reconciler | 05:00 local | `Tools/Reconciler.ts` | `com.pai.reconciler.plist.template` |
| Generate (existing) | ~06:00 | `Tools/GenerateTriage.ts` | user plist |

Serialization: reconciler uses exclusive lock `tmp/reconciler.lock`; read-only remote + log inserts; finishes before Generate. Pre-cron auth runs **inside** Generate at entry (not a separate cron).

## Pre-cron auth (AQ-2.3, AQ-2.4)
- Probe: `gws gmail users getProfile` with **5s** timeout (matches Doctor probe 9b).
- On failure: skip Gmail half in Generate; prepend `[!warning]` banner; parallel alerts:
  - iMessage via `AlertSender.sendAuthFailureAlert`
  - Voice via `POST http://localhost:31337/notify` when `EMAILTRIAGE_DISABLE_VOICE` unset
- User recovery: `gws gmail auth login` (browser OAuth — not automated).

## Banner placement (AQ-2.5)
- `TriageFormatter.formatTriageNote(session)` accepts optional `session.banner` (Obsidian `[!warning]` callout after YAML frontmatter).
- `PreCronAuthCheck` + reconciler drift text merged in `GenerateTriage` before format.
- Reconciler writes pending banner to `tmp/reconciler-banner.txt` when note file does not exist yet.

## Acceptance probes (tests)
1. **Synthetic auth failure:** mock gws timeout → banner text + skip Gmail fetch + alerts mocked.
2. **Synthetic label drift:** note says stage A, remote list says stage B → `reconciliation_log` row + banner fragment.

## Implementation files
| File | Role |
| --- | --- |
| `Tools/TriageNoteParser.ts` | id → stage (+ account) from markdown |
| `Tools/Reconciler.ts` | Gmail drift detection + log + banner file |
| `Tools/PreCronAuthCheck.ts` | Auth probe + alert fan-out |
| `Tools/Banner.ts` | Callout format / merge / strip |
| `Tools/AlertSender.ts` | iMessage + voice for auth failures |
| `Tools/GenerateTriage.ts` | Calls pre-cron at start; passes banner to formatter |
| `References/schema.sql` | `reconciliation_log` table |

## Doc wording (AQ-2.7)
Use **"rendered snapshot, reconciled to remote authority"** — not "SQLite is source of truth" for label placement.
