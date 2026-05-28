"use client";

import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import type { ClassifiedEmail, EmailPriority, TriageSession } from "../../Tools/Types";
import {
  truncate,
  extractSenderName,
  actionLabel,
  formatHeaderDate,
  formatRelativeDate,
  isSuspiciousSender,
  hasInjectionContent,
  subjectConveysFullAsk,
} from "./utils";
import { mailboxUnifiedPathForEmail } from "./lib/mailbox-path";
import { OpenInClientButton } from "./components/OpenInClientButton";
import { inferLinkType } from "./components/LinkTypeLabel";
import { classifyEmailType, type EmailType } from "../../Tools/EmailTypes";
import { SettingsPanel } from "./components/SettingsPanel";

// ─── Email-type taxonomy (AD-1) ───
// The taxonomy is the email_types DB table, served by /api/email-types. Fetch
// it once and cache it module-wide — it is identical for every email, so a
// per-component fetch would be wasteful. classifyEmailType (pure) runs against
// the cached list.
let _emailTypesCache: EmailType[] | null = null;
let _emailTypesPromise: Promise<EmailType[]> | null = null;
function fetchEmailTypes(): Promise<EmailType[]> {
  if (_emailTypesCache) return Promise.resolve(_emailTypesCache);
  if (!_emailTypesPromise) {
    _emailTypesPromise = fetch("/api/email-types")
      .then(r => (r.ok ? r.json() : { types: [] }))
      .then(d => { _emailTypesCache = Array.isArray(d.types) ? d.types : []; return _emailTypesCache!; })
      .catch(() => { _emailTypesCache = []; return _emailTypesCache!; });
  }
  return _emailTypesPromise;
}

// ─── Tab types ───

type TabId = "process" | "automated" | "analytics" | "settings";

const TABS: { id: TabId; label: string; priorities: EmailPriority[] }[] = [
  { id: "process",   label: "To Process", priorities: ["action", "unknown", "review"] },
  { id: "automated", label: "Automated",  priorities: ["archive", "trash", "unsub"] },
  { id: "analytics", label: "Analytics",  priorities: [] },
  { id: "settings",  label: "Settings",   priorities: [] },
];

const PRIORITY_ORDER: Record<EmailPriority, number> = {
  action: 0, unknown: 1, review: 2, archive: 3, trash: 4, unsub: 4,
};

// Section 5.1 canonical colors (Design Review Synthesis)
const PRIORITY_BORDER: Record<EmailPriority, string | null> = {
  action:  "#c08081",
  unknown: "#c08081",
  review:  null,
  archive: null,
  trash:   null,
  unsub:   null,
};

const PRIORITY_OPACITY: Record<EmailPriority, number> = {
  action:  1.0,
  unknown: 1.0,
  review:  1.0,
  archive: 0.5,
  trash:   0.4,
  unsub:   0.4,
};

const PRIORITY_BADGE_BG: Record<EmailPriority, string> = {
  action:  "rgba(192,128,129,0.18)",
  unknown: "rgba(192,128,129,0.18)",
  review:  "rgba(178,154,104,0.15)",
  archive: "rgba(138,134,120,0.15)",
  trash:   "rgba(192,128,129,0.15)",
  unsub:   "rgba(192,128,129,0.15)",
};

const PRIORITY_TEXT_COLOR: Record<EmailPriority, string> = {
  action:  "rgba(255,255,255,0.95)",
  unknown: "rgba(255,255,255,0.80)",
  review:  "rgba(255,255,255,0.60)",
  archive: "rgba(255,255,255,0.45)",
  trash:   "rgba(255,255,255,0.35)",
  unsub:   "rgba(255,255,255,0.35)",
};

const TAB_COLOR: Record<TabId, string> = {
  process:   "#b29a68",
  automated: "#8a8678",
  analytics: "#d4c29d",
  settings:  "#b29a68",
};

const TAB_RGB: Record<TabId, string> = {
  process:   "60,185,252",
  automated: "107,122,150",
  analytics: "167,139,250",
  settings:  "178,154,104",
};

// Sticky section headers within "process" tab
const PROCESS_SECTIONS: { priority: EmailPriority; label: string; color: string }[] = [
  { priority: "action",  label: "ACTION REQUIRED", color: "#c08081" },
  { priority: "unknown", label: "NEEDS TRIAGE",    color: "#c08081" },
  { priority: "review",  label: "FYI / REVIEW",    color: "rgba(232,230,223,0.4)" },
];

// ─── State ───

interface AppState {
  emails: ClassifiedEmail[];
  decisions: Record<string, string>;
  replyDrafts: Record<string, string>;
  aiSummaries: Record<string, string>;
  injectionWarnings: Record<string, boolean>;
  aiActions: Record<string, { executed: string[]; message: string }>;
  selectedId: string | null;
  isLoading: boolean;
  isGenerating: boolean;
  isExecuting: boolean;
  editingReply: boolean;
  date: string;
  sessionStats: {
    total: number;
    unread: number;
    estimatedMinutes: number;
  } | null;
  executionResult: {
    archived: number;
    trashed: number;
    replied: number;
    unsubscribed: number;
    blocked: number;
    junked: number;
    kept: number;
    deferred: number;
    approved: number;
    total: number;
  } | null;
  error: string | null;
  progressSteps: Array<{ step: string; detail: string }>;
}

type Action =
  | { type: "SET_SESSION"; session: TriageSession }
  | { type: "SET_LOADING"; value: boolean }
  | { type: "SET_GENERATING"; value: boolean }
  | { type: "ADD_PROGRESS"; step: string; detail: string }
  | { type: "CLEAR_PROGRESS" }
  | { type: "SET_EXECUTING"; value: boolean }
  | { type: "SELECT"; emailId: string | null }
  | { type: "SET_DECISION"; emailId: string; code: string }
  | { type: "SET_REPLY_DRAFT"; emailId: string; text: string }
  | { type: "SET_EDITING_REPLY"; value: boolean }
  | { type: "SET_AI_SUMMARY"; emailId: string; summary: string; injectionWarning?: boolean }
  | { type: "SET_AI_ACTIONS"; emailId: string; executed: string[]; message: string }
  | { type: "SET_EXECUTION_RESULT"; result: AppState["executionResult"] }
  | { type: "REMOVE_EMAILS"; ids: string[] }
  | { type: "UPDATE_EMAIL_ID"; oldId: string; newId: string }
  | { type: "SET_ERROR"; error: string | null };

const initialState: AppState = {
  emails: [],
  decisions: {},
  replyDrafts: {},
  aiSummaries: {},
  injectionWarnings: {},
  aiActions: {},
  selectedId: null,
  isLoading: true,
  isGenerating: false,
  isExecuting: false,
  editingReply: false,
  date: "", // computed inside the load-existing useEffect to avoid SSR/CSR new Date() mismatch
  sessionStats: null,
  executionResult: null,
  error: null,
  progressSteps: [],
};

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "SET_SESSION": {
      const emails = action.session.emails;
      const first = emails.find((e) => e.priority === "action") ?? emails[0];
      return {
        ...state,
        emails,
        date: action.session.date,
        selectedId: first?.id ?? null,
        sessionStats: {
          total: action.session.total,
          unread: action.session.unread,
          estimatedMinutes: action.session.estimatedMinutes,
        },
        replyDrafts: emails.reduce(
          (acc, e) => { if (e.replyDraft) acc[e.id] = e.replyDraft; return acc; },
          {} as Record<string, string>,
        ),
        isLoading: false,
        isGenerating: false,
        error: null,
      };
    }
    case "SET_LOADING":   return { ...state, isLoading: action.value };
    case "SET_GENERATING": return { ...state, isGenerating: action.value };
    case "SET_EXECUTING":  return { ...state, isExecuting: action.value };
    case "SELECT":         return { ...state, selectedId: action.emailId, editingReply: false };
    case "SET_DECISION":
      return { ...state, decisions: { ...state.decisions, [action.emailId]: action.code } };
    case "SET_REPLY_DRAFT":
      return { ...state, replyDrafts: { ...state.replyDrafts, [action.emailId]: action.text } };
    case "SET_EDITING_REPLY": return { ...state, editingReply: action.value };
    case "SET_AI_SUMMARY":
      return {
        ...state,
        aiSummaries: { ...state.aiSummaries, [action.emailId]: action.summary },
        injectionWarnings: action.injectionWarning
          ? { ...state.injectionWarnings, [action.emailId]: true }
          : state.injectionWarnings,
      };
    case "SET_AI_ACTIONS":
      return { ...state, aiActions: { ...state.aiActions, [action.emailId]: { executed: action.executed, message: action.message } } };
    case "SET_EXECUTION_RESULT":
      return { ...state, executionResult: action.result, isExecuting: false };
    case "REMOVE_EMAILS": {
      const removeSet = new Set(action.ids);
      const newDecisions = { ...state.decisions };
      for (const id of action.ids) delete newDecisions[id];
      return {
        ...state,
        emails: state.emails.filter((e) => !removeSet.has(e.id)),
        decisions: newDecisions,
      };
    }
    case "UPDATE_EMAIL_ID": {
      const { oldId, newId } = action;
      const emails = state.emails.map((e) =>
        e.id === oldId ? { ...e, id: newId } : e
      );
      const decisions = { ...state.decisions };
      if (decisions[oldId] !== undefined) {
        decisions[newId] = decisions[oldId];
        delete decisions[oldId];
      }
      const replyDrafts = { ...state.replyDrafts };
      if (replyDrafts[oldId] !== undefined) {
        replyDrafts[newId] = replyDrafts[oldId];
        delete replyDrafts[oldId];
      }
      const aiSummaries = { ...state.aiSummaries };
      if (aiSummaries[oldId] !== undefined) {
        aiSummaries[newId] = aiSummaries[oldId];
        delete aiSummaries[oldId];
      }
      const injectionWarnings = { ...state.injectionWarnings };
      if (injectionWarnings[oldId] !== undefined) {
        injectionWarnings[newId] = injectionWarnings[oldId];
        delete injectionWarnings[oldId];
      }
      const aiActions = { ...state.aiActions };
      if (aiActions[oldId] !== undefined) {
        aiActions[newId] = aiActions[oldId];
        delete aiActions[oldId];
      }
      const selectedId = state.selectedId === oldId ? newId : state.selectedId;
      return {
        ...state,
        emails,
        decisions,
        replyDrafts,
        aiSummaries,
        injectionWarnings,
        aiActions,
        selectedId,
      };
    }
    case "SET_ERROR":
      return { ...state, error: action.error, isLoading: false, isGenerating: false, isExecuting: false };
    case "ADD_PROGRESS":
      return { ...state, progressSteps: [...state.progressSteps, { step: action.step, detail: action.detail }] };
    case "CLEAR_PROGRESS":
      return { ...state, progressSteps: [] };
    default: return state;
  }
}

// ─── Sort ───

type SortBy = "priority" | "date" | "sender";
type SortDir = "asc" | "desc";

// ─── Tab helpers ───

function getTabEmails(
  emails: ClassifiedEmail[],
  tab: TabId,
  sortBy: SortBy = "priority",
  sortDir: SortDir = "desc",
): ClassifiedEmail[] {
  const tabDef = TABS.find((t) => t.id === tab)!;
  const filtered = emails.filter((e) => tabDef.priorities.includes(e.priority));
  const dir = sortDir === "asc" ? 1 : -1;
  return [...filtered].sort((a, b) => {
    if (sortBy === "sender") {
      const nameA = a.from.replace(/<.*>/, "").trim().toLowerCase();
      const nameB = b.from.replace(/<.*>/, "").trim().toLowerCase();
      return dir * nameA.localeCompare(nameB);
    }
    if (sortBy === "date") {
      return dir * (parseInt(a.id, 10) - parseInt(b.id, 10));
    }
    if (a.isVip && !b.isVip) return -dir;
    if (!a.isVip && b.isVip) return dir;
    if (!a.isRead && b.isRead) return -dir;
    if (a.isRead && !b.isRead) return dir;
    return dir * (PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);
  });
}

function tabCounts(emails: ClassifiedEmail[]) {
  const byPriority: Record<EmailPriority, number> = {
    action: 0, unknown: 0, review: 0, archive: 0, trash: 0, unsub: 0,
  };
  for (const e of emails) {
    byPriority[e.priority] = (byPriority[e.priority] ?? 0) + 1;
  }
  return {
    process: byPriority.action + byPriority.unknown + byPriority.review,
    automated: byPriority.archive + byPriority.trash + byPriority.unsub,
    byPriority,
  };
}

// ─── Decision badge ───

function decisionBadgeStyle(decision?: string): { bg: string; fg: string } {
  switch (decision) {
    case "A":  return { bg: "rgba(178,154,104,0.18)",   fg: "#b29a68" };
    case "T":  return { bg: "rgba(192,128,129,0.18)",    fg: "var(--danger)" };
    case "R":  return { bg: "rgba(111,156,127,0.18)",   fg: "var(--success)" };
    case "D":  return { bg: "rgba(212,194,157,0.18)",   fg: "var(--warning)" };
    case "U":  return { bg: "rgba(192,128,129,0.12)",    fg: "var(--danger)" };
    case "J":  return { bg: "rgba(192,128,129,0.18)",    fg: "var(--danger)" };
    case "BL": return { bg: "rgba(192,128,129,0.22)",    fg: "var(--danger)" };
    case "BD": return { bg: "rgba(192,128,129,0.22)",    fg: "var(--danger)" };
    case "BS": return { bg: "rgba(192,128,129,0.22)",    fg: "var(--danger)" };
    case "AP": return { bg: "rgba(111,156,127,0.22)",   fg: "var(--success)" };
    case "FU": return { bg: "rgba(212,194,157,0.18)",  fg: "#d4c29d" };
    case "K":  return { bg: "rgba(138,134,120,0.15)",  fg: "var(--muted)" };
    default:   return { bg: "var(--border)",           fg: "var(--muted)" };
  }
}

function actionBtnBg(color: string): string {
  if (color === "#b29a68")         return "rgba(178,154,104,0.14)";
  if (color === "var(--warning)")  return "rgba(212,194,157,0.14)";
  if (color === "var(--accent)")   return "rgba(178,154,104,0.14)";
  if (color === "var(--danger)")   return "rgba(192,128,129,0.14)";
  if (color === "var(--success)")  return "rgba(111,156,127,0.14)";
  return "rgba(138,134,120,0.14)";
}

// ─── HeaderBar ───

function HeaderBar({
  date,
  stats,
  decisionsCount,
  onHelpOpen,
  onRegenerate,
  isGenerating,
}: {
  date: string;
  stats: AppState["sessionStats"];
  decisionsCount: number;
  onHelpOpen: () => void;
  onRegenerate: () => void;
  isGenerating: boolean;
}) {
  const total = stats?.total ?? 0;
  const progress = total > 0 ? (decisionsCount / total) * 100 : 0;

  return (
    <header className="bg-surface border-b border-border py-2.5 px-5 flex items-center gap-[14px] shrink-0">
      <span className="text-[1.15rem] font-semibold tracking-[-0.01em] font-serif text-text-strong">
        ✉ Triage
      </span>
      <span className="text-text-muted text-[0.82rem]">
        {formatHeaderDate(date)}
      </span>
      {stats && (
        <>
          <span className="text-text-muted text-[0.77rem]">
            {decisionsCount}/{total}
          </span>
          <div className="flex-1 max-w-[160px] h-[3px] bg-border rounded-[2px] overflow-hidden">
            <div
              className="h-full rounded-[2px] transition-[width] duration-200 ease-out"
              style={{
                width: `${progress}%`,
                background: progress === 100 ? "var(--success)" : "var(--color-gold)",
              }}
            />
          </div>
          <span className="text-text-muted text-[0.73rem]">~{stats.estimatedMinutes} min</span>
          {stats.unread > 0 && (
            <span className="text-[0.68rem] font-semibold py-px px-[7px] rounded-[10px] bg-muted-rose/10 text-danger">
              {stats.unread} unread
            </span>
          )}
        </>
      )}
      <div className="ml-auto flex items-center gap-1.5">
        <button
          onClick={onRegenerate}
          disabled={isGenerating}
          className={`border border-gold/30 rounded-md py-[5px] px-[14px] text-[0.75rem] font-semibold tracking-[0.02em] ${
            isGenerating
              ? "bg-gold/[0.06] text-text-muted cursor-default opacity-60"
              : "bg-gold/[0.12] text-gold cursor-pointer"
          }`}
        >
          {isGenerating ? "↻ Refreshing…" : "↻ Refresh Inbox"}
        </button>
        <button
          onClick={onHelpOpen}
          className="bg-transparent border border-border rounded-full w-6 h-6 text-[0.75rem] font-semibold text-text-muted cursor-pointer flex items-center justify-center"
        >
          ?
        </button>
      </div>
    </header>
  );
}

// ─── TabBar ───

