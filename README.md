# pai-skills-public

> Public PAI v5 skills curated by [shah0006](https://github.com/shah0006). Skills here have passed the eight-gate promotion process documented in [PROMOTION.md](./PROMOTION.md). Working set lives in the private sibling at [shah0006/pai-skills-private](https://github.com/shah0006/pai-skills-private); skills graduate one at a time once they're sanitized and reviewed.

## What's in here

- One folder per skill (TitleCase, matches install layout)
- Per-skill `README.md` with attribution + (for forks) fork rationale
- Top-level `LICENSE` (MIT) — covers user contributions
- Top-level `NOTICE` — aggregates third-party attributions (Daniel Miessler upstream)
- `PROMOTION.md` — the eight-gate criteria for public release

## Install

Each skill is self-contained. Copy or symlink the desired skill folder into your PAI install:

```sh
ln -s "$(pwd)/AppleMessages" ~/.claude/skills/AppleMessages
```

Then restart your PAI session so the skill registry picks it up.

## Authorship classes

- **User-authored** (built from scratch by `shah0006`): listed in [NOTICE](./NOTICE)
- **Miessler forks** (local modifications to upstream [danielmiessler/Personal_AI_Infrastructure](https://github.com/danielmiessler/Personal_AI_Infrastructure)): per-skill README documents original author, contributor, and fork rationale
- **Miessler unmodified**: carried as-is, attribution preserved

## Roadmap

The intent is to graduate every PAI v5 skill from private to public over time, starting with skills that already meet the eight gates. Skills currently in this repo passed the gates as of their first commit; skills NOT yet here are in the working space awaiting sanitization.

## Differentiator vs. agentskills.so / Anthropic skill repos

- This repo is opinionated — each skill ships a vault-first compose pattern (where applicable), `doctor` self-test, and `Tools/Workflows/References` layout
- Skills here have been used in production by `shah0006` (medical doctor + AI infrastructure builder); not theoretical patterns

## Companion repos

- [pai-skills-private](https://github.com/shah0006/pai-skills-private) — working set + sanitization-pending
- [pai-email-triage](https://github.com/shah0006/pai-email-triage) — separate repo for the EmailTriage skill (kept independent for tighter iteration)

## License

MIT for user contributions (see [LICENSE](./LICENSE)). Forked Miessler skills retain their original MIT license; per-skill `README.md` notes attribution.
