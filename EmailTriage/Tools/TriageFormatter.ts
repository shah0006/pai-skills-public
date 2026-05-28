// ~/.claude/skills/EmailTriage/triage-formatter.ts
import type { TriageSession, ClassifiedEmail, FunnelStage } from "./Types";
import { resolveAccountAlias } from "./Types";
import { injectBannerAfterFrontmatter } from "./Banner";

function formatDate(dateStr: string): string {
  const [year, month, day] = dateStr.split("-").map(Number);
  const months = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  return `${months[month - 1]} ${day}, ${year}`;
}

/** Format a Date as YYYY-MM-DD_HH:MM (vault standard: underscore separator, 24-hour clock) */
export function formatDatetime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}:${pad(d.getMinutes())}`;
}export function formatToNewYorkTimestamp(dateStr: string | undefined): string | null {
  if (!dateStr) return null;
  try {
    const cleaned = dateStr.replace(/\s+at\s+.*$/, "").trim();
    const d = new Date(cleaned);
    if (isNaN(d.getTime())) {
      const dOrig = new Date(dateStr);
      if (isNaN(dOrig.getTime())) return null;
      return formatNewYorkDate(dOrig);
    }
    return formatNewYorkDate(d);
  } catch {
    return null;
  }
}

function formatNewYorkDate(d: Date): string {
  const options: Intl.DateTimeFormatOptions = {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  };
  const parts = new Intl.DateTimeFormat("en-US", options).formatToParts(d);
  const getPart = (type: string) => parts.find(p => p.type === type)?.value || "";
  
  const year = getPart("year");
  const month = getPart("month");
  const day = getPart("day");
  let hour = getPart("hour");
  const minute = getPart("minute");

  if (hour === "24") hour = "00";
  
  return `${year}-${month}-${day}_${hour}:${minute}`;
}


/** Format a Date as ISO 8601 with timezone offset (e.g. 2026-03-13T22:14:17-04:00) */
function formatModified(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const absOffset = Math.abs(offset);
  const tzHr = pad(Math.floor(absOffset / 60));
  const tzMin = pad(absOffset % 60);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${tzHr}:${tzMin}`;
}

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max - 1) + "..." : str;
}

/** Escape pipe characters for markdown table cells. Unescaped pipes break column alignment. */
function escPipes(str: string): string {
  return str.replace(/\|/g, "\\|");
}

/** Extract a short date from apple-mail.sh format: "Friday, March 27, 2026 at 4:59:58 AM" -> "2026-03-27" */
function extractShortDate(dateStr: string): string {
  try {
    // Remove "at HH:MM:SS AM/PM" suffix and parse
    const cleaned = dateStr.replace(/\s+at\s+.*$/, "").trim();
    const d = new Date(cleaned);
    if (!isNaN(d.getTime())) {
      const pad = (n: number) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    }
  } catch { /* fall through */ }
  return dateStr.split(",").slice(1, 3).join(",").trim() || dateStr;
}

function senderName(email: ClassifiedEmail): string {
  const namePart = email.from.split("<")[0].trim();
  return namePart || email.fromAddress;
}

/** Account indicator: [i] for iCloud, [g] for Gmail.
 *  Default to "i" when the account can't be resolved — matches the sort path's
 *  fallback (sortToStageFolders defaults unknown → "i") so the doc badge is
 *  consistent with where the email physically gets staged. Without this
 *  default, emails whose apple-mail.sh listing didn't surface an ACCT: field
 *  render with no account badge in the doc (and the UI's AccountBadge
 *  component renders no icon at all because `account` is the empty string). */
function acctBadge(email: ClassifiedEmail): string {
  const alias = resolveAccountAlias(email.account ?? "iCloud") ?? "i";
  return ` [${alias}]`;
}

/** Render an email ID as a clickable message:// link if messageId is available,
 *  otherwise return the plain ID string. */
export function mailLink(email: ClassifiedEmail): string {
  if (email.messageId) {
    return `[${email.id}](message://%3C${encodeURIComponent(email.messageId)}%3E)`;
  }
  return email.id;
}

function newBadge(email: ClassifiedEmail): string {
  return email.isUnknownSender ? " `[NEW]`" : "";
}

/** Render a mini-block for a single email — used for VIP and Action stages where
 *  the user needs full context, a draft, and space to give instructions. */
