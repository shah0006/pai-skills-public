# Workflow: Setup

First-run installation and verification. Run once per machine.

## Prerequisites

1. **Bun** ≥ 1.3 (`bun --version`).
2. **AppleMail skill** installed and tested (`bash ~/.claude/skills/AppleMail/Tools/apple-mail.sh doctor`).
3. **Full Disk Access** for your terminal (so AppleScript can read Mail.app message bodies).
4. **Automation permission** for your terminal → Mail.app (System Settings → Privacy & Security → Automation).
5. **Optional**: Anthropic API key in `web/.env.local` (for AI classification + draft writing). Without it, the rules engine still works but AI features are disabled.

## Install steps

```bash
cd ~/.claude/skills/EmailTriage
bun install                 # root deps (bun:sqlite, js-yaml)
cd web && bun install       # Next.js + React for the review UI
cd ..
```

## First-run customization

Create `~/.claude/PAI/USER/SKILLCUSTOMIZATIONS/EmailTriage/preferences.yaml`:

```yaml
# Vault root for triage notes (optional; falls back to env EMAILTRIAGE_VAULT_ROOT)
vault_root: /Volumes/<your-volume>/<your-vault>

# Self-address for iMessage alert routing (optional)
self_address: you@example.com

# First name + persona used in AI reply prompts
first_name: Yourname
persona: Yourname Lastname (your role)
```

Each key has a matching env var (`EMAILTRIAGE_VAULT_ROOT`, `EMAILTRIAGE_SELF_ADDRESS`, `EMAILTRIAGE_FIRST_NAME`, `EMAILTRIAGE_PERSONA`) that overrides the YAML.

## Initialize the database

```bash
bun run ~/.claude/skills/EmailTriage/Tools/Doctor.ts
```

Doctor creates `triage.db` if missing, runs the migration to seed `vip_senders`, `routing_rules`, and `junk_senders` from the seed YAML files in `References/`.

## Install the launchd send-later agent (optional)

To enable scheduled sends to fire even when no terminal is open, materialize the recurring catchup plist:

```bash
SKILL_DIR=~/.claude/skills/EmailTriage
BUN_BIN=$(which bun)

mkdir -p ~/Library/LaunchAgents

sed \
  -e "s|__BUN_BIN__|$BUN_BIN|g" \
  -e "s|__SKILL_DIR__|$SKILL_DIR|g" \
  "$SKILL_DIR/com.pai.send-later.plist.template" \
  > ~/Library/LaunchAgents/com.pai.send-later.plist

launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.pai.send-later.plist
launchctl print "gui/$(id -u)/com.pai.send-later" | head
```

The agent runs `Tools/SendLater.ts` every 6 hours to catch up missed sends.

To disable later:

```bash
launchctl bootout "gui/$(id -u)/com.pai.send-later"
rm ~/Library/LaunchAgents/com.pai.send-later.plist
```

## Verification

```bash
bun run ~/.claude/skills/EmailTriage/Tools/Doctor.ts
```

Expected output: every check `OK`. If any `FAIL`, follow the printed remediation and re-run.

## Vault directories

EmailTriage expects (and will create on first run):

- `<vault_root>/Email Triage/` — generated triage notes
- `<vault_root>/Email Triage/Reference/` — auto-regenerated reference files
- `<vault_root>/Email Triage/Staged/` — staged reply drafts awaiting review
