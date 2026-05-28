// ~/.claude/skills/EmailTriage/ai-classifier.ts
// AI-powered email classification. Supports both Anthropic API and Ollama Cloud.
// Set LLM_PROVIDER=ollama to use Ollama Cloud models (OpenAI-compatible endpoint).
// Defaults to Anthropic if LLM_PROVIDER is unset or "anthropic".
// Returns 10-category AIActionType for funnel stage placement.
// Falls back gracefully when AI is unavailable.

import type { RawEmail, AIActionType, FunnelStage, EmailPriority } from "./Types";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const OLLAMA_API_URL = "https://ollama.com/v1/chat/completions";

// ── Model selection by provider ──
// Classification: fast/cheap model for batch triage (Gemini Flash if available, else Haiku)
// Drafts: high-quality prose model for reply drafting
const ANTHROPIC_CLASSIFY = "claude-haiku-4-5-20251001";
const ANTHROPIC_DRAFT    = "claude-sonnet-4-6";
const OLLAMA_CLASSIFY    = "gemini-3-flash-preview";
const OLLAMA_DRAFT       = "deepseek-v4-pro";

const API_TIMEOUT = 60_000;

const VALID_ACTION_TYPES = new Set<string>([
  "reply_needed", "decision_needed", "deadline",
  "financial", "document_review",
  "educational", "newsletter",
  "marketing", "transactional",
  "junk",
]);

// ── Types ──────────────────────────────────────────────────────

export interface AIClassificationResult {
  aiActionType: AIActionType;
  funnelStage: FunnelStage;
  priority: EmailPriority;
  reason: string;
  replyDraft?: string;
  isUnsub?: boolean;
}

interface RawAIItem {
  id: string;
  type: string;
  reason: string;
  isUnsub?: boolean;
}

const FALLBACK_RESULT: AIClassificationResult = {
  aiActionType: "transactional",
  funnelStage: "bulk_dispose",
  priority: "review",
  reason: "AI unavailable",
};

// ── Mapping functions ──────────────────────────────────────────

/** Map AIActionType → FunnelStage */
export function actionTypeToFunnelStage(type: AIActionType): FunnelStage {
  switch (type) {
    case "reply_needed":
    case "decision_needed":
    case "deadline":
      return "action";
    case "financial":
    case "document_review":
      return "financial";
    case "educational":
    case "newsletter":
      return "informational";
    case "marketing":
    case "transactional":
      return "bulk_dispose";
    case "junk":
      return "auto_processed";
  }
}

/** Map AIActionType → EmailPriority */
export function actionTypeToPriority(type: AIActionType): EmailPriority {
  switch (type) {
    case "reply_needed":
    case "decision_needed":
    case "deadline":
      return "action";
    case "financial":
    case "document_review":
      return "review";
    case "educational":
    case "newsletter":
      return "review";
    case "marketing":
    case "transactional":
      return "archive";
    case "junk":
      return "trash";
  }
}

// ── Pure functions (testable without mocks) ────────────────────

export function buildClassificationPrompt(emails: RawEmail[]): string {
  const emailSummaries = emails.map((e) => ({
    id: e.id,
    from: e.fromAddress,
    subject: e.subject,
    snippet: e.snippet.slice(0, 200),
    hasAttachment: e.hasAttachment,
  }));

  return `Classify these emails for a morning triage system. Return ONLY valid JSON array.
Each item: {"id": "...", "type": "<type>", "reason": "...(max 80 chars)", "isUnsub": true/false}

For the "reason" field, provide a 1-2 sentence summary of what the email is about and what action it requires. Be specific and descriptive, not just a category label. Example: "March invoice from AWS totaling $247, payment due Apr 5" instead of "Routine invoice".

Types (pick exactly one):
- reply_needed: expects a response from me
- decision_needed: requires approve/reject/choose
- deadline: date-sensitive obligation or deadline
- financial: claims, statements, receipts, tax docs, billing
- document_review: attachments requiring review
- educational: CME, medical literature, professional development
- newsletter: subscribed content worth scanning
- marketing: promotions, sales, coupons, ads
- transactional: confirmations, notifications, automated alerts
- junk: spam, scam, unwanted bulk mail

Rules:
- If an email has a tax document, 1099, W-2, or financial attachment → financial
- If a newsletter has a reply request embedded → reply_needed (action trumps info)
- If unsure between marketing and newsletter → marketing (conservative)
- Do NOT classify newsletters, automated announcements, course registrations, or marketing campaigns as 'deadline' or 'reply_needed' simply because they mention a date or deadline. Newsletters, educational announcements, or promotional calls for nominations/registrations must always be classified as 'newsletter', 'educational', or 'marketing' respectively, unless they represent a direct, individual obligation or specific transaction belonging directly to the recipient.
- Set isUnsub: true if the email looks like something I'd want to unsubscribe from

Emails:
${JSON.stringify(emailSummaries)}`;
}

