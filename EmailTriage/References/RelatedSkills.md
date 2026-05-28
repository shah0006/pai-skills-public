## Related Skills

- **AppleMail** — iCloud transport (`Tools/apple-mail.sh`; byte-identical, not modified by EmailTriage).
- **GoogleWorkspaceCLI** — Gmail helpers invoked by `GwsGmailTransport` (sole writer for account `g`).
- **AppleMessages** — iMessage transport for urgent alerts.

When NOT to use this skill:

- For sending individual emails (use AppleMail or GoogleWorkspaceCLI directly).
- For bulk unsubscribe without triage review (use `bulk-unsubscribe.sh` from AppleMail directly).
- For non-Gmail / non-iCloud accounts — the rules engine is configured for those two providers via the AppleMail transport.
