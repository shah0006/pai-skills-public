# Workflow: Setup

First-run installation, account discovery, and the `accounts.yaml` triage filter.

## Why this workflow exists

The skill ships generic. It must learn which Mail.app accounts exist on this machine and which ones the user wants to triage through it. Phase 1 of the v5 refactor introduced `Tools/Accounts.sh` for this. The `apple-mail.sh accounts` command continues to do the raw Mail.app probe for backward compatibility; `Tools/Accounts.sh` is the canonical entry point for filtered, triage-aware account lists.

## Storage

`accounts.yaml` lives at the user customization path:
`${PAI_DIR:-$HOME/.claude/PAI}/USER/SKILLCUSTOMIZATIONS/AppleMail/accounts.yaml`.

The skill itself ships no `accounts.yaml`. The user creates one via `Tools/Accounts.sh --init`.

## Modes

| Invocation | Behavior |
|------------|----------|
| `Tools/Accounts.sh` | Default read. Print account names where `triage: true`. If `accounts.yaml` is missing, fall back to the raw Mail.app probe. |
| `Tools/Accounts.sh --init` | Probe Mail.app via osascript. Write `accounts.yaml` with every discovered account marked `triage: true` by default. Idempotent (overwrites). |
| `Tools/Accounts.sh --refresh` | Re-probe Mail.app. Add new accounts as `triage: true`. Preserve flags on accounts already present. Warn (stderr) on accounts that disappeared from Mail.app. |
| `Tools/Accounts.sh --help` | Print usage. |

## YAML shape

```
# AppleMail accounts.yaml — populated by Tools/Accounts.sh --init
# triage: true means the account participates in default-filtered output.
accounts:
  - name: iCloud
    triage: true
  - name: Google
    triage: true
  - name: Yahoo (legacy)
    triage: false
```

Edit the `triage:` flag manually at any time. The next default read picks it up. To invert the default for any subset of accounts, run `--init` first, then edit the flags.

## Steps for first-run setup

1. Confirm Mail.app is running and at least one account is configured (Mail → Settings → Accounts).
2. Run: `bash ~/.claude/skills/AppleMail/Tools/Accounts.sh --init`.
3. Open `${PAI_DIR:-$HOME/.claude/PAI}/USER/SKILLCUSTOMIZATIONS/AppleMail/accounts.yaml` and set `triage: false` on any account you do NOT want included in default-filtered output.
4. Verify: `bash ~/.claude/skills/AppleMail/Tools/Accounts.sh` should print only the `triage: true` names.
5. Optionally seed the VIP list at `${PAI_DIR:-$HOME/.claude/PAI}/USER/SKILLCUSTOMIZATIONS/AppleMail/watch-vip.txt` (one name or email fragment per line, `#` for comments).

## Steps after adding a new Mail.app account

1. Add the account in Mail.app as usual.
2. Run: `bash ~/.claude/skills/AppleMail/Tools/Accounts.sh --refresh`.
3. Open `accounts.yaml` and set `triage: false` if you do not want the new account triaged.

## Reconciliation note

The proposal's acceptance criterion "`apple-mail.sh accounts` returns the filtered triage account list" is satisfied at the level of the canonical entry point. `apple-mail.sh accounts` continues to do the raw probe (Phase 1 anti-criterion: do not modify the script body). `Tools/Accounts.sh` is the wrapper that exposes the filtered list. Phase 4 may unify these once the apple-mail.sh body edit window is open.
