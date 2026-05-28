import { NextRequest, NextResponse } from "next/server";
import { execSync, execFileSync } from "child_process";
import { join } from "path";
import { readEmailBody } from "../../../../../server/email-read";
import { writeFileSync, unlinkSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";

const APPLE_MAIL_SH = join(
  (process.env.HOME ?? (() => { throw new Error("HOME env var not set"); })()),
  ".claude/skills/AppleMail/Tools/apple-mail.sh",
);

const OLLAMA_URL = "http://localhost:11434/v1/chat/completions";
const OLLAMA_MODEL = "qwen2.5:7b";

// Persona / first-name / full-identity loaded from SKILLCUSTOMIZATIONS at runtime.
// Falls back to neutral generic so the skill is publishable.
function loadPersona(): { firstName: string; fullPersona: string } {
  const envFirst = process.env.EMAILTRIAGE_FIRST_NAME;
  const envPersona = process.env.EMAILTRIAGE_PERSONA;
  if (envFirst && envPersona) return { firstName: envFirst, fullPersona: envPersona };
  try {
    const home = process.env.HOME;
    if (!home) return { firstName: "the user", fullPersona: "the recipient" };
    const prefs = join(home, ".claude/PAI/USER/SKILLCUSTOMIZATIONS/EmailTriage/preferences.yaml");
    if (!existsSync(prefs)) return { firstName: envFirst ?? "the user", fullPersona: envPersona ?? "the recipient" };
    const raw = readFileSync(prefs, "utf8");
    const fnMatch = raw.match(/^\s*first_name\s*:\s*["']?([^"'#\n]+?)["']?\s*(?:#.*)?$/m);
    const personaMatch = raw.match(/^\s*persona\s*:\s*["']?([^"'#\n]+?)["']?\s*(?:#.*)?$/m);
    return {
      firstName: envFirst ?? fnMatch?.[1].trim() ?? "the user",
      fullPersona: envPersona ?? personaMatch?.[1].trim() ?? "the recipient",
    };
  } catch {
    return { firstName: "the user", fullPersona: "the recipient" };
  }
}

// ─── Tool definitions for Claude ─────────────────────────────────────────────

const TOOLS = [
  {
    name: "create_reply_draft",
    description:
      "Write a reply email draft. Call this when you want to compose a response to the email. The text will be placed in the reply editor for the user to review before sending.",
    input_schema: {
      type: "object" as const,
      properties: {
        draft_text: {
          type: "string",
          description: "The full body of the reply email. No subject, salutation, or sign-off.",
        },
      },
      required: ["draft_text"],
    },
  },
  {
    name: "create_calendar_event",
    description:
      "Create a calendar event in macOS Calendar app. Use when the email contains an appointment, meeting, or scheduled activity.",
    input_schema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "Event title" },
        date: { type: "string", description: "Date in YYYY-MM-DD format" },
        time: { type: "string", description: "Start time in HH:MM 24-hour format" },
        duration_minutes: { type: "number", description: "Duration in minutes (default 60)" },
        location: { type: "string", description: "Physical location or address" },
        notes: { type: "string", description: "Additional event notes" },
        calendar: {
          type: "string",
          description: "Calendar name: Personal, Work, Home, Important/Out of Town, etc. Default: Personal",
        },
      },
      required: ["title", "date", "time"],
    },
  },
  {
    name: "move_email",
    description: "Move this email to a specific Apple Mail folder/mailbox.",
    input_schema: {
      type: "object" as const,
      properties: {
        folder: { type: "string", description: "Exact Apple Mail mailbox name (e.g. Evicore, Archive, Later)" },
      },
      required: ["folder"],
    },
  },
  {
    name: "forward_email",
    description: "Forward this email to another email address.",
    input_schema: {
      type: "object" as const,
      properties: {
        to: { type: "string", description: "Recipient email address" },
        note: { type: "string", description: "Optional message to prepend to the forwarded email" },
      },
      required: ["to"],
    },
  },
  {
    name: "add_reminder",
    description: "Add a reminder in macOS Reminders app.",
    input_schema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "Reminder title" },
        due_date: { type: "string", description: "Due date in YYYY-MM-DD format (optional)" },
        notes: { type: "string", description: "Additional notes for the reminder" },
        list: { type: "string", description: "Reminders list name (default: Reminders)" },
      },
      required: ["title"],
    },
  },
];

// ─── Tool execution ───────────────────────────────────────────────────────────

interface ToolResult {
  success: boolean;
  message: string;
}

