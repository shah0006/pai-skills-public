# Workflow: Send

Compose, reply, forward, save draft, stage to Mail.app, post-send verification.

## Constitutional rule (non-bypassable)

The vault-first composition rule lives in `SKILL.md` § "MANDATORY: Vault-First Email Rule". Read it before ANY composition. It is not duplicated here so the rule has exactly one canonical home; this workflow links back to it. If you cannot see that section in `SKILL.md`, STOP and re-read the skill.

## Commands (composition surface)

| Command | Aliases | Key Options |
|---------|---------|-------------|
| `send <to> <subj> <body>` | `compose`, `new` | `--to` (repeatable), `--cc`, `--bcc`, `--from`, `--attach` / `-A` (repeatable). |
| `reply <id> <body>` | `respond` | `--all`, `-m`, `--cc`, `--bcc`. |
| `reply-all <id> <body>` | `replyall` | Same as reply (`--all` implicit). |
| `forward <id> --to addr` | `fwd` | `--body` (prefix text), `-m`. |
| `draft --to addr -s subj -B body` | `save-draft` | `--cc`. |

## Draft This Email

Trigger: user says "draft an email", "write an email", "compose an email".

Steps:

0. PRE-FLIGHT CHECK (mandatory):
	- Verify you can see Steps 1 to 4 below. If not, STOP and read this file manually.
	- Verify your NEXT tool call will be `Write` targeting a path inside `Email Triage/Drafts/`.
	- If your next tool call is `Bash` with `osascript`, `apple-mail.sh send`, `apple-mail.sh draft`, or ANY Mail.app interaction, STOP. You are violating the Vault-First Email Rule.
1. Compose the email content based on context.
2. Resolve recipient(s) via Apple Contacts (search by name or organization). Resolve To, CC, and BCC the same way. If not found, ask the user for the email address. If multiple matches, list them with name, organization, and email; ask the user to pick.
3. Create a `.email.md` file in `Email Triage/Drafts/` with:
	- Full YAML frontmatter: `document-type: email-draft`, `status: draft`, `from`, `to`, `subject`, `created`, `modified`. Optional fields: `cc`, `bcc` (comma-separated), `attachments` (YAML list of absolute paths).
	- Header block in the body (include CC, BCC, Attachments lines only when those frontmatter fields are present):
		```
		**To:** recipient@example.com
		**CC:** person1@example.com, person2@example.com
		**BCC:** hidden@example.com
		**From:** <user-from-account>
		**Subject:** Subject line
		**Attachments:** "/full/path/to/file.ext"
		```
	- Naming: `YYYY-MM-DD Draft to [Recipient] - [Topic].email.md`.
	- Body with no signature (Mail.app auto-appends).
4. Report to user: "Draft saved to `Email Triage/Drafts/`. Say 'stage it' when ready to send."

## Stage This Email

Trigger: user says "stage this email", "stage it", "send this to Mail".

Steps:

1. Re-read the vault draft `.email.md` file fresh (never use cached version).
2. Push to Apple Mail via `apple-mail.sh draft --to <addr> -s <subj> -B <body>` with optional flags:
	- If `cc:` is present in frontmatter, add `--cc <addrs>`.
	- If `bcc:` is present, BCC is not yet supported by `apple-mail.sh draft`; note this to the user and suggest adding BCC manually in Mail.app after staging.
	- If `attachments:` is present, use direct AppleScript instead of `apple-mail.sh draft` for the entire staging step. The pattern supports attachments:
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
		Add CC via `make new cc recipient`; multiple attachments via repeated `set theFile` plus `make new attachment` blocks.
3. Open the draft in Mail.app for review: `apple-mail.sh open <id> --mailbox drafts`.
4. Update the vault file's `status:` from `draft` to `staged`.
5. User reviews and sends manually from Mail.app (adding BCC manually if needed).

Re-staging: if the user wants changes after staging, edit the existing Mail draft in place. Never trash the Mail draft unless explicitly asked.

Error handling: if `apple-mail.sh draft` fails, report the error reason and leave the vault file as `status: draft` so the user can retry.

Key rules (apply to both Draft and Stage):

- Never include name, credentials, phone, or email in the body. Mail.app auto-appends the signature.
- Always use the iCloud account's `@mac.com` form (never `@me.com`) for iCloud sending.
- Search Apple Contacts for a recipient email when only a name is given.

## Post-Send Verification

Trigger: user confirms "I sent it", "it's sent", "email sent".

Steps:

1. Wait 1 minute in the background (do not block the conversation).
2. Check Apple Mail Sent mailbox: `apple-mail.sh search --subject "<subject>" --mailbox "i/Sent Messages"`.
3. Check Apple Mail Inbox for bounce-back messages related to the recipient.
4. Report delivery status:
	- Success: "Confirmed: email to [recipient] found in Sent mailbox, no bounce detected."
	- Failure: "Warning: email not found in Sent mailbox after 1 minute. Check Mail.app."
	- Bounce: "Warning: bounce-back detected from [recipient]. Check inbox."
5. Update vault file `status:` from `staged` to `sent`.
6. If the user says "archive it", move the vault `.email.md` file to `60 - Archives/60.10 - Email Archive`.
7. If the user does not request archive, ask before deleting; otherwise leave for the user to handle.
8. PAI never deletes a vault email file without explicit instruction.
