import { spawnSync } from "child_process";
import { statSync, existsSync } from "fs";
import { APPLE_MAIL_SH } from "./paths";
import { getTriageNotePath } from "./paths";

const GWS_BIN = process.env.GWS_BIN ?? "gws";

export interface TransportHealth {
  ok: boolean;
  degraded: boolean;
  label: string;
  lastRendered?: string;
}

export interface TransportStatusPayload {
  gmail: TransportHealth;
  icloud: TransportHealth;
  pageBanner?: string;
}

function stripGwsBanner(out: string): string {
  return out.split("\n").filter(l => !l.startsWith("[account:") && !l.startsWith("Using keyring backend:")).join("\n").trim();
}

export function probeGmailTransport(timeoutMs = 5000): TransportHealth {
  const result = spawnSync(
    GWS_BIN,
    ["gmail", "users", "getProfile", "--params", JSON.stringify({ userId: "me" })],
    { encoding: "utf8", timeout: timeoutMs },
  );
  const ok = result.status === 0;
  return {
    ok,
    degraded: !ok,
    label: ok ? "Gmail connected" : "Gmail unreachable",
  };
}

export function probeIcloudTransport(timeoutMs = 8000): TransportHealth {
  try {
    const result = spawnSync("bash", [APPLE_MAIL_SH, "list", "i", "1"], {
      encoding: "utf8",
      timeout: timeoutMs,
    });
    const ok = result.status === 0;
    return {
      ok,
      degraded: !ok,
      label: ok ? "iCloud Mail connected" : "iCloud Mail unreachable",
    };
  } catch {
    return { ok: false, degraded: true, label: "iCloud Mail unreachable" };
  }
}

export function buildTransportStatus(date: string): TransportStatusPayload {
  const gmail = probeGmailTransport();
  const icloud = probeIcloudTransport();
  const notePath = getTriageNotePath(date);
  let lastRendered: string | undefined;
  if (existsSync(notePath)) {
    lastRendered = statSync(notePath).mtime.toISOString();
    if (gmail.degraded) gmail.lastRendered = lastRendered;
    if (icloud.degraded) icloud.lastRendered = lastRendered;
  }

  const parts: string[] = [];
  if (gmail.degraded) {
    parts.push(`⚠️ Gmail unreachable — showing last rendered state from ${lastRendered ?? "unknown"}`);
  }
  if (icloud.degraded) {
    parts.push(`⚠️ iCloud Mail unreachable — showing last rendered state from ${lastRendered ?? "unknown"}`);
  }

  return {
    gmail,
    icloud,
    pageBanner: parts.length > 0 ? parts.join(" | ") : undefined,
  };
}

export function openInSourceClientUrl(emailId: string, accountName?: string): string {
  const acct = (accountName ?? "").toLowerCase();
  if (acct.includes("google") || acct === "gmail" || isGmailId(emailId)) {
    return `https://mail.google.com/mail/u/0/#inbox/${emailId}`;
  }
  return `message://%3c${emailId}%3e`;
}

function isGmailId(id: string): boolean {
  return /^[a-f0-9]{12,}$/i.test(id);
}
