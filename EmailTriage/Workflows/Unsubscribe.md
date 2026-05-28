# Workflow: Unsubscribe

RFC 8058 one-click unsubscribe + DB-side junk-listing for senders that ignore the spec.

## Trigger

In the triage note: mark a Stage 5 (Bulk Dispose) row with `U` (Unsubscribe) and check the stage's review gate `[x]`. Then run `/process-email`.

Or run directly:

```bash
bun run ~/.claude/skills/EmailTriage/Tools/Unsubscribe.ts <email-id>
```

## What it does

1. Reads the email's `List-Unsubscribe` and `List-Unsubscribe-Post` headers via `apple-mail.sh headers <id>`.
2. If RFC 8058 (one-click POST) is supported, fires the POST and records the response.
3. If only a `mailto:` link is offered, queues a send via the standard transport with `subject: unsubscribe`.
4. If only an `https://` link, surfaces the URL in the triage note for manual confirmation (cannot programmatically click).
5. Records the attempt in `unsubscribed` table (sender, domain, method, success, attempted_at).
6. Auto-regenerates `<vault>/Email Triage/Reference/Unsubscribe History.md`.

## Methods detected (in order of preference)

| Method | Header pattern | Action |
|---|---|---|
| One-click HTTP POST | `List-Unsubscribe-Post: List-Unsubscribe=One-Click` | POST to URL |
| HTTP GET link | `List-Unsubscribe: <https://...>` | Surface URL for manual click |
| Mailto | `List-Unsubscribe: <mailto:...>` | Queue mailto send |
| None | header missing | Escalate to BD (block domain) |

## Verification

```bash
sqlite3 ~/.claude/skills/EmailTriage/triage.db \
  "SELECT sender_address, method, success, attempted_at FROM unsubscribed ORDER BY attempted_at DESC LIMIT 10;"
```

```bash
cat "<vault>/Email Triage/Reference/Unsubscribe History.md"
```

## Daily report

```bash
bun run ~/.claude/skills/EmailTriage/Tools/UnsubReport.ts [--date YYYY-MM-DD] [--output PATH]
```

Generates a per-day unsubscribe report with domain stats and repeat offenders.

## Edge cases

- **Sender ignores RFC 8058** — silent success on POST, but emails keep arriving. Escalate to `BD` (Block Domain) on the next triage.
- **403 / 404 on the unsubscribe URL** — recorded as failed. Surfaces in the next morning's note for manual handling.
- **mailto-only** — sent via the user's primary account; check the Sent folder to confirm the unsubscribe email actually went out.
