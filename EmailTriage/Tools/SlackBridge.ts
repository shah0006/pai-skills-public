// Tools/SlackBridge.ts — Phase 23: Slack/Discord bridge scaffold (v0).
//
// Minimal webhook poster. The user has no stated workflow that needs this
// today (per session note 2026-05-19 "no use case stated"), but the
// scaffold is here so it's a 5-minute config change instead of a
// 1-hour build the day they decide they want morning-triage summaries
// posted to a team channel.
//
// Config: SLACK_WEBHOOK_URL env var (or DISCORD_WEBHOOK_URL — both
// services accept Slack-style payloads via the right webhook endpoint).
// No webhook URL = function silently no-ops + returns { sent: false }.
//
// Usage:
//   const ok = await postToSlack({ text: "Morning triage: 41 emails / 6 to process" });
//   const ok = await postToSlack({ webhook: "https://...", text: "..." });

export interface SlackPayload {
  text: string;
  channel?: string;
  username?: string;
}

export interface PostResult {
  sent: boolean;
  status?: number;
  error?: string;
}

export async function postToSlack(
  args: SlackPayload & { webhook?: string },
): Promise<PostResult> {
  const url = args.webhook ?? process.env.SLACK_WEBHOOK_URL ?? process.env.DISCORD_WEBHOOK_URL;
  if (!url) return { sent: false, error: "no webhook configured (set SLACK_WEBHOOK_URL or DISCORD_WEBHOOK_URL)" };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: args.text,
        channel: args.channel,
        username: args.username ?? "PAI Email Triage",
      }),
    });
    return { sent: res.ok, status: res.status };
  } catch (err) {
    return { sent: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Convenience formatter — turns a triage session summary into a Slack
 * message body. Designed to be called from GenerateTriage after the doc
 * is written, for users who opt in via the SLACK_WEBHOOK_URL env var.
 */
export function formatTriageSummary(args: {
  date: string;
  total: number;
  toProcess: number;
  automated: number;
  vip: number;
}): string {
  return `Morning Triage — ${args.date}\n`
    + `• ${args.total} emails (${args.toProcess} to process / ${args.automated} automated)\n`
    + `• ${args.vip} VIP items need attention`;
}

if (import.meta.main) {
  const text = process.argv.slice(2).join(" ") || "test message from PAI Email Triage";
  const result = await postToSlack({ text });
  console.log(JSON.stringify(result, null, 2));
}
