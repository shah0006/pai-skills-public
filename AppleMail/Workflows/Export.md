# Workflow: Export

Save attachments to disk; export an email to Obsidian-flavoured Markdown.

## Commands

| Command | Aliases | Usage |
|---------|---------|-------|
| `save-attachment <id> [-m box] [-o dir]` | `save-att` | Download attachments (default `~/Downloads/`). |
| `export <id> [-m box] [-o path]` | `export-email` | Export to Obsidian `.email.md` with YAML frontmatter. |

## Export output shape

`export` writes a Markdown file with YAML frontmatter (sender, recipient, subject, date, message ID) followed by the plain-text body. The format is consumable by the EmailTriage web UI and matches the `Email Triage/Archive/` convention. Attachments are not embedded; the export references their original Mail.app message ID so a follow-up `save-attachment` against the same ID retrieves the binary.

## Examples

```
apple-mail.sh save-attachment 79132 -o ~/Downloads/invoices/
apple-mail.sh export 79132 -o "<vault-root>/Email Triage/Archive/2026-05-05 invoice.email.md"
```
