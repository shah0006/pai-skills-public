# AppleMessages

- **Authorship**: user-authored (`shah0006`)
- **Upstream**: none — original work
- **License**: MIT (see repo LICENSE)
- **Verified**: 2026-05-04 — NOT in any Daniel Miessler PAI release or Packs library

## What it does

See [SKILL.md](./SKILL.md) for the full skill specification (frontmatter + workflows + command reference).

## Install

Symlink or copy this folder into your PAI install:

```sh
ln -s "$(pwd)" ~/.claude/skills/AppleMessages
```

Then restart your PAI session.

## Layout (PAI v5)

- `SKILL.md` — frontmatter + body (USE WHEN, hard constraints, command reference, gotchas)
- `Tools/` — executable scripts
- `Workflows/` — procedural `.md` (one per major operation)
- `References/` — reference docs (schemas, API references, etc.)
