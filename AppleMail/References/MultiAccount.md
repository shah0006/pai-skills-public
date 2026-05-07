# Reference: MultiAccount

Multi-account architecture for `Tools/apple-mail.sh`: the unified path convention, IMAP semantics, and the post-archive Gmail INBOX-label sync (the only remaining cross-skill `gws` integration after GoogleWorkspaceCLI v5 Phase 4 removed the Region B label-creation fallback).

## Unified path convention

All mailbox arguments accept an account-prefixed path: `i/folder` for iCloud, `g/folder` for Gmail. Pre-registered single-letter aliases:

| Alias | Account family |
|-------|----------------|
| `i` | iCloud |
| `g` | Google / Gmail |
| `y` | Yahoo |
| `h` | Hotmail / Outlook.com |
| `a` | AOL |
| `p` | ProtonMail |

Examples:

```
apple-mail.sh list "g/Stages/Stage 1 - VIP"
apple-mail.sh list "i"
apple-mail.sh move 87209 "g/Stages/Stage 5 - Bulk Dispose"
apple-mail.sh search "invoice" --mailbox "i/Receipts"
```

If you pass a plain name (`inbox`, `Receipts`, `sent`), the resolver searches all accounts.

## IMAP account handling (Gmail, Yahoo, etc.)

Three differences from iCloud that `Tools/apple-mail.sh` handles automatically:

1. Nested folder creation. IMAP accounts cannot use AppleScript's parent-child `make new mailbox at end of mailboxes of parentFolder` pattern. Instead, the `create-mailbox` command creates with the full slash-separated path at the account level:
	```
	make new mailbox with properties {name:"Stages/Stage 1 - VIP"} at end of mailboxes of targetAccount
	```
2. System mailbox access. `inbox of account`, `sent mailbox of account`, etc., are unreliable on modern macOS for ALL accounts (not just IMAP). All system mailboxes are resolved by name:
	- INBOX: `first mailbox whose name is "INBOX"`
	- Sent: `first mailbox whose name is "Sent Messages"` (fallback: `"Sent Mail"`)
	- Drafts, Trash, Junk: similar name-based lookup with fallbacks.
3. Account lookup. Direct lookup (`first account whose name is "Google"`) instead of loop iteration; loop iteration returns references rather than values on modern macOS.

## Cross-skill `gws` integration (post-Phase-4 of GoogleWorkspaceCLI v5)

GoogleWorkspaceCLI v5 (sealed 2026-05-06) is now the canonical path for Gmail label management. Previously this skill carried two `gws` paths; one was a Region B fallback for Gmail label creation when AppleScript IMAP-create failed, the other is a functional Mail.app↔Gmail integration. Status as of 2026-05-06:

- **REMOVED in GoogleWorkspaceCLI v5 Phase 4 (2026-05-06):** the `create-mailbox` Region B fallback to `gws gmail users labels create`. AppleScript IMAP-create failures now surface the AppleScript error directly. For Gmail label work — create, rename (with auto-merge), delete, delete-with-messages, list, tree, get — use `bun ~/.claude/skills/GoogleWorkspaceCLI/Tools/Gmail/Labels.ts <subcommand>`.
- **RETAINED (Region A, functional integration):** when you move a Gmail message OUT of INBOX via Mail.app, `Tools/apple-mail.sh` calls `gws gmail users messages modify` to remove the INBOX label so Gmail web UI reflects the archive. This is keep-cross-app-state-consistent integration, not a fallback. It only fires for `effective_acct == "Google"` and only when `gws` is on PATH.

The Region A integration is transparent. Callers do not need to know `gws` is involved on the post-archive cleanup path.

## How accounts are discovered

The skill ships with no hardcoded account names. Two discovery paths:

- Raw probe: `apple-mail.sh accounts` (or `osascript -e 'tell application "Mail" to get name of every account'` directly) returns the live list.
- Filtered triage: `Tools/Accounts.sh` returns the subset of accounts where `triage: true` in `${PAI_DIR:-$HOME/.claude/PAI}/USER/SKILLCUSTOMIZATIONS/AppleMail/accounts.yaml`. See `Workflows/Setup.md`.
