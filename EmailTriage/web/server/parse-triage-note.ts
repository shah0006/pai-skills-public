// Shared triage-note → session parser (parse-note + stage-review must stay aligned)

import type { ClassifiedEmail, TriageSession, EmailPriority, FunnelStage } from "../../Tools/Types";

// ─── ID extraction helper ───
// Handles: [87126](message://...) [i], [`87126`](message://...) [i], `87126`, or plain 87126.
// IDs may be NUMERIC (Apple Mail, e.g. 97336) or HEX (Gmail, e.g. 19e31b0ff3ca0a6d).
// Older regex required \\d+ which failed on Gmail hex IDs — it then fell through to a
// permissive \\d{4,6} scan that captured the FIRST 4-6 digits found anywhere in the cell,
// including the message:// URL payload (e.g. "010001" extracted from
// "message://%3C%3C0100019e31b0fdc4-..."). The UI then sent that wrong ID to
// /api/email/<id>, which 500'd with "Email ID not found in Stages/Stage 6 - Auto-Processed".
// Hex character class fixes both cases without changing behavior for Apple Mail rows.
function extractId(cell: string): { id: string; account?: string; messageUrl?: string } {
  const badge = cell.match(/\[([igyhap])\]/);
  // Bracketed display ID inside a (message://...) link — authoritative form.
  // Capturing the URL here lets the UI's Open button hand a real RFC 2822
  // Message-Id to Mail.app instead of synthesizing one from the Apple-numeric
  // ID (which Mail.app's message:// scheme doesn't recognize). UX-4 fix.
  const linked = cell.match(/\[`?([a-fA-F0-9]+)`?\]\((message:\/\/[^)]+)\)/);
  if (linked) return { id: linked[1], account: badge?.[1], messageUrl: linked[2] };
  // Fall back: a link with non-message URL — still extract the id, drop the URL.
  const linkedAny = cell.match(/\[`?([a-fA-F0-9]+)`?\]\([^)]*\)/);
  if (linkedAny) return { id: linkedAny[1], account: badge?.[1] };
  const backtick = cell.match(/`([a-fA-F0-9]+)`/);
  if (backtick) return { id: backtick[1], account: badge?.[1] };
  const plain = cell.match(/\b([a-fA-F0-9]{4,})\b/);
  if (plain) return { id: plain[1], account: badge?.[1] };
  return { id: cell.trim() };
}

function accountAliasToName(alias?: string): string | undefined {
  if (!alias) return undefined;
  const map: Record<string, string> = {
    i: "iCloud", g: "Google", y: "Yahoo", h: "Hotmail", a: "AOL", p: "ProtonMail",
  };
  return map[alias] ?? alias;
}

function makeEmail(
  id: string, from: string, subject: string,
  priority: EmailPriority, funnelStage: FunnelStage,
  aiSummary?: string, matchedRule?: string | null,
  account?: string, emailDate?: string, messageUrl?: string,
): ClassifiedEmail {
  const fromAddress = from.includes("@") ? from.replace(/.*<(.+?)>.*/, "$1").trim() : from;
  const fromDomain = fromAddress.includes("@") ? fromAddress.split("@")[1] : "";
  return {
    id,
    subject,
    from,
    fromAddress,
    fromDomain,
    date: emailDate || new Date().toISOString(),
    isRead: false,
    hasAttachment: subject.includes("[att]"),
    snippet: aiSummary || subject,
    priority,
    funnelStage,
    matchedRule: matchedRule ?? null,
    folder: null,
    replyDraft: null,
    isVip: funnelStage === "vip",
    isJunk: false,
    isUnknownSender: false,
    aiSummary: aiSummary || undefined,
    account: account || "",
    messageUrl: messageUrl,
  };
}

/** Parse an existing markdown triage note into a TriageSession (V1 + V2 formats).
 *  @param noteContent - The raw markdown note content
 *  @param date - The triage date (YYYY-MM-DD)
 *  @param processedIds - Optional set of email IDs already trashed/archived today.
 *    If provided, these emails are excluded from the parsed session. This fixes the
 *    stale-triage-note bug: when a user trashes an email via the UI, ExecuteTriage
 *    records it in email_actions but does NOT update the triage note on disk. The
 *    next page load would re-parse the stale note and show trashed emails as if
 *    they're still pending. Cross-referencing email_actions excludes them. */
