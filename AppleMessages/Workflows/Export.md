# Workflow: Export

Exports conversations or daily digests to vault Markdown files.

## Export a single conversation

```bash
# Default: last 200 messages, written to vault folder
apple-messages.sh export "+13125551234"

# Custom count
apple-messages.sh export "+13125551234" 500

# Custom output dir
apple-messages.sh export "+13125551234" 500 --out "/path/to/folder"
```

**Default vault path:** `/Volumes/Hyperdrive 4 Tb/Main Obsidian (Sync)/40 - System/iMessage Exports/iMessage - <handle>.md`

**Output format:**

```
---
created: YYYY-MM-DD
modified: YYYY-MM-DDTHH:MM:SS-04:00
document-type: imessage-export
handle: +13125551234
messages: 200
---

# iMessage Conversation — +13125551234

**Me** (YYYY-MM-DD HH:MM:SS):

Outgoing message body

---

**+13125551234** (YYYY-MM-DD HH:MM:SS):

Incoming message body

---
...
```

## Daily digest (today's incoming, grouped by handle)

```bash
# Stdout
apple-messages.sh daily-digest

# To file
apple-messages.sh daily-digest --out ~/Downloads/imessage-digest.md
```

Useful for end-of-day summary or attaching to a journal entry.

## Tips

- Vault standard: handles with `+` and special chars are sanitized in filenames (replaced with `_`).
- For large exports (10k+ messages) the SQLite query is fast (~100ms); the bottleneck is the per-row formatting in bash.
- After export, run VaultLint on the output to normalize formatting per Obsidian standards.