export function formatEmailBlock(email: ClassifiedEmail, defaultAction: string): string {
  const badge = email.isVip ? " [VIP]" : "";
  const newTag = newBadge(email);
  const att = email.hasAttachment ? " [att]" : "";
  const subject = truncate(email.subject, 70) + att;
  const aiLine = email.aiSummary ? `*AI: ${email.aiSummary}*` : "";

  const dateStr = email.date ? ` -- ${extractShortDate(email.date)}` : '';
  const acct = acctBadge(email);
  const idDisplay = email.messageId ? mailLink(email) : `\`${email.id}\``;
  let block = `#### ${idDisplay} ${email.fromAddress}${badge}${acct}${newTag}${dateStr}\n`;
  block += `**${subject}**\n`;
  if (aiLine) block += `${aiLine}\n`;

  // Body content (per body inclusion rules)
  if (email.bodyInclusion === "blocked") {
    block += `*[SECURITY: suspicious content detected -- review in Apple Mail only]*\n`;
  } else if (email.bodyInclusion === "summary" && email.body) {
    // AI summary: render as italic summary line (concise, decision-focused)
    block += `*${email.body.replace(/\n/g, " ").trim()}*\n`;
  } else if (email.body) {
    // Full or truncated: render as-is
    block += `${email.body}\n`;
  }

  // Draft line -- show inline if available, placeholder if pending (lazy generation)
  if (email.replyDraft) {
    // Collapse multi-line drafts to single line for scanning
    const draftOneLiner = email.replyDraft.split("\n").filter(l => l.trim()).slice(0, 2).join(" ").trim();
    const shortDraft = truncate(draftOneLiner, 120);
    block += `**Draft reply:** ${shortDraft}\n`;
  } else if (defaultAction === "R") {
    block += `**Draft reply:** *(pending -- generated on review or execution)*\n`;
  }

  block += `**Action:** [${defaultAction}]  **You:**\n`;
  return block;
}

/** Render mini-blocks for a list of emails */
function emailBlocks(emails: ClassifiedEmail[], defaultAction: string): string {
  if (emails.length === 0) return "*None*\n";
  return emails.map(e => formatEmailBlock(e, defaultAction)).join("\n");
}

/** Attachment cell: show count if present, empty if none */
function attCell(email: ClassifiedEmail): string {
  return email.hasAttachment ? "1" : "";
}

/** Render Stage 3 Financial table with Type/Vendor/Amount/Archive To/You columns */
function financialTable(emails: ClassifiedEmail[]): string {
  if (emails.length === 0) return "*None*\n";
  const header = "\n| ID | Date | Sender | Type | Vendor | Amount | Subject | \ud83d\udcce | Action | Archive To | You |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |";
  const rows = emails.map(e => formatFinancialRow(e));
  return header + "\n" + rows.join("\n") + "\n";
}

/** Render Stage 4 Informational table with mark columns A/T/K */
function informationalTable(emails: ClassifiedEmail[]): string {
  if (emails.length === 0) return "*None*\n";
  const header = "\n| ID | Date | Sender | Subject | \ud83d\udcce | Archive To | A | T | K | You |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |";
  const rows = emails.map(e => formatInformationalRow(e));
  return header + "\n" + rows.join("\n") + "\n";
}

/** Render Stage 5 Bulk Dispose table with mark columns A/T/J/U/BD/BS */
function bulkDisposeTable(emails: ClassifiedEmail[]): string {
  if (emails.length === 0) return "*None*\n";
  const header = "\n| ID | Sender | Subject | \ud83d\udcce | Archive To | A | T | J | U | BD | BS | You |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |";
  const rows = emails.map(e => formatBulkDisposeRow(e));
  return header + "\n" + rows.join("\n") + "\n";
}

/** Render Stage 6 Auto-Processed table with Rule column and mark columns.
 *  Sorted by rule column so related emails group together. */
function autoProcessedTable(emails: ClassifiedEmail[]): string {
  if (emails.length === 0) return "*None*\n";
  const header = "\n| ID | Sender | Subject | \ud83d\udcce | Rule | Archive To | A | T | K | J | U | BD | BS | You |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |";
  const sorted = [...emails].sort((a, b) => {
    const ruleA = a.matchedRule ?? "";
    const ruleB = b.matchedRule ?? "";
    return ruleA.localeCompare(ruleB);
  });
  const rows = sorted.map(e => formatAutoProcessedRow(e));
  return header + "\n" + rows.join("\n") + "\n";
}