function runAppleScript(script: string): string {
  const tmp = join(tmpdir(), `pai_osa_${Date.now()}.scpt`);
  try {
    writeFileSync(tmp, script, "utf-8");
    return execFileSync("osascript", [tmp], { encoding: "utf-8", timeout: 45_000 }).trim();
  } finally {
    try { unlinkSync(tmp); } catch { /* ignore */ }
  }
}

function executeTool(
  name: string,
  input: Record<string, unknown>,
  emailId: string,
): ToolResult {
  try {
    switch (name) {
      case "create_calendar_event": {
        const title = String(input.title ?? "");
        const dateStr = String(input.date ?? "");
        const timeStr = String(input.time ?? "");
        const duration = Number(input.duration_minutes ?? 60);
        const location = String(input.location ?? "");
        const notes = String(input.notes ?? "");
        const calendar = String(input.calendar ?? "Personal");

        const [year, month, day] = dateStr.split("-").map(Number);
        const [hour, minute] = timeStr.split(":").map(Number);

        // Escape for AppleScript string literals
        const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

        const script = `
tell application "Calendar"
  set targetCalendar to first calendar whose name is "${esc(calendar)}"
  set startDate to current date
  set year of startDate to ${year}
  set month of startDate to ${month}
  set day of startDate to ${day}
  set hours of startDate to ${hour}
  set minutes of startDate to ${minute}
  set seconds of startDate to 0
  set endDate to startDate + (${duration} * minutes)
  set props to {summary:"${esc(title)}", start date:startDate, end date:endDate}
  if "${esc(location)}" is not "" then set location of props to "${esc(location)}"
  if "${esc(notes)}" is not "" then set description of props to "${esc(notes)}"
  make new event at end of events of targetCalendar with properties props
end tell
return "ok"`;

        runAppleScript(script);
        return {
          success: true,
          message: `Calendar event created: "${title}" on ${dateStr} at ${timeStr}${location ? ` @ ${location}` : ""}`,
        };
      }

      case "move_email": {
        const folder = String(input.folder ?? "");
        execSync(`bash "${APPLE_MAIL_SH}" move ${emailId} "${folder.replace(/"/g, '\\"')}"`, {
          encoding: "utf-8",
          timeout: 45_000,
        });
        return { success: true, message: `Email moved to "${folder}"` };
      }

      case "forward_email": {
        const to = String(input.to ?? "");
        const note = String(input.note ?? "");
        const noteArg = note ? `--body "${note.replace(/"/g, '\\"').replace(/\n/g, " ")}"` : "";
        execSync(`bash "${APPLE_MAIL_SH}" forward ${emailId} --to "${to}" ${noteArg}`, {
          encoding: "utf-8",
          timeout: 20_000,
        });
        return { success: true, message: `Email forwarded to ${to}` };
      }

      case "add_reminder": {
        const title = String(input.title ?? "");
        const dueDate = String(input.due_date ?? "");
        const notes = String(input.notes ?? "");
        const list = String(input.list ?? "Reminders");

        const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

        let duePart = "";
        if (dueDate) {
          const [y, m, d] = dueDate.split("-").map(Number);
          duePart = `set due date of theReminder to date "${m}/${d}/${y} 9:00:00 AM"`;
        }

        const script = `
tell application "Reminders"
  set theList to list "${esc(list)}"
  set theReminder to make new reminder at end of reminders of theList with properties {name:"${esc(title)}"}
  ${duePart}
  ${notes ? `set body of theReminder to "${esc(notes)}"` : ""}
end tell
return "ok"`;

        runAppleScript(script);
        return {
          success: true,
          message: `Reminder added: "${title}"${dueDate ? ` due ${dueDate}` : ""}`,
        };
      }

      case "create_reply_draft":
        // Handled at call site — not a side-effect tool
        return { success: true, message: "Reply draft prepared" };

      default:
        return { success: false, message: `Unknown tool: ${name}` };
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, message: `${name} failed: ${msg}` };
  }
}

// ─── Anthropic agentic draft ──────────────────────────────────────────────────

interface DraftResult {
  draft: string;
  actionsExecuted: string[];
  message: string;
}

