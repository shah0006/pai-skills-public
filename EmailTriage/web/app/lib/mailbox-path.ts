import type { ClassifiedEmail, AccountAlias } from "../../../Tools/Types";
import { getStageFolderPath, resolveAccountAlias } from "../../../Tools/Types";

function inferAccountAlias(email: ClassifiedEmail): AccountAlias | null {
  const raw = (email.account ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  const fromBadge = resolveAccountAlias(raw);
  if (fromBadge) return fromBadge;
  if (/^\d+$/.test(email.id)) return "i";
  if (/^[a-f0-9]{12,}$/i.test(email.id)) return "g";
  return null;
}

/** Unified mailbox path for apple-mail.sh `--mailbox` (e.g. `i/Stages/Stage 5 - Bulk Dispose`). */
export function mailboxUnifiedPathForEmail(email: ClassifiedEmail): string | undefined {
  const alias = inferAccountAlias(email);
  if (!alias) return undefined;
  return getStageFolderPath(email.funnelStage, alias) ?? undefined;
}
