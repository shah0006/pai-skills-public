// ~/.claude/skills/EmailTriage/types.ts

export type EmailPriority = 'action' | 'review' | 'unknown' | 'archive' | 'trash' | 'unsub';

// Funnel stage determines which section of the triage note an email appears in
export type FunnelStage = 'vip' | 'follow_up_due' | 'action' | 'financial' | 'informational' | 'bulk_dispose' | 'auto_processed';

// AI classifier returns these granular action types for funnel placement
export type AIActionType =
  | 'reply_needed'     // Stage: action — email expects a response
  | 'decision_needed'  // Stage: action — requires approve/reject/choose
  | 'deadline'         // Stage: action — date-sensitive obligation
  | 'financial'        // Stage: financial — claims, statements, receipts, tax, billing
  | 'document_review'  // Stage: financial — attachments requiring review
  | 'educational'      // Stage: informational — CME, medical literature, professional dev
  | 'newsletter'       // Stage: informational — subscribed content worth scanning
  | 'marketing'        // Stage: bulk_dispose — promotions, sales, coupons
  | 'transactional'    // Stage: bulk_dispose — confirmations, notifications, alerts
  | 'junk';            // Stage: auto_processed — spam, scam indicators

export interface RawEmail {
  id: string;
  subject: string;
  from: string;          // "Name <email@domain.com>" format
  fromAddress: string;   // parsed email address only
  fromDomain: string;    // parsed domain only
  date: string;
  isRead: boolean;
  hasAttachment: boolean;
  snippet: string;
  account: string;               // Apple Mail account name (e.g. "iCloud", "Google")
  messageId?: string;            // RFC 2822 Message-ID header (for message:// links)
  messageUrl?: string;           // Full message:// URL extracted from the doc's bracketed link — used by the web UI's Open-in-Mail handler (UX-4)
}

export interface ClassifiedEmail extends RawEmail {
  priority: EmailPriority;
  funnelStage: FunnelStage;     // which triage funnel section this email appears in
  aiActionType?: AIActionType;  // granular AI classification for funnel placement
  matchedRule: string | null;   // e.g. "domain:substack.com" or "vip" or "ai"
  folder: string | null;        // destination folder if archiving
  replyDraft: string | null;
  isVip: boolean;
  isJunk: boolean;
  isUnknownSender: boolean;
  aiSummary?: string;           // pre-generated Claude 1-line summary for action/unknown
  body?: string;                 // Fetched email body (Stages 1-2 only)
  bodyInclusion?: BodyInclusion; // How the body should be rendered in triage note
  financialType?: string;       // Pattern-matched: Statement, Receipt, EOB, DocuSign, Invoice, etc.
  financialVendor?: string;     // Extracted vendor/company name from sender
  financialAmount?: string;     // Extracted dollar amount (e.g. "$45.00") from subject/snippet
  remoteUnreachable?: boolean;  // Phase 3: transport unreachable; row from rendered note only
}

export interface EmailAction {
  emailId: string;
  action: 'archive' | 'trash' | 'reply' | 'defer' | 'keep' | 'junk' | 'block' | 'unsub' | 'approve';
  folder?: string;
  replyText?: string;
  followUpDate?: string;         // YYYY-MM-DD_HH:MM (vault standard: underscore, 24h)
  sendAt?: string;               // YYYY-MM-DD_HH:MM for Send Later
}

export interface TriageSession {
  date: string;                  // YYYY-MM-DD
  generatedAt: string;           // YYYY-MM-DD_HH:MM (vault standard: underscore, 24h)
  total: number;
  inboxTotal: number | null;  // Total emails in inbox (may be > total if fetch was capped)
  unread: number;
  emails: ClassifiedEmail[];
  estimatedMinutes: number;
  accountFilter?: AccountAlias;  // If set, only this account was triaged
  banner?: string;             // Optional [!warning] callout (pre-cron / reconciler)
}

// ─── Account Aliases ───

export type AccountAlias = 'i' | 'g' | 'y' | 'h' | 'a' | 'p';

export const ACCOUNT_MAP: Record<string, AccountAlias> = {
  i: 'i', icloud: 'i',
  g: 'g', gmail: 'g', google: 'g',
  y: 'y', yahoo: 'y',
  h: 'h', hotmail: 'h',
  a: 'a', aol: 'a',
  p: 'p', protonmail: 'p',
};

export function resolveAccountAlias(input: string): AccountAlias | null {
  return ACCOUNT_MAP[input.toLowerCase()] ?? null;
}


// ─── Triage Note State (for incremental merge in Phase 13.3) ───

export interface TriageNoteState {
  knownIds: Set<string>;
  decisions: Map<string, { action: string; archiveTo?: string; you?: string }>;
  instructionsContent: string;
  executionLog?: string;
}

// ─── Body Inclusion ───

export type BodyInclusion = 'full' | 'truncated' | 'summary' | 'blocked';

// ─── Stage Folder Mapping ───

// Folder names without account prefix (backward compat)
export const STAGE_FOLDER_NAMES: Record<FunnelStage, string | null> = {
  vip: "Stage 1 - VIP",
  follow_up_due: null,  // Synthetic entries from follow_ups DB -- not moved
  action: "Stage 2 - Action Required",
  financial: "Stage 3 - Financial",
  informational: "Stage 4 - Informational",
  bulk_dispose: "Stage 5 - Bulk Dispose",
  auto_processed: "Stage 6 - Auto-Processed",
};

// Returns account-prefixed stage folder path (e.g. "i/Stages/Stage 1 - VIP")
export function getStageFolderPath(stage: FunnelStage, account: AccountAlias): string | null {
  const folderName = STAGE_FOLDER_NAMES[stage];
  if (!folderName) return null;
  return `${account}/Stages/${folderName}`;
}

export const FOLDER_STAGE_MAP: Record<string, FunnelStage> = {
  "Stage 1 - VIP": "vip",
  "Stage 2 - Action Required": "action",
  "Stage 3 - Financial": "financial",
  "Stage 4 - Informational": "informational",
  "Stage 5 - Bulk Dispose": "bulk_dispose",
  "Stage 6 - Auto-Processed": "auto_processed",
};
