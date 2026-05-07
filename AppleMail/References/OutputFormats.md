# Reference: OutputFormats

Stable output formats from `Tools/apple-mail.sh`. EmailTriage's `email-parser.ts` and `triage-formatter.ts` parse these strings; do not change them without an explicit cross-skill migration.

## List output line format

```
ID:79132 [ ] [⚑] [📎] | Date | From: addr | Subject: text
```

Field semantics:

| Field | Values |
|-------|--------|
| `ID:NNNNN` | Numeric Mail.app message ID. |
| Read flag | `[ ]` = unread, `[READ]` = read. |
| Flagged flag | `[⚑]` if flagged, blank otherwise. |
| Attachment flag | `[📎]` if has attachments, blank otherwise. |
| Date | Long form: `Friday, March 27, 2026 at 4:59:58 AM`. The `triage-formatter.ts` short-date extractor parses this to `2026-03-27`. |
| From | `From: <name or address>`. |
| Subject | `Subject: <text>`. |
| ACCT (optional) | `\| ACCT:<account-name>` appended when listing across accounts (`--mailbox all`). |

Header lines that downstream parsers tolerate and skip:

```
Mailbox: inbox (82 total)
=====
```

The total-count extractor in `email-parser.ts` keys on the literal `Mailbox: <name> (N total)` shape.

## Mailbox names

System aliases (case-insensitive):

| Name | Resolves to |
|------|-------------|
| `inbox` (default) | First mailbox named `INBOX`. |
| `sent` | First mailbox named `Sent Messages` (fallback `Sent Mail`). |
| `drafts` | First mailbox named `Drafts`. |
| `trash` | First mailbox named `Trash` or `Deleted Messages`. |
| `junk` | First mailbox named `Junk` or `Spam`. |

Custom mailboxes:

- Plain name: `"Receipts"`, `"Family"` — searches all accounts; first match wins.
- Account-prefixed: `i/Receipts`, `g/Receipts` — bound to the named account.
- Hierarchical: `i/Stages/Stage 1 - VIP` — supports up to 4 levels deep.
- Quoted exact name: `"Exact Folder Name"` — for names containing spaces.

## Attachment listing

```
NAME=invoice.pdf MIME=application/pdf SIZE=124532
```

One line per attachment. Tab-separated fields are not used; key=value pairs are.

## Export `.email.md` shape

YAML frontmatter:

```
---
document-type: email
status: archived
from: <sender>
to: <recipient>
subject: <subject>
date: <ISO-8601>
message-id: <Mail.app numeric ID>
mailbox: <mailbox path>
created: <ISO-8601>
modified: <ISO-8601>
---
```

Body: plain-text email body, no signature stripping, no HTML re-render. Used by Email Triage's archive consumer.

## Watch log entries

```
[YYYY-MM-DD_HH:MM:SS] VIP: Sender Name — Subject text
[YYYY-MM-DD_HH:MM:SS] NEW: Sender Name — Subject text
[YYYY-MM-DD_HH:MM:SS] Check complete: 5 new (1 VIP, 4 regular)
```

One log line per detected new message; one summary line per check.

## Stability commitment

These formats are part of the AppleMail skill's public contract. Phase 1 of the v5 refactor preserves them byte-for-byte (the script body is unmodified). Future format changes require a coordinated update with `EmailTriage/email-parser.ts` and `EmailTriage/triage-formatter.ts`.