// ─── Single-item formatters (exported for incremental merge) ───

/** Default You column instruction based on financial document type (per plan Section 4, Stage 3). */
function financialYouDefault(type: string | undefined): string {
  switch (type) {
    case "Statement": return "save statement";
    case "Receipt": return "process receipt";
    case "EOB": return "process receipt";
    case "Invoice": return "save invoice";
    case "DocuSign": return "sign and return";
    default: return "";
  }
}

/** Format a single Stage 3 Financial table row.
 *  Subject is pre-condensed by AI pipeline; truncation here is a safety net only. */
export function formatFinancialRow(email: ClassifiedEmail): string {
  const dateCol = email.date ? extractShortDate(email.date) : "";
  const sender = escPipes(truncate(email.fromAddress, 30)) + newBadge(email);
  const type = email.financialType ? truncate(email.financialType, 15) : "--";
  const vendor = email.financialVendor ? escPipes(truncate(email.financialVendor, 25)) : "--";
  const amount = email.financialAmount ?? "--";
  const subject = escPipes(truncate(email.subject, 55));
  const idCell = mailLink(email) + acctBadge(email);
  const archiveTo = email.folder ?? "";
  // Per plan: DocuSign → R (needs signing action), all others → T (save doc then trash email)
  const defaultAction = email.financialType === "DocuSign" ? "R" : "T";
  const youDefault = financialYouDefault(email.financialType);
  return `| ${idCell} | ${dateCol} | ${sender} | ${type} | ${vendor} | ${amount} | ${subject} | ${attCell(email)} | ${defaultAction} | ${archiveTo} | ${youDefault} |`;
}

/** Format a single Stage 4 Informational table row.
 *  Subject is pre-condensed by AI pipeline; truncation here is a safety net only. */
export function formatInformationalRow(email: ClassifiedEmail): string {
  const dateCol = email.date ? extractShortDate(email.date) : "";
  const sender = escPipes(truncate(email.fromAddress, 30)) + newBadge(email);
  const subject = escPipes(truncate(email.subject, 55));
  const archiveTo = email.folder ?? "";
  const idCell = mailLink(email) + acctBadge(email);
  const att = attCell(email);
  // Per plan: default to A (archive) if folder suggested, T (trash) if no folder
  if (email.folder) {
    return `| ${idCell} | ${dateCol} | ${sender} | ${subject} | ${att} | ${archiveTo} | x |  |  |  |`;
  }
  return `| ${idCell} | ${dateCol} | ${sender} | ${subject} | ${att} | ${archiveTo} |  | x |  |  |`;
}

/** Format a single Stage 5 Bulk Dispose table row.
 *  Subject is pre-condensed by AI pipeline; truncation here is a safety net only. */
export function formatBulkDisposeRow(email: ClassifiedEmail): string {
  const sender = escPipes(truncate(senderName(email), 25)) + newBadge(email);
  const subject = escPipes(truncate(email.subject, 55));
  const archiveTo = email.folder ?? "";
  const idCell = mailLink(email) + acctBadge(email);
  // Default: T (trash) per plan. Junk-matched get x in J column instead.
  const isJunk = email.matchedRule?.startsWith("junk:") || email.isJunk;
  if (isJunk) {
    return `| ${idCell} | ${sender} | ${subject} | ${attCell(email)} | ${archiveTo} |  |  | x |  |  |  |  |`;
  }
  return `| ${idCell} | ${sender} | ${subject} | ${attCell(email)} | ${archiveTo} |  | x |  |  |  |  |  |`;
}

/** Format a single Stage 6 Auto-Processed table row.
 *  Subject is pre-condensed by AI pipeline; truncation here is a safety net only. */
export function formatAutoProcessedRow(email: ClassifiedEmail): string {
  const sender = escPipes(truncate(senderName(email), 25)) + newBadge(email);
  const subject = escPipes(truncate(email.subject, 55));
  // Shorten staged rules: "staged:i/Stages/Stage 6 - Auto-Processed" → "staged"
  const rawRule = email.matchedRule ?? "";
  const rule = rawRule.startsWith("staged:") ? "staged" : escPipes(rawRule);
  const archiveTo = email.folder ?? "";
  const isJunkRule = rawRule.startsWith("junk:");
  const idCell = mailLink(email) + acctBadge(email);
  const att = attCell(email);
  // Default: A with folder for routing matches, T for junk matches
  if (isJunkRule) {
    return `| ${idCell} | ${sender} | ${subject} | ${att} | ${rule} | ${archiveTo} |  | x |  |  |  |  |  |  |`;
  }
  return `| ${idCell} | ${sender} | ${subject} | ${att} | ${rule} | ${archiveTo} | x |  |  |  |  |  |  |  |`;
}

