# AppleMail

- **Authorship**: user-authored (`shah0006`)
- **Upstream**: none — original work
- **License**: MIT (see repo LICENSE)
- **Verified**: 2026-05-04 — NOT in any Daniel Miessler PAI release or Packs library

## What it does

See [SKILL.md](./SKILL.md) for the full skill specification (frontmatter + workflows + command reference).

Read, send, search, and reply to emails via macOS Mail.app via a single bash CLI (`apple-mail.sh`) wrapping AppleScript and direct SQLite access to Mail's Envelope Index. Multi-account aware, supports bulk ops, watch monitoring, and Obsidian export.

## Install

Symlink or copy this folder into your PAI install:

```sh
ln -s "$(pwd)" ~/.claude/skills/AppleMail
```

Then create your local accounts file at:

```
~/.claude/PAI/USER/SKILLCUSTOMIZATIONS/AppleMail/accounts.yaml
```

The skill reads this YAML at runtime — see SKILL.md for the schema. Optionally drop a personal `watch-vip.txt` in the same SKILLCUSTOMIZATIONS folder to override the shipped default.

## Self-test

```sh
~/.claude/skills/AppleMail/Tools/apple-mail.sh doctor
```

Verifies Mail.app is reachable via AppleScript, the Envelope Index SQLite is readable (Full Disk Access granted), `accounts.yaml` is present, and the VIP list resolves. Exit 0 = healthy.

You can also run the broader smoke test:

```sh
bash ~/.claude/skills/AppleMail/Tools/TestAppleMail.sh
```

## Layout (PAI v5)

- `SKILL.md` — frontmatter + body (USE WHEN, NOT FOR, hard constraints, command reference, gotchas)
- `Tools/` — `apple-mail.sh` and helpers (`Accounts.sh`, `BulkUnsubscribe.sh`, `WatchCheck.sh`, `TestAppleMail.sh`)
- `Workflows/` — procedural `.md` (one per major operation: Read, Search, Send, Manage, BulkOps, Watch, Export, Setup)
- `References/` — reference docs (CommandRef, MultiAccount, OutputFormats)
- `watch-vip.txt` — default VIP sender list (override at `~/.claude/PAI/USER/SKILLCUSTOMIZATIONS/AppleMail/watch-vip.txt`)

## Promotion notes

- Promoted from `pai-skills-private` to `pai-skills-public` on 2026-05-07
- Sanitization pass: hardcoded email addresses replaced with `accounts.yaml` references; `watch-vip.txt` shipped with placeholder examples (real VIP list moves to SKILLCUSTOMIZATIONS)
- v5 compliance pass: 2026-05-07 — added `NOT FOR` clause, `doctor` selftest, README
