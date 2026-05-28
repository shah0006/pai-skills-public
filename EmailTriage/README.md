# EmailTriage

Morning email triage pipeline with a 6-stage classification funnel, mark-column tables, review-gated execution, scheduled sends, and auto-generated reference files. PAI v5 skill, bash + AppleScript transport via the AppleMail skill, SQLite as the single source of truth.

## What it does

The 3-stage daily pipeline:

1. **Generate** (`/generate-email-triage`) — fetches inbox emails via Apple Mail, applies an 8-tier classification funnel (VIP → junk → sender rules → domain rules → subject rules → known senders → AI classifier → unknown), sorts new emails into per-account stage folders, and writes a V2 triage note to your vault.
2. **Review** (`/start-email-triage`) — boots a Next.js web UI on `localhost:9988` for keyboard-driven review, AI-drafted replies, and decision capture into mark-column tables.
3. **Execute** (`/process-email`) — applies the marked decisions to Apple Mail, sends approved replies, queues scheduled sends via launchd, blocks senders/domains, fires RFC 8058 unsubscribes, and writes the audit log.

## Layout

```
EmailTriage/
├── SKILL.md                        # frontmatter + thin orchestration doc
├── README.md                       # this file
├── LICENSE                         # MIT
├── Tools/                          # all executables
│   ├── GenerateTriage.ts           # /generate-email-triage entry
│   ├── ExecuteTriage.ts            # /process-email entry
│   ├── SendLater.ts                # scheduled-send manager
│   ├── Doctor.ts                   # self-test
│   ├── AiClassifier.ts             # Anthropic batch classifier
│   ├── AlertSender.ts              # iMessage urgency alert
│   ├── Analytics.ts                # session analytics
│   ├── Db.ts                       # SQLite layer (10 tables)
│   ├── EmailParser.ts              # apple-mail.sh output parser
│   ├── PathResolver.ts             # i/g account routing
│   ├── ReferenceGenerator.ts       # auto-regen vault Reference/*.md files
│   ├── RulesEngine.ts              # 8-tier funnel
│   ├── StagedDrafts.ts             # vault Staged/ workflow
│   ├── TriageFormatter.ts          # V2 markdown renderer
│   ├── Types.ts                    # type definitions
│   ├── UnsubReport.ts              # daily unsubscribe report
│   └── Unsubscribe.ts              # RFC 8058 one-click
├── Workflows/                      # operational procedures
│   ├── Setup.md
│   ├── Generate.md
│   ├── Review.md
│   ├── Execute.md
│   ├── ScheduledSend.md
│   ├── Unsubscribe.md
│   └── DailyOps.md
├── References/                     # reference docs + canonical seeds
│   ├── ClassificationFunnel.md
│   ├── DatabaseSchema.md
│   ├── RulesYamlFormat.md
│   ├── JunkSendersFormat.md
│   ├── LaunchdConfig.md
│   ├── schema.sql                  # canonical SQL schema
│   ├── rules.yaml.seed             # placeholder rule template
│   ├── junk-senders.yaml.seed      # placeholder junk template
│   └── snippets.yaml               # quick-reply snippets
├── web/                            # Next.js review UI (port 9988)
├── tests/                          # 449 tests, 1120 assertions
├── scheduled/                      # launchd send queue (gitignored)
├── com.pai.send-later.plist.template  # launchd recurring agent template
└── send-dispatcher.sh              # zero-dep send agent for launchd
```

## Install

Prerequisites: macOS, Bun ≥ 1.3, AppleMail skill installed and tested, Full Disk Access for your terminal, Automation permission for terminal → Mail.app.

```bash
cd ~/.claude/skills/EmailTriage
bun install                          # root deps (bun:sqlite, js-yaml)
cd web && bun install                # Next.js review UI
cd ..
bun run Tools/Doctor.ts              # verify install
```

For first-run customization, see `Workflows/Setup.md`. For the recurring scheduled-send agent, also see `References/LaunchdConfig.md`.

## Customization

Optional `~/.claude/PAI/USER/SKILLCUSTOMIZATIONS/EmailTriage/preferences.yaml`:

```yaml
vault_root: /Volumes/<your-volume>/<your-vault>
self_address: you@example.com
first_name: Yourname
persona: Yourname Lastname (your-role)
```

Each key has a matching env var (`EMAILTRIAGE_VAULT_ROOT`, `EMAILTRIAGE_SELF_ADDRESS`, `EMAILTRIAGE_FIRST_NAME`, `EMAILTRIAGE_PERSONA`) that overrides the YAML.

## Daily usage

```bash
/generate-email-triage    # 1. build today's triage note
/start-email-triage       # 2. review and mark decisions in the web UI
/process-email            # 3. apply decisions
```

The full daily flow with verification commands is documented in `Workflows/DailyOps.md`.

## Architecture

- **Transport**: AppleMail skill (`apple-mail.sh`) drives Mail.app via AppleScript. Phase 1 of the Gmail Transport Proposal will swap Gmail to a direct gws transport (separate sign-off gate).
- **Source of truth**: SQLite at `<skill-root>/triage.db` (gitignored). 10 tables, see `References/DatabaseSchema.md`.
- **Classification**: 8-tier funnel implemented as a pure function over an in-memory cache. See `References/ClassificationFunnel.md`.
- **Vault output**: `<vault_root>/Email Triage/Email Triage -- <Month> <Day>, <Year>.md` plus auto-regenerated `<vault_root>/Email Triage/Reference/*.md`.

## Tests

```bash
cd ~/.claude/skills/EmailTriage && bun test
```

Current baseline: **449 pass / 0 fail / 1120 expect calls** across 20 test files in 660 source files. Every refactor must keep this green or document why.

## Troubleshooting

| Symptom | Recovery |
|---|---|
| `apple-mail.sh` returns empty | Mail.app must be running and the account synced. Try `bash ~/.claude/skills/AppleMail/Tools/apple-mail.sh list i` for iCloud only. |
| AI classifier rate limit (429) | Retries once after 5s, then falls back to rules-engine-only. Check `process.env.ANTHROPIC_API_KEY` is set. |
| Unsubscribe fails silently | Sender ignored RFC 8058. Mark `BD` (block domain) in next morning's triage. |
| Safe re-run collision | Default behavior is incremental merge (preserves prior decisions). Use `--force` for destructive regeneration. |
| Scheduled send fails | Retried up to 3 attempts then renamed to `<id>.failed.json`. Run `bun run Tools/SendLater.ts catchup` to retry. |
| Review-gate skipped | Stages with `[]` (unchecked) are not processed. Check `[x]` to enable (case-insensitive). |
| Next.js production build fails on `bun:sqlite` | Known limitation — analytics route uses `bun:sqlite` which Next.js's prod build can't resolve. Use `bun run dev` (Bun runtime) for the review UI. |

## Related skills

| Skill | Role |
|---|---|
| AppleMail | iCloud + IMAP transport (today the only Gmail path; Phase 1 swaps Gmail to gws) |
| GoogleWorkspaceCLI | Phase 1+ Gmail transport (sole writer) |
| AppleMessages | iMessage urgency alert delivery |

## Licence

MIT. See `LICENSE`.

## Reference proposals

- `Coordination/EmailTriage Phase 0 Pre-Decisions.md` — pre-Phase-0b OBSERVE sign-off; locked-in choices for the v5 layout
- `Coordination/EmailTriage Gmail Transport Proposal.md` — Q1=C, Q2=A, Q3=B sign-off for the gws transport split
