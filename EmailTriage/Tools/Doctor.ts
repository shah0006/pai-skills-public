#!/usr/bin/env bun
/**
 * Doctor.ts — generic real-probe Doctor (Phase 1 placeholder).
 * Replace per-skill probes with content from ~/.claude/skills/Doctor/References/PerSkillProbeMap.md
 * once the per-skill probe map entry exists.
 */
import { existsSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { execSync } from "node:child_process"

const SKILL_DIR = dirname(import.meta.dir)
const checks: { name: string; ok: boolean; detail: string }[] = []

function tryExec(cmd: string): { ok: boolean; out: string } {
  try {
    const out = execSync(cmd, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim()
    return { ok: true, out }
  } catch {
    return { ok: false, out: "" }
  }
}

// Probe 1: SKILL.md present and non-empty
const skillMd = join(SKILL_DIR, "SKILL.md")
const skillMdOk = existsSync(skillMd) && statSync(skillMd).size > 0
checks.push({ name: "SKILL.md present", ok: skillMdOk, detail: skillMd })

// Probe 2: Workflows/ directory present
const wfDir = join(SKILL_DIR, "Workflows")
checks.push({ name: "Workflows/ present", ok: existsSync(wfDir), detail: wfDir })

// Probe 3: Tools/ directory present
const tlDir = join(SKILL_DIR, "Tools")
checks.push({ name: "Tools/ present", ok: existsSync(tlDir), detail: tlDir })

// Probe 4: bun on PATH
const bun = tryExec("bun --version")
checks.push({ name: "bun on PATH", ok: bun.ok, detail: bun.out })

const failed = checks.filter((c) => !c.ok)
console.log(JSON.stringify({ checks, passed: failed.length === 0 }, null, 2))
process.exit(failed.length === 0 ? 0 : 1)