export function parseTriageNoteToSession(
  noteContent: string,
  date: string,
  processedIds?: Set<string>,
): TriageSession {
  const emails: ClassifiedEmail[] = [];
  const lines = noteContent.split("\n");

  let total = 0;
  let unread = 0;
  let estimatedMinutes = 0;
  const headerMatch = noteContent.match(/(\d+) emails \| (\d+) unread.*Est\. review: (\d+)/);
  if (headerMatch) {
    total = parseInt(headerMatch[1], 10);
    unread = parseInt(headerMatch[2], 10);
    estimatedMinutes = parseInt(headerMatch[3], 10);
  }

  let currentStage: string | null = null;
  let currentPriority: EmailPriority = "review";

  let hasFinancialTypes = false;
  const bulkDisposeColIndices = { T: 6, U: 8 };
  const financialColIndices = { Type: 3, Vendor: 4, Amount: 5, Subject: 6 };
  const informationalColIndices = { Sender: 2, Subject: 3 };


  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.includes("Stage 1: VIP") && !line.includes("~~")) {
      currentStage = "vip"; currentPriority = "action"; continue;
    }
    if (line.includes("Stage 2: Action")) {
      currentStage = "action"; currentPriority = "action"; continue;
    }
    if (line.includes("Stage 3:")) {
      currentStage = "financial"; currentPriority = "review"; continue;
    }
    if (line.includes("Stage 4:")) {
      currentStage = "informational"; currentPriority = "review"; continue;
    }
    if (line.includes("Stage 5: Bulk Dispose")) {
      currentStage = "bulk_dispose"; currentPriority = "archive"; continue;
    }
    if (line.includes("Stage 6:")) {
      currentStage = "auto_processed"; currentPriority = "archive"; continue;
    }
    if (line.includes("~~Stage") && line.includes("✅")) { currentStage = "processed"; continue; }
    if (line.includes("Already Processed")) { currentStage = "processed"; continue; }
    if (line.includes("## Execution Log")) { currentStage = "processed"; continue; }
    if (currentStage === "processed") continue;

    if (line.startsWith("####")) {
      const { id, account, messageUrl } = extractId(line);
      if (id && /^[a-fA-F0-9]{4,}$/.test(id) && currentStage) {
        let senderPart = line.replace(/^####\s+/, "");
        senderPart = senderPart.replace(/\[`?[a-fA-F0-9]+`?\]\([^)]*\)\s*/, "");
        senderPart = senderPart.replace(/`[a-fA-F0-9]+`\s*/, "");
        const senderMatch = senderPart.match(/^(\S+)/);
        const from = senderMatch ? senderMatch[1] : "";

        const dateMatch = line.match(/--\s+(\d{4}-\d{2}-\d{2})/);
        const emailDate = dateMatch ? dateMatch[1] : new Date().toISOString();

        const subjectLine = lines[i + 1] || "";
        const subject = subjectLine.replace(/^\*\*/, "").replace(/\*\*$/, "").trim();

        let aiSummary = "";
        let j = i + 2;
        while (j < lines.length && !lines[j].startsWith("####") && !lines[j].startsWith("## ")) {
          const scanLine = lines[j];
          if (scanLine.startsWith("*AI:")) {
            aiSummary = scanLine.replace(/^\*AI:\s*/, "").replace(/\*$/, "").trim();
          }
          j++;
        }

        emails.push(makeEmail(id, from, subject, currentPriority, currentStage as FunnelStage, aiSummary, null, accountAliasToName(account), emailDate, messageUrl));
        continue;
      }
    }

    if (!line.startsWith("|")) continue;
    const rawCells = line.split("|").map((c: string) => c.trim()).slice(1, -1);
    if (rawCells.length < 3) continue;

    if (rawCells[0] === "ID") {
      if (currentStage === "bulk_dispose") {
        const tIdx = rawCells.indexOf("T");
        const uIdx = rawCells.indexOf("U");
        if (tIdx !== -1) bulkDisposeColIndices.T = tIdx;
        if (uIdx !== -1) bulkDisposeColIndices.U = uIdx;
      } else if (currentStage === "financial") {
        const typeIdx = rawCells.indexOf("Type");
        if (typeIdx !== -1) {
          hasFinancialTypes = true;
          financialColIndices.Type = typeIdx;
          const vendorIdx = rawCells.indexOf("Vendor");
          const amountIdx = rawCells.indexOf("Amount");
          const subjIdx = rawCells.indexOf("Subject");
          if (vendorIdx !== -1) financialColIndices.Vendor = vendorIdx;
          if (amountIdx !== -1) financialColIndices.Amount = amountIdx;
          if (subjIdx !== -1) financialColIndices.Subject = subjIdx;
        } else {
          hasFinancialTypes = false;
        }
      } else if (currentStage === "informational") {
        const senderIdx = rawCells.indexOf("Sender");
        const subjIdx = rawCells.indexOf("Subject");
        if (senderIdx !== -1) informationalColIndices.Sender = senderIdx;
        if (subjIdx !== -1) informationalColIndices.Subject = subjIdx;
      }
      continue;
    }

    if (rawCells[0].match(/^-+$/)) continue;
    if (!currentStage || currentStage === "processed") continue;

    if (currentStage === "bulk_dispose") {
      const { id, account, messageUrl } = extractId(rawCells[0]);
      if (!id || !/^[a-fA-F0-9]{4,}$/.test(id)) continue;
      const sender = rawCells[1]?.replace(/\s*`\[NEW\]`/, "").trim() || "";
      const subject = rawCells[2] || "";

      let action: EmailPriority = "archive";
      if (rawCells[bulkDisposeColIndices.T]?.toLowerCase() === "x") action = "trash";
      else if (rawCells[bulkDisposeColIndices.U]?.toLowerCase() === "x") action = "unsub";

      emails.push(makeEmail(id, sender, subject, action, "bulk_dispose", "", null, accountAliasToName(account), undefined, messageUrl));
      continue;
    }

    if (currentStage === "financial") {
      const { id, account, messageUrl } = extractId(rawCells[0]);
      if (!id || !/^[a-fA-F0-9]{4,}$/.test(id)) continue;

      let sender = "";
      let subject = "";
      let aiSummary = "";
      let financialType: string | undefined;
      let financialVendor: string | undefined;
      let financialAmount: string | undefined;

      if (hasFinancialTypes) {
        sender = rawCells[2]?.replace(/\s*`\[NEW\]`/, "").trim() || "";
        financialType = rawCells[financialColIndices.Type] || undefined;
        financialVendor = rawCells[financialColIndices.Vendor] || undefined;
        financialAmount = rawCells[financialColIndices.Amount] || undefined;
        subject = rawCells[financialColIndices.Subject] || "";
      } else {
        sender = rawCells[2]?.replace(/\s*`\[NEW\]`/, "").trim() || "";
        subject = rawCells[3] || "";
        aiSummary = rawCells[4] || "";
      }

      const email = makeEmail(id, sender, subject, "review", "financial", aiSummary, null, accountAliasToName(account), undefined, messageUrl);
      if (financialType) email.financialType = financialType;
      if (financialVendor) email.financialVendor = financialVendor;
      if (financialAmount) email.financialAmount = financialAmount;
      emails.push(email);
      continue;
    }

    if (currentStage === "informational") {
      const { id, account, messageUrl } = extractId(rawCells[0]);
      if (!id || !/^[a-fA-F0-9]{4,}$/.test(id)) continue;
      const sender = rawCells[informationalColIndices.Sender]?.replace(/\s*`\[NEW\]`/, "").trim() || "";
      const subject = rawCells[informationalColIndices.Subject] || "";
      const aiSummary = rawCells[4] || "";

      emails.push(makeEmail(id, sender, subject, "review", "informational", aiSummary, null, accountAliasToName(account), undefined, messageUrl));
      continue;
    }

    {
      const { id, account, messageUrl } = extractId(rawCells[0]);
      if (!id || !/^[a-fA-F0-9]{4,}$/.test(id)) continue;
      const sender = rawCells[1]?.replace(/\s*`\[NEW\]`/, "").trim() || "";
      const subject = rawCells[2] || "";
      const aiSummary = rawCells.length >= 4 ? rawCells[3] : "";
      emails.push(makeEmail(id, sender, subject, currentPriority, currentStage as FunnelStage, aiSummary, null, accountAliasToName(account), undefined, messageUrl));
      continue;
    }
  }

  let inStage6 = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes("Stage 6:")) { inStage6 = true; continue; }
    if (inStage6 && line.startsWith("## ")) { inStage6 = false; continue; }
    if (!inStage6) continue;

    const checkboxMatch = line.match(/^-\s+\[[ x]\]\s+/);
    if (!checkboxMatch) continue;

    const afterCheckbox = line.slice(checkboxMatch[0].length);
    const { id, account, messageUrl } = extractId(afterCheckbox);
    if (!id || !/^[a-fA-F0-9]{4,}$/.test(id)) continue;

    let rest = afterCheckbox;
    rest = rest.replace(/\[`?[a-fA-F0-9]+`?\]\([^)]*\)\s*/, "");
    rest = rest.replace(/`[a-fA-F0-9]+`\s*/, "");

    const parts = rest.split(/\s+--\s+/);
    const sender = parts[0]?.replace(/\s*`\[NEW\]`/, "").trim() || "";
    const subjectAndRule = parts[1] || "";
    const ruleMatch = subjectAndRule.match(/\(([^)]+)\)\s*$/);
    const rule = ruleMatch ? ruleMatch[1] : null;
    const subject = ruleMatch ? subjectAndRule.slice(0, ruleMatch.index).trim() : subjectAndRule.trim();

    emails.push(makeEmail(id, sender, subject, "archive", "auto_processed", "", rule, accountAliasToName(account), undefined, messageUrl));
  }

  // Filter out emails that were already processed (trashed/archived) today.
  // This fixes the stale-triage-note bug: when a user trashes an email via the
  // UI, ExecuteTriage records it in email_actions but does NOT update the
  // triage note on disk. The next page load would re-parse the stale note and
  // show trashed emails as if they're still pending. By cross-referencing
  // email_actions, we exclude already-handled items from the session.
  let filteredEmails = emails;
  if (processedIds && processedIds.size > 0) {
    filteredEmails = emails.filter(e => !processedIds.has(e.id));
  }

  return {
    date,
    generatedAt: new Date().toISOString(),
    total: total || filteredEmails.length,
    inboxTotal: null,
    unread: unread || filteredEmails.length,
    emails: filteredEmails,
    estimatedMinutes: estimatedMinutes || Math.ceil(filteredEmails.length / 4),
  };
}
