---
name: Verify
parent-skill: VaultLint
---
# Verify Workflow

Run the linter against known-violating files in the vault to confirm the plugin chain is intact.

## Quick sanity check

```bash
bun ~/.claude/skills/VaultLint/Tools/LintNative.ts --selftest
```

Expected result: `{"status":"linted",...}` with a diff showing tab conversion and blank-line cleanup.

## Backfill known violators

When the build first lands, two files in the Coordination folder are known to violate the standard:

```bash
bun ~/.claude/skills/VaultLint/Tools/LintNative.ts \
  "/Volumes/Hyperdrive 4 Tb/Main Obsidian (Sync)/30 - Areas/Computer/Artificial Intelligence/Agents/PAI/Coordination/PAI v4 Skills Inventory.md"

bun ~/.claude/skills/VaultLint/Tools/LintNative.ts \
  "/Volumes/Hyperdrive 4 Tb/Main Obsidian (Sync)/30 - Areas/Computer/Artificial Intelligence/Agents/PAI/Coordination/Q-3 Priming List Proposal.md"
```

Both should return `linted` on first run, then `unchanged` on subsequent runs.

## Hook integration test

Edit any vault file via the Edit tool. The PostToolUse hook fires automatically and writes the lint result to the conversation. Watch for the JSON envelope from `VaultLint.hook.ts` in the next system message.
