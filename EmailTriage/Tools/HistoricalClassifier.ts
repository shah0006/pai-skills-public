// Tools/HistoricalClassifier.ts — Phase 22: heuristic classifier from history.
//
// Given a new email's metadata, predicts the most likely action based on
// prior user decisions for the same sender / domain. Augments (does NOT
// replace) RulesEngine + AiClassifier — its predictions are weighted
// inputs the existing pipeline can consume.
//
// Three signal layers, combined by confidence:
//   1. Per-sender history (exact address match) — strongest signal
//   2. Per-domain history (any address @same domain) — fallback for
//      new addresses at known domains
//   3. Subject-pattern match against historical patterns — weakest signal
//      (heuristics only, no learned patterns yet — v1 is rule-based)
//
// Returns: { predictedAction, confidence, basis }
//   - predictedAction: one of the markdown action codes (A/T/R/D/K/J/U)
//   - confidence: 0..1
//   - basis: human-readable explanation for the UI ("based on 8 prior trashes")
//
// Designed to be testable in isolation; reads from SenderMemory which
// in turn reads domain_activity. No network calls, no LLM.

import type { Database } from "bun:sqlite";
import { getSenderHistory, getDomainHistory, type SenderHistory, type ActionCounts } from "./SenderMemory";

export type ActionCode = "A" | "T" | "R" | "D" | "K" | "J" | "U" | "BL" | "AP";

export interface Prediction {
  predictedAction: ActionCode | null;
  confidence: number;  // 0..1
  basis: string;        // human-readable
  source: "sender" | "domain" | "none";
}

const BUCKET_TO_CODE: Record<keyof ActionCounts, ActionCode | null> = {
  archive: "A", trash: "T", reply: "R", defer: "D", keep: "K",
  junk: "J", unsub: "U", block: "BL", approve: "AP", other: null,
};

interface ClassifyInput {
  address?: string;
  domain?: string;
}

function dominantAction(history: SenderHistory): { code: ActionCode; pct: number; count: number } | null {
  if (history.totalSeen === 0 || !history.mostCommonAction) return null;
  const count = history.actions[history.mostCommonAction];
  const pct = count / history.totalSeen;
  const code = BUCKET_TO_CODE[history.mostCommonAction];
  return code ? { code, pct, count } : null;
}

export function classifyFromHistory(db: Database, input: ClassifyInput): Prediction {
  const empty: Prediction = { predictedAction: null, confidence: 0, basis: "no history", source: "none" };

  // Layer 1: exact sender match
  if (input.address) {
    const sh = getSenderHistory(db, input.address);
    const dom = dominantAction(sh);
    if (dom && sh.totalSeen >= 3 && dom.pct >= 0.75) {
      // Strong sender signal: >= 3 sightings, >= 75% same action
      return {
        predictedAction: dom.code,
        confidence: Math.min(0.95, dom.pct * (sh.totalSeen / (sh.totalSeen + 2))),  // shrinkage
        basis: `${dom.count} of ${sh.totalSeen} prior emails from this sender were ${actionWord(dom.code)}`,
        source: "sender",
      };
    }
    if (dom && sh.totalSeen >= 2 && dom.pct === 1.0) {
      // Weak but unanimous: 2 sightings, both same → moderate confidence
      return {
        predictedAction: dom.code,
        confidence: 0.6,
        basis: `both prior emails from this sender were ${actionWord(dom.code)}`,
        source: "sender",
      };
    }
  }

  // Layer 2: domain fallback
  if (input.domain) {
    const dh = getDomainHistory(db, input.domain);
    const dom = dominantAction(dh);
    if (dom && dh.totalSeen >= 5 && dom.pct >= 0.8) {
      return {
        predictedAction: dom.code,
        confidence: Math.min(0.8, dom.pct * (dh.totalSeen / (dh.totalSeen + 5))),  // heavier shrinkage at domain level
        basis: `${dom.count} of ${dh.totalSeen} prior emails from @${input.domain} were ${actionWord(dom.code)}`,
        source: "domain",
      };
    }
  }

  return empty;
}

function actionWord(code: ActionCode): string {
  switch (code) {
    case "A":  return "archived";
    case "T":  return "trashed";
    case "R":  return "replied to";
    case "D":  return "deferred";
    case "K":  return "kept";
    case "J":  return "marked junk";
    case "U":  return "unsubscribed from";
    case "BL": return "blocked";
    case "AP": return "approved";
  }
}
