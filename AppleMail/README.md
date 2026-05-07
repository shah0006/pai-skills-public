# AppleMail

- **Authorship**: user-authored (`shah0006`)
- **Upstream**: none — original work
- **License**: MIT (see repo LICENSE)
- **Verified**: 2026-05-04 — NOT in any Daniel Miessler PAI release or Packs library

## What it does

See [SKILL.md](./SKILL.md) for the full skill specification (frontmatter + workflows + command reference).

## Install

Symlink or copy this folder into your PAI install:

```sh
ln -s "$(pwd)" ~/.claude/skills/AppleMail
```

Then create your local accounts file at:

```
~/.claude/PAI/USER/SKILLCUSTOMIZATIONS/AppleMail/accounts.yaml
```

The skill reads this YAML at runtime — see SKILL.md for the schema.

## Layout (PAI v5)

- `SKILL.md` — frontmatter + body (USE WHEN, hard constraints, command reference, gotchas)
- `Tools/` — `apple-mail.sh` and helpers
- `Workflows/` — procedural `.md` (one per major operation)
- `References/` — reference docs

## Promotion notes

- Promoted from `pai-skills-private` to `pai-skills-public` on 2026-05-07
- Sanitization pass: hardcoded email addresses replaced with `accounts.yaml` references
