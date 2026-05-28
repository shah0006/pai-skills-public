# Workflow: Review

Stage 2 of the pipeline: open the web UI to review and edit decisions on the generated triage note.

## Trigger

Slash command: `/start-email-triage` (vault command at `<vault>/.claude/commands/start-email-triage.md`).

Or run directly:

```bash
cd ~/.claude/skills/EmailTriage/web && bun run dev
```

Then open `http://localhost:9988/`.

## What it does

- Boots a Next.js dev server (port 9988 by default; configurable in `web/next.config.ts`).
- Loads today's triage note (or `?date=YYYY-MM-DD`) and renders Stage 1-6 lists.
- Provides keyboard navigation and inline action editing.
- Saves decisions back into the triage note's mark-column tables.
- AI-drafted reply support: per-row "Generate draft" calls Anthropic Sonnet via the Claude API; falls back to local Ollama if no API key.

## Keyboard

| Keys | Action |
|---|---|
| `j` / `k` | Move down / up between rows |
| `space` | Toggle selection (mark column) |
| `a` / `t` / `r` / `d` / `u` / `b` | Set Archive / Trash / Reply / Defer / Unsubscribe / Block |
| `cmd+enter` | Open the Execute pane (transitions to Workflow: Execute) |

## Expected output

- Triage note's mark columns populated with decisions (`x` in the chosen action column per row).
- Review-gate `[x]` on stage headings the user wants Execute to act on.
- Optional staged drafts written to `<vault>/Email Triage/Staged/` for Reply rows.

## Verification

- Triage note diff before vs after review shows mark columns set.
- Staged drafts appear in `<vault>/Email Triage/Staged/`.

## Dependencies

- Bun (web dev server runs on Bun's runtime to use `bun:sqlite`).
- Anthropic API key in `web/.env.local` (`ANTHROPIC_API_KEY=...`) for AI drafts.
- Ollama at `http://localhost:11434` is the optional fallback.

## Notes

- The web UI reads the live triage note file every refresh. To reset, regenerate via `/generate-email-triage --force`.
- Stage 6 (Auto-Processed) is review-optional. Other stages need explicit `[x]` to be processed.
- Production `next build` is not supported because the analytics route imports `bun:sqlite`. Use `bun run dev` only.
