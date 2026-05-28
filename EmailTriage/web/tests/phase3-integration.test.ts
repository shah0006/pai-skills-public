// Phase 3 regression tests: mailbox contract, VIP parse + tab bucket, Open button DOM

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { chmodSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseTriageNoteToSession } from "../server/parse-triage-note";
import type { ClassifiedEmail, EmailPriority } from "../../Tools/Types";
import { OpenInClientButton } from "../app/components/OpenInClientButton";

const PROCESS_PRIORITIES: EmailPriority[] = ["action", "unknown", "review"];

function inToProcessTab(e: ClassifiedEmail): boolean {
  return PROCESS_PRIORITIES.includes(e.priority);
}

const FIXTURE_NOTE = `---
date: 2026-05-18
---

# Email Triage - 2026-05-18

42 emails | 0 unread | Est. review: 10

## Stage 1: VIP
#### [11111](message://x) VIPSender [VIP] [i] -- 2026-05-18
**VIP subject line**

#### [19e425347b9b6634](message://z) GmailSender [VIP] [g] -- 2026-05-18
**Gmail VIP subject line**

## Stage 5: Bulk Dispose
| ID | Sender | Subject | A | T | U | BD | BS |
|----|--------|---------|---|---|---|----|----|
| 22222 | BulkCo | BulkSubj |  | x |  |  |  |

## Stage 6: Auto-Processed
- [x] [33333](message://y) AutoSender -- AutoSubj (auto-rule)
`;

describe("parseTriageNoteToSession (stage-review / parse-note shared)", () => {
  test("ingests VIP #### rows and Stage 6 checkboxes; VIP lands in To Process tab bucket", () => {
    const session = parseTriageNoteToSession(FIXTURE_NOTE, "2026-05-18");
    const byId = new Map(session.emails.map((e) => [e.id, e]));

    const vip = byId.get("11111");
    expect(vip).toBeDefined();
    expect(vip!.funnelStage).toBe("vip");
    expect(vip!.priority).toBe("action");
    expect(inToProcessTab(vip!)).toBe(true);

    const gmailVip = byId.get("19e425347b9b6634");
    expect(gmailVip).toBeDefined();
    expect(gmailVip!.funnelStage).toBe("vip");
    expect(gmailVip!.from).toBe("GmailSender");
    expect(gmailVip!.priority).toBe("action");
    expect(inToProcessTab(gmailVip!)).toBe(true);

    const bulk = byId.get("22222");
    expect(bulk?.funnelStage).toBe("bulk_dispose");
    expect(bulk?.priority).toBe("trash");

    const auto = byId.get("33333");
    expect(auto?.funnelStage).toBe("auto_processed");
    expect(auto?.priority).toBe("archive");

    const processCount = session.emails.filter(inToProcessTab).length;
    const automatedCount = session.emails.filter((e) => ["archive", "trash", "unsub"].includes(e.priority)).length;
    expect(processCount).toBeGreaterThanOrEqual(2);
    expect(automatedCount).toBe(2);
    expect(session.emails.length).toBe(4);
  });
});

describe("GET /api/email/:id — apple-mail --mailbox contract", () => {
  let prevApple: string | undefined;
  let mockPath: string;

  beforeAll(() => {
    prevApple = process.env.EMAILTRIAGE_APPLE_MAIL_SH;
    mockPath = join(process.env.TMPDIR || "/tmp", `apple-mail-contract-${Date.now()}.sh`);
    const bash = [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'cmd="${1:-}"',
      'if [[ "$cmd" != "read" && "$cmd" != "mark-unread" ]]; then',
      '  echo "unexpected argv: $*" >&2',
      "  exit 1",
      "fi",
      'if [[ "$*" != *--mailbox* ]]; then',
      '  echo "contract: --mailbox is required" >&2',
      "  exit 2",
      "fi",
      'if [[ "$cmd" == "read" ]]; then',
      '  echo "Subject: Contract"',
      '  echo "From: c@t.com"',
      '  echo "==="',
      '  echo "MAILBOX_OK"',
      "fi",
      "exit 0",
      "",
    ].join("\n");
    writeFileSync(mockPath, bash, "utf8");
    chmodSync(mockPath, 0o755);
    process.env.EMAILTRIAGE_APPLE_MAIL_SH = mockPath;
  });

  afterAll(() => {
    if (prevApple === undefined) delete process.env.EMAILTRIAGE_APPLE_MAIL_SH;
    else process.env.EMAILTRIAGE_APPLE_MAIL_SH = prevApple;
    try {
      unlinkSync(mockPath);
    } catch { /* ignore */ }
  });

  test("forwards ?mailbox= to apple-mail wrapper (numeric id)", async () => {
    const { GET } = await import("../app/api/email/[id]/route");
    const mb = encodeURIComponent("i/Stages/Stage 5 - Bulk Dispose");
    const req = new Request(`http://localhost:9988/api/email/12345?mailbox=${mb}`);
    const res = await GET(req, { params: Promise.resolve({ id: "12345" }) });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { body?: string; error?: string };
    expect(data.error).toBeUndefined();
    expect(data.body).toContain("MAILBOX_OK");
  });
});

describe("OpenInClientButton", () => {
  test("renders data-testid for QA / DOM contract", () => {
    const html = renderToStaticMarkup(
      createElement(OpenInClientButton, { onClick: () => {} }),
    );
    expect(html).toContain('data-testid="open-in-client"');
    expect(html.toLowerCase()).toContain("open");
  });
});
