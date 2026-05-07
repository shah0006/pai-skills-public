# Workflow: Send

The vault-draft to send pattern for outgoing iMessages. Mirrors the AppleMail compose constraint.

## Steps

1. **Determine the recipient's mobile number.**
   - Look up in Apple Contacts (`AppleScript` to Contacts).
   - If no mobile is on file: **STOP and ASK** the user. Do NOT send to email as a fallback unless explicitly told to.
2. **Compose the message body in a vault draft file.**
   - Path: `/Volumes/Hyperdrive 4 Tb/Main Obsidian (Sync)/Coordination/iMessage Drafts/<recipient>-<topic>.imessage.md`
   - Optional YAML frontmatter (the skill strips it on send):
     ```
     ---
     to: +13125551234
     recipient: Recipient Name
     created: YYYY-MM-DD
     ---
     ```
   - Body below frontmatter is what gets sent.
3. **Surface the draft to the user for review.**
   - Output the draft path; read back the body in chat.
   - Wait for explicit user approval before sending.
4. **Send.**
   - `apple-messages.sh send-from-vault <mobile> <vault-path>` -- preferred; strips frontmatter automatically.
   - Or `apple-messages.sh send <mobile> "<short text>"` for one-line replies.
5. **Verify delivery.**
   - Watch the script's stdout for `sent to ...` confirmation.
   - On failure: do not retry blindly; show the error to the user.

## Hard rules

- Mobile number only (no Gmail, no work email). Refuse with `ERROR` if email is passed without `--allow-email`.
- One draft per outgoing message. Do not reuse a draft for unrelated recipients.
- After sending, leave the draft in place as the audit trail; mark `sent: <timestamp>` in frontmatter.

## Example

```bash
# 1. Look up mobile in Contacts
osascript -e 'tell application "Contacts" to return value of first phone of person "Recipient Name"'

# 2. Stage draft (in your editor or via Write tool)
# /Volumes/.../Coordination/iMessage Drafts/recipient-topic.imessage.md

# 3. Send
~/.claude/skills/AppleMessages/Tools/apple-messages.sh send-from-vault "+13125551234" "/Volumes/.../Coordination/iMessage Drafts/recipient-topic.imessage.md"
```
