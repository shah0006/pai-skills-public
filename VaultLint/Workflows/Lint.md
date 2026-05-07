---
name: Lint
parent-skill: VaultLint
---
# Lint Workflow

Trigger the Obsidian Linter on a single named vault file.

## Invocation

```bash
bun ~/.claude/skills/VaultLint/Tools/LintNative.ts "<absolute-path-to-md-file>"
```

The path must be under `/Volumes/Hyperdrive 4 Tb/Main Obsidian (Sync)/` and end in `.md`.

## Return values

The skill prints one JSON line to stdout. Three possible shapes:

```json
{"status":"unchanged","path":"<abs>","sha":"<sha256>"}
```

The file was already standard-compliant. Linter ran but produced no changes. This is the success case for files that pass.

```json
{"status":"linted","path":"<abs>","preSha":"<sha>","postSha":"<sha>","diff":"<line-diff snippet>"}
```

The linter modified the file. The skill captures the diff snippet (max 4KB, max 60 changed lines) so the caller can decide what to do next. Common changes: tabs replacing 2-space indents, blank-line-after-heading removed, YAML frontmatter normalized, H1 renamed to filename.

```json
{"status":"error","path":"<abs>","reason":"<machine-readable reason>"}
```

Possible reasons:

- `path-not-absolute` — caller passed a relative path
- `path-outside-vault` — caller passed a path outside the vault root
- `path-not-markdown` — extension is not `.md`
- `file-not-found` — the file does not exist on disk
- `obsidian-not-running` — Obsidian.app is not running; skill cannot reach the linter
- `open-failed: <details>` — `open <uri>` returned non-zero
- `uncaught: <message>` — uncaught exception in the skill itself

## Side effects

The named file becomes the active tab in Obsidian (the linter command operates on the active leaf, and Advanced URI must focus the file before the linter sees it). There is no parameter that bypasses this without forking the linter plugin. Treat the focus shift as expected.

## Polling and timeout

The skill polls for sha256 OR mtime change every 250ms with a 10s overall timeout. If the file does not change within 10s, the skill returns `unchanged` (the assumption being that the file passed standard).

## Self-test

```bash
bun ~/.claude/skills/VaultLint/Tools/LintNative.ts --selftest
```

Creates a deliberately-violating temp file in the vault root, lints it, deletes it, and returns the lint result. Use this to verify the plugin chain is reachable.
