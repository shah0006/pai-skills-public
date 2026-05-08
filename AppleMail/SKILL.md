---
name: AppleMail
description: Read, send, search, and reply to emails via macOS Mail.app (Apple Mail). USE WHEN user wants to check Apple Mail inbox or any folder, read an email, send email (with attachments), search emails (with date range), reply/reply-all/forward (with CC/BCC), flag/move/trash/archive emails, save attachments to disk, export to Markdown, bulk operations (bulk-trash, bulk-move, bulk-mark-read), thread-read with full bodies, check unread counts, list email accounts and folders, open a specific email in Mail.app GUI, OR stage this email (create draft and open for review). Differentiator -- 27-command bash script wrapping AppleScript for full Mail.app control including bulk ops, watch monitoring, and Obsidian export. CONSTRAINT: All email composition MUST go through vault draft file (Email Triage/Drafts/*.email.md) BEFORE touching Mail.app. Never compose directly in Mail.app. NOT FOR Gmail-only OAuth API workflows (use GoogleWorkspaceCLI), iMessage / SMS (use AppleMessages), or external SMTP relays (use a dedicated mailer).
context: fork
---

**CRITICAL: If you invoked this skill via Skill("AppleMail") and received a generic "skill completed" message without seeing the workflow procedures below, you MUST read this file manually before proceeding. Run: Read ~/.claude/skills/AppleMail/SKILL.md. Do NOT improvise email operations without the full workflow loaded.**

# SKILL
## Customization
**Before executing, check for user customizations at:**
`~/.claude/PAI/USER/SKILLCUSTOMIZATIONS/AppleMail/`
Full-featured macOS Mail.app control via a 27-command bash script wrapping AppleScript. Supports inbox reading, sending with attachments, search with date ranges, reply/reply-all/forward with CC/BCC, bulk operations (trash, move, mark-read), thread reading with full bodies, attachment saving, Markdown export, folder management, and unread count monitoring across multiple accounts.

Script: `~/.claude/skills/AppleMail/Tools/apple-mail.sh` (alias: `apple-mail.sh` if added to PATH)
Accounts: configured in `~/.claude/PAI/USER/SKILLCUSTOMIZATIONS/AppleMail/accounts.yaml` (per-account aliases + default-from)
VIP list (default): `~/.claude/skills/AppleMail/Tools/watch-vip.txt` (override at `~/.claude/PAI/USER/SKILLCUSTOMIZATIONS/AppleMail/watch-vip.txt`)
Doctor: `Tools/apple-mail.sh doctor` — verifies Mail.app reachable, accounts.yaml present, AppleScript permissions granted.

## Mailbox Names
`inbox` (default) | `sent` | `drafts` | `trash` | `junk` | `"Exact Folder Name"` (custom iCloud folders)

## List Output Format
```
ID:79132 [ ] [⚑] [📎] | Date | From: addr | Subject: text
```
`[ ]`=unread, `[READ]`=read, `[⚑]`=flagged, `[📎]`=attachments

## Command Reference

### Reading

| Command | Aliases | Usage |
|---------|---------|-------|
| `list [N] [-m box] [-u]` | `ls` | List recent emails (default 10). `-u`=unread only |
| `read <id> [-m box]` | `show`, `view` | Read full email by ID |
| `unread [-m box]` | `count-unread` | Count unread messages |
| `thread <id> [-m box]` | `conversation` | List thread messages (headers) |
| `thread-read <id> [-m box]` | `threadread` | Full thread with bodies, chronological |
| `attachments <id> [-m box]` | `attach`, `att` | List attachments (name, MIME, size) |
| `open <id> [-m box]` | `open-email` | Open email in Mail.app GUI window |

### Searching

`search <query> [N] [options]` (aliases: `find`, `query`)

| Option | Description |
|--------|-------------|
| `-m box` / `--mailbox all` | Target mailbox or all mailboxes |
| `-f addr` | Filter by sender |
| `-u` | Unread only |
| `-b` / `--body` | Search body too (slow) |
| `--after YYYY-MM-DD` | After date |
| `--before YYYY-MM-DD` | Before date |

**Performance:** Default searches (subject/sender/date) query Mail's SQLite `Envelope Index` directly at `~/Library/Mail/V10/MailData/Envelope Index` and return in ~20-30ms regardless of mailbox size. `--mailbox all` is cheap on this path (single SQL query, no per-mailbox AppleScript fan-out). Adding `--body` routes through AppleScript and is slow (30-90s); use it only when you truly need full-text body search. If the SQLite DB is unavailable the code automatically falls back to the AppleScript path.

### Composing

| Command | Aliases | Key Options |
|---------|---------|-------------|
| `send <to> <subj> <body>` | `compose`, `new` | `--to` (repeatable), `--cc`, `--bcc`, `--from`, `--attach`/`-A` (repeatable) |
| `reply <id> <body>` | `respond` | `--all`, `-m`, `--cc`, `--bcc` |
| `reply-all <id> <body>` | `replyall` | Same as reply (--all implicit) |
| `forward <id> --to addr` | `fwd` | `--body` (prefix text), `-m` |
| `draft --to addr -s subj -B body` | `save-draft` | `--cc` |

### Organization

| Command | Aliases | Usage |
|---------|---------|-------|
| `flag <id> [-m box]` | `star` | Flag email |
| `unflag <id> [-m box]` | `unstar` | Remove flag |
| `mark-read <id> [-m box]` | `markread` | Mark read |
| `mark-unread <id> [-m box]` | `markunread` | Mark unread |
| `move <id> <dest> [-m src]` | | Move to mailbox |
| `trash <id> [-m box]` | `delete`, `rm` | Move to Trash |
| `archive <id> [-m box]` | | Move to Archive |

### Bulk Operations (Mailbox-Wide)
Three modes: (no flag)=dry-run | `--confirm`=interactive prompt | `--force`=immediate (PAI-safe)

| Command | Key Options |
|---------|-------------|
| `bulk-trash -m box [--unread-only] [--force]` | Trash all/unread in mailbox |
| `bulk-move -m box -d dest [--unread-only] [--force]` | Move all/unread between mailboxes |
| `bulk-mark-read -m box [--force]` | Mark all as read |

### Bulk Operations by ID
Operate on specific messages by numeric ID in a single AppleScript call. No dry-run needed.

| Command | Usage |
|---------|-------|
| `bulk-trash-ids <id> ... [-m box]` | Trash specific messages |
| `bulk-move-ids <id> ... <dest> [-m box]` | Move specific messages (last positional arg = dest, or use `--dest`) |
| `bulk-archive-ids <id> ... [-m box]` | Archive specific messages |
| `bulk-mark-read-ids <id> ... [-m box]` | Mark specific messages read |
| `bulk-flag-ids <id> ... [-m box]` | Flag specific messages |
| `bulk-unflag-ids <id> ... [-m box]` | Unflag specific messages |
| `bulk-mark-unread-ids <id> ... [-m box]` | Mark specific messages unread |

Not-found IDs produce warnings but do not stop the batch. Output: `N of M message(s) processed`.

### Attachments & Export

| Command | Aliases | Usage |
|---------|---------|-------|
| `save-attachment <id> [-m box] [-o dir]` | `save-att` | Download attachments (default ~/Downloads/) |
| `export <id> [-m box] [-o path]` | `export-email` | Export to Obsidian `.email.md` with YAML frontmatter |

### Watch / Monitor

| Command | Purpose |
|---------|---------|
| `watch start` | Start launchd monitoring (every 2 min) |
| `watch stop` | Stop monitoring |
| `watch status` | Show status, last check, unread/VIP counts |
| `watch check` | Manual check now |
| `watch log [N]` | Show last N lines of log (default 30) |
| `watch vip` | Display VIP sender list |
| `watch vip-add <sender>` | Add VIP sender (case-insensitive partial match) |

VIP list: `~/.claude/PAI/USER/SKILLCUSTOMIZATIONS/AppleMail/watch-vip.txt` (preferred) or `~/.claude/skills/AppleMail/Tools/watch-vip.txt` (fallback) | Log: `~/.cache/apple-mail-watch/watch.log`

### Info

| Command | Aliases | Purpose |
|---------|---------|---------|
| `accounts` | `accts` | List configured email accounts |
| `folders` | `mailboxes`, `boxes` | List all mailboxes with unread/total counts |

## Workflows

### MANDATORY: Vault-First Email Rule (Non-Bypassable)

**STOP. Read this before ANY email composition.**

PAI must NEVER create emails directly in Apple Mail via raw AppleScript, `osascript`, or any method that bypasses the vault draft step. ALL outgoing emails MUST go through the vault `.email.md` file first.

**Why this exists:** On 2026-04-09, PAI bypassed this rule by using raw AppleScript `make new outgoing message` to create a draft directly in Mail.app, skipping the vault entirely. This meant the email was not tracked, not editable in Obsidian, and invisible to the Email Triage system.

**Anti-patterns (NEVER do these):**
- `osascript -e 'tell application "Mail" to make new outgoing message...'`
- `apple-mail.sh send` without a vault `.email.md` file
- Any direct Mail.app composition that skips `Email Triage/Drafts/`

**The ONLY correct path:** Draft This Email workflow (vault file first) -> Stage This Email workflow (push to Mail.app) -> User sends manually.

**Red-Flag Thoughts (if you think ANY of these, STOP):**

| Thought | Reality |
|---------|---------|
| "I invoked the skill, it returned, I can proceed" | Fork mode may not have loaded the workflows. Verify you can see the Draft steps. |
| "I'll just use AppleScript directly, it's faster" | Speed does not excuse process non-compliance. Vault draft first. |
| "The skill didn't load, I'll improvise" | Re-read SKILL.md. Never improvise email composition. |
| "I already know how to send email" | Knowing how is not the same as following the workflow. |
| "This is just a quick email" | All emails go through the vault. No exceptions. |
| "I'll create the vault file after" | The vault file comes FIRST. Not after. |

### Draft This Email
**Trigger:** User says "draft an email", "write an email", "compose an email"
**Steps:**
0. **PRE-FLIGHT CHECK (mandatory):**
   - Verify that the skill content has loaded (you can see Steps 1-4 below). If not, STOP and read `~/.claude/skills/AppleMail/SKILL.md` manually.
   - Verify your NEXT tool call will be `Write` targeting a path inside `Email Triage/Drafts/`. 
   - If your next tool call is `Bash` with `osascript`, `apple-mail.sh send`, `apple-mail.sh draft`, or ANY Mail.app interaction -- STOP. You are violating the Vault-First Email Rule.
   - If you are uncertain, re-read the MANDATORY section above.
1. Compose the email content based on context
2. Resolve recipient(s) via Apple Contacts (search by name, organization)
   - Resolve To, CC, and BCC recipients using the same contact lookup rules
   - If not found: ask user for the email address directly
   - If multiple matches: show all matches with name, organization, and email, then ask user to pick
3. Create a `.email.md` file in `Email Triage/Drafts/` with:
   - Full YAML frontmatter: `document-type: email-draft`, `status: draft`, `from`, `to`, `subject`, `created`, `modified`
   - Optional frontmatter fields (include only when provided by user):
     - `cc:` -- comma-separated email addresses
     - `bcc:` -- comma-separated email addresses
     - `attachments:` -- YAML list of absolute file paths
   - Header block in body (include CC/BCC/Attachments lines only when those fields are present):
     ```
     **To:** recipient@example.com
     **CC:** person1@example.com, person2@example.com
     **BCC:** hidden@example.com
     **From:** <icloud-or-gmail-address from accounts.yaml>
     **Subject:** Subject line
     **Attachments:** "/full/path/to/file.ext"
     ```
   - Naming: `YYYY-MM-DD Draft to [Recipient] - [Topic].email.md`
   - Body with no signature (Mail auto-appends)
4. Report to user: "Draft saved to Email Triage/Drafts/. Say 'stage it' when ready to send."

### Stage This Email
**Trigger:** User says "stage this email", "stage it", "send this to Mail"
**Steps:**
1. Re-read the vault draft `.email.md` file fresh (never use cached version)
2. Push to Apple Mail via `apple-mail.sh draft --to <addr> -s <subj> -B <body>` with optional flags:
   - If `cc:` is present in frontmatter: add `--cc <addrs>`
   - If `bcc:` is present in frontmatter: **not yet supported by apple-mail.sh** -- note this to user and suggest adding BCC manually in Mail.app after staging
   - If `attachments:` is present in frontmatter: use direct AppleScript instead of `apple-mail.sh draft` for the entire staging step. The AppleScript pattern supports attachments:
     ```applescript
     tell application "Mail"
         set newMsg to make new outgoing message with properties {subject:"<subject>", content:"<body>", visible:true}
         tell newMsg
             set sender to "<from>"
             make new to recipient with properties {address:"<to>"}
             -- repeat for each attachment:
             set theFile to POSIX file "<attachment-path>"
             make new attachment with properties {file name:theFile}
         end tell
         save newMsg
         close newMsg
     end tell
     ```
     Include CC recipients via `make new cc recipient` and multiple attachments by repeating the `set theFile` / `make new attachment` block for each file.
3. Open the draft in Mail.app for review: `apple-mail.sh open <id> --mailbox drafts`
4. Update the vault file's `status:` from `draft` to `staged`
5. User reviews and sends manually from Mail.app (adding BCC recipients manually if needed)

**Re-staging:** If user wants changes after staging, edit the existing Mail draft in place. Never trash the Mail draft unless explicitly asked.

**Error handling:** If `apple-mail.sh draft` fails, report the error with the reason why, and leave the vault file as `status: draft` so the user can retry.

**Key rules (apply to both workflows):**
- Never include name/credentials/phone/email in body (Apple Mail auto-appends signature)
- Always use the iCloud address declared in `accounts.yaml` (the `@mac.com` form, never `@me.com`)
- Search AppleContacts for recipient email when only a name is given

### Post-Send Verification
**Trigger:** User confirms "I sent it", "it's sent", "email sent"
**Steps:**
1. Wait 1 minute in the background (do not block the conversation)
2. Check Apple Mail Sent mailbox for the email: `apple-mail.sh search --subject "<subject>" --mailbox "i/Sent Messages"`
3. Check Apple Mail Inbox for bounce-back messages related to the recipient
4. Report delivery status to user:
   - Success: "Confirmed: email to [recipient] found in Sent mailbox, no bounce detected."
   - Failure: "Warning: email not found in Sent mailbox after 1 minute. Check Mail.app."
   - Bounce: "Warning: bounce-back detected from [recipient]. Check inbox."
5. Update vault file `status:` from `staged` to `sent`
6. If user says "archive it": move vault `.email.md` file to `60 - Archives/60.10 - Email Archive`
7. If user does not request archive: ask before deleting, or leave for user to handle
8. PAI never deletes a vault email file without explicit instruction

## Multi-Account Architecture

### Unified Path Convention
All mailbox arguments use an account-prefixed path: `i/folder` for iCloud, `g/folder` for Gmail. Pre-registered aliases: `y` (Yahoo), `h` (Hotmail), `a` (AOL), `p` (ProtonMail). Examples:
- `apple-mail.sh list "g/Stages/Stage 1 - VIP"` -- list emails in Gmail staging folder
- `apple-mail.sh list "i"` -- list iCloud inbox
- `apple-mail.sh move 87209 "g/Stages/Stage 5 - Bulk Dispose"` -- move Gmail email to staging folder

### IMAP Account Handling (Gmail, Yahoo, etc.)
Three critical differences from iCloud that `apple-mail.sh` handles automatically:

1. **Nested folder creation:** IMAP accounts cannot use AppleScript's parent-child `make new mailbox at end of mailboxes of parentFolder` pattern. Instead, the `create-mailbox` command creates with the full slash-separated path at the account level:
   ```
   make new mailbox with properties {name:"Stages/Stage 1 - VIP"} at end of mailboxes of targetAccount
   ```

2. **System mailbox access:** `inbox of account`, `sent mailbox of account`, etc. are unreliable on modern macOS for ALL accounts (not just IMAP). All system mailboxes are resolved by name:
   - INBOX: `first mailbox whose name is "INBOX"`
   - Sent: `first mailbox whose name is "Sent Messages"` (fallback: `"Sent Mail"`)
   - Drafts, Trash, Junk: similar name-based lookup with fallbacks

3. **Account lookup:** Direct lookup (`first account whose name is "Google"`) instead of loop iteration, which returns references rather than values on modern macOS.

### Gmail Fallback Transport (gws CLI)
When AppleScript operations fail on Gmail, `apple-mail.sh` falls back to the `gws` CLI (Google Workspace CLI v0.18.1) for:
- `create-mailbox`: Falls back to `gws gmail users labels create` if AppleScript IMAP creation fails
- Future: label management, message modification via Gmail API

The fallback is transparent -- callers don't need to know which transport handled the operation.

## Limitations
- Plain text only (HTML stripped with notice). Search without `--body` matches subject+sender only.
- Bulk ops require `--mailbox`; use `--force` for automation.
- Missing required args produce self-explanatory errors (`Email ID required`, `--to <address> required`, etc.)

Last Updated: 2026-04-17