/** Table headers for each stage (used by merge to insert into empty sections) */
export const FINANCIAL_TABLE_HEADER = "\n| ID | Date | Sender | Type | Vendor | Amount | Subject | \ud83d\udcce | Action | Archive To | You |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |";
export const INFORMATIONAL_TABLE_HEADER = "\n| ID | Date | Sender | Subject | \ud83d\udcce | Archive To | A | T | K | You |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |";
export const BULK_DISPOSE_TABLE_HEADER = "\n| ID | Sender | Subject | \ud83d\udcce | Archive To | A | T | J | U | BD | BS | You |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |";
export const AUTO_PROCESSED_TABLE_HEADER = "\n| ID | Sender | Subject | \ud83d\udcce | Rule | Archive To | A | T | K | J | U | BD | BS | You |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |";

// Backwards-compatible aliases (used by incremental merge in generate-triage.ts)
export const COMPACT_TABLE_HEADER = FINANCIAL_TABLE_HEADER;
export function formatCompactRow(email: ClassifiedEmail, _defaultAction: string = "A"): string {
  return formatFinancialRow(email);
}
export function formatCheckboxItem(email: ClassifiedEmail): string {
  return formatAutoProcessedRow(email);
}

export function formatTriageNote(session: TriageSession): string {
  const { date, generatedAt, total, inboxTotal, unread, emails, estimatedMinutes, accountFilter } = session;

  // Group by funnel stage
  const vip = emails.filter(e => e.funnelStage === "vip");
  const followUpDue = emails.filter(e => e.funnelStage === "follow_up_due");
  const action = emails.filter(e => e.funnelStage === "action");
  const financial = emails.filter(e => e.funnelStage === "financial");
  const informational = emails.filter(e => e.funnelStage === "informational");
  const bulkDispose = emails.filter(e => e.funnelStage === "bulk_dispose");
  const autoProcessed = emails.filter(e => e.funnelStage === "auto_processed");

  // Count emails needing review (interactive stages)
  const reviewCount = vip.length + followUpDue.length + action.length + financial.length + informational.length;
  const autoCount = bulkDispose.length + autoProcessed.length;

  const genTime = formatDatetime(new Date(generatedAt));
  const displayDate = formatDate(date);
  const modifiedTime = formatModified(new Date());

  // Build account map: "id:alias,id:alias,..." for executor to locate per-account stage folders
  const accountMap = emails
    .map(e => `${e.id}:${resolveAccountAlias(e.account ?? "iCloud") ?? "i"}`)
    .join(",");

  // Build arrival map: "id:timestamp,id:timestamp,..." for capturing sender response-time & tone memory
  const arrivalMap = emails
    .map(e => {
      const ts = formatToNewYorkTimestamp(e.date);
      return ts ? `${e.id}:${ts}` : null;
    })
    .filter(Boolean)
    .join(",");

  // Account filter label for header
  const ACCOUNT_LABELS: Record<string, string> = { i: "iCloud", g: "Gmail" };
  const filterLabel = accountFilter ? ` (${ACCOUNT_LABELS[accountFilter] ?? accountFilter} only)` : "";
  const accountFilterYaml = accountFilter ? `\naccount-filter: ${accountFilter}` : "";

  let note = `---
date: ${date}
document-type: email-triage
accounts:
  - icloud
  - gmail
total: ${total}
inbox-total: ${inboxTotal ?? total}
unread: ${unread}
review-count: ${reviewCount}
auto-count: ${autoCount}
account-map: "${accountMap}"
arrival-map: "${arrivalMap}"${accountFilterYaml}
status: pending
processed_at:
modified: ${modifiedTime}
---
# Email Triage -- ${displayDate}
> ${inboxTotal && inboxTotal > total ? `${total} of ${inboxTotal} inbox emails` : `${total} emails`}${filterLabel} | ${unread} unread | ${reviewCount} need review | Generated: ${genTime} | Est. review: ${estimatedMinutes} min
> ${vip.length} VIP | ${action.length} Action | ${financial.length} Financial | ${informational.length} Info | ${bulkDispose.length} Bulk | ${autoProcessed.length} Auto-processed${followUpDue.length > 0 ? ` | ${followUpDue.length} Follow-up Due` : ""}
>
> **Action codes:** K=Keep A=Archive T=Trash R=Reply D=Defer FU=Follow-up J=Junk U=Unsub AP=Approve BL=Block
> **You:** Write instructions for PAI -- "reply saying not interested", "forward to Anand", "save attachment to receipts"
> **Multiple actions:** comma-separated -- e.g. \`R, FU:2026-03-10\` or \`U, T\`

## Instructions
*Freeform commands -- executor parses and applies before processing emails.*
*Examples: "add @domain.com to junk", "VIP add email@x.com", "create rule for all LinkedIn"*

>

`;

  // ── Triage Overview ──
  note += `## Triage Overview\n\n`;
  note += `| Stage | Count | Status |\n| --- | --- | --- |\n`;
  note += `| VIP | ${vip.length} | |\n`;
  if (followUpDue.length > 0) note += `| Follow-Up Due | ${followUpDue.length} | |\n`;
  note += `| Action Required | ${action.length} | |\n`;
  note += `| Financial | ${financial.length} | |\n`;
  note += `| Informational | ${informational.length} | |\n`;
  note += `| Bulk Dispose | ${bulkDispose.length} | |\n`;
  note += `| Auto-Processed | ${autoProcessed.length} | |\n`;
  note += `| **Total** | **${total}** | **${reviewCount} need review** |\n`;
  note += "\n";

  // ── Stage 1: VIP ──
  note += `## [] Stage 1: VIP (${vip.length})\n`;
  note += `*People who matter most. Always review first.*\n`;
  note += emailBlocks(vip, "R");
  note += "\n";

  // ── Follow-Up Due ──
  if (followUpDue.length > 0) {
    note += `## [] Follow-Up Due (${followUpDue.length})\n`;
    note += `*Emails you marked for follow-up with no reply detected.*\n`;
    note += emailBlocks(followUpDue, "R");
    note += "\n";
  }

  // ── Stage 2: Action Required ──
  note += `## [] Stage 2: Action Required (${action.length})\n`;
  note += `*Emails needing reply, decision, or deadline action.*\n`;
  note += emailBlocks(action, "R");
  note += "\n";

  // ── Stage 3: Financial & Documents ──
  note += `## [] Stage 3: Financial & Documents (${financial.length})\n`;
  note += `*Receipts, statements, tax docs, attachments to file.*\n`;
  note += `*Action: K=Keep, A=Archive (specify folder), T=Trash, J=Junk, R=Reply, D=Defer, FU=Follow-up*\n`;
  note += `*You: "process receipt", "save statement", "sign and return", "save license key", "forward to Anand"*\n`;
  note += financialTable(financial);
  note += "\n";

  // ── Stage 4: Informational ──
  note += `## [] Stage 4: Informational (${informational.length})\n`;
  note += `*Educational content, newsletters, professional updates. A=Archive (specify folder), T=Trash, K=Keep.*\n`;
  note += informationalTable(informational);
  note += "\n";

  // ── Stage 5: Bulk Dispose ──
  note += `## [] Stage 5: Bulk Dispose (${bulkDispose.length})\n`;
  note += `*Marketing, transactional notifications. Default: T (trash). Mark columns: A=Archive, J=Junk, U=Unsub, BD=Block Domain, BS=Block Sender*\n`;
  note += bulkDisposeTable(bulkDispose);
  note += "\n";

  // ── Stage 6: Auto-Processed ──
  note += `## [] Stage 6: Auto-Processed (${autoProcessed.length})\n`;
  note += `*Rule-matched archives, junk, and AI-classified spam. Default per rule. Override any row.*\n`;
  note += autoProcessedTable(autoProcessed);
  note += "\n";

  // ── Execution Log ──
  note += `## Execution Log\n`;
  note += `*Filled in by PAI after processing*\n`;
  note += `- Archived: --  |  Trashed: --  |  Replied: --  |  Unsubscribed: --  |  Blocked: --\n`;
  note += `- Processed at: --\n`;
  note += `- Duration: --\n`;

  if (session.banner?.trim()) {
    return injectBannerAfterFrontmatter(note, session.banner.trim());
  }
  return note;
}
