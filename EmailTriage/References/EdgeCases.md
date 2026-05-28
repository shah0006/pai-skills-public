## Edge Cases

| Failure mode | Recovery |
|---|---|
| `apple-mail.sh` returns empty | Verify Mail.app running and account synced. `apple-mail.sh list i` for iCloud only |
| AI classifier rate limit (429) | Retries once after 5s. Batch mode reduces API calls. Falls back to rules-engine-only |
| Unsubscribe fails silently | Sender ignored RFC 8058. Escalate to `BD` (block domain) on next triage |
| Safe re-run collision | Default: incremental merge (preserves decisions). `--force` for full regeneration |
| Scheduled send fails | Retry 3x, then `<id>.failed.json`. `bun run Tools/SendLater.ts catchup` to retry |
| Review gate skipped | Unchecked `[]` stages are not processed. Check `[x]` (case-insensitive) |
| Message ID changes after sort | Generator runs post-sort ID reconciliation (step 8b). Executor has fallback staging-folder search |
| Executor can't find message | Fallback: searches all staging folders for that account. Logs `[RETRY]` and `[FALLBACK]` |
