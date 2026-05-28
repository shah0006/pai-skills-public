## Key source files (Tools/)

| File | Purpose |
|---|---|
| `GenerateTriage.ts` | Pipeline orchestrator (fetch, classify, format, write) |
| `ExecuteTriage.ts` | Batch execution (parse decisions, execute actions) |
| `AiClassifier.ts` | AI classification (batch mode, Anthropic Haiku) |
| `RulesEngine.ts` | 8-tier DB-backed classifier (pure function) |
| `TriageFormatter.ts` | V2 Obsidian renderer (mark columns, review gates) |
| `Db.ts` | SQLite layer (10 tables, all CRUD operations) |
| `PathResolver.ts` | Unified per-account path convention (`i/folder`, `g/folder`) |
| `ReferenceGenerator.ts` | Auto-regenerated vault reference files |
| `AlertSender.ts` | iMessage urgent email alerts |
| `StagedDrafts.ts` | Draft review workflow (Staged/ folder) |
| `SendLater.ts` | Scheduled send management (JSON + launchd) |
| `Unsubscribe.ts` | RFC 8058 one-click unsubscribe |
| `UnsubReport.ts` | Daily unsubscribe report |
| `Analytics.ts` | Session analytics (CLI + web tab) |
| `EmailParser.ts` | apple-mail.sh output parser |
| `Types.ts` | Type definitions (AccountAlias, FunnelStage, etc.) |
| `Doctor.ts` | Self-test |
| `Transport.ts` | Per-account transport (gws + apple-mail.sh) |
| `PreCronAuthCheck.ts` | Gmail auth probe before Generate |
| `Reconciler.ts` | Nightly Gmail drift detection |

`send-dispatcher.sh` (at skill root) is the zero-dependency send agent that launchd invokes. Stays at root (Phase 0 A3=B locked-in choice) so the launchd plist's absolute path doesn't drift.
