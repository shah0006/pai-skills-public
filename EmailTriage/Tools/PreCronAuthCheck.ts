// PreCronAuthCheck.ts — Gmail auth probe before Generate (5s timeout)

import { spawnSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { sendAuthFailureAlert } from "./AlertSender";
import { formatWarningBanner } from "./Banner";
import { getReconcilerBannerPath } from "./Reconciler";
import { mergeBanners } from "./Banner";

const AUTH_TIMEOUT_MS = 5_000;

function gwsBin(): string {
  return process.env.GWS_BIN ?? "gws";
}

export interface PreCronResult {
  gmailOk: boolean;
  banner?: string;
}

function stripGwsBanner(out: string): string {
  return out.split("\n").filter(l => !l.startsWith("[account:") && !l.startsWith("Using keyring backend:")).join("\n").trim();
}

/** Probe Gmail auth via gws users.getProfile (matches Doctor 9b). */
export function probeGmailAuth(timeoutMs = AUTH_TIMEOUT_MS): { ok: boolean; detail?: string } {
  const result = spawnSync(
    gwsBin(),
    ["gmail", "users", "getProfile", "--params", JSON.stringify({ userId: "me" })],
    { encoding: "utf8", timeout: timeoutMs },
  );
  if (result.error?.message?.includes("ETIMEDOUT") || result.signal === "SIGTERM") {
    return { ok: false, detail: "timeout" };
  }
  if (result.status !== 0) {
    const err = (result.stderr ?? "").toString().trim();
    return { ok: false, detail: err || `exit ${result.status}` };
  }
  try {
    const json = JSON.parse(stripGwsBanner((result.stdout ?? "").toString()));
    if (json.emailAddress || json.messagesTotal !== undefined) {
      return { ok: true, detail: json.emailAddress as string | undefined };
    }
  } catch { /* fall through */ }
  return { ok: false, detail: "unparseable profile response" };
}

export function readPendingReconcilerBanner(): string | undefined {
  const path = getReconcilerBannerPath();
  if (!existsSync(path)) return undefined;
  try {
    return readFileSync(path, "utf-8").trim() || undefined;
  } catch {
    return undefined;
  }
}

export function runPreCronAuthCheck(options: {
  skipAlerts?: boolean;
  includeReconcilerBanner?: boolean;
} = {}): PreCronResult {
  const auth = probeGmailAuth();
  const reconcilerBanner = options.includeReconcilerBanner !== false
    ? readPendingReconcilerBanner()
    : undefined;

  if (auth.ok) {
    return { gmailOk: true, banner: reconcilerBanner };
  }

  const authBanner = formatWarningBanner("Gmail auth failure (pre-cron)", [
    "Gmail half of morning triage will be skipped until auth is restored.",
    "Run: `gws gmail auth login` (browser OAuth).",
    auth.detail ? `Probe detail: ${auth.detail}` : "",
  ]);

  if (!options.skipAlerts) {
    sendAuthFailureAlert(auth.detail);
  }

  return {
    gmailOk: false,
    banner: mergeBanners(reconcilerBanner, authBanner),
  };
}

if (import.meta.main) {
  const r = runPreCronAuthCheck({ skipAlerts: process.argv.includes("--no-alerts") });
  console.log(r.gmailOk ? "Gmail auth OK" : "Gmail auth FAIL");
  if (r.banner) console.log(r.banner);
  process.exit(r.gmailOk ? 0 : 1);
}