function TabBar({
  activeTab,
  counts,
  onSelect,
}: {
  activeTab: TabId;
  counts: ReturnType<typeof tabCounts>;
  onSelect: (tab: TabId) => void;
}) {
  return (
    <div className="flex bg-surface border-b border-border pl-1 shrink-0">
      {TABS.map((tab) => {
        const isActive = tab.id === activeTab;
        const count = tab.id === "process" ? counts.process : tab.id === "automated" ? counts.automated : 0;
        const color = TAB_COLOR[tab.id];
        const rgb = TAB_RGB[tab.id];
        return (
          <button
            key={tab.id}
            onClick={() => onSelect(tab.id)}
            className={`py-2 px-[18px] text-[0.8rem] border-none rounded-none cursor-pointer flex items-center gap-1.5 whitespace-nowrap transition-[color,box-shadow,background] duration-150 ${isActive ? "font-semibold" : "font-normal"}`}
            style={{
              // Dynamic per-tab color/rgb stays inline — accent values are
              // parameterized per TabId, not a single design token.
              boxShadow: isActive ? `inset 0 -2px 0 ${color}` : "none",
              background: isActive ? `rgba(${rgb},0.07)` : "transparent",
              color: isActive ? color : "var(--muted)",
            }}
          >
            {tab.label}
            {count > 0 && (
              <span
                className="text-[0.62rem] font-bold py-px px-[5px] rounded-lg leading-[15px] min-w-[15px] text-center"
                style={{
                  background: isActive ? `rgba(${rgb},0.18)` : "rgba(138,134,120,0.12)",
                  color: isActive ? color : "var(--muted)",
                }}
              >
                {count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ─── Account badge ───

function AccountBadge({ account, small }: { account?: string; small?: boolean }) {
  if (!account) return null;
  const lcAccount = account.toLowerCase();
  const isGoogle = lcAccount === "google" || lcAccount === "gmail" || lcAccount === "g";
  const sz = small ? 14 : 16;
  // Brand-true Google blue + iCloud blue are intentionally kept inline — they
  // are NOT part of the Ethos palette (scannability cue per CEO direction).
  const bg = isGoogle ? "rgba(66,133,244,0.12)" : "rgba(178,154,104,0.12)";
  const border = isGoogle ? "rgba(66,133,244,0.3)" : "rgba(178,154,104,0.3)";
  return (
    <span
      title={`${account} account`}
      className="inline-flex items-center justify-center rounded-full shrink-0 select-none border"
      style={{ width: sz, height: sz, background: bg, borderColor: border }}
    >
      {isGoogle ? (
        <span
          className="font-extrabold leading-none font-[Arial,sans-serif]"
          style={{ color: "#4285F4", fontSize: sz - 5 }}
        >G</span>
      ) : (
        <svg viewBox="0 0 24 24" width={sz - 4} height={sz - 4} aria-hidden="true" fill="#5aadea">
          <path d="M19.35 10.04C18.67 6.59 15.64 4 12 4c-3.64 0-6.67 2.59-7.35 6.04C2.05 10.22 0 12.36 0 15c0 2.76 2.24 5 5 5h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z"/>
        </svg>
      )}
    </span>
  );
}

// ─── Inbox Zero overlay (Task 7.8) ───

function InboxZeroOverlay({ stats, date }: { stats: AppState["sessionStats"]; date: string }) {
  // Multi-stop gradients aren't expressible as utility classes — keep inline.
  const gradient = "linear-gradient(135deg, #1a1a1a 0%, #1f2620 40%, #243029 70%, #1a1a1a 100%)";
  const radials = "radial-gradient(ellipse at 20% 80%, rgba(178,154,104,0.08) 0%, transparent 50%), radial-gradient(ellipse at 80% 20%, rgba(212,194,157,0.05) 0%, transparent 50%)";
  return (
    <div
      className="flex-1 flex items-center justify-center relative overflow-hidden"
      style={{ background: gradient }}
    >
      <div className="absolute inset-0 pointer-events-none" style={{ background: radials }} />
      <div className="text-center z-[1] p-10">
        <div className="text-[3.5rem] mb-[18px] text-gold opacity-95">✦</div>
        <div className="text-[0.7rem] uppercase tracking-[0.16em] text-gold font-medium mb-3">
          Inbox Zero
        </div>
        <div className="text-[2.25rem] font-semibold tracking-[-0.02em] font-serif text-text-strong mb-2">
          Triage complete.
        </div>
        <div className="text-[0.85rem] text-muted-gold mb-6">
          {formatHeaderDate(date)}
        </div>
        {stats && (
          <div className="flex gap-7 justify-center text-[0.82rem] text-text-muted">
            <span>
              <span className="font-bold text-text-strong text-[1.1rem]">{stats.total}</span> emails
            </span>
            <span>
              <span className="font-bold text-text-strong text-[1.1rem]">~{stats.estimatedMinutes}</span> min
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Help overlay ───

function HelpOverlay({ onClose }: { onClose: () => void }) {
  return (
    <div
      onClick={onClose}
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-[1000]"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-surface border border-border rounded-[10px] py-6 px-7 w-[90%] max-w-[520px] max-h-[80vh] overflow-y-auto"
      >
        <div className="flex justify-between items-center mb-4">
          <h2 className="m-0 text-base font-bold">How to use Triage</h2>
          <button onClick={onClose} className="bg-transparent border-none text-text-muted cursor-pointer text-[1.2rem]">✕</button>
        </div>

        <HelpSection title="Tabs">
          <HelpRow label="To Process" color="var(--color-gold)">Action, Unknown, and Review emails — your decisions needed.</HelpRow>
          <HelpRow label="Automated" color="var(--text-muted)">Already classified as Archive or Trash — no action needed.</HelpRow>
        </HelpSection>

        <HelpSection title="Sections (To Process)">
          <HelpRow label="ACTION REQUIRED" color="var(--color-muted-rose)">Urgent — VIP or high priority.</HelpRow>
          <HelpRow label="NEEDS TRIAGE" color="var(--color-muted-rose)">Unknown senders — approve or block.</HelpRow>
          <HelpRow label="FYI / REVIEW" color="rgba(232,230,223,0.6)">Non-urgent, review and decide.</HelpRow>
        </HelpSection>

        <HelpSection title="Keyboard shortcuts (same as markdown codes)">
          <HelpRow label="j / k">Navigate emails.</HelpRow>
          <HelpRow label="a">Archive (markdown: A).</HelpRow>
          <HelpRow label="t">Trash (markdown: T).</HelpRow>
          <HelpRow label="r">Reply (markdown: R).</HelpRow>
          <HelpRow label="d">Defer (markdown: D).</HelpRow>
          <HelpRow label="f">Follow-up (markdown: FU).</HelpRow>
          <HelpRow label="u">Unsubscribe (markdown: U).</HelpRow>
          <HelpRow label="Shift+J">Junk (markdown: J).</HelpRow>
          <HelpRow label="p">Approve sender (markdown: AP).</HelpRow>
          <HelpRow label="b">Block sender (markdown: BL).</HelpRow>
          <HelpRow label="o">Open in source client (Mail.app or Gmail).</HelpRow>
          <HelpRow label="Space">Keep (markdown: K).</HelpRow>
          <HelpRow label="Backspace">Trash (alt).</HelpRow>
          <HelpRow label="⌘↵">Process All.</HelpRow>
          <HelpRow label="1 / 2">Switch tabs.</HelpRow>
        </HelpSection>

        <div className="mt-4 text-right">
          <button
            onClick={onClose}
            className="py-1.5 px-4 text-[0.8rem] border-none rounded-[5px] bg-gold text-white cursor-pointer"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}

function HelpSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mb-4">
      <div className="text-[0.68rem] font-bold tracking-[0.06em] uppercase text-text-muted mb-1.5">{title}</div>
      {children}
    </div>
  );
}

function HelpRow({ label, color, children }: { label: string; color?: string; children: ReactNode }) {
  return (
    <div className="flex gap-2.5 mb-[5px] text-[0.8rem] leading-[1.4]">
      <span className="min-w-[150px] shrink-0 font-medium" style={{ color: color ?? "var(--text)" }}>{label}</span>
      <span className="text-text-muted">{children}</span>
    </div>
  );
}

// ─── Section header (sticky, within list) — Task 7.5 ───

function SectionHeader({ label, color, count }: { label: string; color: string; count: number }) {
  return (
    <div className="sticky top-0 z-10 pt-[5px] pb-1 px-3 bg-bg border-b border-border flex items-center gap-[7px]">
      <span
        className="text-[0.57rem] font-bold tracking-[0.09em] uppercase"
        style={{ color }}
      >
        {label}
      </span>
      <span className="text-[0.57rem] font-semibold px-[5px] rounded-md bg-text-muted/10 text-text-muted leading-[14px]">
        {count}
      </span>
    </div>
  );
}

// ─── EmailListItem — Tasks 7.4, 7.7, 7.9 ───

function EmailListItem({
  email,
  isSelected,
  decision,
  aiSummary,
  injectionWarning,
  senderHistoryBadge,
  threadBadge,
  inAutomatedTab,
  onClick,
}: {
  email: ClassifiedEmail;
  isSelected: boolean;
  decision?: string;
  aiSummary?: string;
  injectionWarning?: boolean;
  /** Compact SenderMemory hint, e.g. {label:'5T', kind:'trash'} — Phase 22 in-list surface. */
  senderHistoryBadge?: { label: string; kind: "archive" | "trash" | "reply" | "keep" | "unsub" } | null;
  /** Phase 24 cross-account thread indicator: {size, accounts}. */
  threadBadge?: { size: number; accounts: string[] } | null;
  /** UX-11: in the Automated tab every row has an automated priority, so the priority-driven
   *  dimming flattens the whole view to "broken/inactive." Bump to ≥ 0.85 when in Automated. */
  inAutomatedTab?: boolean;
  onClick: () => void;
}) {
  const borderColor = PRIORITY_BORDER[email.priority];
  const rawOpacity = PRIORITY_OPACITY[email.priority];
  const opacity = inAutomatedTab ? Math.max(rawOpacity, 0.85) : rawOpacity;
  const senderName = extractSenderName(email.from);
  const badge = decisionBadgeStyle(decision);
  const relDate = formatRelativeDate(email.date);
  const isStruckThrough = email.priority === "trash" || email.priority === "unsub";
  const suspicious = isSuspiciousSender(email.from);

  // Reusable warning badge class — same shape for spoof / inject / sync / attachment
  const badgeBase = "text-[0.6rem] font-bold py-px px-1 rounded-[3px] shrink-0 border";

  return (
    <div
      onClick={onClick}
      data-email-id={email.id}
      className="py-3 px-3.5 cursor-pointer border-b border-border transition-[background] duration-100 ease-out"
      style={{
        // Per-priority left rail + selection state are dynamic — keep inline.
        borderLeft: `3px solid ${isSelected ? "var(--color-gold)" : (borderColor ?? "transparent")}`,
        background: isSelected ? "rgba(178,154,104,0.07)" : "transparent",
        opacity: isSelected ? 1 : opacity,
      }}
    >
      {/* Row 1: sender + badges (no date) */}
      <div className="flex items-center gap-[5px] mb-[3px]">
        {!email.isRead && (
          <span
            className="w-[5px] h-[5px] rounded-full shrink-0 mr-px"
            style={{ background: borderColor ?? "var(--color-gold)" }}
          />
        )}
        {email.isVip && <span className="text-[0.65rem] shrink-0">⭐</span>}
        <span
          className={`text-[0.85rem] flex-1 min-w-0 whitespace-nowrap overflow-hidden text-ellipsis ${!email.isRead ? "font-semibold" : "font-normal"} ${isStruckThrough ? "line-through" : ""}`}
          style={{ color: PRIORITY_TEXT_COLOR[email.priority] }}
        >
          {senderName}
        </span>
        {suspicious && (
          <span title="Sender domain doesn't match known brand — possible phishing" className={`${badgeBase} bg-muted-rose/15 text-muted-rose border-muted-rose/30`}>
            ⚠ spoof?
          </span>
        )}
        {injectionWarning && (
          <span title="Email body contains text attempting to manipulate AI processing — treat with caution" className={`${badgeBase} bg-muted-gold/15 text-muted-gold border-muted-gold/30`}>
            ⚠ inject?
          </span>
        )}
        {email.remoteUnreachable && (
          <span title="Remote transport unreachable — showing last rendered state" className={`${badgeBase} bg-muted-rose/15 text-muted-rose border-muted-rose/30`}>
            ⚠ sync
          </span>
        )}
        <AccountBadge account={email.account} small />
        {email.hasAttachment && (
          <span title="Has attachment" className={`${badgeBase} font-semibold bg-text-muted/[0.18] text-text-muted border-text-muted/25`}>
            📎
          </span>
        )}
        {threadBadge && (
          <span
            title={`Part of ${threadBadge.size}-email thread spanning ${threadBadge.accounts.join("+")}`}
            className={`${badgeBase} font-semibold bg-gold/15 text-gold border-gold/30`}
          >
            🔗 {threadBadge.size}
          </span>
        )}
        {senderHistoryBadge && (
          <span
            title={`Sender history: ${senderHistoryBadge.label} ${senderHistoryBadge.kind}`}
            className={`${badgeBase} font-semibold ${
              senderHistoryBadge.kind === "trash" || senderHistoryBadge.kind === "unsub" ? "bg-muted-rose/15 text-muted-rose border-muted-rose/30"
              : senderHistoryBadge.kind === "archive" ? "bg-text-muted/[0.18] text-text-muted border-text-muted/25"
              : senderHistoryBadge.kind === "reply" ? "bg-gold/15 text-gold border-gold/30"
              : "bg-success/15 text-success border-success/30"
            }`}
          >
            {senderHistoryBadge.label}
          </span>
        )}
        {decision && (
          <span
            className="text-[0.58rem] font-bold py-px px-[5px] rounded-[3px] shrink-0 tracking-[0.04em]"
            style={{ background: badge.bg, color: badge.fg }}
          >
            {decision}
          </span>
        )}
      </div>
      {/* Row 2: subject + date right-aligned */}
      <div className="flex items-baseline gap-1.5 mb-[3px]">
        <div
          className={`text-[0.78rem] whitespace-nowrap overflow-hidden text-ellipsis flex-1 min-w-0 ${!email.isRead ? "pl-3" : "pl-0"} ${isSelected ? "text-text/85" : "text-text-muted"}`}
        >
          {email.subject}
        </div>
        {relDate && (
          <span className="text-[0.60rem] text-text-muted shrink-0 opacity-60">
            {relDate}
          </span>
        )}
      </div>
      {/* Row 3: AI summary (when loaded) or raw snippet */}
      {(aiSummary || email.snippet) && (
        <div
          className={`text-[0.72rem] overflow-hidden whitespace-normal leading-[1.4] line-clamp-2 ${!email.isRead ? "pl-3" : "pl-0"} ${aiSummary ? "text-gold/75" : "text-text-muted/50"}`}
        >
          {aiSummary ? (
            <>
              <span className="text-[0.60rem] mr-[3px] opacity-90">✦</span>
              {aiSummary}
            </>
          ) : email.snippet}
        </div>
      )}
    </div>
  );
}

// ─── Phase 22: clickable suggestion → POST /api/sender/rule ───

type SenderSuggestion = { kind: "auto-archive" | "auto-trash" | "auto-unsub" | "block"; confidencePct: number } | null;

function SenderSuggestionButton({
  addrSuggestion, domainSuggestion, address, domain,
}: {
  addrSuggestion: SenderSuggestion;
  domainSuggestion: SenderSuggestion;
  address?: string;
  domain?: string;
}) {
  const [applyState, setApplyState] = useState<"idle" | "applying" | "done" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const s = addrSuggestion ?? domainSuggestion;
  if (!s) return null;
  const scope: "address" | "domain" = addrSuggestion ? "address" : "domain";

  const label = s.kind === "auto-archive" ? "Add auto-archive rule"
              : s.kind === "auto-trash"   ? "Add auto-trash rule"
              : s.kind === "auto-unsub"   ? "Add auto-unsub rule"
              :                              "Block this sender";

  async function apply() {
    if (applyState !== "idle") return;
    setApplyState("applying");
    setErrorMsg(null);
    try {
      const body: Record<string, string> = { action: s!.kind === "auto-archive" ? "archive"
                                                  : s!.kind === "auto-trash"   ? "trash"
                                                  : s!.kind === "auto-unsub"   ? "unsub"
                                                  :                              "block" };
      if (scope === "address" && address) body.address = address;
      if (scope === "domain" && domain) body.domain = domain;
      const res = await fetch("/api/sender/rule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.success) {
        setApplyState("done");
      } else {
        setApplyState("error");
        setErrorMsg(data.error ?? "Failed to add rule");
      }
    } catch (err) {
      setApplyState("error");
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  }

  if (applyState === "done") {
    return (
      <div className="text-[0.66rem] py-1 px-1.5 rounded bg-success/10 border border-success/25 text-success mt-0.5">
        ✓ Rule added — future emails will be processed automatically
      </div>
    );
  }
  return (
    <button
      onClick={apply}
      disabled={applyState === "applying"}
      className={`text-[0.66rem] py-1 px-1.5 rounded border text-left mt-0.5 ${
        applyState === "error"
          ? "bg-muted-rose/10 border-muted-rose/25 text-muted-rose cursor-pointer"
          : applyState === "applying"
            ? "bg-gold/10 border-gold/25 text-gold cursor-default opacity-60"
            : "bg-gold/10 border-gold/25 text-gold cursor-pointer hover:bg-gold/20"
      }`}
      title={`Apply ${s.kind} rule for ${scope === "address" ? address : domain}`}
    >
      {applyState === "applying" ? "Applying…" : applyState === "error" ? `× ${errorMsg ?? "Failed"}` : `✦ ${label} (${Math.round(s.confidencePct)}%)`}
    </button>
  );
}

// ─── Phase 23 v1: clickable "Create hold" button on calendar suggestion ───

// UX-2 (Phase 27.2, 2026-05-19): convert the one-shot "Create hold" button into
// a two-stage Preview → Create flow. Every field (title, start, end, location,
// description, attendees, destination calendar) is inline-editable. Empty fields
// render a "+ add <field>" affordance instead of being silently absent — per the
// Decisions-written-directly policy that hidden rows hide missing data.
type CalSuggestionInput = {
  summary: string;
  start: string | null;
  end: string | null;
  location: string | null;
  description: string | null;
  attendees: string[];
  proposedTime: string | null;
  confidence: number;
  basis: string;
};

// Convert an ISO string to the value a <input type="datetime-local"> expects
// (YYYY-MM-DDTHH:mm in local time). Returns "" when unparseable.
function isoToLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function localInputToIso(local: string): string | null {
  if (!local) return null;
  const d = new Date(local);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

// Human-readable date+time for the collapsed card preview.
function formatEventDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleString("en-US", {
    weekday: "short",
    month:   "short",
    day:     "numeric",
    year:    "numeric",
    hour:    "numeric",
    minute:  "2-digit",
    timeZoneName: "short",
  });
}

function CalendarSuggestionCard({ suggestion }: { suggestion: CalSuggestionInput }) {
  const [stage, setStage] = useState<"collapsed" | "preview" | "creating" | "done" | "error">("collapsed");
  const [eventLink, setEventLink] = useState<string | undefined>();
  const [err, setErr] = useState<string | null>(null);

  // Editable draft — seeded from the suggestion, mutated freely in the preview.
  const [summary, setSummary] = useState(suggestion.summary);
  const [start, setStart] = useState(isoToLocalInput(suggestion.start));
  const [end, setEnd] = useState(isoToLocalInput(suggestion.end));
  const [location, setLocation] = useState(suggestion.location ?? "");
  const [description, setDescription] = useState(suggestion.description ?? "");
  const [attendees, setAttendees] = useState(suggestion.attendees.join(", "));
  const [showLocation, setShowLocation] = useState(!!suggestion.location);
  const [showDescription, setShowDescription] = useState(!!suggestion.description);
  const [showAttendees, setShowAttendees] = useState(suggestion.attendees.length > 0);

  // Destination calendar picker.
  const [calendars, setCalendars] = useState<Array<{ id: string; summary: string; primary: boolean }>>([]);
  const [calendarId, setCalendarId] = useState("primary");
  useEffect(() => {
    if (stage !== "preview" || calendars.length > 0) return;
    let cancelled = false;
    fetch("/api/calendar/list")
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (cancelled || !d?.calendars) return;
        setCalendars(d.calendars);
        const primary = d.calendars.find((c: { primary: boolean }) => c.primary);
        if (primary) setCalendarId(primary.id);
      })
      .catch(() => { /* picker falls back to 'primary' */ });
    return () => { cancelled = true; };
  }, [stage, calendars.length]);

  const canCreate = summary.trim() !== "" && start !== "" && end !== "";

  async function createEvent() {
    if (!canCreate) return;
    setStage("creating"); setErr(null);
    try {
      const res = await fetch("/api/calendar/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          summary: summary.trim(),
          start: localInputToIso(start),
          end: localInputToIso(end),
          location: location.trim() || undefined,
          description: description.trim() || undefined,
          attendees: attendees.split(",").map(a => a.trim()).filter(a => a.includes("@")),
          calendarId,
        }),
      });
      const data = await res.json();
      if (data.success) { setStage("done"); setEventLink(data.htmlLink); }
      else { setStage("error"); setErr(data.error ?? "Failed to create event"); }
    } catch (e) {
      setStage("error"); setErr(e instanceof Error ? e.message : String(e));
    }
  }

  const fieldCls = "w-full py-1 px-1.5 text-[0.68rem] bg-bg border border-border rounded text-text outline-none font-sans";
  const labelCls = "text-[0.6rem] text-text-muted uppercase tracking-[0.04em]";
  const addBtnCls = "text-[0.64rem] text-gold/80 hover:text-gold cursor-pointer bg-transparent border-none p-0 text-left";

  return (
    <div className="py-1.5 px-2 rounded bg-gold/10 border border-gold/25">
      <div className="text-[0.68rem] text-gold font-medium flex items-center gap-1.5 mb-0.5">
        📅 Suggests calendar event ({Math.round(suggestion.confidence * 100)}%)
      </div>
      <div className="text-[0.62rem] text-text-muted opacity-70 italic mb-1.5">{suggestion.basis}</div>

      {stage === "done" ? (
        <div className="text-[0.66rem] text-success">
          ✓ Event created{eventLink ? <> · <a href={eventLink} target="_blank" rel="noreferrer" className="underline">open in Calendar</a></> : null}
        </div>
      ) : stage === "collapsed" ? (
        <div className="flex flex-col gap-1.5">
          {/* Read-only field preview — shows what the AI extracted so the user
              can see exactly what will be proposed before opening the edit form. */}
          <div className="rounded border border-gold/20 bg-bg/50 px-2 py-1.5 flex flex-col gap-1">
            <div className="flex gap-2 items-start">
              <span className="text-[0.57rem] text-text-muted uppercase tracking-[0.05em] w-10 shrink-0 pt-px">Title</span>
              <span className="text-[0.68rem] text-text font-medium leading-snug">{suggestion.summary}</span>
            </div>
            {suggestion.start && (
              <div className="flex gap-2 items-start">
                <span className="text-[0.57rem] text-text-muted uppercase tracking-[0.05em] w-10 shrink-0 pt-px">When</span>
                <span className="text-[0.65rem] text-text leading-snug">{formatEventDate(suggestion.start)}
                  {suggestion.end && (
                    <span className="text-text-muted"> – {formatEventDate(suggestion.end)}</span>
                  )}
                </span>
              </div>
            )}
            {suggestion.location && (
              <div className="flex gap-2 items-start">
                <span className="text-[0.57rem] text-text-muted uppercase tracking-[0.05em] w-10 shrink-0 pt-px">Where</span>
                <span className="text-[0.65rem] text-text leading-snug">{suggestion.location}</span>
              </div>
            )}
            {suggestion.description && (
              <div className="flex gap-2 items-start">
                <span className="text-[0.57rem] text-text-muted uppercase tracking-[0.05em] w-10 shrink-0 pt-px">Note</span>
                <span className="text-[0.62rem] text-text-muted italic leading-snug line-clamp-2">{suggestion.description}</span>
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={() => setStage("preview")}
            className="text-[0.66rem] py-0.5 px-2 rounded border border-gold/40 bg-gold/[0.15] text-gold cursor-pointer hover:bg-gold/25 self-start"
          >
            Review &amp; Create Event
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {/* Title */}
          <div>
            <div className={labelCls}>Title</div>
            <input value={summary} onChange={e => setSummary(e.target.value)} className={fieldCls} placeholder="Event title" />
          </div>

          {/* Start / End — always shown; required */}
          <div>
            <div className={labelCls}>Start</div>
            <input type="datetime-local" value={start} onChange={e => setStart(e.target.value)} className={fieldCls} />
            {start === "" && <div className="text-[0.6rem] text-muted-rose mt-0.5">Required — pick a start time</div>}
          </div>
          <div>
            <div className={labelCls}>End</div>
            <input type="datetime-local" value={end} onChange={e => setEnd(e.target.value)} className={fieldCls} />
            {end === "" && <div className="text-[0.6rem] text-muted-rose mt-0.5">Required — pick an end time</div>}
          </div>

          {/* Location — optional; '+ add' affordance when empty */}
          {showLocation ? (
            <div>
              <div className={labelCls}>Location</div>
              <input value={location} onChange={e => setLocation(e.target.value)} className={fieldCls} placeholder="Address, room, or video link" />
            </div>
          ) : (
            <button type="button" className={addBtnCls} onClick={() => setShowLocation(true)}>+ add location</button>
          )}

          {/* Description — optional */}
          {showDescription ? (
            <div>
              <div className={labelCls}>Description</div>
              <textarea value={description} onChange={e => setDescription(e.target.value)} className={`${fieldCls} min-h-[44px] max-h-[120px] resize-y`} placeholder="Notes / agenda" />
            </div>
          ) : (
            <button type="button" className={addBtnCls} onClick={() => setShowDescription(true)}>+ add description</button>
          )}

          {/* Attendees — optional */}
          {showAttendees ? (
            <div>
              <div className={labelCls}>Attendees</div>
              <input value={attendees} onChange={e => setAttendees(e.target.value)} className={fieldCls} placeholder="comma-separated emails" />
            </div>
          ) : (
            <button type="button" className={addBtnCls} onClick={() => setShowAttendees(true)}>+ add attendees</button>
          )}

          {/* Destination calendar */}
          <div>
            <div className={labelCls}>Calendar</div>
            <select value={calendarId} onChange={e => setCalendarId(e.target.value)} className={fieldCls}>
              {calendars.length === 0 && <option value="primary">Primary</option>}
              {calendars.map(c => (
                <option key={c.id} value={c.id}>{c.summary}{c.primary ? " (primary)" : ""}</option>
              ))}
            </select>
          </div>

          {stage === "error" && <div className="text-[0.64rem] text-muted-rose">× {err}</div>}

          <div className="flex items-center gap-1.5 mt-0.5">
            <button
              type="button"
              onClick={createEvent}
              disabled={!canCreate || stage === "creating"}
              className={`text-[0.66rem] py-0.5 px-2 rounded border border-gold/40 ${
                !canCreate || stage === "creating"
                  ? "bg-gold/[0.06] text-text-muted cursor-default opacity-60"
                  : "bg-gold/[0.15] text-gold cursor-pointer hover:bg-gold/25"
              }`}
            >
              {stage === "creating" ? "Creating…" : "Create Event"}
            </button>
            {stage !== "creating" && (
              <button
                type="button"
                onClick={() => setStage("collapsed")}
                className="text-[0.64rem] py-0.5 px-2 rounded border border-border bg-transparent text-text-muted cursor-pointer hover:text-text"
              >
                Cancel
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// Phase 28: default destination for the Receipt card's "Archive to Receipts"
// action. The exact mailbox-folder path is a per-user setting (Q16 / Phase 29
// "Paths & folders" panel); "Receipts" is the shipped default.
const RECEIPT_FOLDER = "Receipts";

// Phase 28: Receipt card — a pane-3 card parallel to CalendarSuggestionCard.
// Renders for any email classified as a receipt (type-driven, not stage-driven,
// so a VIP-staged receipt shows it too). The extracted fields are inline-
// editable; "Archive to Receipts" routes the email to the receipt mailbox
// folder. It does NOT render a PDF or write a database — that is Project 56's
// ReceiptProcessing pipeline, run later as a batch.
function ReceiptCard({
  initialVendor, initialAmount, initialDate, financialType, onArchiveToReceipts,
}: {
  initialVendor: string;
  initialAmount: string;
  initialDate: string;
  financialType: string | null;
  onArchiveToReceipts?: () => void;
}) {
  const [vendor, setVendor] = useState(initialVendor);
  const [amount, setAmount] = useState(initialAmount);
  const [date, setDate] = useState(initialDate);
  const [showVendor, setShowVendor] = useState(initialVendor !== "");
  const [showAmount, setShowAmount] = useState(initialAmount !== "");
  const [showDate, setShowDate] = useState(initialDate !== "");
  const [archived, setArchived] = useState(false);

  const fieldCls = "w-full py-1 px-1.5 text-[0.68rem] bg-bg border border-border rounded text-text outline-none font-sans";
  const labelCls = "text-[0.6rem] text-text-muted uppercase tracking-[0.04em]";
  const addBtnCls = "text-[0.64rem] text-gold/80 hover:text-gold cursor-pointer bg-transparent border-none p-0 text-left";

  return (
    <div className="py-1.5 px-2 rounded bg-gold/10 border border-gold/25">
      <div className="text-[0.68rem] text-gold font-medium flex items-center gap-1.5 mb-1">
        🧾 Receipt{financialType ? ` — ${financialType}` : ""}
      </div>
      {archived ? (
        <div className="text-[0.66rem] text-success">✓ Flagged for the Receipts folder</div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {showVendor ? (
            <div>
              <div className={labelCls}>Vendor</div>
              <input value={vendor} onChange={e => setVendor(e.target.value)} className={fieldCls} placeholder="Vendor" />
            </div>
          ) : (
            <button type="button" className={addBtnCls} onClick={() => setShowVendor(true)}>+ add vendor</button>
          )}
          {showAmount ? (
            <div>
              <div className={labelCls}>Amount</div>
              <input value={amount} onChange={e => setAmount(e.target.value)} className={fieldCls} placeholder="$0.00" />
            </div>
          ) : (
            <button type="button" className={addBtnCls} onClick={() => setShowAmount(true)}>+ add amount</button>
          )}
          {showDate ? (
            <div>
              <div className={labelCls}>Date</div>
              <input value={date} onChange={e => setDate(e.target.value)} className={fieldCls} placeholder="date" />
            </div>
          ) : (
            <button type="button" className={addBtnCls} onClick={() => setShowDate(true)}>+ add date</button>
          )}
          <button
            type="button"
            onClick={() => { onArchiveToReceipts?.(); setArchived(true); }}
            className="mt-0.5 self-start text-[0.66rem] py-0.5 px-2 rounded border border-gold/40 bg-gold/[0.15] text-gold cursor-pointer hover:bg-gold/25"
          >
            Archive to Receipts
          </button>
          <div className="text-[0.6rem] text-text-muted italic">
            Full receipt processing (PDF, vendor database) runs later via the receipt batch workflow.
          </div>
        </div>
      )}
    </div>
  );
}

// ─── AiInsightPanel — right-side AI context column ───

type InstructionStatus = { loading: boolean; results?: string[]; error?: string };
type InstructionsControl = {
  instructions: string;
  setInstructions: (v: string) => void;
  showInstructions: boolean;
  setShowInstructions: (v: boolean) => void;
  instructionStatus: InstructionStatus;
  setInstructionStatus: (s: InstructionStatus) => void;
};

function AiInsightPanel({ email, aiSummary, decision, body, instructionsControl, onArchiveToReceipts }: {
  email: ClassifiedEmail;
  aiSummary?: string;
  decision?: string;
  body: string | null;
  instructionsControl?: InstructionsControl;
  onArchiveToReceipts?: () => void;
}) {
  const bodyText = body ?? "";
  const combined = bodyText + " " + email.subject;

  // ── Fact extraction ──
  const dateMatches = [...new Set(
    bodyText.match(/\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:,?\s+\d{4})?/gi) ?? []
  )].slice(0, 3);
  const amountMatches = [...new Set(bodyText.match(/\$[\d,]+(?:\.\d{2})?/g) ?? [])].slice(0, 4);
  // UX-6 (2026-05-19): surface the actual URLs found in the body with an inferred
  // type label, instead of just rendering a count.
  const extractedUrls = [...new Set(bodyText.match(/https?:\/\/[^\s<>"'\)\]]+/g) ?? [])].slice(0, 8);
  const linkCount = extractedUrls.length;

  // ── Urgency scoring ──
  const urgencyTerms = combined.match(/\b(?:urgent|action required|respond by|deadline|expires?|confirm|verify|complete by|submit by|one.time|verification code|last chance|time.sensitive|immediately|asap)\b/gi) ?? [];
  const urgencyLevel = urgencyTerms.length >= 3 ? "high" : urgencyTerms.length >= 1 ? "medium" : "none";

  // ── Email type classification (AD-1) ──
  // The taxonomy lives in the email_types DB table — the single source of truth.
  // emailTypes is fetched once (module-cached) from /api/email-types; the pure
  // classifier from Tools/EmailTypes runs the DB-sourced detection regexes in
  // sort_order, first match wins. No hardcoded type cascade remains here.
  const [emailTypes, setEmailTypes] = useState<EmailType[]>([]);
  useEffect(() => { fetchEmailTypes().then(setEmailTypes); }, []);
  const emailType = classifyEmailType(emailTypes, email.subject, bodyText);

  // ── Phase 23: calendar suggestion (fetched when email selected) ──
  type CalSuggestion = {
    summary: string;
    start: string | null;
    end: string | null;
    location: string | null;
    description: string | null;
    attendees: string[];
    proposedTime: string | null;
    confidence: number;
    basis: string;
  } | null;
  const [calSuggestion, setCalSuggestion] = useState<CalSuggestion>(null);
  useEffect(() => {
    setCalSuggestion(null);
    if (!email.subject) return;
    let cancelled = false;
    fetch("/api/calendar/suggest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subject: email.subject, body: bodyText, emailId: email.id, fromAddress: email.fromAddress }),
    })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (!cancelled && d && d.suggestion) setCalSuggestion(d.suggestion); })
      .catch(() => { /* non-critical */ });
    return () => { cancelled = true; };
  }, [email.id, email.subject, bodyText]);

  // ── Sender trust signals ──
  const suspicious = isSuspiciousSender(email.from);
  const injectionAttempt = hasInjectionContent(bodyText);
  const hasMxPattern = /@(noreply|no-reply|donotreply|notification|alert|auto|mailer)\./i.test(email.from);
  const trustLevel = suspicious || injectionAttempt ? "low" :
    email.isUnknownSender ? "unknown" :
    hasMxPattern ? "system" : "trusted";

  // ── Sender memory (Phase 22 v0) — fetch on selection, render below trust ──
  type SHistory = {
    totalSeen: number;
    actions: { archive: number; trash: number; reply: number; defer: number; keep: number; junk: number; unsub: number; block: number; approve: number; other: number };
    mostCommonAction: string | null;
    firstSeen: string | null; lastSeen: string | null;
    isFrequent: boolean;
    suggestion: { kind: "auto-archive" | "auto-trash" | "auto-unsub" | "block"; confidencePct: number } | null;
    replyAffinity?: number;
    isReplyAffinity?: boolean;
  };
  const [senderHistory, setSenderHistory] = useState<{ address?: SHistory; domain?: SHistory } | null>(null);
  useEffect(() => {
    setSenderHistory(null);
    const params = new URLSearchParams();
    if (email.fromAddress) params.set("address", email.fromAddress);
    if (email.fromDomain) params.set("domain", email.fromDomain);
    if (params.toString().length === 0) return;
    let cancelled = false;
    fetch(`/api/sender/history?${params}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (!cancelled && d && !d.error) setSenderHistory(d); })
      .catch(() => { /* sparse data is OK — silently no-op */ });
    return () => { cancelled = true; };
  }, [email.fromAddress, email.fromDomain]);

  const trustConfig: Record<string, { label: string; color: string }> = {
    trusted:  { label: "Known sender", color: "var(--success)" },
    system:   { label: "System / automated", color: "var(--muted)" },
    unknown:  { label: "First-time sender", color: "var(--warning)" },
    low:      { label: suspicious ? "Suspicious domain" : "AI manipulation attempt", color: "var(--danger)" },
  };
  const trust = trustConfig[trustLevel];

  // ── Priority config ──
  const priorityConfig: Record<string, { label: string; color: string; action: string }> = {
    action:  { label: "Action Required", color: "var(--warning)",   action: "Reply or act" },
    review:  { label: "Needs Review",    color: "#b29a68",          action: "Review & decide" },
    unknown: { label: "New Sender",      color: "var(--muted)",     action: "Approve or Block" },
    archive: { label: "Auto-Archive",    color: "var(--success)",   action: "Archive" },
    trash:   { label: "Auto-Trash",      color: "var(--danger)",    action: "Trash" },
    unsub:   { label: "Unsubscribe",     color: "var(--danger)",    action: "Unsubscribe" },
  };
  const pCfg = priorityConfig[email.priority];

  const section = (label: string, children: ReactNode) => (
    <div className="mb-[11px]">
      <div className="text-[0.55rem] uppercase tracking-[0.08em] text-text-muted opacity-55 mb-1 font-semibold">{label}</div>
      {children}
    </div>
  );

  return (
    <div className="w-[210px] shrink-0 border-l border-border pl-3.5 text-[0.72rem] text-text-muted flex flex-col overflow-y-auto">
      {/* UX-1 (2026-05-19, Q11=a): Instructions affordance lives in the AI Insight
          Panel header — contextual placement next to the per-email actions.
          State is lifted in the parent page so instructions persist across email
          selection. Renders as the first card; the previous top-banner location
          read as decorative text. */}
      {instructionsControl && (() => {
        const ic = instructionsControl;
        const onApply = async () => {
          if (!ic.instructions.trim() || ic.instructionStatus.loading) return;
          ic.setInstructionStatus({ loading: true });
          try {
            const res = await fetch("/api/instructions", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ instructions: ic.instructions.trim() }),
            });
            const data = await res.json();
            if (data.success) ic.setInstructionStatus({ loading: false, results: data.results });
            else ic.setInstructionStatus({ loading: false, error: data.error ?? "Failed to parse instructions" });
          } catch (err) {
            ic.setInstructionStatus({ loading: false, error: err instanceof Error ? err.message : String(err) });
          }
        };
        return (
          <div className="pb-2 border-b border-border mb-2 -ml-3.5 pl-3.5 pr-3.5">
            <button
              type="button"
              onClick={() => ic.setShowInstructions(!ic.showInstructions)}
              className={`w-full py-1 border-none bg-transparent flex items-center gap-1.5 cursor-pointer text-[0.72rem] font-medium tracking-[0.03em] ${
                ic.instructions.trim() ? "text-gold" : "text-text-muted"
              }`}
              aria-expanded={ic.showInstructions}
              aria-controls="instructions-panel"
            >
              <span className="text-[0.65rem]">{ic.showInstructions ? "▾" : "▸"}</span>
              <span>+ Instructions</span>
              {ic.instructions.trim() && (
                <span className="text-[0.6rem] py-0 px-[5px] rounded-lg bg-gold/[0.12] text-gold">active</span>
              )}
            </button>
            {ic.showInstructions && (
              <div id="instructions-panel" className="pt-1">
                <textarea
                  value={ic.instructions}
                  onChange={(e) => ic.setInstructions(e.target.value)}
                  placeholder={"Freeform commands for PAI — processed before email actions.\nExamples: \"add @domain.com to junk\", \"VIP add email@x.com\", \"archive Bina's email to Bina/Archive\""}
                  className="w-full min-h-[56px] max-h-[120px] resize-y py-2 px-2.5 text-[0.74rem] leading-normal bg-bg border border-border rounded-md text-text outline-none font-sans"
                />
                <div className="mt-1.5 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={onApply}
                    disabled={!ic.instructions.trim() || ic.instructionStatus.loading}
                    className={`py-[5px] px-3.5 text-[0.74rem] font-semibold border-none rounded-[5px] ${
                      ic.instructions.trim() ? "bg-gold text-white cursor-pointer" : "bg-border text-text-muted cursor-default"
                    } ${ic.instructionStatus.loading ? "opacity-60" : "opacity-100"}`}
                  >
                    {ic.instructionStatus.loading ? "Applying…" : "Apply Rules"}
                  </button>
                  <span className="text-[0.62rem] text-text-muted">
                    AI parses your instructions and updates rules.yaml
                  </span>
                </div>
                {ic.instructionStatus.results && (
                  <div className="mt-1.5 py-1.5 px-2.5 rounded-[5px] bg-success/[0.08] border border-success/20">
                    {ic.instructionStatus.results.map((r, i) => (
                      <div key={i} className="text-[0.7rem] text-success mb-0.5">✓ {r}</div>
                    ))}
                  </div>
                )}
                {ic.instructionStatus.error && (
                  <div className="mt-1.5 py-1.5 px-2.5 rounded-[5px] bg-muted-rose/[0.08] border border-muted-rose/20 text-[0.7rem] text-danger">
                    {ic.instructionStatus.error}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })()}

      {/* Classification + decision status */}
      {section("Classification",
        <div>
          <div className="flex items-center gap-[5px]">
            <span
              className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
              style={{ background: pCfg?.color ?? "var(--muted)" }}
            />
            <span
              className="font-semibold text-[0.74rem]"
              style={{ color: pCfg?.color ?? "var(--muted)" }}
            >
              {pCfg?.label ?? email.priority}
            </span>
          </div>
          {decision ? (
            <div className="text-success mt-[3px] text-[0.68rem]">✓ Marked: {actionLabel(decision)}</div>
          ) : pCfg && (
            <div className="mt-[3px] text-[0.68rem] opacity-70">→ {pCfg.action}</div>
          )}
        </div>
      )}

      {/* Email type */}
      {emailType && section("Email Type",
        <div className="text-[0.70rem] text-text opacity-75">{emailType}</div>
      )}

      {/* Financial metadata (from V2 parse) */}
      {(email.financialType || email.financialVendor || email.financialAmount) && section("Financial Details",
        <div className="flex flex-col gap-[3px]">
          {email.financialType && (
            <div className="text-[0.68rem] flex gap-1">
              <span className="text-text-muted min-w-10">Type:</span>
              <span className="text-text opacity-80">{email.financialType}</span>
            </div>
          )}
          {email.financialVendor && (
            <div className="text-[0.68rem] flex gap-1">
              <span className="text-text-muted min-w-10">Vendor:</span>
              <span className="text-text opacity-80">{email.financialVendor}</span>
            </div>
          )}
          {email.financialAmount && (
            <div className="text-[0.68rem] flex gap-1">
              <span className="text-text-muted min-w-10">Amount:</span>
              <span className="text-success font-semibold">{email.financialAmount}</span>
            </div>
          )}
        </div>
      )}

      {/* Urgency — both 'high' and 'medium' rendered with the same muted-rose
          tint per intent (any urgency reads as warning, severity in glyph). */}
      {urgencyLevel !== "none" && section("Urgency",
        <div className="py-1 px-2 rounded bg-muted-rose/10 border border-muted-rose/25 text-muted-rose text-[0.68rem] flex items-center gap-1">
          {urgencyLevel === "high" ? "🔴" : "⚡"} {urgencyLevel === "high" ? "High urgency" : "Time-sensitive language"}
        </div>
      )}

      {/* Sender trust */}
      {section("Sender Trust",
        <div className="flex flex-col gap-[3px]">
          <div
            className="flex items-center gap-1 font-medium"
            style={{ color: trust.color }}
          >
            <span>{trustLevel === "trusted" ? "✓" : trustLevel === "system" ? "⚙" : trustLevel === "unknown" ? "👤" : "⚠"}</span>
            <span>{trust.label}</span>
          </div>
          {injectionAttempt && trustLevel !== "low" && (
            <div className="text-muted-gold text-[0.67rem]">⚠ AI manipulation attempt</div>
          )}
          {email.hasAttachment && (
            <div className="text-[0.67rem]">📎 Has attachments</div>
          )}
          {hasMxPattern && trustLevel === "system" && (
            <div className="text-[0.67rem] opacity-65">Automated sender (no-reply)</div>
          )}
        </div>
      )}

      {/* Calendar suggestion (Phase 23 v0+v1 / UX-2) */}
      {calSuggestion && (
        section("Calendar",
          <CalendarSuggestionCard suggestion={calSuggestion} />
        )
      )}

      {/* Receipt card (Phase 28) — type-driven: renders for any email classified
          a receipt, regardless of funnel stage (so a VIP-staged receipt shows it). */}
      {(emailType === "Receipt / Transaction" || !!email.financialType) && (
        section("Receipt",
          <ReceiptCard
            initialVendor={email.financialVendor ?? ""}
            initialAmount={email.financialAmount ?? ""}
            initialDate={email.date ?? ""}
            financialType={email.financialType ?? null}
            onArchiveToReceipts={onArchiveToReceipts}
          />
        )
      )}

      {/* Sender History (Phase 22 v0) */}
      {senderHistory && (senderHistory.address?.totalSeen || senderHistory.domain?.totalSeen) ? (
        section("Sender History",
          <div className="flex flex-col gap-[3px]">
            {senderHistory.address && senderHistory.address.totalSeen > 0 && (
              <div className="text-[0.68rem]">
                <span className="text-text-muted">You: </span>
                <span className="text-text opacity-85">{senderHistory.address.totalSeen} seen</span>
                {senderHistory.address.actions.archive > 0 && <span className="text-success">{" "}· {senderHistory.address.actions.archive}A</span>}
                {senderHistory.address.actions.trash   > 0 && <span className="text-muted-rose">{" "}· {senderHistory.address.actions.trash}T</span>}
                {senderHistory.address.actions.reply   > 0 && <span className="text-gold">{" "}· {senderHistory.address.actions.reply}R</span>}
                {senderHistory.address.actions.unsub   > 0 && <span className="text-muted-gold">{" "}· {senderHistory.address.actions.unsub}U</span>}
              </div>
            )}
            {senderHistory.domain && senderHistory.domain.totalSeen > (senderHistory.address?.totalSeen ?? 0) && (
              <div className="text-[0.66rem] opacity-70">
                <span className="text-text-muted">Domain: </span>
                <span>{senderHistory.domain.totalSeen} seen across senders</span>
              </div>
            )}
            {senderHistory.address?.isReplyAffinity && (
              <div className="text-[0.66rem] text-gold flex items-center gap-1 mt-0.5">
                📨 You usually reply ({senderHistory.address.actions.reply} of {senderHistory.address.actions.reply + senderHistory.address.actions.archive + senderHistory.address.actions.trash + senderHistory.address.actions.keep})
              </div>
            )}
            <SenderSuggestionButton
              addrSuggestion={senderHistory.address?.suggestion ?? null}
              domainSuggestion={senderHistory.domain?.suggestion ?? null}
              address={email.fromAddress}
              domain={email.fromDomain}
            />
          </div>
        )
      ) : senderHistory ? (
        section("Sender History",
          <div className="text-[0.66rem] text-text-muted opacity-70">No prior decisions on this sender.</div>
        )
      ) : null}

      {/* Dates */}
      {dateMatches.length > 0 && section("Dates Mentioned",
        <div className="flex flex-col gap-0.5">
          {dateMatches.map((d, i) => <div key={i} className="text-[0.68rem]">📅 {d}</div>)}
        </div>
      )}

      {/* Amounts */}
      {amountMatches.length > 0 && section("Amounts",
        <div className="flex flex-col gap-0.5">
          {amountMatches.map((a, i) => <div key={i} className="text-[0.68rem]">💵 {a}</div>)}
        </div>
      )}

      {/* Links — each URL with an inferred type label (UX-6) */}
      {linkCount > 0 && section("Links",
        <div className="flex flex-col gap-[3px]">
          {extractedUrls.map((u) => {
            const label = inferLinkType(u);
            const host = (() => { try { return new URL(u).host; } catch { return u.slice(0, 40); } })();
            return (
              <div key={u} className="text-[0.66rem] flex items-baseline gap-1.5">
                <a href={u} target="_blank" rel="noreferrer" className="underline text-text-muted hover:text-text truncate" title={u}>{host}</a>
                {label && <span className="text-[0.6rem] text-muted-gold whitespace-nowrap">({label})</span>}
              </div>
            );
          })}
        </div>
      )}

      {/* Matched rule */}
      {email.matchedRule && section("Matched Rule",
        <div className="text-[0.67rem] font-mono bg-border py-0.5 px-1.5 rounded-[3px] text-text-muted">
          {email.matchedRule}
        </div>
      )}
    </div>
  );
}

// ─── EmailDetailPanel — Tasks 7.6, 7.10, 7.11 ───

function EmailDetailPanel({
  email,
  decision,
  replyDraft,
  editingReply,
  aiSummary,
  aiActions,
  onSetDecision,
  onSetReplyDraft,
  onSetEditingReply,
  onLoadAiSummary,
  onLoadDraft,
  onSendReply,
  onOpenInClient,
  replyRef,
  folderOverride,
  onSetFolderOverride,
  cachedBody,
  instructionsControl,
  onUpdateEmailId,
}: {
  email: ClassifiedEmail;
  decision?: string;
  replyDraft?: string;
  editingReply: boolean;
  aiSummary?: string;
  aiActions?: { executed: string[]; message: string };
  onSetDecision: (code: string) => void;
  onSetReplyDraft: (text: string) => void;
  onSetEditingReply: (value: boolean) => void;
  onLoadAiSummary: () => Promise<void>;
  onLoadDraft: (context?: string) => Promise<void>;
  onSendReply: () => Promise<void>;
  onOpenInClient: () => void;
  replyRef: RefObject<HTMLTextAreaElement | null>;
  folderOverride?: string;
  onSetFolderOverride: (folder: string) => void;
  cachedBody?: string;
  instructionsControl?: InstructionsControl;
  onUpdateEmailId?: (oldId: string, newId: string) => void;
}) {
  const [body, setBody] = useState<string | null>(null);
  const [bodyLoading, setBodyLoading] = useState(false);
  const [bodyExpanded, setBodyExpanded] = useState(false);
  // UX-10: email was 404 from its expected mailbox — moved/trashed/deleted outside the UI.
  const [moved, setMoved] = useState(false);
  const [folders, setFolders] = useState<Array<{ name: string; account: string | null; depth: number; parent: string | null; displayLabel: string }>>([]);
  const [foldersLoaded, setFoldersLoaded] = useState(false);
  const [folderSearch, setFolderSearch] = useState("");
  const [snippets, setSnippets] = useState<Array<{ id: string; label: string; text: string }>>([]);
  const [snippetsLoaded, setSnippetsLoaded] = useState(false);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [draftLoading, setDraftLoading] = useState(false);
  const [hoveredBtn, setHoveredBtn] = useState<string | null>(null);

  useEffect(() => {
    setBody(null);
    setBodyExpanded(false); // collapse body on each new email
    setMoved(false);
    if (!email?.id) return;

    // Use cached body if available (prefetched), otherwise fetch
    if (cachedBody) {
      setBody(cachedBody);
      return;
    }

    setBodyLoading(true);
    const mb = mailboxUnifiedPathForEmail(email);
    const params = new URLSearchParams();
    if (mb) params.set("mailbox", mb);
    if (email.subject) params.set("subject", email.subject);
    if (email.fromAddress) params.set("from", email.fromAddress);
    const qs = params.toString() ? `?${params.toString()}` : "";
    fetch(`/api/email/${email.id}${qs}`)
      .then(async (r) => {
        // UX-10 (2026-05-19): if the email is gone from its expected mailbox
        // (moved/trashed/deleted via Mail.app while the UI still shows the row),
        // the transport call 404s or returns an "Email ID not found" error.
        // Surface that as a moved-banner state instead of rendering "Error: \u2026".
        const data = await r.json().catch(() => ({}));
        
        // If the ID was shifted and resolved successfully by the backend, update it
        if (data.id && data.id !== email.id && onUpdateEmailId) {
          onUpdateEmailId(email.id, data.id);
        }

        const looksMoved =
          r.status === 404
          || (typeof data.error === "string" && /not found/i.test(data.error));
        if (looksMoved) {
          setMoved(true);
          setBody(null);
          return;
        }
        const raw = data.body ?? data.error ?? "No body available";
        setBody(
          raw
            .replace(/\r\n/g, "\n")
            .replace(/[\uFFFC\uFFFD]/g, "")   // strip image placeholder chars from HTML email conversion
            .replace(/\n{3,}/g, "\n\n")
            .trim()
        );
      })
      .catch((e) => setBody(`Error: ${e.message}`))
      .finally(() => setBodyLoading(false));
  }, [email?.id, email?.funnelStage, email?.account, cachedBody]);

  const showFolderPicker = decision === "A" || email.priority === "archive";

  useEffect(() => {
    if (!showFolderPicker || foldersLoaded) return;
    fetch("/api/folders")
      .then((r) => r.json())
      .then((data) => { if (Array.isArray(data.folders)) setFolders(data.folders); })
      .catch(() => {})
      .finally(() => setFoldersLoaded(true));
  }, [showFolderPicker, foldersLoaded]);

  const showReplyEditor = editingReply || decision === "R" || !!replyDraft;

  // Load snippets when reply editor opens — Task 7.11
  useEffect(() => {
    if (!showReplyEditor || snippetsLoaded) return;
    fetch("/api/snippets")
      .then((r) => r.json())
      .then((data) => { if (Array.isArray(data.snippets)) setSnippets(data.snippets); })
      .catch(() => {})
      .finally(() => setSnippetsLoaded(true));
  }, [showReplyEditor, snippetsLoaded]);

  // UX-3: auto-load the AI summary only when the auto-generation criteria are
  // met (eligible priority/stage AND body >= 240 chars AND subject doesn't
  // convey the full ask). Depends on `body` too, since body loads async — the
  // effect re-checks once the body arrives. handleGetSummary is idempotent
  // (guards on summaryLoading / aiSummary) so the re-run is safe.
  useEffect(() => {
    if (!shouldAutoSummary || aiSummary) return;
    void handleGetSummary();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [email?.id, body]);

  const handleGetSummary = async () => {
    if (summaryLoading || aiSummary) return;
    setSummaryLoading(true);
    try {
      await onLoadAiSummary();
    } finally {
      setSummaryLoading(false);
    }
  };

  const [draftError, setDraftError] = useState<string | null>(null);
  const [draftContext, setDraftContext] = useState("");

  const handleGetDraft = async () => {
    if (draftLoading || replyDraft) return;
    setDraftLoading(true);
    setDraftError(null);
    onSetEditingReply(true);
    try {
      await onLoadDraft(draftContext);
    } catch (e) {
      setDraftError(e instanceof Error ? e.message : "Draft failed");
    } finally {
      setDraftLoading(false);
    }
  };

  const senderName = extractSenderName(email.from);
  // UX-3 (Phase 27.3): summary eligibility — which emails CAN show a summary
  // (manual button or auto). `review` joined action/unknown; Stage 5/6
  // (bulk_dispose / auto_processed) are excluded entirely — a one-line marketing
  // blast or an already-rule-handled email does not warrant an AI summary.
  const needsAiSummary =
    (email.priority === "action" || email.priority === "review" || email.priority === "unknown")
    && email.funnelStage !== "bulk_dispose"
    && email.funnelStage !== "auto_processed";
  // UX-3 auto-generation criteria: eligible AND body >= 240 chars AND the
  // subject doesn't already convey the full ask. Below the bar the user can
  // still summon a summary via the manual "✦ AI Summary" button.
  const shouldAutoSummary =
    needsAiSummary
    && (body?.length ?? 0) >= 240
    && !subjectConveysFullAsk(email.subject, body ?? "");

  // Action buttons — context-aware based on email priority
  // Unknown senders: AP (Approve) and BL (Block) are primary actions
  // All others: Archive/Trash are primary, Reply/Defer secondary
  const isUnknown = email.priority === "unknown";

  // Derive AI-suggested action from priority for the recommendation banner
  const aiSuggestedCode: string | null =
    email.priority === "archive" ? "A" :
    email.priority === "trash"   ? "T" :
    email.priority === "unsub"   ? "U" :
    email.priority === "unknown" ? "AP" :
    null;

  const actionButtons = isUnknown
    ? [
        { code: "AP", label: "Approve",      key: "p",     color: "var(--success)", primary: true },
        { code: "BL", label: "Block",         key: "b",     color: "var(--danger)",  primary: true },
        { code: "T",  label: "Trash",         key: "t",     color: "var(--danger)",  primary: false },
        { code: "A",  label: "Archive",       key: "a",     color: "#b29a68",        primary: false },
        { code: "U",  label: "Unsub",         key: "u",     color: "var(--danger)",  primary: false },
      ]
    : [
        { code: "A",  label: "Archive",       key: "a",     color: "#b29a68",        primary: true  },
        { code: "T",  label: "Trash",         key: "t",     color: "var(--danger)",  primary: true  },
        { code: "R",  label: "Reply",         key: "r",     color: "var(--success)", primary: false },
        { code: "D",  label: "Defer",         key: "d",     color: "var(--warning)", primary: false },
        { code: "K",  label: "Keep",          key: "space", color: "var(--muted)",   primary: false },
        { code: "U",  label: "Unsub",         key: "u",     color: "var(--danger)",  primary: false },
      ];

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Compact fixed header — sender, subject, inline meta */}
      <div className="pt-3 pb-2.5 px-6 border-b border-border bg-surface shrink-0">
        {/* Row 1: Sender + badges */}
        <div className="flex items-center gap-2 mb-[3px]">
          {email.isVip && <span className="text-[0.7rem]">⭐</span>}
          <span className="text-[0.95rem] font-semibold text-text flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
            {senderName}
          </span>
          <AccountBadge account={email.account} />
          <span
            className="text-[0.65rem] py-0.5 px-[7px] rounded font-semibold"
            style={{
              background: PRIORITY_BADGE_BG[email.priority],
              color: PRIORITY_BORDER[email.priority] ?? "var(--text-muted)",
            }}
          >
            {email.priority}
          </span>
          {decision && (
            <span
              className="text-[0.65rem] font-semibold py-0.5 px-[7px] rounded"
              style={(() => { const s = decisionBadgeStyle(decision); return { background: s.bg, color: s.fg }; })()}
            >
              → {actionLabel(decision)}
            </span>
          )}
        </div>
        {/* Row 2: Subject */}
        <div className="text-[0.88rem] font-medium text-text mb-1 leading-snug">
          {email.subject}
        </div>
        {/* Row 3: Compact inline meta */}
        <div className="flex items-center gap-1.5 text-[0.67rem] text-text-muted flex-wrap">
          <span className="max-w-[220px] overflow-hidden text-ellipsis whitespace-nowrap opacity-80">{email.fromAddress}</span>
          <span className="opacity-40">·</span>
          <span className="opacity-70">{formatRelativeDate(email.date)}</span>
          {email.hasAttachment && <span>📎</span>}
          {email.funnelStage && (
            <span className="py-px px-[5px] rounded-[3px] bg-gold/[0.08] text-gold/60 font-medium capitalize">{email.funnelStage.replace(/_/g, " ")}</span>
          )}
          {email.isUnknownSender && (
            <span className="py-px px-[5px] rounded-[3px] bg-border text-text-muted">Unknown sender</span>
          )}
          {email.matchedRule && (
            <span className="py-px px-[5px] rounded-[3px] bg-border text-text-muted font-mono">{email.matchedRule}</span>
          )}
        </div>
      </div>

      {/* Scrollable content area */}
      <div className="flex-1 overflow-y-auto pt-3 pb-3 pl-6 pr-5 flex flex-col gap-2.5">

        {/* Two-column: body (left, AI summary on top) + AI panel (right).
            Layout (2026-05-19): the AI summary used to be a full-width banner
            ABOVE this two-column row, so a long (now dynamic-length, per UX-3)
            summary pushed the right-hand AiInsightPanel down. It now lives
            INSIDE the body column, so pane 3 keeps a fixed vertical origin
            regardless of summary length. */}
        <div className="flex gap-4 flex-1 min-h-0">
          {/* Email body — collapsed by default, expand on demand */}
          <div className="flex-1 min-w-0 transition-opacity duration-150">

            {/* AI summary — confined to pane 2 (the body column).
                The summary text caps at ~10 lines (max-h-[12.75rem] ≈ 10 ×
                0.85rem × 1.5 line-height) and scrolls internally beyond that.
                Below 10 lines it flows naturally with no scrollbar; the cap
                only bites on rare outliers, keeping the body text from being
                shoved far down. The "✦ AI Summary" label stays pinned above
                the scroll region. */}
            {needsAiSummary && aiSummary && (
              <div className="mb-2.5 py-2.5 px-3.5 rounded-[7px] bg-gold/[0.08] border border-gold/[0.22]">
                <div className="text-[0.58rem] font-bold tracking-[0.08em] uppercase text-gold mb-1 opacity-80">
                  ✦ AI Summary
                </div>
                <div className="text-[0.85rem] text-text/90 leading-[1.5] font-normal max-h-[12.75rem] overflow-y-auto">
                  {aiSummary}
                </div>
              </div>
            )}
            {needsAiSummary && !aiSummary && (
              <button
                onClick={handleGetSummary}
                disabled={summaryLoading}
                className={`mb-2.5 py-[3px] px-[9px] text-[0.68rem] border border-border rounded bg-transparent ${
                  summaryLoading ? "text-text-muted cursor-default opacity-60" : "text-gold cursor-pointer"
                }`}
              >
                {summaryLoading ? "Summarizing…" : "✦ AI Summary"}
              </button>
            )}
            {/* UX-10 (2026-05-19): banner when the email was 404 from its expected mailbox —
                moved/trashed/deleted in Mail.app outside the UI. Pre-fix, the body pane just
                read "Error: …" or "Email ID not found" with no actionable guidance. */}
            {moved && (
              <div className="mb-2 py-1.5 px-2.5 rounded border border-muted-rose/40 bg-muted-rose/[0.08] text-[0.7rem] text-muted-rose">
                <div className="font-semibold mb-0.5">⚠ Moved or deleted since triage</div>
                <div className="opacity-90">This email isn&apos;t in its expected mailbox anymore — likely moved or deleted in Mail.app since the triage was generated. The row is stale; you can dismiss it from the list with Keep or Trash, then regenerate the triage to resync.</div>
              </div>
            )}
            {(() => {
              const fullText = body ?? email.snippet ?? "No preview available";
              const paragraphs = fullText.split(/\n{2,}/).filter(Boolean);
              const PREVIEW_PARAS = 4;
              const previewParas = paragraphs.slice(0, PREVIEW_PARAS);
              const hasMore = paragraphs.length > PREVIEW_PARAS;
              const visibleParas = bodyExpanded ? paragraphs : previewParas;

              return (
                <div>
                  <div className="font-sans break-words">
                    {visibleParas.map((para, i) => (
                      <p key={i} className="mt-0 mb-[7px] mx-0 text-[0.87rem] leading-[1.6] text-text">
                        {para.split("\n").map((line, j, arr) => (
                          <Fragment key={j}>{line}{j < arr.length - 1 && <br />}</Fragment>
                        ))}
                      </p>
                    ))}
                  </div>
                  {hasMore && !bodyLoading && (
                    <button
                      onClick={() => setBodyExpanded(!bodyExpanded)}
                      className="mt-1 py-[3px] px-2.5 text-[0.70rem] border border-border rounded bg-transparent text-text-muted cursor-pointer opacity-70"
                    >
                      {bodyExpanded
                        ? "↑ Collapse"
                        : `↓ Show full email (${paragraphs.length - PREVIEW_PARAS} more section${paragraphs.length - PREVIEW_PARAS !== 1 ? "s" : ""})`}
                    </button>
                  )}
                  {bodyLoading && (
                    <div className="mt-1.5 text-[0.72rem] text-text-muted opacity-70">
                      Loading full email…
                    </div>
                  )}
                </div>
              );
            })()}
          </div>

          {/* AI Insight Panel — right column */}
          <AiInsightPanel
            email={email}
            aiSummary={aiSummary}
            decision={decision}
            body={body}
            instructionsControl={instructionsControl}
            onArchiveToReceipts={() => {
              // Phase 28: route the receipt to the receipt mailbox folder via
              // the existing archive mechanism — folder override + Archive
              // decision. No PDF / DB work (that is Project 56).
              onSetFolderOverride(RECEIPT_FOLDER);
              onSetDecision("A");
            }}
          />
        </div>

        {/* Folder picker */}
        {showFolderPicker && (() => {
          const filterQuery = folderSearch.toLowerCase().trim();
          const filteredFolders = filterQuery
            ? folders.filter((f) => f.displayLabel.toLowerCase().includes(filterQuery))
            : folders;
          const selectedFolder = folderOverride ?? email.folder ?? "";
          return (
            <div>
              <div className="text-[0.68rem] text-text-muted mb-1.5 font-medium tracking-[0.04em] uppercase flex items-center gap-2">
                Archive to folder
                {email.folder && <span className="text-gold text-[0.65rem] normal-case tracking-normal">(suggested: {email.folder})</span>}
              </div>
              {/* Search input + suggested quick-select */}
              <div className="flex gap-1.5 mb-1">
                {email.folder && (
                  <button
                    onClick={() => { onSetFolderOverride(email.folder!); setFolderSearch(""); }}
                    className={`py-1 px-2.5 text-[0.72rem] rounded-[5px] shrink-0 cursor-pointer border ${
                      selectedFolder === email.folder
                        ? "border-gold bg-gold/[0.12] text-gold"
                        : "border-border bg-surface text-text-muted"
                    }`}
                  >
                    {email.folder}
                  </button>
                )}
                <input
                  type="text"
                  placeholder="Search folders…"
                  value={folderSearch}
                  onChange={(e) => setFolderSearch(e.target.value)}
                  className="flex-1 py-1 px-2 text-[0.72rem] bg-bg border border-border rounded-[5px] text-text outline-none"
                />
              </div>
              {/* Filtered folder list */}
              {(folderSearch || !selectedFolder) && filteredFolders.length > 0 && (
                <div className="max-h-[140px] overflow-y-auto border border-border rounded-[5px] bg-surface">
                  {filteredFolders.map((f) => {
                    const isSubfolder = f.depth === 2;
                    const leafName = isSubfolder && f.name.includes("/") ? f.name.split("/").pop()! : f.name;
                    const isSelected = selectedFolder === f.name;
                    return (
                      <div
                        key={f.displayLabel}
                        onClick={() => { onSetFolderOverride(f.name); setFolderSearch(""); }}
                        className={`text-[0.72rem] cursor-pointer flex justify-between items-center ${
                          isSubfolder ? "pt-[3px] pb-[3px] pl-[22px] pr-2.5 ml-2.5 border-l-2 border-gold/20" : "py-1 px-2.5"
                        } ${
                          isSelected ? "bg-gold/[0.12] text-gold"
                          : isSubfolder ? "bg-black/[0.08] text-text-muted"
                          : "bg-transparent text-text"
                        }`}
                      >
                        <span>
                          {isSubfolder && <span className="text-gold/40 mr-1">↳</span>}
                          {leafName}
                        </span>
                        <span className="text-[0.60rem] text-text-muted opacity-70">
                          {isSubfolder && f.parent ? `${f.parent} / ` : ""}{f.account ?? ""}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
              {selectedFolder && !folderSearch && (
                <div className="mt-1.5 py-[5px] px-2.5 rounded-[5px] bg-gold/[0.08] border border-gold/20 text-[0.72rem] text-gold flex items-center justify-between">
                  <span>→ <strong>{selectedFolder}</strong></span>
                  <span className="text-[0.65rem] text-text-muted cursor-pointer" onClick={() => setFolderSearch(" ")}>change</span>
                </div>
              )}
              {email.priority === "archive" && !decision && selectedFolder && (
                <div className="mt-1.5 py-[7px] px-3 rounded-md bg-gold/[0.08] border border-gold/20 text-[0.75rem] text-gold flex items-center gap-2">
                  <span>✓</span>
                  <span>Will archive to <strong>{selectedFolder}</strong>. Press <kbd className="bg-gold/15 py-0 px-[5px] rounded-[3px] font-mono">j</kbd> to continue.</span>
                </div>
              )}
            </div>
          );
        })()}

        {/* Reply editor with snippets — Task 7.11 */}
        {showReplyEditor && (
          <div>
            {/* Snippet starters */}
            {snippets.length > 0 && (
              <div className="mb-[7px] flex flex-wrap gap-1">
                {snippets.map((s) => (
                  <button
                    key={s.id}
                    title={s.text}
                    onClick={() => {
                      const area = replyRef.current;
                      if (!area) return;
                      const start = area.selectionStart ?? 0;
                      const end = area.selectionEnd ?? 0;
                      const current = area.value;
                      const newVal = current.slice(0, start) + s.text + current.slice(end);
                      onSetReplyDraft(newVal);
                      onSetEditingReply(true);
                      setTimeout(() => {
                        area.focus();
                        area.selectionStart = area.selectionEnd = start + s.text.length;
                      }, 0);
                    }}
                    className="py-0.5 px-2 text-[0.67rem] border border-border rounded bg-text-muted/[0.08] text-text-muted cursor-pointer whitespace-nowrap"
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            )}
            <div className="flex items-center justify-between mb-[5px]">
              <div className="text-[0.68rem] text-text-muted font-medium tracking-[0.04em] uppercase">
                Reply draft
              </div>
              {!replyDraft && (
                <div className="flex gap-[5px] items-center">
                  <input
                    type="text"
                    placeholder="Context for AI…"
                    value={draftContext}
                    onChange={(e) => setDraftContext(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleGetDraft(); } }}
                    className="py-[3px] px-2 text-[0.72rem] border border-border rounded bg-bg text-text outline-none w-40"
                  />
                  <button
                    onClick={handleGetDraft}
                    disabled={draftLoading}
                    className={`py-[3px] px-2.5 text-[0.72rem] border border-success/[0.35] rounded whitespace-nowrap flex items-center gap-1 ${
                      draftLoading
                        ? "bg-success/[0.06] text-text-muted cursor-default"
                        : "bg-success/[0.12] text-success cursor-pointer"
                    }`}
                  >
                    {draftLoading ? "Drafting…" : "✦ Draft Reply"}
                  </button>
                </div>
              )}
            </div>
            {draftError && (
              <div className="text-[0.7rem] text-danger mb-1 py-[3px] px-1.5 bg-muted-rose/[0.08] rounded">
                {draftError}
              </div>
            )}
            {/* PAI Actions panel — shown when Claude executed tools */}
            {aiActions && (aiActions.executed.length > 0 || aiActions.message) && (
              <div className="mb-[7px] py-2 px-2.5 rounded-md bg-gold/[0.07] border border-gold/[0.22]">
                {aiActions.executed.filter(a => a !== "Reply draft prepared").map((action, i) => (
                  <div key={i} className="text-[0.71rem] text-gold flex items-center gap-[5px] mb-0.5">
                    <span>✓</span><span>{action}</span>
                  </div>
                ))}
                {aiActions.message && (
                  <div className={`text-[0.71rem] text-text-muted italic ${aiActions.executed.length > 0 ? "mt-1" : "mt-0"}`}>
                    {aiActions.message}
                  </div>
                )}
              </div>
            )}
            <textarea
              ref={replyRef}
              value={replyDraft ?? ""}
              onChange={(e) => onSetReplyDraft(e.target.value)}
              onFocus={() => onSetEditingReply(true)}
              placeholder="Type your reply…"
              className="w-full min-h-[200px] py-2.5 px-3 bg-bg border border-border rounded-md text-text text-[0.82rem] leading-[1.55] resize-y outline-none font-[inherit] box-border"
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  onSetEditingReply(false);
                  (e.target as HTMLTextAreaElement).blur();
                }
              }}
            />
            {replyDraft && replyDraft.trim() && (
              <div className="flex gap-2 mt-1.5">
                <button
                  onClick={onSendReply}
                  className="py-[7px] px-[18px] text-[0.82rem] font-semibold bg-success text-white border-none rounded-md cursor-pointer flex items-center gap-1.5"
                >
                  Send Reply
                </button>
                <span className="text-[0.7rem] text-text-muted self-center">
                  Sends reply, archives email, and advances to next
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Sticky action bar — pinned to bottom, so eye lands here after reading */}
      <div className="border-t border-border bg-surface shrink-0">
        {/* AI recommendation banner */}
        {aiSuggestedCode && !decision && (
          <div className="py-[5px] px-6 border-b border-border bg-gold/[0.04] text-[0.72rem] text-gold/70 flex items-center gap-2">
            <span className="opacity-60 text-[0.60rem] uppercase tracking-[0.06em] font-semibold">AI suggests</span>
            <span className="font-semibold text-gold">{actionLabel(aiSuggestedCode)}</span>
            <span className="opacity-50">·</span>
            <span className="opacity-55">
              press <kbd className="bg-gold/15 py-0 px-1 rounded-[3px] font-mono text-[0.68rem]">{actionButtons.find(b => b.code === aiSuggestedCode)?.key ?? "e"}</kbd> to confirm
            </span>
          </div>
        )}
        <div className="py-2.5 px-6 flex gap-[7px] flex-wrap items-center">
          <OpenInClientButton onClick={onOpenInClient} />
          {actionButtons.map((btn) => {
            const isActive = decision === btn.code;
            const isHovered = hoveredBtn === btn.code;
            const isSuggested = aiSuggestedCode === btn.code && !decision;
            // Dynamic per-button accent color (btn.color is per-action: success
            // for archive, danger for trash, etc.) — kept inline because there
            // are 9 buttons × 4 states = 36 color/shade combinations and the
            // per-action color is parameterized via the actionButtons map.
            const layoutSize = btn.primary ? "py-2 px-5 text-[0.83rem]" : "py-1.5 px-[13px] text-[0.74rem]";
            const weight = isActive ? "font-bold" : btn.primary ? "font-semibold" : "font-normal";
            return (
              <button
                key={btn.code}
                onClick={() => onSetDecision(btn.code)}
                onMouseEnter={() => setHoveredBtn(btn.code)}
                onMouseLeave={() => setHoveredBtn(null)}
                title={`[${btn.key}] ${btn.label}`}
                className={`${layoutSize} ${weight} border rounded-md cursor-pointer transition-all duration-[120ms] ease-out flex items-center gap-1.5`}
                style={{
                  borderColor: isActive || isSuggested || isHovered ? btn.color : "var(--border)",
                  background: isActive ? actionBtnBg(btn.color)
                    : isSuggested ? `${actionBtnBg(btn.color)}60`
                    : isHovered ? `${actionBtnBg(btn.color)}80`
                    : "var(--surface)",
                  color: isActive || isSuggested || isHovered ? btn.color : "var(--muted)",
                  boxShadow: isActive ? `0 0 0 1px ${btn.color}40`
                    : isSuggested ? `0 0 0 1px ${btn.color}30`
                    : isHovered ? `0 1px 4px rgba(0,0,0,0.25)`
                    : "none",
                }}
              >
                <kbd
                  className="text-[0.60rem] font-mono py-px px-1 rounded-[3px] border leading-snug"
                  style={{
                    background: isActive || isSuggested ? `${btn.color}25` : "rgba(128,128,128,0.15)",
                    color: isActive || isSuggested ? btn.color : "var(--muted)",
                    borderColor: isActive || isSuggested ? `${btn.color}40` : "rgba(128,128,128,0.2)",
                  }}
                >
                  {btn.key}
                </kbd>
                {btn.label}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ─── StatusBar ───

function StatusBar({
  onProcessMarked,
  onProcessAll,
  isExecuting,
  markedCount,
  executionResult,
  onShowHelp,
}: {
  onProcessMarked: () => void;
  onProcessAll: () => void;
  isExecuting: boolean;
  markedCount: number;
  executionResult: AppState["executionResult"];
  onShowHelp: () => void;
}) {
  // Keyboard shortcut pill renderer
  const Shortcut = ({ keys, label }: { keys: string; label: string }) => (
    <span className="flex items-center gap-[5px] text-text/75">
      <kbd className="bg-white/10 border border-white/[0.18] border-b-2 border-b-white/[0.12] py-0.5 px-2 rounded-[5px] text-[0.78rem] font-mono font-semibold text-text/90 leading-normal tracking-[0.02em] whitespace-nowrap">
        {keys}
      </kbd>
      <span className="text-[0.74rem] opacity-70">{label}</span>
    </span>
  );

  return (
    <footer className="bg-charcoal/95 border-t border-white/[0.08] py-[7px] px-4 flex items-center justify-between shrink-0 gap-3">
      {/* Keyboard shortcuts — prominent */}
      <div className="flex gap-[14px] flex-wrap items-center">
        <Shortcut keys="j / k" label="navigate" />
        <Shortcut keys="a" label="archive" />
        <Shortcut keys="t" label="trash" />
        <Shortcut keys="r" label="reply" />
        <Shortcut keys="p" label="approve" />
        <Shortcut keys="b" label="block" />
        <Shortcut keys="u" label="unsub" />
        <Shortcut keys="d" label="defer" />
        <Shortcut keys="f" label="follow-up" />
        <Shortcut keys="o" label="open" />
        <Shortcut keys="space" label="keep" />
        <span className="opacity-25 text-[0.8rem]">|</span>
        <button
          onClick={onShowHelp}
          className="bg-white/[0.07] border border-white/15 border-b-2 border-b-white/10 rounded-[5px] py-0.5 px-2 text-[0.78rem] font-semibold text-text/90 cursor-pointer font-mono"
          title="View all shortcuts"
        >
          ?
        </button>
      </div>

      {/* Right side: results + process buttons */}
      <div className="flex items-center gap-2 shrink-0">
        {executionResult && (
          <span className="text-success text-[0.73rem]">
            ✓ {executionResult.total} processed
          </span>
        )}
        <button
          onClick={onProcessMarked}
          disabled={isExecuting || markedCount === 0}
          className={`py-[5px] px-[13px] text-[0.76rem] font-medium border border-border rounded-[5px] bg-surface ${
            isExecuting || markedCount === 0
              ? "text-text-muted cursor-not-allowed"
              : "text-text cursor-pointer"
          } ${markedCount === 0 ? "opacity-50" : "opacity-100"}`}
        >
          Process Marked{markedCount > 0 ? ` (${markedCount})` : ""}
        </button>
        <button
          onClick={onProcessAll}
          disabled={isExecuting}
          className={`py-[5px] px-[14px] text-[0.76rem] font-semibold border-none rounded-[5px] transition-all duration-150 ease-out ${
            isExecuting
              ? "bg-border text-text-muted cursor-not-allowed"
              : "bg-gold text-white cursor-pointer"
          }`}
        >
          {isExecuting ? "Processing…" : "Process All ⌘↵"}
        </button>
      </div>
    </footer>
  );
}

// ─── Analytics Panel — Task 9.6 ───

interface AnalyticsData {
  period: { days: number; start: string; end: string };
  sessions: { total: number; avgEmails: number; avgDurationSec: number };
  actionDistribution: { archived: number; trashed: number; replied: number; kept: number; unsubscribed: number; blocked: number };
  junkRate: { current: number; trend: number };
  topSenders: Array<{ sender: string; count: number; lastSeen: string }>;
  weeklyTrend: Array<{ week: string; total: number; autoProcessed: number; junkRate: number }>;
}

interface AutonomousScanData {
  scanned: number;
  recommendations: Array<{ emailId: string; fromAddress: string; action: "A" | "T" | "U"; confidence: number; basis: string; reason: string }>;
  skipped: { vip: number; nonExecutableAction: number; lowConfidence: number; weakSampleSize: number };
}

function AnalyticsPanel() {
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [autoScan, setAutoScan] = useState<AutonomousScanData | null>(null);
  // Active Rules was removed from Analytics in Phase 29 — rule management now
  // lives in Settings → Routing rules (it is configuration, not analytics).

  useEffect(() => {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
    fetch("/api/autonomous-scan", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date: today }),
    })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d && d.result) setAutoScan(d.result); })
      .catch(() => { /* non-critical */ });
  }, []);

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetch(`/api/analytics?days=${days}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.error) setError(d.error);
        else setData(d);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [days]);

  const fmtDuration = (sec: number) => {
    if (sec < 60) return `${sec}s`;
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
  };

  // Shared utility classes (replaces the old React.CSSProperties helpers).
  const card = "bg-surface border border-border rounded-lg py-3.5 px-4 min-w-[140px]";
  const cardLabel = "text-[0.62rem] text-text-muted uppercase tracking-[0.05em] mb-1";
  const cardValue = "text-[1.4rem] font-bold text-text";
  const th = "text-left py-1.5 px-2.5 border-b border-border text-text-muted text-[0.65rem] uppercase tracking-[0.04em]";
  const td = "py-1.5 px-2.5 border-b border-border text-text";

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-text-muted">
        Loading analytics...
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center text-danger">
        Error: {error}
      </div>
    );
  }
  if (!data) return null;

  const dist = data.actionDistribution;
  const distTotal = dist.archived + dist.trashed + dist.replied + dist.kept + dist.unsubscribed + dist.blocked;

  const barRow = (label: string, count: number, color: string) => {
    const pct = distTotal > 0 ? (count / distTotal) * 100 : 0;
    return (
      <div key={label} className="flex items-center gap-2 mb-1.5">
        <span className="w-20 text-[0.72rem] text-text-muted text-right">{label}</span>
        <div className="flex-1 h-4 bg-bg rounded-[3px] overflow-hidden">
          <div
            className="h-full rounded-[3px] transition-[width] duration-300"
            style={{ width: `${pct}%`, background: color }}
          />
        </div>
        <span className="w-[60px] text-[0.72rem] text-text">{count} ({Math.round(pct)}%)</span>
      </div>
    );
  };

  return (
    <div className="flex-1 overflow-auto py-5 px-6 bg-bg">
      {/* Period selector */}
      <div className="flex items-center gap-2 mb-5">
        <span className="text-[0.75rem] text-text-muted">Period:</span>
        {[7, 14, 30, 60, 90].map((d) => (
          <button
            key={d}
            onClick={() => setDays(d)}
            className={`py-[3px] px-2.5 text-[0.7rem] border-none rounded cursor-pointer ${
              days === d
                ? "bg-muted-gold/[0.18] text-muted-gold font-semibold"
                : "bg-surface text-text-muted font-normal"
            }`}
          >
            {d}d
          </button>
        ))}
      </div>

      {/* Summary cards */}
      <div className="flex gap-3 mb-6 flex-wrap">
        <div className={card}>
          <div className={cardLabel}>Sessions</div>
          <div className={cardValue}>{data.sessions.total}</div>
        </div>
        <div className={card}>
          <div className={cardLabel}>Avg Emails</div>
          <div className={cardValue}>{data.sessions.avgEmails}</div>
        </div>
        <div className={card}>
          <div className={cardLabel}>Avg Duration</div>
          <div className={cardValue}>{fmtDuration(data.sessions.avgDurationSec)}</div>
        </div>
        <div className={card}>
          <div className={cardLabel}>Junk Rate</div>
          <div
            className="text-[1.4rem] font-bold"
            style={{ color: data.junkRate.current > 50 ? "var(--color-muted-rose)" : "var(--success)" }}
          >
            {data.junkRate.current}%
          </div>
          <div
            className="text-[0.62rem]"
            style={{ color: data.junkRate.trend > 0 ? "var(--color-muted-rose)" : data.junkRate.trend < 0 ? "var(--success)" : "var(--muted)" }}
          >
            {data.junkRate.trend > 0 ? "+" : ""}{data.junkRate.trend}% trend
          </div>
        </div>
      </div>

      {/* Action Distribution */}
      <div className={`${card} mb-6 py-4 px-5`}>
        <div className={`${cardLabel} mb-3`}>Action Distribution</div>
        {distTotal === 0 ? (
          <div className="text-text-muted text-[0.78rem]">No data in this period</div>
        ) : (
          <>
            {barRow("Archived", dist.archived, "var(--color-gold)")}
            {barRow("Trashed", dist.trashed, "var(--color-muted-rose)")}
            {barRow("Replied", dist.replied, "var(--success)")}
            {barRow("Kept", dist.kept, "var(--color-muted-rose)")}
            {barRow("Unsub", dist.unsubscribed, "var(--color-muted-gold)")}
            {barRow("Blocked", dist.blocked, "var(--color-muted-rose)")}
          </>
        )}
      </div>

      {/* Two-column: Top Senders + Weekly Trend */}
      <div className="flex gap-4 flex-wrap">
        {/* Top Senders */}
        <div className={`${card} flex-[1_1_340px] py-4 px-0`}>
          <div className={`${cardLabel} pl-[18px] mb-2`}>Top Senders</div>
          {data.topSenders.length === 0 ? (
            <div className="py-2.5 px-[18px] text-text-muted text-[0.78rem]">No sender data</div>
          ) : (
            <table className="w-full border-collapse text-[0.78rem]">
              <thead>
                <tr>
                  <th className={th}>Sender</th>
                  <th className={`${th} text-right`}>Count</th>
                  <th className={`${th} text-right`}>Last Seen</th>
                </tr>
              </thead>
              <tbody>
                {data.topSenders.map((s, i) => (
                  <tr key={i}>
                    <td className={td}>{s.sender}</td>
                    <td className={`${td} text-right`}>{s.count}</td>
                    <td className={`${td} text-right text-[0.7rem] text-text-muted`}>{s.lastSeen}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Weekly Trend */}
        <div className={`${card} flex-[1_1_340px] py-4 px-0`}>
          <div className={`${cardLabel} pl-[18px] mb-2`}>Weekly Trend</div>
          {data.weeklyTrend.length === 0 ? (
            <div className="py-2.5 px-[18px] text-text-muted text-[0.78rem]">No weekly data</div>
          ) : (
            <table className="w-full border-collapse text-[0.78rem]">
              <thead>
                <tr>
                  <th className={th}>Week</th>
                  <th className={`${th} text-right`}>Total</th>
                  <th className={`${th} text-right`}>Auto-Elim</th>
                  <th className={`${th} text-right`}>Junk %</th>
                </tr>
              </thead>
              <tbody>
                {data.weeklyTrend.map((w, i) => (
                  <tr key={i}>
                    <td className={td}>{w.week}</td>
                    <td className={`${td} text-right`}>{w.total}</td>
                    <td className={`${td} text-right`}>{w.autoProcessed}</td>
                    <td className={`${td} text-right`}>{w.junkRate}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Autopilot Preview — what PAI WOULD auto-action if autopilot were on */}
      {autoScan && (
        <div className={`${card} mt-6 py-4 px-5`}>
          <div className="flex items-center justify-between mb-3">
            <div className={cardLabel}>Autopilot Preview (Phase 24)</div>
            <div className="text-[0.7rem] text-text-muted">
              scanned {autoScan.scanned} · {autoScan.recommendations.length} recommended · skipped {autoScan.skipped.vip + autoScan.skipped.nonExecutableAction + autoScan.skipped.lowConfidence + autoScan.skipped.weakSampleSize}
            </div>
          </div>
          {autoScan.recommendations.length === 0 ? (
            <div className="text-text-muted text-[0.78rem]">
              No emails meet the autopilot threshold today.
              {" "}({autoScan.skipped.weakSampleSize} have weak sample size — autopilot will activate as their history grows.)
            </div>
          ) : (
            <table className="w-full border-collapse text-[0.74rem]">
              <thead>
                <tr>
                  <th className={th}>Action</th>
                  <th className={th}>Sender</th>
                  <th className={`${th} text-right`}>Confidence</th>
                  <th className={th}>Basis</th>
                </tr>
              </thead>
              <tbody>
                {autoScan.recommendations.slice(0, 20).map((r, i) => (
                  <tr key={i}>
                    <td className={`${td} font-mono text-[0.72rem] ${r.action === "T" ? "text-muted-rose" : r.action === "A" ? "text-text-muted" : "text-muted-gold"}`}>{r.action}</td>
                    <td className={`${td} font-mono text-[0.72rem]`}>{r.fromAddress}</td>
                    <td className={`${td} text-right`}>{Math.round(r.confidence * 100)}%</td>
                    <td className={`${td} text-text-muted text-[0.7rem] italic`}>{r.basis}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Active Rules moved to Settings → Routing rules (Phase 29) — it is
          configuration, not analytics. Analytics keeps metrics and trends. */}
    </div>
  );
}

// ─── Main Page ───

export default function Home() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [activeTab, setActiveTab] = useState<TabId>("process");
  const [sortBy, setSortBy] = useState<SortBy>("priority");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [accountFilter, setAccountFilter] = useState<string>("all");
  const [showHelp, setShowHelp] = useState(false);
  const [folderOverrides, setFolderOverrides] = useState<Record<string, string>>({});
  const [instructions, setInstructions] = useState("");
  const [showInstructions, setShowInstructions] = useState(false);
  const [collapsedDomains, setCollapsedDomains] = useState<Set<string>>(new Set());
  // Phase 24 cross-account thread map: emailId → { threadSize, accountsTouched }
  const [threadMap, setThreadMap] = useState<Map<string, { size: number; accounts: string[] }>>(new Map());
  const [instructionStatus, setInstructionStatus] = useState<{ loading: boolean; results?: string[]; error?: string }>({ loading: false });
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [bodyCacheState, setBodyCacheState] = useState<Record<string, string>>({});
  const [transportBanner, setTransportBanner] = useState<string | undefined>();
  const prefetchingIds = useRef<Set<string>>(new Set());

  const currentEmail = state.emails.find((e) => e.id === state.selectedId) ?? null;
  const counts = useMemo(() => tabCounts(state.emails), [state.emails]);

  const accountNames = useMemo(() => {
    const names = new Set(state.emails.map((e) => e.account).filter((a): a is string => !!a));
    return Array.from(names).sort();
  }, [state.emails]);

  const displayEmails = useMemo(() => {
    const tabFiltered = getTabEmails(state.emails, activeTab, sortBy, sortDir);
    if (accountFilter === "all") return tabFiltered;
    return tabFiltered.filter((e) => e.account === accountFilter);
  }, [state.emails, activeTab, sortBy, sortDir, accountFilter]);

  // Phase 22: batch-fetch SenderMemory for every email in the loaded session.
  // Map keyed by lowercased address. Re-fetches when the session emails change
  // (e.g. session reload, regenerate, account filter change is irrelevant since
  // we want history for all senders regardless of active tab/filter).
  const [senderHistoryMap, setSenderHistoryMap] = useState<Map<string, { totalSeen: number; mostCommonAction: string | null; isFrequent: boolean; actions: Record<string, number> }>>(new Map());
  useEffect(() => {
    if (state.emails.length === 0) return;
    const senders = state.emails
      .filter(e => e.fromAddress)
      .map(e => ({ address: e.fromAddress, domain: e.fromDomain }));
    if (senders.length === 0) return;
    let cancelled = false;
    fetch("/api/sender/batch-history", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ senders }),
    })
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (cancelled || !d || d.error) return;
        const map = new Map<string, { totalSeen: number; mostCommonAction: string | null; isFrequent: boolean; actions: Record<string, number> }>();
        for (const r of (d.results ?? []) as Array<{ address?: string; history: { address?: { totalSeen: number; mostCommonAction: string | null; isFrequent: boolean; actions: Record<string, number> } } }>) {
          if (r.address && r.history?.address && r.history.address.totalSeen > 0) {
            map.set(r.address, r.history.address);
          }
        }
        setSenderHistoryMap(map);
      })
      .catch(() => { /* non-critical — badges just won't render */ });
    return () => { cancelled = true; };
  }, [state.emails]);

  // Phase 24: fetch cross-account threads on session load. Map each
  // participating emailId to {threadSize, accountsTouched} so the EmailListItem
  // can render a "🔗 N/g+i" chip.
  useEffect(() => {
    if (state.emails.length === 0) return;
    const payload = state.emails.map(e => ({
      emailId: e.id,
      account: e.account ?? "unknown",
      subject: e.subject,
      fromAddress: e.fromAddress,
      date: e.date,
    }));
    let cancelled = false;
    fetch("/api/threads/cross-account", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ emails: payload }),
    })
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (cancelled || !d || d.error) return;
        const map = new Map<string, { size: number; accounts: string[] }>();
        for (const t of (d.threads ?? []) as Array<{ emails: Array<{ emailId: string }>; accountsTouched: string[] }>) {
          for (const e of t.emails) {
            map.set(e.emailId, { size: t.emails.length, accounts: t.accountsTouched });
          }
        }
        setThreadMap(map);
      })
      .catch(() => { /* non-critical */ });
    return () => { cancelled = true; };
  }, [state.emails]);

  // Derive a compact in-list badge from a sender's history. Returns null when
  // there's nothing useful to surface (no history, or no clear dominant action).
  const senderBadgeFor = useCallback((address?: string) => {
    if (!address) return null;
    const h = senderHistoryMap.get(address.toLowerCase());
    if (!h || h.totalSeen < 2 || !h.mostCommonAction) return null;
    const kind = h.mostCommonAction;
    if (!["archive", "trash", "reply", "keep", "unsub"].includes(kind)) return null;
    const count = h.actions[kind] ?? h.totalSeen;
    const code = kind === "archive" ? "A" : kind === "trash" ? "T" : kind === "reply" ? "R" : kind === "keep" ? "K" : "U";
    return { label: `${count}${code}`, kind: kind as "archive" | "trash" | "reply" | "keep" | "unsub" };
  }, [senderHistoryMap]);

  const currentDisplayIndex = displayEmails.findIndex((e) => e.id === state.selectedId);
  const decisionsCount = Object.keys(state.decisions).length;
  const markedCount = decisionsCount;

  // ─── Tab change ───
  const handleTabChange = useCallback(
    (tab: TabId) => {
      setActiveTab(tab);
      const tabEmails = getTabEmails(state.emails, tab);
      if (tabEmails.length > 0 && !tabEmails.find((e) => e.id === state.selectedId)) {
        dispatch({ type: "SELECT", emailId: tabEmails[0].id });
      }
    },
    [state.emails, state.selectedId],
  );

  // ─── SSE generate helper ───
  const generateWithProgress = useCallback(async () => {
    dispatch({ type: "SET_GENERATING", value: true });
    dispatch({ type: "CLEAR_PROGRESS" });
    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ test: false }),
      });
      if (!res.ok || !res.body) {
        throw new Error(`HTTP ${res.status}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        let eventType = "";
        for (const line of lines) {
          if (line.startsWith("event: ")) {
            eventType = line.slice(7);
          } else if (line.startsWith("data: ")) {
            const data = JSON.parse(line.slice(6));
            if (eventType === "progress") {
              dispatch({ type: "ADD_PROGRESS", step: data.step, detail: data.detail ?? "" });
            } else if (eventType === "result") {
              dispatch({ type: "SET_SESSION", session: data.session });
            } else if (eventType === "error") {
              throw new Error(data.error);
            }
          }
        }
      }
    } catch (err) {
      dispatch({ type: "SET_ERROR", error: err instanceof Error ? err.message : String(err) });
    }
  }, []);

  // ─── Load existing triage on mount (DO NOT auto-regenerate) ───
  useEffect(() => {
    async function loadExisting() {
      try {
        // Date selection: ?date=YYYY-MM-DD URL override → fixture/historical replay;
        // otherwise today's NY-tz date computed client-only (avoids SSR/CSR mismatch).
        const dateOverride = new URLSearchParams(window.location.search).get("date");
        const validOverride = dateOverride && /^\d{4}-\d{2}-\d{2}$/.test(dateOverride) ? dateOverride : null;
        const today = validOverride
          ?? new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
        const res = await fetch(`/api/stage-review?date=${today}`);
        const data = await res.json();
        if (data.transports?.pageBanner) {
          setTransportBanner(data.transports.pageBanner);
        } else {
          setTransportBanner(undefined);
        }
        if (data.exists && data.session) {
          dispatch({ type: "SET_SESSION", session: data.session });
          return;
        }
        await generateWithProgress();
      } catch {
        await generateWithProgress();
      }
    }
    loadExisting();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Regenerate ───
  const handleRegenerate = useCallback(async () => {
    if (state.isGenerating) return;
    setAccountFilter("all");
    await generateWithProgress();
  }, [state.isGenerating]);

  // ─── Auto-switch to process tab on load ───
  useEffect(() => {
    if (state.emails.length > 0) {
      setActiveTab(counts.process > 0 ? "process" : "automated");
    }
  }, [state.emails.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Auto-focus reply textarea ───
  useEffect(() => {
    if (state.editingReply && replyRef.current) replyRef.current.focus();
  }, [state.editingReply, state.selectedId]);

  // ─── Scroll selected item into view ───
  useEffect(() => {
    if (listRef.current && state.selectedId) {
      const item = listRef.current.querySelector(`[data-email-id="${state.selectedId}"]`);
      (item as HTMLElement)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [state.selectedId]);

  // ─── Email body prefetch (batch) ───
  const prefetchBodies = useCallback((emails: ClassifiedEmail[]) => {
    const uncached = emails.filter((e) => !bodyCacheState[e.id] && !prefetchingIds.current.has(e.id));
    if (uncached.length === 0) return;
    for (const e of uncached) prefetchingIds.current.add(e.id);
    const mailboxById: Record<string, string> = {};
    for (const e of uncached) {
      const m = mailboxUnifiedPathForEmail(e);
      if (m) mailboxById[e.id] = m;
    }
    fetch("/api/email/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: uncached.map((e) => e.id), mailboxById }),
    })
      .then((r) => r.json())
      .then((data) => {
        const bodies = data.bodies ?? {};
        const cleaned: Record<string, string> = {};
        for (const [id, raw] of Object.entries(bodies)) {
          cleaned[id] = (raw as string).replace(/\r\n/g, "\n").replace(/[\uFFFC\uFFFD]/g, "").replace(/\n{3,}/g, "\n\n").trim();
        }
        if (Object.keys(cleaned).length > 0) {
          setBodyCacheState((prev) => ({ ...prev, ...cleaned }));
        }
      })
      .catch(() => {})
      .finally(() => { for (const e of uncached) prefetchingIds.current.delete(e.id); });
  }, [bodyCacheState]);

  // Prefetch first 5 emails when session loads
  useEffect(() => {
    if (displayEmails.length > 0) {
      prefetchBodies(displayEmails.slice(0, 5));
    }
  }, [displayEmails.length > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  // Prefetch next 3 emails when navigating
  useEffect(() => {
    if (currentDisplayIndex >= 0) {
      const nextEmails: ClassifiedEmail[] = [];
      for (let i = 1; i <= 3; i++) {
        const next = displayEmails[currentDisplayIndex + i];
        if (next) nextEmails.push(next);
      }
      if (nextEmails.length > 0) prefetchBodies(nextEmails);
    }
  }, [currentDisplayIndex, displayEmails, prefetchBodies]);

  // ─── Decision helper ───
  const setDecisionAndAdvance = useCallback(
    (code: string) => {
      if (!currentEmail) return;
      dispatch({ type: "SET_DECISION", emailId: currentEmail.id, code });
      // UX-8 fix (2026-05-19): for Archive, if no destination folder is already
      // set (neither suggested via email.folder nor overridden via picker), do
      // NOT advance — the folder picker surfaces on the current email and the
      // user can pick a destination or accept default. Before the fix, the
      // picker flashed momentarily on an email the user had already navigated
      // past. Reply path was already exempt from advance for the same reason.
      const needsFolderPick =
        code === "A"
        && !currentEmail.folder
        && !folderOverrides[currentEmail.id];
      if (code !== "R" && !needsFolderPick) {
        const nextIdx = currentDisplayIndex + 1;
        if (nextIdx < displayEmails.length) {
          dispatch({ type: "SELECT", emailId: displayEmails[nextIdx].id });
        }
      }
    },
    [currentEmail, currentDisplayIndex, displayEmails, folderOverrides],
  );

  // ─── Execute helper ───
  const executeEmails = useCallback(
    async (emailsToProcess: ClassifiedEmail[]) => {
      if (state.isExecuting || emailsToProcess.length === 0) return;
      dispatch({ type: "SET_EXECUTING", value: true });
      try {
        // UX-12 fix (2026-05-19): send typed {items:[...]} payload so /api/execute
        // actually runs applyActions against Mail.app + the DB. The previous shape
        // (`noteContent`) only built the plan; the UI's row-removal happened against
        // a no-op on the mailbox side.
        const items = emailsToProcess.map((email) => {
          const decision = state.decisions[email.id] ?? "K";
          const replyText = state.replyDrafts[email.id];
          const folder = folderOverrides[email.id] ?? email.folder;
          const actionCodes: string[] = [decision];
          if (folder) actionCodes.push(`FOLDER:${folder}`);
          return {
            id: email.id,
            account: email.account,
            actionCodes,
            sender: email.from,
            subject: email.subject,
            funnelStage: email.funnelStage,
            ...(decision === "R" && replyText ? { replyDraft: replyText } : {}),
          };
        });
        const payload: Record<string, unknown> = { items };
        if (instructions.trim()) payload.instructions = instructions.trim();
        const res = await fetch("/api/execute", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
        if (!res.ok) { const data = await res.json(); throw new Error(data.error ?? `HTTP ${res.status}`); }
        const data = await res.json();
        dispatch({ type: "SET_EXECUTION_RESULT", result: data.summary });
        // Gate optimistic row-removal on real success.
        // Pre-UX-12-fix this removed rows regardless of whether the API actually executed anything,
        // so a no-op API response visibly "cleared" emails that were still in Mail.app.
        const apiReportedSuccess = data.success === true
          && data.summary
          && (data.summary.total > 0)
          && (!data.errors || data.errors.length === 0);
        if (apiReportedSuccess) {
          const removedIds = emailsToProcess
            .filter((e) => (state.decisions[e.id] ?? "K") !== "K")
            .map((e) => e.id);
          if (removedIds.length > 0) {
            dispatch({ type: "REMOVE_EMAILS", ids: removedIds });
          }
        } else if (data.errors && data.errors.length > 0) {
          dispatch({ type: "SET_ERROR", error: `Execute reported ${data.errors.length} error(s): ${data.errors.slice(0, 3).join("; ")}` });
        }
      } catch (err) {
        dispatch({ type: "SET_ERROR", error: err instanceof Error ? err.message : String(err) });
      }
    },
    [state.isExecuting, state.decisions, state.replyDrafts, folderOverrides, instructions],
  );

  const processAll    = useCallback(() => executeEmails(state.emails), [executeEmails, state.emails]);
  const processMarked = useCallback(() => executeEmails(state.emails.filter((e) => state.decisions[e.id])), [executeEmails, state.emails, state.decisions]);

  // ─── Open in source client (iCloud → Mail.app, Gmail → web) — Phase 3 ───
  const openInSourceClient = useCallback((email: ClassifiedEmail) => {
    const acct = (email.account ?? "").toLowerCase();
    const isGmail = acct.includes("google") || acct === "gmail" || /^[a-f0-9]{12,}$/i.test(email.id);
    if (isGmail) {
      window.open(`https://mail.google.com/mail/u/0/#inbox/${email.id}`, "_blank");
      return;
    }
    // UX-4 fix: prefer the message:// URL the parser captured from the doc's
    // bracketed link — that's the real RFC 2822 Message-Id Mail.app's scheme
    // expects. Falling back to synthesizing from the Apple-numeric id (the
    // pre-fix behavior) hands Mail.app something it doesn't recognize.
    const url = email.messageUrl
      ?? `message://%3c${email.id}%3e`;
    window.open(url, "_blank");
  }, []);

  // ─── AI summary loader ───
  const loadAiSummary = useCallback(async () => {
    if (!currentEmail) return;
    const mb = mailboxUnifiedPathForEmail(currentEmail);
    const qs = mb ? `?mailbox=${encodeURIComponent(mb)}` : "";
    const res = await fetch(`/api/email/${currentEmail.id}/summary${qs}`);
    const data = await res.json();
    if (data.summary) {
      dispatch({
        type: "SET_AI_SUMMARY",
        emailId: currentEmail.id,
        summary: data.summary,
        injectionWarning: data.injectionWarning === true,
      });
    } else if (data.injectionWarning) {
      // No usable summary but injection was detected — still record the warning
      dispatch({
        type: "SET_AI_SUMMARY",
        emailId: currentEmail.id,
        summary: "⚠ Suspicious content detected in this email",
        injectionWarning: true,
      });
    }
  }, [currentEmail]);

  // ─── AI draft reply loader ───
  const loadDraft = useCallback(async (context?: string) => {
    if (!currentEmail) return;
    const res = await fetch(`/api/email/${currentEmail.id}/draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: currentEmail.from,
        subject: currentEmail.subject,
        isVip: currentEmail.isVip,
        context: context ?? "",
        mailbox: mailboxUnifiedPathForEmail(currentEmail),
      }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    if (data.draft) {
      dispatch({ type: "SET_REPLY_DRAFT", emailId: currentEmail.id, text: data.draft });
    }
    if (data.actionsExecuted?.length || data.message) {
      dispatch({ type: "SET_AI_ACTIONS", emailId: currentEmail.id, executed: data.actionsExecuted ?? [], message: data.message ?? "" });
    }
  }, [currentEmail]);

  // ─── Send reply, archive, and advance ───
  const sendReplyAndAdvance = useCallback(async () => {
    if (!currentEmail) return;
    const replyText = state.replyDrafts[currentEmail.id];
    if (!replyText?.trim()) return;

    dispatch({ type: "SET_EXECUTING", value: true });
    try {
      // Send the reply via execute API
      const lines = [
        `## ${currentEmail.subject}`,
        `from: ${currentEmail.from}`,
        `id: ${currentEmail.id}`,
        `action: reply`,
        `reply: |`,
        `  ${replyText}`,
        "",
      ];
      const res = await fetch("/api/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ noteContent: lines.join("\n") }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }

      // Remove from list and advance to next
      dispatch({ type: "REMOVE_EMAILS", ids: [currentEmail.id] });

      // Select next email
      const nextIdx = currentDisplayIndex + 1;
      if (nextIdx < displayEmails.length) {
        const nextEmail = displayEmails[nextIdx];
        if (nextEmail && nextEmail.id !== currentEmail.id) {
          dispatch({ type: "SELECT", emailId: nextEmail.id });
        }
      }
    } catch (err) {
      dispatch({ type: "SET_ERROR", error: err instanceof Error ? err.message : String(err) });
    } finally {
      dispatch({ type: "SET_EXECUTING", value: false });
    }
  }, [currentEmail, state.replyDrafts, currentDisplayIndex, displayEmails]);

  // ─── Keyboard shortcuts — synced with markdown action codes ───
  // K=Keep A=Archive T=Trash R=Reply D=Defer F=Follow-up J=Junk U=Unsub AP(p)=Approve BL(b)=Block
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (state.editingReply) return;
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) return;

      // Use raw key for shift detection (J vs j), lowercase for everything else
      const key = e.key;
      const lk = key.toLowerCase();

      // Shift+J = Junk (markdown J) — must check before j navigation
      if (key === "J" && e.shiftKey) { e.preventDefault(); setDecisionAndAdvance("J"); return; }

      switch (lk) {
        case "j":
        case "arrowdown":
          e.preventDefault();
          if (currentDisplayIndex + 1 < displayEmails.length) dispatch({ type: "SELECT", emailId: displayEmails[currentDisplayIndex + 1].id });
          break;
        case "k":
        case "arrowup":
          e.preventDefault();
          if (currentDisplayIndex - 1 >= 0) dispatch({ type: "SELECT", emailId: displayEmails[currentDisplayIndex - 1].id });
          break;
        case "a": e.preventDefault(); setDecisionAndAdvance("A"); break;    // archive (matches markdown A)
        case "t": e.preventDefault(); setDecisionAndAdvance("T"); break;    // trash (matches markdown T)
        case "r":
          e.preventDefault();
          if (currentEmail) { dispatch({ type: "SET_DECISION", emailId: currentEmail.id, code: "R" }); dispatch({ type: "SET_EDITING_REPLY", value: true }); }
          break;
        case "d": e.preventDefault(); setDecisionAndAdvance("D"); break;    // defer (matches markdown D)
        case "f": e.preventDefault(); setDecisionAndAdvance("FU"); break;   // follow-up (matches markdown FU)
        case "u": e.preventDefault(); setDecisionAndAdvance("U"); break;    // unsub (matches markdown U)
        case "b": e.preventDefault(); setDecisionAndAdvance("BL"); break;   // block (matches markdown BL)
        case "p": e.preventDefault(); setDecisionAndAdvance("AP"); break;   // approve (matches markdown AP)
        case "o": e.preventDefault(); if (currentEmail) openInSourceClient(currentEmail); break;
        case " ": e.preventDefault(); setDecisionAndAdvance("K"); break;    // keep (matches markdown K)
        case "backspace":
          if (!e.metaKey && !e.ctrlKey) { e.preventDefault(); setDecisionAndAdvance("T"); }
          break;
        case "enter":
          if (e.metaKey || e.ctrlKey) { e.preventDefault(); processAll(); break; }
          if (currentEmail && !state.decisions[currentEmail.id]) {
            const aiSug = currentEmail.priority === "archive" ? "A" :
              currentEmail.priority === "trash" ? "T" :
              currentEmail.priority === "unsub" ? "U" :
              currentEmail.priority === "unknown" ? "AP" : null;
            if (aiSug) { e.preventDefault(); setDecisionAndAdvance(aiSug); break; }
          }
          e.preventDefault(); dispatch({ type: "SET_EDITING_REPLY", value: true });
          break;
        case "escape": e.preventDefault(); dispatch({ type: "SET_EDITING_REPLY", value: false }); break;
        case "1": setActiveTab("process"); break;
        case "2": setActiveTab("automated"); break;
        case "3": setActiveTab("analytics"); break;
        case "4": setActiveTab("settings"); break;
        case "?": e.preventDefault(); setShowHelp(true); break;
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [state.editingReply, currentDisplayIndex, displayEmails, currentEmail, setDecisionAndAdvance, processAll, openInSourceClient, setShowHelp]);

  // ─── Loading state with progress steps ───
  if (state.isLoading || state.isGenerating) {
    const stepLabels: Record<string, string> = {
      fetch: "Fetching emails",
      rules: "Loading rules",
      classify: "Classifying emails",
      ai: "AI classification",
      vip: "VIP enrichment",
      write: "Writing triage note",
      done: "Complete",
    };
    const stepOrder = ["fetch", "rules", "classify", "ai", "vip", "write", "done"];
    const completedSteps = new Set(state.progressSteps.map((s) => s.step));
    const lastStep = state.progressSteps[state.progressSteps.length - 1];
    return (
      <main style={{ height: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--bg)" }}>
        <div style={{ textAlign: "center", minWidth: "280px" }}>
          {state.progressSteps.length === 0 ? (
            <>
              <div style={{ width: "32px", height: "32px", border: "2px solid var(--border)", borderTop: "2px solid var(--color-gold)", borderRadius: "50%", animation: "spin 0.8s linear infinite", margin: "0 auto 18px" }} />
              <div style={{ fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.16em", color: "var(--color-gold)", fontWeight: 500, marginBottom: "12px" }}>Establishing pipeline</div>
              <div style={{ fontSize: "2.25rem", fontWeight: 600, letterSpacing: "-0.02em", fontFamily: "var(--font-serif)", color: "var(--text-strong)", marginBottom: "8px" }}>Connecting…</div>
              <div style={{ color: "var(--color-muted-gold)", fontSize: "0.9rem" }}>Initializing email triage pipeline</div>
            </>
          ) : (
            <>
              <div style={{ fontSize: "1rem", fontWeight: 600, marginBottom: "4px" }}>
                {lastStep?.step === "done" ? "✓ Complete" : "Generating triage…"}
              </div>
              {lastStep && lastStep.step !== "done" && (
                <div style={{ color: "#b29a68", fontSize: "0.85rem", fontWeight: 500, marginBottom: "10px" }}>
                  {lastStep.detail}
                </div>
              )}
              <div style={{ textAlign: "left", margin: "0 auto", maxWidth: "280px", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "8px", padding: "8px 12px" }}>
                {stepOrder.map((key) => {
                  const done = completedSteps.has(key);
                  const active = lastStep?.step === key && key !== "done";
                  return (
                    <div key={key} style={{ display: "flex", alignItems: "center", gap: "8px", padding: "4px 0", fontSize: "0.82rem", color: done ? "var(--success)" : active ? "#b29a68" : "var(--muted)", opacity: done || active ? 1 : 0.35, fontWeight: active ? 600 : 400 }}>
                      <span style={{ width: "18px", textAlign: "center", fontSize: "0.8rem" }}>
                        {done ? "✓" : active ? "›" : "·"}
                      </span>
                      <span>{stepLabels[key] ?? key}</span>
                      {active && <span style={{ marginLeft: "auto", width: "8px", height: "8px", borderRadius: "50%", background: "#b29a68", animation: "pulse 1s ease-in-out infinite" }} />}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } } @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }`}</style>
      </main>
    );
  }

  // ─── Error state ───
  if (state.error) {
    return (
      <main className="h-screen flex items-center justify-center bg-bg">
        <div className="text-center max-w-[420px]">
          <div className="text-base font-semibold text-danger mb-2">Error loading triage</div>
          <div className="text-text-muted text-[0.82rem] font-mono bg-surface p-3 rounded-md border border-border text-left whitespace-pre-wrap break-all">
            {state.error}
          </div>
          <button
            onClick={() => window.location.reload()}
            className="mt-4 py-[7px] px-5 text-[0.82rem] border border-border rounded-[5px] bg-surface text-text cursor-pointer"
          >
            Retry
          </button>
        </div>
      </main>
    );
  }

  const showInboxZero = activeTab === "process" && counts.process === 0;

  // ─── Main layout ───
  return (
    <main className="h-screen flex flex-col bg-bg overflow-hidden">
      {showHelp && <HelpOverlay onClose={() => setShowHelp(false)} />}
      <HeaderBar date={state.date} stats={state.sessionStats} decisionsCount={decisionsCount} onHelpOpen={() => setShowHelp(true)} onRegenerate={handleRegenerate} isGenerating={state.isGenerating} />
      <TabBar activeTab={activeTab} counts={counts} onSelect={handleTabChange} />
      {transportBanner && (
        <div className="py-1.5 px-3.5 text-[0.72rem] text-muted-rose bg-muted-rose/[0.08] border-b border-muted-rose/25">
          {transportBanner}
        </div>
      )}

      {/* UX-1 (2026-05-19): Instructions affordance moved to AiInsightPanel header
          per Q11=(a). The control state (instructions / showInstructions /
          instructionStatus) is still defined here so it persists across email
          selection; the AiInsightPanel renders the trigger and expanded surface
          via the instructionsControl prop. */}

      {/* Analytics tab — Task 9.6 */}
      {activeTab === "analytics" ? (
        <AnalyticsPanel />
      ) : activeTab === "settings" ? (
        <SettingsPanel />
      ) : showInboxZero ? (
        <InboxZeroOverlay stats={state.sessionStats} date={state.date} />
      ) : (
        <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
          {/* Left panel — email list */}
          <div className="flex-[0_1_28%] min-w-[220px] max-w-[400px] border-r border-border bg-surface flex flex-col overflow-hidden">
            {/* Account filter + Sort bar */}
            {accountNames.length > 0 && (
              <div className="py-1 px-2.5 border-b border-border flex items-center gap-1 bg-bg shrink-0">
                <span className="text-[0.6rem] text-text-muted mr-0.5 tracking-[0.05em] uppercase">Account:</span>
                <select
                  value={accountFilter}
                  onChange={(e) => setAccountFilter(e.target.value)}
                  className="text-[0.65rem] py-px px-1 border border-border rounded-[3px] bg-surface text-text cursor-pointer outline-none"
                >
                  <option value="all">All Accounts</option>
                  {accountNames.map((name) => <option key={name} value={name}>{name}</option>)}
                </select>
              </div>
            )}
            <div className="py-[5px] px-2.5 border-b border-border flex items-center gap-0.5 bg-bg shrink-0">
              <span className="text-[0.6rem] text-text-muted mr-1 tracking-[0.05em] uppercase">Sort:</span>
              {(["priority", "date", "sender"] as SortBy[]).map((key) => (
                <button
                  key={key}
                  onClick={() => setSortBy(key)}
                  className={`py-0.5 px-2 text-[0.65rem] border-none rounded-[3px] cursor-pointer capitalize ${
                    sortBy === key ? "bg-gold/15 text-gold font-semibold" : "bg-transparent text-text-muted font-normal"
                  }`}
                >
                  {key}
                </button>
              ))}
              <button
                onClick={() => setSortDir((d) => d === "asc" ? "desc" : "asc")}
                className="ml-1 py-0.5 px-1.5 text-[0.65rem] border-none rounded-[3px] bg-gold/10 text-gold cursor-pointer font-semibold"
              >
                {sortDir === "desc" ? "↓" : "↑"}
              </button>
            </div>

            {/* Email list */}
            <div ref={listRef} className="flex-1 overflow-y-auto">
              {displayEmails.length === 0 ? (
                <div className="py-6 px-4 text-center text-text-muted text-[0.8rem]">No emails in this tab</div>
              ) : activeTab === "process" ? (
                // Process tab: sticky section headers — Task 7.5
                PROCESS_SECTIONS.map(({ priority, label, color }) => {
                  const sectionEmails = displayEmails.filter((e) => e.priority === priority);
                  if (sectionEmails.length === 0) return null;
                  return (
                    <div key={priority}>
                      <SectionHeader label={label} color={color} count={sectionEmails.length} />
                      {sectionEmails.map((email) => (
                        <EmailListItem
                          inAutomatedTab={false}
                          key={email.id}
                          email={email}
                          isSelected={email.id === state.selectedId}
                          decision={state.decisions[email.id]}
                          aiSummary={state.aiSummaries[email.id]}
                          injectionWarning={
                            state.injectionWarnings[email.id] ||
                            hasInjectionContent(email.snippet ?? "")
                          }
                          senderHistoryBadge={senderBadgeFor(email.fromAddress)}
                          threadBadge={threadMap.get(email.id) ?? null}
                          onClick={() => dispatch({ type: "SELECT", emailId: email.id })}
                        />
                      ))}
                    </div>
                  );
                })
              ) : (
                // Automated tab: domain-grouped (Phase 22 topic clustering for
                // Stage 5/6 bulk volume — newsletters/promos cluster by domain
                // and grouping cuts scroll length dramatically). Single-email
                // domains render flat (no group header) to avoid noise.
                (() => {
                  const byDomain = new Map<string, typeof displayEmails>();
                  for (const e of displayEmails) {
                    const key = (e.fromDomain || "—unknown—").toLowerCase();
                    const list = byDomain.get(key) ?? [];
                    list.push(e);
                    byDomain.set(key, list);
                  }
                  // Sort domains: most-emails first
                  const groups = Array.from(byDomain.entries()).sort((a, b) => b[1].length - a[1].length);
                  return groups.flatMap(([domain, emails]) => {
                    const collapsed = collapsedDomains.has(domain);
                    if (emails.length === 1) {
                      // Single-email domain: render flat without group chrome
                      return (
                        <EmailListItem
                          inAutomatedTab={true}
                          key={emails[0].id}
                          email={emails[0]}
                          isSelected={emails[0].id === state.selectedId}
                          decision={state.decisions[emails[0].id]}
                          senderHistoryBadge={senderBadgeFor(emails[0].fromAddress)}
                          threadBadge={threadMap.get(emails[0].id) ?? null}
                          onClick={() => dispatch({ type: "SELECT", emailId: emails[0].id })}
                        />
                      );
                    }
                    return [
                      <div
                        key={`hdr-${domain}`}
                        onClick={() => setCollapsedDomains(prev => {
                          const next = new Set(prev);
                          if (next.has(domain)) next.delete(domain); else next.add(domain);
                          return next;
                        })}
                        className="sticky top-0 z-10 py-1 px-3 bg-bg border-b border-border flex items-center gap-1.5 cursor-pointer hover:bg-surface"
                      >
                        <span className="text-[0.62rem] text-text-muted">{collapsed ? "▸" : "▾"}</span>
                        <span className="text-[0.7rem] font-medium text-text-muted truncate">{domain}</span>
                        <span className="text-[0.6rem] font-semibold py-0 px-1.5 rounded-md bg-text-muted/10 text-text-muted ml-auto">{emails.length}</span>
                      </div>,
                      ...(collapsed ? [] : emails.map((email) => (
                        <EmailListItem
                          inAutomatedTab={true}
                          key={email.id}
                          email={email}
                          isSelected={email.id === state.selectedId}
                          decision={state.decisions[email.id]}
                          senderHistoryBadge={senderBadgeFor(email.fromAddress)}
                          threadBadge={threadMap.get(email.id) ?? null}
                          onClick={() => dispatch({ type: "SELECT", emailId: email.id })}
                        />
                      ))),
                    ];
                  });
                })()
              )}
            </div>
          </div>

          {/* Right panel — detail */}
          <div className="flex-1 overflow-hidden flex flex-col">
            {currentEmail ? (
              <EmailDetailPanel
                email={currentEmail}
                decision={state.decisions[currentEmail.id]}
                replyDraft={state.replyDrafts[currentEmail.id]}
                editingReply={state.editingReply}
                aiSummary={state.aiSummaries[currentEmail.id]}
                aiActions={state.aiActions[currentEmail.id]}
                onSetDecision={(code) => setDecisionAndAdvance(code)}
                onSetReplyDraft={(text) => dispatch({ type: "SET_REPLY_DRAFT", emailId: currentEmail.id, text })}
                onSetEditingReply={(value) => dispatch({ type: "SET_EDITING_REPLY", value })}
                onLoadAiSummary={loadAiSummary}
                onLoadDraft={loadDraft}
                onSendReply={sendReplyAndAdvance}
                onOpenInClient={() => openInSourceClient(currentEmail)}
                replyRef={replyRef}
                folderOverride={folderOverrides[currentEmail.id]}
                cachedBody={bodyCacheState[currentEmail.id]}
                onSetFolderOverride={(folder) => setFolderOverrides((prev) => ({ ...prev, [currentEmail.id]: folder }))}
                onUpdateEmailId={(oldId, newId) => dispatch({ type: "UPDATE_EMAIL_ID", oldId, newId })}
                instructionsControl={{
                  instructions,
                  setInstructions,
                  showInstructions,
                  setShowInstructions,
                  instructionStatus,
                  setInstructionStatus,
                }}
              />
            ) : (
              <div className="p-10 text-center text-text-muted text-[0.85rem]">Select an email</div>
            )}
          </div>
        </div>
      )}

      <StatusBar onProcessMarked={processMarked} onProcessAll={processAll} isExecuting={state.isExecuting} markedCount={markedCount} executionResult={state.executionResult} onShowHelp={() => setShowHelp(true)} />
    </main>
  );
}

// ─── Helpers ───

function mapDecisionToAction(code: string): string {
  const map: Record<string, string> = {
    A: "archive", T: "trash", R: "reply", D: "defer", U: "unsub", K: "keep",
    J: "junk", BL: "block", BD: "block_domain", BS: "block_sender",
    AP: "approve", FU: "follow_up",
  };
  return map[code] ?? "keep";
}