export function parseAIClassificationResponse(response: string): Map<string, AIClassificationResult> {
  const resultMap = new Map<string, AIClassificationResult>();
  const items = parseRawItems(response);

  for (const item of items) {
    resultMap.set(item.id, toClassificationResult(item));
  }

  return resultMap;
}

// ── Internal parse helpers ─────────────────────────────────────

function stripCodeFences(text: string): string {
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*\n?/m, "");
  cleaned = cleaned.replace(/\n?```\s*$/m, "");
  return cleaned.trim();
}

function parseRawItems(response: string): RawAIItem[] {
  if (!response || !response.trim()) return [];

  const cleaned = stripCodeFences(response);

  try {
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return [];

    return parsed.filter(
      (item: any) => item && typeof item.id === "string" && VALID_ACTION_TYPES.has(item.type),
    );
  } catch {
    return [];
  }
}

function toClassificationResult(item: RawAIItem): AIClassificationResult {
  const aiActionType = item.type as AIActionType;
  return {
    aiActionType,
    funnelStage: actionTypeToFunnelStage(aiActionType),
    priority: actionTypeToPriority(aiActionType),
    reason: typeof item.reason === "string" ? item.reason.slice(0, 80) : "Classified by AI",
    isUnsub: item.isUnsub === true,
  };
}

// ── Provider detection + credential loading ──────────────────────

type LLMProvider = "anthropic" | "ollama";

let _provider: LLMProvider | undefined;
let _apiKey: string | undefined;

function getProvider(): LLMProvider {
  if (_provider) return _provider;
  const val = (typeof process !== "undefined" ? process.env.LLM_PROVIDER : undefined);
  _provider = (val === "ollama") ? "ollama" : "anthropic";
  return _provider;
}

function getApiKey(): string {
  if (_apiKey) return _apiKey;
  const provider = getProvider();
  const keyVar = provider === "ollama" ? "OLLAMA_API_KEY" : "ANTHROPIC_API_KEY";

  // 1. Check environment
  if (typeof process !== "undefined" && process.env[keyVar]) {
    _apiKey = process.env[keyVar]!;
    return _apiKey;
  }

  // 2. Check skill .env.local
  try {
    const skillRoot = join(
      typeof import.meta !== "undefined" && import.meta.dir
        ? join(import.meta.dir, "..")
        : join((typeof process !== "undefined" ? process.env.HOME ?? "" : ""), ".claude/skills/EmailTriage"),
    );
    const envLocal = join(skillRoot, "web", ".env.local");
    if (existsSync(envLocal)) {
      const content = readFileSync(envLocal, "utf-8");
      const m = content.match(new RegExp(`^${keyVar}=(.+?)\\s*$`, "m"));
      if (m) { _apiKey = m[1].trim(); return _apiKey; }
    }
  } catch { /* fall through */ }

  // 3. Check ~/.hermes/.env for Ollama key
  if (provider === "ollama") {
    try {
      const hermesEnv = join(
        typeof process !== "undefined" ? (process.env.HOME ?? "") : "",
        ".hermes/.env"
      );
      if (existsSync(hermesEnv)) {
        const content = readFileSync(hermesEnv, "utf-8");
        const m = content.match(/^OLLAMA_API_KEY=(.+?)\s*$/m);
        if (m) { _apiKey = m[1].trim(); return _apiKey; }
      }
    } catch { /* fall through */ }
  }

  throw new Error(`${keyVar} not set (provider=${provider})`);
}

/** Detect provider & select appropriate model. Callers pass a task hint — "classify" or "draft". */
function resolveModel(task: "classify" | "draft"): string {
  if (getProvider() === "ollama") return task === "classify" ? OLLAMA_CLASSIFY : OLLAMA_DRAFT;
  return task === "classify" ? ANTHROPIC_CLASSIFY : ANTHROPIC_DRAFT;
}

// ── Unified LLM call (dispatches by provider) ────────────────────

async function callLLM(
  systemPrompt: string,
  userPrompt: string,
  task: "classify" | "draft",
  maxTokens: number = 2048,
): Promise<string> {
  const provider = getProvider();
  const key = getApiKey();

  if (provider === "ollama") {
    // Ollama Cloud — OpenAI-compatible chat completions
    const response = await fetch(OLLAMA_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: resolveModel(task),
        max_tokens: maxTokens,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
      signal: AbortSignal.timeout(API_TIMEOUT),
    });

    if (!response.ok) {
      const err = await response.text().catch(() => "unknown error");
      throw new Error(`Ollama Cloud API ${response.status}: ${err}`);
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>;
    };
    return data.choices?.[0]?.message?.content ?? "";
  }

  // Anthropic — native Messages API
  const response = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: resolveModel(task),
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
    signal: AbortSignal.timeout(API_TIMEOUT),
  });

  if (!response.ok) {
    const err = await response.text().catch(() => "unknown error");
    throw new Error(`Anthropic API ${response.status}: ${err}`);
  }

  const data = await response.json() as {
    content: Array<{ type: string; text?: string }>;
  };

  return data.content
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text!)
    .join("\n");
}

// ── Draft prompt builder (now accepts body text) ─────────────────

export function buildReplyDraftPrompt(email: RawEmail, body?: string): string {
  const bodyText = body?.trim() || email.snippet.slice(0, 500) || "(no body available)";
  // Persona/identity loaded from SKILLCUSTOMIZATIONS/EmailTriage/preferences.yaml `persona` key,
  // or EMAILTRIAGE_PERSONA env var. Falls back to a neutral generic persona.
  const persona = (() => {
    if (process.env.EMAILTRIAGE_PERSONA) return process.env.EMAILTRIAGE_PERSONA;
    try {
      const home = process.env.HOME;
      if (!home) return "the recipient";
      const fs = require("fs");
      const path = require("path");
      const prefs = path.join(home, ".claude/PAI/USER/SKILLCUSTOMIZATIONS/EmailTriage/preferences.yaml");
      if (!fs.existsSync(prefs)) return "the recipient";
      const raw = fs.readFileSync(prefs, "utf8");
      const m = raw.match(/^\s*persona\s*:\s*["']?([^"'#\n]+?)["']?\s*(?:#.*)?$/m);
      return m ? m[1].trim() : "the recipient";
    } catch { return "the recipient"; }
  })();
  return `Write a brief professional reply draft for this email. Max 3 sentences. Natural tone. First person from ${persona}.
From: ${email.fromAddress}
Subject: ${email.subject}
Body:
${bodyText.slice(0, 1500)}`;
}

// ── Exported async functions ───────────────────────────────────

/** Generate AI summaries and reply drafts for emails that already have a funnel stage
 *  (e.g., VIP emails classified by rules engine). Does NOT reclassify.
 *  emailBodies: map of email ID → full body text (fetched by caller) */
export async function generateContextForEmails(
  emails: RawEmail[],
  emailBodies?: Map<string, string>,
): Promise<Map<string, { summary: string; replyDraft?: string }>> {
  const resultMap = new Map<string, { summary: string; replyDraft?: string }>();
  if (emails.length === 0) return resultMap;

  // Step 1: Batch classify to get summaries (fast model)
  try {
    const prompt = buildClassificationPrompt(emails);
    const response = await callLLM(
      "You are an email classification assistant. Return only valid JSON array.",
      prompt,
      "classify",
    );
    const parsed = parseAIClassificationResponse(response);
    for (const [id, result] of parsed) {
      resultMap.set(id, { summary: result.reason });
    }
  } catch {
    for (const email of emails) {
      resultMap.set(email.id, { summary: "" });
    }
  }

  // Step 2: Generate reply drafts IN PARALLEL (smart model)
  const draftPromises = emails.map(async (email) => {
    try {
      const body = emailBodies?.get(email.id);
      const draftPrompt = buildReplyDraftPrompt(email, body);
      const draft = await callLLM(
        "You are a professional email assistant. Write concise reply drafts.",
        draftPrompt,
        "draft",
        512,
      );
      return { id: email.id, draft: draft.trim() };
    } catch {
      return { id: email.id, draft: "" };
    }
  });

  const draftResults = await Promise.all(draftPromises);
  for (const { id, draft } of draftResults) {
    if (draft) {
      const existing = resultMap.get(id) ?? { summary: "" };
      existing.replyDraft = draft;
      resultMap.set(id, existing);
    }
  }

  return resultMap;
}

/** Classify emails in a single batch call. Does NOT generate drafts — caller handles that. */
export async function batchClassifyEmails(
  emails: RawEmail[],
): Promise<Map<string, AIClassificationResult>> {
  const resultMap = new Map<string, AIClassificationResult>();
  if (emails.length === 0) return resultMap;

  try {
    const prompt = buildClassificationPrompt(emails);
    const response = await callLLM(
      "You are an email classification assistant. Return only valid JSON array.",
      prompt,
      "classify",
    );
    const parsed = parseAIClassificationResponse(response);

    for (const [id, result] of parsed) {
      resultMap.set(id, result);
    }
  } catch {
    for (const email of emails) {
      resultMap.set(email.id, { ...FALLBACK_RESULT });
    }
    return resultMap;
  }

  // Fill in any missing emails with fallback
  for (const email of emails) {
    if (!resultMap.has(email.id)) {
      resultMap.set(email.id, { ...FALLBACK_RESULT });
    }
  }

  return resultMap;
}
