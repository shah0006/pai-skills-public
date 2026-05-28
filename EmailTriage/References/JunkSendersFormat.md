# Reference: junk-senders.yaml Format

`References/junk-senders.yaml.seed` seeds the `junk_senders` table on first migration. Like `rules.yaml`, the DB takes over after seeding.

## Top-level keys

```yaml
by_address:    # array of strings — exact email addresses to block
by_domain:     # array of strings — entire domains to block
```

## Semantics

- `by_address` matches the email's `fromAddress` exactly (case-insensitive).
- `by_domain` matches the email's `fromDomain` exactly. `from_domain: example.com` blocks `anybody@example.com` AND `noreply@subdomain.example.com` (the runtime extracts the registered eTLD+1 from `fromAddress`, then compares).

## Funnel impact

Both lists feed tiers 2 and 3 of the classification funnel (see `ClassificationFunnel.md`). On match:

- `funnelStage` = `auto_processed`
- `priority` = `trash`
- `isJunk` = `true`

The email lands in Stage 6 of the triage note with the auto-trash badge. If the user leaves Stage 6 unchecked at execute time, the email stays in Mail.app inbox; checking `[x]` triggers the trash.

## Adding entries at runtime

Two entry points:

1. **Marking `J` (Junk) in Stage 5** — Execute writes the address to `junk_senders` (`by_address` style) on commit.
2. **Marking `BD` (Block Domain) in Stage 5** — Execute writes the domain to `junk_senders` (`by_domain` style) on commit.

Both auto-trigger `regenerateReference(db, "junk")`, which refreshes `<vault>/Email Triage/Reference/Junk Blocklist.md`.

## Auto-blocking (frequency-based)

`Tools/Db.ts::autoBlockFrequentTrashDomains()` scans `domain_activity` for domains with high trash velocity (default threshold) and auto-promotes them into `junk_senders.by_domain`. This catches recruiter spam and similar high-volume offenders without manual `BD`.

## YAML format gotchas

- Keep entries as plain strings, not quoted, unless the address contains special chars.
- Comments allowed (`#`).
- Trailing whitespace OK; the parser strips it.
- A blank `by_address:` or `by_domain:` (with no items) is valid.

## When to edit the seed vs the DB

- **Edit the seed** before first run on a new machine, to bootstrap your starting blocklist.
- **After first run**, never edit the seed (it's been renamed to `rules.yaml`/`junk-senders.yaml` after seeding and is no longer consulted). Edit the DB via marking actions in triage, or use SQL directly:

```sql
INSERT INTO junk_senders (domain, reason, account)
VALUES ('newjunkdomain.com', 'manual block 2026-04-15', NULL);
```
