import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { runPreCronAuthCheck } from "../Tools/PreCronAuthCheck";
import { getReconcilerBannerPath, getSkillTmpDir } from "../Tools/Reconciler";

describe("runPreCronAuthCheck", () => {
  const origGws = process.env.GWS_BIN;
  const origVoice = process.env.EMAILTRIAGE_DISABLE_VOICE;
  const origSelf = process.env.EMAILTRIAGE_SELF_ADDRESS;

  afterEach(() => {
    if (origGws) process.env.GWS_BIN = origGws;
    else delete process.env.GWS_BIN;
    if (origVoice) process.env.EMAILTRIAGE_DISABLE_VOICE = origVoice;
    else delete process.env.EMAILTRIAGE_DISABLE_VOICE;
    if (origSelf) process.env.EMAILTRIAGE_SELF_ADDRESS = origSelf;
    else delete process.env.EMAILTRIAGE_SELF_ADDRESS;
  });

  test("synthetic auth failure produces banner and skip signal", () => {
    process.env.GWS_BIN = "/usr/bin/false";
    process.env.EMAILTRIAGE_DISABLE_VOICE = "1";
    process.env.EMAILTRIAGE_SELF_ADDRESS = "";
    const r = runPreCronAuthCheck({ skipAlerts: true, includeReconcilerBanner: false });
    expect(r.gmailOk).toBe(false);
    expect(r.banner).toContain("Gmail auth failure");
    expect(r.banner).toContain("gws gmail auth login");
  });

  test("merges reconciler banner when present", () => {
    getSkillTmpDir();
    writeFileSync(getReconcilerBannerPath(), "> [!warning] Reconciler drift\n> test line\n");
    process.env.GWS_BIN = "/usr/bin/false";
    process.env.EMAILTRIAGE_DISABLE_VOICE = "1";
    const r = runPreCronAuthCheck({ skipAlerts: true });
    expect(r.banner).toContain("Reconciler drift");
    expect(r.banner).toContain("Gmail auth failure");
    try { rmSync(getReconcilerBannerPath()); } catch { /* */ }
  });
});
