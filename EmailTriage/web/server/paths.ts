import { existsSync, readFileSync } from "fs";
import { join } from "path";

export function getVaultRoot(): string {
  if (process.env.EMAILTRIAGE_VAULT_ROOT) return process.env.EMAILTRIAGE_VAULT_ROOT;
  try {
    const home = process.env.HOME;
    if (!home) return "";
    const prefs = join(home, ".claude/PAI/USER/SKILLCUSTOMIZATIONS/EmailTriage/preferences.yaml");
    if (!existsSync(prefs)) return "";
    const raw = readFileSync(prefs, "utf8");
    const m = raw.match(/^\s*vault_root\s*:\s*["']?([^"'#\n]+?)["']?\s*(?:#.*)?$/m);
    return m ? m[1].trim() : "";
  } catch {
    return "";
  }
}

export const SKILL_ROOT = join(
  process.env.HOME ?? "",
  ".claude/skills/EmailTriage",
);

export const APPLE_MAIL_SH = join(
  process.env.HOME ?? "",
  ".claude/skills/AppleMail/Tools/apple-mail.sh",
);

/** Canonical triage note path (matches Tools/GenerateTriage.getOutputPath). */
export function getTriageNotePath(date: string, vaultRoot?: string): string {
  const root = vaultRoot ?? getVaultRoot();
  const dir = join(root, "Email Triage");
  const [y, m, d] = date.split("-").map(Number);
  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  return join(dir, `Email Triage -- ${months[m - 1]} ${d}, ${y}.md`);
}

export function isGmailMessageId(id: string): boolean {
  return /^[a-f0-9]{12,}$/i.test(id);
}

export function isIcloudMessageId(id: string): boolean {
  return /^\d+$/.test(id);
}
