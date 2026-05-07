# Promotion criteria

A skill graduates from `pai-skills-private/` → `pai-skills-public/` only when **all eight** are true.

## Eight gates

1. **No PII in skill content**
	- No hardcoded email addresses, phone numbers, physical addresses, names
	- No `/Users/<username>/` filesystem paths
	- No vault-specific absolute paths (use placeholder like `<vault-root>` or `${PAI_DIR}`)
2. **No credentials**
	- No API keys, OAuth secrets, refresh tokens
	- No `.env` files with real values (a `.env.example` with placeholders is fine)
3. **Externalizable customization**
	- All user-specific config lives at runtime under `~/.claude/PAI/USER/SKILLCUSTOMIZATIONS/<Skill>/`
	- Sample/example configs in skill content use placeholder values only
4. **PAI v5 layout**
	- `SKILL.md` at root with frontmatter (`name`, `description`, `USE WHEN`, `NOT FOR`)
	- `Tools/` for executables (TitleCase filenames)
	- `Workflows/` for procedural `.md` (one workflow per major operation)
	- `References/` for reference docs
5. **Documented**
	- Per-skill `README.md` explaining what it does, how to install, and (for forks) attribution + fork rationale
	- Each `Workflows/*.md` describes one operation end-to-end
6. **Self-testable**
	- `doctor` / `--selftest` / equivalent command exists and passes locally
7. **License compatible**
	- User-authored → MIT (repo default)
	- Forked → original LICENSE preserved + per-skill `README.md` attribution + contributor list + fork rationale
8. **User sign-off**
	- All files (SKILL.md, all Tools, all Workflows, all References) reviewed by `shah0006`
	- Explicit approval recorded in promotion commit message

## Process

1. Run gate-check on the candidate skill → produce passes/fails report
2. Reviewer (you) inspects failures, approves fixes
3. After all eight pass, `git mv pai-skills-private/<Skill>/ pai-skills-public/<Skill>/`
4. Commit message format: `promote(<Skill>): from private to public — gate report attached`

## Tracking

Per-skill graduation status will be tracked in:

- The `Skill Catalog/<Skill>.md` page (vault) — YAML frontmatter field
- Repo top-level `STATUS.md` (TBD) — board of pending / promoted / blocked
- Inventory at `30 - Areas/Computer/Artificial Intelligence/Agents/PAI/Coordination/PAI v4 Skills Inventory.md`
