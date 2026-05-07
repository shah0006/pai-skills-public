---
name: VaultLint
description: "Deterministic enforcement of the Obsidian vault Markdown Formatting Standard. Pure-Bun implementation that applies the user's enabled Obsidian Linter rules to a vault file BY ABSOLUTE PATH, with no Obsidian dependency and no active-tab side effect. Reads enabled rules from `.obsidian/plugins/obsidian-linter/data.json` and errors loudly if a rule is enabled that the implementation hasn't covered (drift detection). USE WHEN linting a vault file, normalizing markdown to vault standard, after writing/editing any file under the Main Obsidian vault. NOT FOR linting markdown files outside the vault — only files under `/Volumes/Hyperdrive 4 Tb/Main Obsidian (Sync)/`. Differentiator vs ad-hoc rewriting -- rule semantics mirror the upstream Obsidian Linter plugin v1.31.2 so output matches what Obsidian-on-save would produce."
version: 2.0.0
effort: low
---

# VaultLint

**Tool:** `bun ~/.claude/skills/VaultLint/Tools/LintNative.ts <absolute-path>`
**No Obsidian required.** Runs synchronously in Bun against the file on disk, reads enabled-rule list from the plugin's `data.json`, applies them, writes the result back.
**Vault root:** `/Volumes/Hyperdrive 4 Tb/Main Obsidian (Sync)/`
**Standard enforced:** `50 - Resources/50.40 - Vault Management/Standards/Markdown Formatting Standard.md`

## When to use

This skill is normally invoked **automatically** by `~/.claude/hooks/VaultLint.hook.ts` after any Edit/Write/MultiEdit on a file under the vault root. You should rarely need to call it directly.

Manual invocation is appropriate when:

- Backfilling a known-violating file: `bun ~/.claude/skills/VaultLint/Tools/LintNative.ts "<path>"`
- Verifying the linter is reachable: `bun ~/.claude/skills/VaultLint/Tools/LintNative.ts --selftest`

## How it works

1. Caller passes the absolute path of a vault `.md` file
2. Skill loads `<vault>/.obsidian/plugins/obsidian-linter/data.json` and extracts the set of rules with `enabled: true`
3. Skill cross-checks against `IMPLEMENTED_RULES` — any enabled rule not implemented is a hard error (drift detection)
4. Skill applies rules in this order against the file content:
   - Build protection mask (YAML frontmatter, fenced code blocks, $$ math blocks — all skipped by every rule)
   - `headings-start-line` — strip leading whitespace from heading lines
   - `convert-bullet-list-markers` — `*` and `+` bullets → `-`
   - `unordered-list-style: consistent` — first-seen marker normalized across the doc
   - `ordered-list-style` — renumber ascending, `)` → `.`
   - `space-after-list-markers` — exactly one space between marker and content
   - `remove-multiple-spaces` — collapse 2+ internal spaces (skips inline code, tables, soft-break trailing spaces)
   - `convert-spaces-to-tabs: tabsize=2` — leading-whitespace spaces → tabs
   - `remove-leading-or-trailing-whitespace-on-paste` — paste-event-only upstream; no-op at lint-file time
5. Captures sha256 pre/post; if equal → `unchanged`, else writes file and returns `linted` with a unified-diff snippet
6. Returns one of: `unchanged` (file already standard-compliant), `linted` (file modified — diff returned), `error` (path invalid, rule drift, etc.)

## Constraints

- File must already be saved to disk before invocation (Write tool flushes to disk before PostToolUse hooks fire)
- Path must be UNDER the vault root; non-vault files are rejected
- **No active-tab side effect.** Unlike the v1.x Advanced-URI implementation, the file is not opened or activated in Obsidian
- **Obsidian does NOT need to be running.** This is a pure file-on-disk operation

## Drift detection

When you enable a new rule in Obsidian Linter settings, the linter will fail on its next run with `rule-not-implemented: <rule-id>`. This is intentional — silent skip would let formatting drift go unnoticed. To resolve:

1. Add the rule's logic as a new function in `Tools/LintNative.ts`
2. Add its ID to `IMPLEMENTED_RULES`
3. Add it to the orchestration order in `applyRules()`
4. Test against `--selftest` and a known-violating fixture
5. Bump `version:` in this frontmatter

## Currently implemented rules (8)

These are the rules currently enabled in `<vault>/.obsidian/plugins/obsidian-linter/data.json`:

| Rule ID | Behavior |
|---------|----------|
| `headings-start-line` | Strip leading whitespace from `#…` heading lines |
| `convert-bullet-list-markers` | `*` / `+` → `-` |
| `unordered-list-style` | `list-style: consistent` — first-seen marker wins |
| `ordered-list-style` | `number-style: ascending`, `list-end-style: "."` |
| `space-after-list-markers` | Exactly one space between marker and content |
| `remove-multiple-spaces` | Collapse 2+ internal spaces (skips code, tables, soft breaks) |
| `convert-spaces-to-tabs` | `tabsize: 2` — leading-whitespace spaces → tabs |
| `remove-leading-or-trailing-whitespace-on-paste` | No-op (paste-event only upstream) |

## Workflows

- `Workflows/Lint.md` — invoking the lint, interpreting return values
- `Workflows/Verify.md` — manual verification on known-violating files

## Custom Regex support

LintNative also reads and applies the user's `customRegexes` array from `data.json` — every entry with `enabled: true` is applied as a regex substitution over the whole document, after the named rules. This covers the user's 38+ custom rules (citation cleanup, footnote reformatting, blank-line-around-headings, etc.). Failed regexes (invalid syntax in V8) are surfaced in the `diff` field but do not block other rules from running.

## Gotchas

- **Drift bubbles up loudly** — adding a named rule in Obsidian without adding it here breaks linting until updated. Don't suppress the error; add the rule.
- **Rule semantics are reimplemented, not borrowed** — upstream Obsidian Linter is not on npm and its bundled `lintText` is too coupled to the Obsidian `App` API to use directly. The 8 rules + custom regex passthrough mirror upstream v1.31.2 behavior; if upstream changes a rule's semantics in a future release, parity drift is possible.
- **Known parity gap: `unordered-list-style: consistent` on mixed-marker docs** — when a document mixes `*`, `+`, `-` markers at the top level AND has nested lists, upstream sometimes produces a different nested marker than the top-level. Our implementation always normalizes to the first-seen marker. Practical impact: ~zero on normal vault content; surfaces only on contrived test fixtures.
- **Idempotent** — second run on a linted file always returns `unchanged`. Non-idempotent output is a bug.
- **Custom regex `replace` strings** — Obsidian Linter stores `\n`/`\t` as literal escape sequences in `data.json`. LintNative converts them to actual newlines/tabs before applying. If you write a custom regex via the Obsidian UI, the UI handles this automatically; if you edit `data.json` directly, follow the same convention.

## Not for

- Files outside the vault root — return error, do not attempt
- Bulk linting of an entire folder — invoke per-file in a shell loop, or use Obsidian's `lint-all-files-in-folder` command directly via the command palette
