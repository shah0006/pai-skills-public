// tests/email-read-batch.test.ts — Phase 30 optimization pass.
//
// Verifies the /api/email/batch concurrency fix: readEmailBodyAsync mirrors the
// synchronous readEmailBody but over async spawn, so the batch route's
// BATCH_SIZE window runs reads truly in parallel instead of strictly serially.
//
// A stub apple-mail.sh (sleeps on `read`) stands in for the real AppleScript
// bridge so the speedup is deterministic and the test needs no live mailbox.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readEmailBodyAsync } from "../web/server/email-read";

const IDS = ["90001", "90002", "90003", "90004", "90005", "90006", "90007", "90008", "90009"];
const MAILBOX = "i/Stages/Stage 5 - Bulk Dispose";
const READ_SLEEP_SEC = "0.06";

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "etr-batch-"));
  const stubPath = join(tmpDir, "stub-apple-mail.sh");
  // `read` sleeps then emits apple-mail.sh format (headers, ===, body).
  // `mark-unread` returns immediately. Mirrors the real script's surface.
  writeFileSync(stubPath, [
    "#!/bin/bash",
    'if [ "$1" = "read" ]; then',
    `  sleep ${READ_SLEEP_SEC}`,
    `  printf 'Subject: Stub %s\\nFrom: stub@test\\n===\\nBODY-%s\\n' "$2" "$2"`,
    "fi",
    "exit 0",
    "",
  ].join("\n"));
  process.env.EMAILTRIAGE_APPLE_MAIL_SH = stubPath;
});

afterAll(() => {
  delete process.env.EMAILTRIAGE_APPLE_MAIL_SH;
  rmSync(tmpDir, { recursive: true, force: true });
});

async function readSequential(ids: string[]): Promise<Record<string, string>> {
  const bodies: Record<string, string> = {};
  for (const id of ids) {
    const { body } = await readEmailBodyAsync(id, { mailbox: MAILBOX });
    bodies[id] = body;
  }
  return bodies;
}

// Mirrors the /api/email/batch loop: a bounded-concurrency window of BATCH_SIZE.
async function readBatched(ids: string[], batchSize = 3): Promise<Record<string, string>> {
  const bodies: Record<string, string> = {};
  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(async (id) => {
      const { body } = await readEmailBodyAsync(id, { mailbox: MAILBOX });
      return { id, body };
    }));
    for (const { id, body } of results) bodies[id] = body;
  }
  return bodies;
}

test("ISC-73: readEmailBodyAsync returns the stub body unchanged", async () => {
  const { body } = await readEmailBodyAsync("90001", { mailbox: MAILBOX });
  expect(body).toBe("BODY-90001");
});

test("ISC-69: batched-concurrent reads are measurably faster than sequential, identical output", async () => {
  const t0 = performance.now();
  const seq = await readSequential(IDS);
  const seqMs = performance.now() - t0;

  const t1 = performance.now();
  const conc = await readBatched(IDS, 3);
  const concMs = performance.now() - t1;

  // ISC-73 (anti): the optimization changes speed, not results.
  expect(conc).toEqual(seq);
  for (const id of IDS) expect(conc[id]).toBe(`BODY-${id}`);

  // ISC-67 baseline + ISC-69 improvement — a 3-wide window over 9 reads is
  // structurally ~3x faster. Assert a conservative 0.6x ceiling.
  console.log(`[optimization] baseline(sequential)=${seqMs.toFixed(0)}ms optimized(concurrent)=${concMs.toFixed(0)}ms ratio=${(concMs / seqMs).toFixed(2)}`);
  expect(concMs).toBeLessThan(seqMs * 0.6);
});
