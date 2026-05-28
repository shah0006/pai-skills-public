# Reference: rules.yaml Format

`References/rules.yaml.seed` is the bootstrap template that seeds `vip_senders` + `routing_rules` on a fresh database. Once the DB exists, the seed is no longer consulted; the DB is the source of truth.

## Top-level keys

```yaml
vip_senders:        # array of strings (email addresses)
sender_rules:       # array of rule objects matching from
domain_rules:       # array of rule objects matching from_domain
subject_rules:      # array of rule objects matching subject_contains
```

## Rule object shape

```yaml
- match:
    from: "exact-address@example.com"        # OR
    from_domain: "example.com"               # OR
    subject_contains: "substring"            # OR multiple combined (AND semantics)
  action: archive | trash | review | defer   # what to do
  folder: "Apple Mail folder name"           # required for archive
  stop: true | false                         # default true; false allows fall-through to next tier
  add_to_unsub_queue: true | false           # optional flag
  note: "free-text rationale"                # optional human comment
```

## Action vocabulary

| Action | Effect at Execute time | Funnel stage |
|---|---|---|
| `archive` | Mail.app → folder | `auto_processed` |
| `trash` | Mail.app → Trash | `auto_processed` |
| `review` | Stay in inbox; surface in note | `informational` (or higher) |
| `defer` | Move to `Later/`; resurface in N days | `informational` |

## Folder reference

When `action: archive` is set, `folder` should be an exact mailbox name in Mail.app (case-sensitive). Common conventions in the user's setup:

- `Subscriptions` — newsletters, mailing lists
- `Receipts` — purchase + order confirmations
- `Financial` — statements, invoices, billing
- `Work` — professional / employment
- `Personal` — personal correspondence
- `Medical Education` — CME, journals, conferences
- `Later` — deferred (do NOT route rules here; use `action: defer` instead)
- `Blocked` — iCloud only — auto-blocked senders

Per-person folders (e.g. `Personal/Subscriptions/Nate`) are nested via `/` in the folder name.

## How seeds become DB rows

`runMigration(db, dir)`:

1. Looks for `dir/rules.yaml` first; falls back to `dir/rules.yaml.seed`.
2. If `rules.yaml` is absent and `rules.yaml.seed` is present, parses the seed.
3. INSERT OR IGNORE rows into `vip_senders` and `routing_rules`.
4. After successful commit, **renames `rules.yaml.seed` → `rules.yaml`** so the next migration doesn't re-seed.
5. From that point on, runtime updates (e.g. user marks `BD` in triage) write directly to the DB; the YAML file becomes stale but harmless.

## Adding a rule at runtime

Don't edit `rules.yaml` after seeding. Use the API:

```typescript
import { addRoutingRule, addVipSender } from "./Tools/Db";

addRoutingRule(db, "domain", "newdomain.com", "archive", "Subscriptions", true, "manual");
addVipSender(db, "important@person.com", "Important Person", "i");
```

Or via the web UI's instructions tab, which calls these helpers under the hood.