async function agenticDraft(
  emailBody: string,
  emailId: string,
  from: string,
  subject: string,
  isVip: boolean,
  context: string,
): Promise<DraftResult> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic();

  const senderCtx = isVip
    ? `${from} is a VIP contact (family or close colleague) — warm and personal tone.`
    : `Sender: ${from}`;

  const { firstName, fullPersona } = loadPersona();

  const systemPrompt = `You are PAI, the personal AI assistant for ${fullPersona}.

Your job: read the email, understand ${firstName}'s context note, and take the appropriate action(s) using the tools available.

${senderCtx}
Subject: ${subject}
Today: ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}

Guidelines:
- If ${firstName} asks to "add to calendar", extract all event details from the email and call create_calendar_event
- If no explicit instruction is given but a reply makes sense, call create_reply_draft
- You may call multiple tools (e.g. add to calendar AND draft a confirmation reply)
- Reply drafts: first person, no salutation, no sign-off, direct and warm
- If ${firstName}'s context changes the reply tone or content, honor that precisely
- For VIP contacts, be warm; for professional contacts, be crisp and professional`;

  const userMessage = `Email received:
---
${emailBody.slice(0, 4000)}
---
${context?.trim() ? `\n${firstName}'s instruction: ${context.trim()}` : "\n(No specific instruction — use your judgment about what to do.)"}`;

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userMessage },
  ];

  const actionsExecuted: string[] = [];
  let draft = "";
  let finalMessage = "";

  // Agentic loop — keep going until no more tool calls
  for (let turn = 0; turn < 5; turn++) {
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: systemPrompt,
      tools: TOOLS,
      messages,
    });

    // Collect any text content as the final message
    for (const block of response.content) {
      if (block.type === "text" && block.text.trim()) {
        finalMessage = block.text.trim();
      }
    }

    if (response.stop_reason === "end_turn") break;
    if (response.stop_reason !== "tool_use") break;

    // Execute all tool calls in this turn
    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      const toolInput = block.input as Record<string, unknown>;

      if (block.name === "create_reply_draft") {
        draft = String(toolInput.draft_text ?? "");
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: "Draft prepared successfully.",
        });
        actionsExecuted.push("Reply draft prepared");
      } else {
        const result = executeTool(block.name, toolInput, emailId);
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: result.message,
          is_error: !result.success,
        });
        actionsExecuted.push(result.message);
      }
    }

    // Continue the loop with tool results
    messages.push({ role: "assistant", content: response.content });
    messages.push({ role: "user", content: toolResults });
  }

  return { draft, actionsExecuted, message: finalMessage };
}

// ─── Ollama fallback (text-only) ──────────────────────────────────────────────

async function ollamaDraft(
  emailBody: string,
  from: string,
  subject: string,
  isVip: boolean,
  context: string,
): Promise<DraftResult> {
  const senderCtx = isVip
    ? `This email is from ${from}, a VIP contact (family or close colleague).`
    : `This email is from ${from}.`;

  const { firstName, fullPersona } = loadPersona();

  const contextSection = context?.trim()
    ? `\n\nAdditional context from ${firstName}: ${context.trim()}`
    : "";

  const prompt = `You are drafting a reply email on behalf of ${fullPersona}.

${senderCtx}
Subject: ${subject}${contextSection}

Email received:
${emailBody.slice(0, 3000)}

Draft a warm, direct, professional reply from ${firstName}'s perspective. Guidelines:
- First person, from ${firstName}
- Address the specific points raised — don't be generic
- Keep it concise (2-5 sentences typically, longer if needed for complex questions)
- Warm but not effusive — ${firstName} is direct and thoughtful
- Do NOT include a subject line, salutation, or sign-off — just the body text
- Do NOT explain what you're doing, just write the reply`;

  const res = await fetch(OLLAMA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 512,
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) throw new Error(`Ollama error: ${res.status}`);
  const data = (await res.json()) as { choices: Array<{ message: { content: string } }> };
  const draft = data.choices?.[0]?.message?.content?.trim() ?? "";

  return { draft, actionsExecuted: [], message: "" };
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const body = await request.json().catch(() => ({}));
    const { from = "", subject = "", isVip = false, context = "", mailbox } = body as {
      from?: string;
      subject?: string;
      isVip?: boolean;
      context?: string;
      mailbox?: string;
    };

    let emailBody: string;
    try {
      const r = readEmailBody(id, { mailbox: typeof mailbox === "string" ? mailbox.trim() || undefined : undefined });
      emailBody = r.body;
    } catch (readErr) {
      const msg = readErr instanceof Error ? readErr.message : String(readErr);
      return NextResponse.json({ error: msg, draft: "", actionsExecuted: [], message: "" }, { status: 500 });
    }

    if (!emailBody) {
      return NextResponse.json({ draft: "", actionsExecuted: [], message: "" });
    }

    // Use agentic Claude when API key is available; fall back to Ollama
    const result = process.env.ANTHROPIC_API_KEY
      ? await agenticDraft(emailBody, id, from, subject, isVip, context)
      : await ollamaDraft(emailBody, from, subject, isVip, context);

    return NextResponse.json(result);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg, draft: "", actionsExecuted: [], message: "" }, { status: 500 });
  }
}
