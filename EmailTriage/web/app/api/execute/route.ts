// POST /api/execute
//
// Two accepted payload shapes:
//
//   A. Typed (preferred — used by Process Marked / Process All):
//      { items: Array<{ id, account, actionCodes, replyDraft?, sender?, subject?, notes?, funnelStage? }> }
//      Each item is run via ExecuteTriage.applyActions which actually invokes Mail.app + writes email_actions.
//
//   B. Legacy noteContent (kept for backward compat):
//      { noteContent: string }
//      Runs buildExecutionPlan. NOTE: this path historically returned the plan WITHOUT executing it —
//      callers that need real execution must use shape A.
//
// Returns: { success: true, summary: ExecutionSummary, errors?: string[] }
//
// Codified 2026-05-19 after UX-12: prior implementation only built the plan, never ran it. The UI's
// Process buttons were visually convincing no-ops. This route now actually executes when shape A is used.

import { NextResponse } from "next/server";
import type { ActionItem } from "../../../../Tools/ExecuteTriage";

export const dynamic = "force-dynamic";

export interface ExecutionSummary {
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
  errors?: string[];
}

interface TypedPayloadItem {
  id: string;
  actionCodes: string[];
  account?: string;
  replyDraft?: string;
  sender?: string;
  subject?: string;
  notes?: string;
  funnelStage?: string;
}

interface TypedPayload {
  items: TypedPayloadItem[];
}

interface LegacyPayload {
  noteContent: string;
}

function isTypedPayload(body: unknown): body is TypedPayload {
  return !!body && typeof body === "object" && Array.isArray((body as TypedPayload).items);
}

function isLegacyPayload(body: unknown): body is LegacyPayload {
  return !!body && typeof body === "object" && typeof (body as LegacyPayload).noteContent === "string";
}

export async function POST(req: Request) {
  try {
    const body = await req.json();

    // Shape A — typed payload, actually executes
    if (isTypedPayload(body)) {
      const { applyActions } = await import("../../../../Tools/ExecuteTriage");
      const actions: ActionItem[] = body.items.map((it) => ({
        id: it.id,
        actionCodes: it.actionCodes,
        replyDraft: it.replyDraft,
        sender: it.sender,
        subject: it.subject,
        notes: it.notes,
        account: it.account as ActionItem["account"],
        funnelStage: it.funnelStage as ActionItem["funnelStage"],
        source: "table",
      }));
      const result = await applyActions(actions);
      const summary: ExecutionSummary = {
        archived: result.archive,
        trashed: result.trash,
        replied: result.reply,
        unsubscribed: result.unsub,
        blocked: result.block,
        junked: result.junk,
        kept: result.keep,
        deferred: result.defer,
        approved: result.approve,
        total: result.total,
      };
      const responseBody: { success: boolean; summary: ExecutionSummary; errors?: string[] } = {
        success: result.errors.length === 0,
        summary,
      };
      if (result.errors.length > 0) responseBody.errors = result.errors;
      return NextResponse.json(responseBody);
    }

    // Shape B — legacy noteContent (plan only, no execution; kept for back-compat)
    if (isLegacyPayload(body)) {
      const { buildExecutionPlan } = await import("../../../../Tools/ExecuteTriage");
      const plan = buildExecutionPlan(body.noteContent);
      const summary: ExecutionSummary = {
        archived: plan.summary.archive ?? 0,
        trashed: plan.summary.trash ?? 0,
        replied: plan.summary.reply ?? 0,
        unsubscribed: plan.summary.unsub ?? 0,
        blocked: plan.summary.block ?? 0,
        junked: plan.summary.junk ?? 0,
        kept: plan.summary.keep ?? 0,
        deferred: plan.summary.defer ?? 0,
        approved: plan.summary.approve ?? 0,
        total: plan.actions.length,
      };
      return NextResponse.json({
        success: true,
        summary,
        warning: "noteContent path builds the plan but does not execute — use {items:[...]} payload to actually run actions.",
      });
    }

    return NextResponse.json(
      { error: "Body must be { items: ActionItem[] } or { noteContent: string }" },
      { status: 400 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
