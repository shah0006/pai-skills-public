// ~/.claude/skills/EmailTriage/rules-engine.ts
// Deterministic rules-based email classification
// All data comes from SQLite via ClassificationCache (loaded once per run)

import type { RawEmail, ClassifiedEmail, FunnelStage } from "./Types";
import type { RoutingRuleRow } from "./Db";

export interface ClassificationCache {
  vipSenders: Set<string>;       // lowercase addresses
  junkAddresses: Set<string>;    // lowercase addresses
  junkDomains: Set<string>;      // lowercase domains
  routingRules: RoutingRuleRow[];
  knownSenders: Set<string>;     // lowercase addresses
}

function actionToPriority(action: string): ClassifiedEmail["priority"] {
  switch (action) {
    case "archive": return "archive";
    case "trash": return "trash";
    case "unsub": return "unsub";
    case "review": return "review";
    default: return "review";
  }
}

/** Map rule-based classifications to funnel stages */
function ruleFunnelStage(priority: ClassifiedEmail["priority"]): FunnelStage {
  switch (priority) {
    case "archive": return "auto_processed";
    case "trash": return "auto_processed";
    case "unsub": return "auto_processed";
    case "action": return "action";
    case "review": return "informational";
    default: return "informational";
  }
}

export function classifyEmail(
  email: RawEmail,
  cache: ClassificationCache,
): ClassifiedEmail {
  const base: ClassifiedEmail = {
    ...email,
    priority: "review",
    funnelStage: "informational",
    matchedRule: null,
    folder: null,
    replyDraft: null,
    isVip: false,
    isJunk: false,
    isUnknownSender: false,
  };

  const addressLower = email.fromAddress.toLowerCase();
  const domainLower = email.fromDomain.toLowerCase();

  // 1. VIP check
  if (cache.vipSenders.has(addressLower)) {
    return { ...base, priority: "action", funnelStage: "vip", isVip: true, matchedRule: "vip" };
  }

  // 2. Junk by address
  if (cache.junkAddresses.has(addressLower)) {
    return { ...base, priority: "trash", funnelStage: "auto_processed", isJunk: true, matchedRule: `junk:address:${addressLower}` };
  }

  // 3. Junk by domain
  if (cache.junkDomains.has(domainLower)) {
    return { ...base, priority: "trash", funnelStage: "auto_processed", isJunk: true, matchedRule: `junk:domain:${domainLower}` };
  }

  // 4. Routing rules -- check in type-priority order: sender > domain > subject
  const senderRules = cache.routingRules.filter(r => r.ruleType === "sender");
  const domainRules = cache.routingRules.filter(r => r.ruleType === "domain");
  const subjectRules = cache.routingRules.filter(r => r.ruleType === "subject");

  for (const rule of senderRules) {
    if (rule.matchValue === addressLower || rule.matchValue.toLowerCase() === addressLower) {
      const priority = actionToPriority(rule.action);
      return {
        ...base,
        priority,
        funnelStage: ruleFunnelStage(priority),
        folder: rule.folder ?? null,
        matchedRule: `sender:${rule.matchValue}`,
      };
    }
  }

  for (const rule of domainRules) {
    if (rule.matchValue === domainLower || rule.matchValue.toLowerCase() === domainLower) {
      const priority = actionToPriority(rule.action);
      return {
        ...base,
        priority,
        funnelStage: ruleFunnelStage(priority),
        folder: rule.folder ?? null,
        matchedRule: `domain:${rule.matchValue}`,
      };
    }
  }

  for (const rule of subjectRules) {
    if (email.subject.toLowerCase().includes(rule.matchValue.toLowerCase())) {
      const priority = actionToPriority(rule.action);
      return {
        ...base,
        priority,
        funnelStage: ruleFunnelStage(priority),
        folder: rule.folder ?? null,
        matchedRule: `subject:${rule.matchValue}`,
      };
    }
  }

  // 5. Mark unknown senders -- passes through to AI classification
  const isUnknown = !cache.knownSenders.has(addressLower);

  // 6. No rule matched -- needs AI classification
  return {
    ...base,
    priority: "unknown",
    funnelStage: "informational",
    isUnknownSender: isUnknown,
    matchedRule: null,
  };
}
