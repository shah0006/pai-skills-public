# Reference: Classification Funnel

The 8-tier funnel that decides each email's `funnelStage` (the row it lands in on the triage note) and `priority`.

## Order

First match wins. Each tier has a `stop` flag (default `true`): if the rule matches and `stop=true`, no later tier is evaluated.

| Tier | What it checks | Stage on match | Priority on match |
|---|---|---|---|
| 1. VIP | Address in `vip_senders` table | `vip` | `action` |
| 2. Junk | Address in `junk_senders` (by_address) | `auto_processed` | `trash` |
| 3. Junk domain | `from_domain` in `junk_senders` (by_domain) | `auto_processed` | `trash` |
| 4. Sender rule | Exact `from` match in `routing_rules` (rule_type=`sender`) | per-rule | per-rule |
| 5. Domain rule | `from_domain` match in `routing_rules` (rule_type=`domain`) | per-rule | per-rule |
| 6. Subject rule | `subject` substring match in `routing_rules` (rule_type=`subject`) | per-rule | per-rule |
| 7. Known sender | Address seen ≥ N times in `known_senders` | `informational` (default) | `review` |
| 8. AI classifier | Anthropic Haiku batch call | per-class | per-class |
| Fallback | No match | `informational` (unknown badge) | `review` |

## funnelStage values (6 stages)

| Stage | Name | Triage note format | Review gate default |
|---|---|---|---|
| 1 | `vip` | H4 blocks with body + AI draft | Manual `[x]` |
| 2 | `action` | H4 blocks with body + AI draft | Manual `[x]` |
| 3 | `financial` | Expanded table (Type / Vendor / Amount) | Manual `[x]` |
| 4 | `informational` | Mark-column table (A / T / K) | Manual `[x]` |
| 5 | `bulk_dispose` | Mark-column table (A / T / J / U / BD / BS) | Manual `[x]` |
| 6 | `auto_processed` | Mark-column table (with Rule column) | Optional `[]` |

## Priority values

`action` · `review` · `archive` · `trash`

Maps to: take action now / review and decide / will be archived if executed / will be trashed if executed.

## Code references

- `Tools/RulesEngine.ts` — `classifyEmail()` is the funnel implementation. Pure function: input email + cache, output ClassifiedEmail.
- `Tools/AiClassifier.ts` — tier 8 batch classifier (Anthropic Haiku).
- `Tools/Db.ts` — `buildClassificationCache()` reads all rules into in-memory Sets / arrays before the loop.
- `Tools/Types.ts` — `FunnelStage`, `EmailPriority`, `ClassifiedEmail` type definitions.

## Caching

`buildClassificationCache(db)` is called once per `generateTriage()` run. The cache is held for the duration of the run; no per-email DB reads. ~1ms per email regardless of inbox size.

## Anti-patterns

- Don't read rules from YAML at classify time. The YAML is only seed data for the DB. The DB is the source of truth.
- Don't mutate the cache during the run. Add new rules via `addRoutingRule()` etc., which write through to the DB; rebuild the cache for the next run.
