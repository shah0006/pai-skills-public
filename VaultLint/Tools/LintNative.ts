#!/usr/bin/env bun
/**
 * VaultLint/Tools/LintNative.ts
 *
 * Pure-Bun replacement for Lint.ts. Applies the user's enabled Obsidian Linter
 * rules to a vault Markdown file BY ABSOLUTE PATH, with no Obsidian dependency
 * and no active-tab side effect. Drift-detects: any rule enabled in
 * data.json that this file doesn't implement is a hard error.
 *
 * USAGE:
 *   bun LintNative.ts <absolute-path>
 *   bun LintNative.ts --selftest
 *
 * EXIT: 0 on unchanged|linted, 1 on error
 *
 * STDOUT (one JSON line):
 *   {"status":"unchanged","path":"...","sha":"..."}
 *   {"status":"linted","path":"...","preSha":"...","postSha":"...","diff":"..."}
 *   {"status":"error","path":"...","reason":"..."}
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync } from "fs";
import { createHash } from "crypto";
import { resolve, isAbsolute } from "path";

const VAULT_ROOT = "/Volumes/Hyperdrive 4 Tb/Main Obsidian (Sync)";
const PLUGIN_DATA = `${VAULT_ROOT}/.obsidian/plugins/obsidian-linter/data.json`;
const DIFF_MAX_BYTES = 4_000;

const IMPLEMENTED_RULES = new Set([
	"headings-start-line",
	"convert-bullet-list-markers",
	"ordered-list-style",
	"remove-multiple-spaces",
	"unordered-list-style",
	"convert-spaces-to-tabs",
	"space-after-list-markers",
	"remove-leading-or-trailing-whitespace-on-paste",
]);

type Result =
	| { status: "unchanged"; path: string; sha: string }
	| { status: "linted"; path: string; preSha: string; postSha: string; diff: string }
	| { status: "error"; path: string; reason: string };

interface RuleConfig {
	enabled: boolean;
	[k: string]: unknown;
}
interface CustomRegex {
	label?: string;
	find: string;
	replace: string;
	flags?: string;
	enabled?: boolean;
}
interface PluginData {
	ruleConfigs?: Record<string, RuleConfig>;
	customRegexes?: CustomRegex[];
}

function sha256(s: string): string {
	return createHash("sha256").update(s, "utf-8").digest("hex");
}

function loadEnabledRules(): { enabled: Set<string>; configs: Record<string, RuleConfig>; customRegexes: CustomRegex[] } | { error: string } {
	if (!existsSync(PLUGIN_DATA)) {
		return { error: "plugin-data-not-found" };
	}
	let parsed: PluginData;
	try {
		parsed = JSON.parse(readFileSync(PLUGIN_DATA, "utf-8")) as PluginData;
	} catch (e) {
		return { error: `plugin-data-parse: ${e instanceof Error ? e.message : String(e)}` };
	}
	const configs = parsed.ruleConfigs ?? {};
	const enabled = new Set<string>();
	for (const [k, v] of Object.entries(configs)) {
		if (v && v.enabled === true) enabled.add(k);
	}
	const customRegexes = (parsed.customRegexes ?? []).filter((r) => r && r.enabled === true && r.find);
	return { enabled, configs, customRegexes };
}

// Apply user's custom regex commands (Obsidian Linter "Custom Regex" feature)
// Each entry has find/replace/flags, treated as an unconditional regex
// substitution over the whole document. Upstream applies these AFTER all
// named rules.
function applyCustomRegexes(content: string, regexes: CustomRegex[]): { content: string; failures: string[] } {
	const failures: string[] = [];
	let out = content;
	for (const rx of regexes) {
		try {
			// Obsidian Linter stores `replace` with literal "\n" — we need actual newlines
			const replace = rx.replace.replace(/\\n/g, "\n").replace(/\\t/g, "\t");
			const re = new RegExp(rx.find, rx.flags || "g");
			out = out.replace(re, replace);
		} catch (e) {
			failures.push(`${rx.label || "(unlabeled)"}: ${e instanceof Error ? e.message : String(e)}`);
		}
	}
	return { content: out, failures };
}

// Build a per-line "protected" mask. A line is protected if it falls inside
// YAML frontmatter (top of file only), a fenced code block, or a $$...$$ math
// block. The fence/yaml/math marker line itself is also protected.
function buildProtectionMask(lines: string[]): boolean[] {
	const mask = new Array<boolean>(lines.length).fill(false);
	let inYaml = false;
	let yamlClosed = false;
	let inFence = false;
	let fenceMarker: string | null = null; // "```" or "~~~"
	let inMath = false;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		// YAML frontmatter — only at top of file
		if (i === 0 && line.trimEnd() === "---") {
			inYaml = true;
			mask[i] = true;
			continue;
		}
		if (inYaml) {
			mask[i] = true;
			if (line.trimEnd() === "---") {
				inYaml = false;
				yamlClosed = true;
			}
			continue;
		}
		// Fenced code block
		const fenceMatch = line.match(/^\s*(```+|~~~+)/);
		if (!inFence && fenceMatch) {
			inFence = true;
			fenceMarker = fenceMatch[1];
			mask[i] = true;
			continue;
		}
		if (inFence) {
			mask[i] = true;
			// Closing fence: same marker character, length >= opener, no language tag
			const closeMatch = line.match(/^\s*(```+|~~~+)\s*$/);
			if (closeMatch && fenceMarker && closeMatch[1][0] === fenceMarker[0] && closeMatch[1].length >= fenceMarker.length) {
				inFence = false;
				fenceMarker = null;
			}
			continue;
		}
		// Math block ($$ on its own line — block-level)
		if (line.trim() === "$$") {
			mask[i] = true;
			inMath = !inMath;
			continue;
		}
		if (inMath) {
			mask[i] = true;
			continue;
		}
	}
	void yamlClosed; // intentionally unused — placeholder if we later need first-pass tracking
	return mask;
}

// === RULES ===

// 1. headings-start-line — strip leading whitespace from heading lines
function ruleHeadingsStartLine(lines: string[], protectedMask: boolean[]): string[] {
	return lines.map((line, i) => {
		if (protectedMask[i]) return line;
		const m = line.match(/^(\s+)(#{1,6}\s+\S)/);
		if (m) return line.slice(m[1].length);
		return line;
	});
}

// 2. convert-bullet-list-markers — leading * or + bullet → -
function ruleConvertBulletListMarkers(lines: string[], protectedMask: boolean[]): string[] {
	return lines.map((line, i) => {
		if (protectedMask[i]) return line;
		return line.replace(/^(\s*)([*+])(\s+)/, (_m, indent, _marker, space) => `${indent}-${space}`);
	});
}

// 3. unordered-list-style: "consistent" — pick the FIRST unordered marker in
// the document, normalize the rest. After rule 2, almost everything is "-" so
// this is usually a no-op, but we implement faithfully.
function ruleUnorderedListStyleConsistent(lines: string[], protectedMask: boolean[]): string[] {
	let chosen: string | null = null;
	for (let i = 0; i < lines.length; i++) {
		if (protectedMask[i]) continue;
		const m = lines[i].match(/^(\s*)([-*+])(\s+)/);
		if (m) {
			chosen = m[2];
			break;
		}
	}
	if (!chosen) return lines;
	const target = chosen;
	return lines.map((line, i) => {
		if (protectedMask[i]) return line;
		return line.replace(/^(\s*)([-*+])(\s+)/, (_m, indent, _marker, space) => `${indent}${target}${space}`);
	});
}

// 4. ordered-list-style: number-style=ascending, list-end-style="."
// Renumber consecutive ordered list items (same indent level) starting from
// the first item's number. Normalize end punctuation to ".".
function ruleOrderedListStyle(lines: string[], protectedMask: boolean[]): string[] {
	const out = lines.slice();
	type ListState = { indent: number; nextNum: number };
	const stack: ListState[] = [];

	const orderedRe = /^(\s*)(\d+)([.)])(\s+)(.*)$/;

	function indentOf(s: string): number {
		// Count leading whitespace as "visual columns" — tabs = 4 visual cols, spaces = 1
		let cols = 0;
		for (const ch of s) {
			if (ch === "\t") cols += 4;
			else if (ch === " ") cols += 1;
			else break;
		}
		return cols;
	}

	for (let i = 0; i < lines.length; i++) {
		if (protectedMask[i]) {
			// Reset stack — protected region breaks list continuity
			stack.length = 0;
			continue;
		}
		const line = lines[i];
		const m = line.match(orderedRe);
		if (!m) {
			// Non-list line. Blank line + unindented text breaks lists; just blank
			// alone is allowed within list (loose list). Conservative: any
			// non-list, non-blank, non-indented line resets all lists.
			if (line.trim() === "") {
				// blank — keep stack
			} else {
				const lineIndent = indentOf(line);
				while (stack.length && stack[stack.length - 1].indent >= lineIndent) {
					stack.pop();
				}
				if (lineIndent === 0) stack.length = 0;
			}
			continue;
		}
		const [, indentStr, numStr, , spaceAfter, content] = m;
		const ind = indentOf(indentStr);
		// Pop deeper levels
		while (stack.length && stack[stack.length - 1].indent > ind) stack.pop();
		let state: ListState;
		if (stack.length && stack[stack.length - 1].indent === ind) {
			state = stack[stack.length - 1];
		} else {
			// New list level — first item sets the starting number
			state = { indent: ind, nextNum: parseInt(numStr, 10) };
			stack.push(state);
		}
		const newNum = state.nextNum;
		state.nextNum = newNum + 1;
		out[i] = `${indentStr}${newNum}.${spaceAfter}${content}`;
	}
	return out;
}

// 5. space-after-list-markers — exactly ONE space between marker and content.
// Empty bullets (just "-" with no content) are left alone.
function ruleSpaceAfterListMarkers(lines: string[], protectedMask: boolean[]): string[] {
	return lines.map((line, i) => {
		if (protectedMask[i]) return line;
		// Unordered: -, *, +
		const u = line.match(/^(\s*)([-*+])(\s+)(.*)$/);
		if (u) {
			const [, indent, marker, , rest] = u;
			return `${indent}${marker} ${rest}`;
		}
		// Ordered: \d+. or \d+)
		const o = line.match(/^(\s*)(\d+)([.)])(\s+)(.*)$/);
		if (o) {
			const [, indent, num, end, , rest] = o;
			return `${indent}${num}${end} ${rest}`;
		}
		return line;
	});
}

// 6. remove-multiple-spaces — collapse 2+ internal spaces to one.
// Skips: leading whitespace, inline code (`...`), tables (rows with | and a
// separator row above), trailing-2-spaces line break.
function ruleRemoveMultipleSpaces(lines: string[], protectedMask: boolean[]): string[] {
	// Detect table rows: a line is in a table if it contains '|' AND either
	// it's a separator row (matches /^\s*\|?\s*:?-+:?(\s*\|\s*:?-+:?)+\|?\s*$/),
	// or the previous OR next non-protected line is a separator row.
	const isSepRow = (ln: string): boolean => /^\s*\|?\s*:?-{3,}:?(\s*\|\s*:?-{3,}:?)+\s*\|?\s*$/.test(ln);
	const tableRow = new Array<boolean>(lines.length).fill(false);
	for (let i = 0; i < lines.length; i++) {
		if (isSepRow(lines[i])) {
			tableRow[i] = true;
			if (i - 1 >= 0) tableRow[i - 1] = true;
			let j = i + 1;
			while (j < lines.length && lines[j].includes("|") && lines[j].trim() !== "") {
				tableRow[j] = true;
				j++;
			}
		}
	}

	return lines.map((line, i) => {
		if (protectedMask[i]) return line;
		if (tableRow[i]) return line;
		// Preserve trailing-2-spaces-as-line-break
		const hasSoftBreak = /  $/.test(line) && !/   $/.test(line);
		// Split into leading whitespace + body
		const lead = line.match(/^[ \t]*/)?.[0] ?? "";
		const body = line.slice(lead.length);
		// Walk body, skipping inline code spans
		let out = "";
		let j = 0;
		while (j < body.length) {
			const ch = body[j];
			if (ch === "`") {
				// Find matching backtick run end
				let runLen = 1;
				while (j + runLen < body.length && body[j + runLen] === "`") runLen++;
				const opener = body.slice(j, j + runLen);
				const closeIdx = body.indexOf(opener, j + runLen);
				if (closeIdx === -1) {
					out += body.slice(j);
					j = body.length;
					break;
				}
				out += body.slice(j, closeIdx + runLen);
				j = closeIdx + runLen;
			} else {
				out += ch;
				j++;
			}
		}
		// Now collapse 2+ spaces in 'out', but only outside of code spans (already preserved above)
		// Simple approach: re-walk, skipping code spans again, collapsing in-between
		let collapsed = "";
		let k = 0;
		while (k < out.length) {
			const ch = out[k];
			if (ch === "`") {
				let runLen = 1;
				while (k + runLen < out.length && out[k + runLen] === "`") runLen++;
				const opener = out.slice(k, k + runLen);
				const closeIdx = out.indexOf(opener, k + runLen);
				if (closeIdx === -1) {
					collapsed += out.slice(k);
					break;
				}
				collapsed += out.slice(k, closeIdx + runLen);
				k = closeIdx + runLen;
			} else if (ch === " ") {
				let runLen = 1;
				while (k + runLen < out.length && out[k + runLen] === " ") runLen++;
				collapsed += " ";
				k += runLen;
			} else {
				collapsed += ch;
				k++;
			}
		}
		let result = lead + collapsed;
		// Restore trailing soft break if it was there
		if (hasSoftBreak && !/  $/.test(result)) {
			result = result.replace(/\s*$/, "  ");
		}
		return result;
	});
}

// 7. convert-spaces-to-tabs (tabsize=2) — convert leading-whitespace spaces
// to tabs at the configured tab size. Only leading whitespace.
function ruleConvertSpacesToTabs(lines: string[], protectedMask: boolean[], tabSize: number): string[] {
	return lines.map((line, i) => {
		if (protectedMask[i]) return line;
		const m = line.match(/^([ \t]*)(.*)$/);
		if (!m) return line;
		const [, lead, rest] = m;
		// Walk lead char-by-char, converting groups of `tabSize` spaces to a tab.
		let cols = 0;
		let newLead = "";
		for (const ch of lead) {
			if (ch === "\t") {
				// Flush any pending spaces as their own representation
				newLead += "\t";
				cols = 0;
			} else if (ch === " ") {
				cols++;
				if (cols === tabSize) {
					newLead += "\t";
					cols = 0;
				}
			}
		}
		// Remaining cols < tabSize stay as spaces
		if (cols > 0) newLead += " ".repeat(cols);
		return newLead + rest;
	});
}

// 8. remove-leading-or-trailing-whitespace-on-paste — paste-event-only in
// upstream plugin. No-op at lint-file time.
function rulePasteWhitespaceNoop(lines: string[]): string[] {
	return lines;
}

// === ORCHESTRATION ===

function applyRules(content: string, configs: Record<string, RuleConfig>, customRegexes: CustomRegex[]): { content: string; regexFailures: string[] } {
	// Preserve original line endings
	const eol = content.includes("\r\n") ? "\r\n" : "\n";
	let lines = content.split(/\r\n|\n/);

	let mask = buildProtectionMask(lines);
	lines = ruleHeadingsStartLine(lines, mask);
	lines = ruleConvertBulletListMarkers(lines, mask);
	lines = ruleUnorderedListStyleConsistent(lines, mask);
	lines = ruleOrderedListStyle(lines, mask);
	lines = ruleSpaceAfterListMarkers(lines, mask);
	mask = buildProtectionMask(lines);
	lines = ruleRemoveMultipleSpaces(lines, mask);
	const tabSize = parseInt(String(configs["convert-spaces-to-tabs"]?.tabsize ?? "2"), 10) || 2;
	lines = ruleConvertSpacesToTabs(lines, mask, tabSize);
	lines = rulePasteWhitespaceNoop(lines);

	const merged = lines.join(eol);
	// Custom regexes operate on the whole document, after named rules. Upstream order.
	const { content: out, failures } = applyCustomRegexes(merged, customRegexes);
	return { content: out, regexFailures: failures };
}

function unifiedDiffSnippet(pre: string, post: string): string {
	const preLines = pre.split("\n");
	const postLines = post.split("\n");
	const out: string[] = [];
	const max = Math.max(preLines.length, postLines.length);
	let shown = 0;
	for (let i = 0; i < max && shown < 60; i++) {
		const a = preLines[i] ?? "";
		const b = postLines[i] ?? "";
		if (a !== b) {
			out.push(`- ${a}`);
			out.push(`+ ${b}`);
			shown += 2;
		}
	}
	let s = out.join("\n");
	if (s.length > DIFF_MAX_BYTES) s = s.slice(0, DIFF_MAX_BYTES) + "\n... (truncated)";
	return s || "(no line-level diff produced — likely whitespace-only changes)";
}

function lintFile(absPath: string): Result {
	if (!isAbsolute(absPath)) return { status: "error", path: absPath, reason: "path-not-absolute" };
	const norm = resolve(absPath);
	if (!norm.startsWith(VAULT_ROOT + "/") && norm !== VAULT_ROOT) {
		return { status: "error", path: norm, reason: "path-outside-vault" };
	}
	if (!norm.endsWith(".md")) return { status: "error", path: norm, reason: "path-not-markdown" };
	if (!existsSync(norm)) return { status: "error", path: norm, reason: "file-not-found" };

	const loaded = loadEnabledRules();
	if ("error" in loaded) return { status: "error", path: norm, reason: loaded.error };
	const { enabled, configs, customRegexes } = loaded;
	for (const ruleId of enabled) {
		if (!IMPLEMENTED_RULES.has(ruleId)) {
			return { status: "error", path: norm, reason: `rule-not-implemented: ${ruleId}` };
		}
	}

	const pre = readFileSync(norm, "utf-8");
	const preSha = sha256(pre);
	const { content: post, regexFailures } = applyRules(pre, configs, customRegexes);
	const postSha = sha256(post);
	if (preSha === postSha) return { status: "unchanged", path: norm, sha: preSha };

	writeFileSync(norm, post, "utf-8");
	const diff = unifiedDiffSnippet(pre, post);
	if (regexFailures.length > 0) {
		// Linted, but some custom regexes failed — surface in reason field
		// (kept as 'linted' status since the named rules + working regexes did fire).
		return { status: "linted", path: norm, preSha, postSha, diff: `${diff}\n\n[regex-failures: ${regexFailures.join("; ")}]` };
	}
	return { status: "linted", path: norm, preSha, postSha, diff };
}

function selftest(): Result {
	const testPath = `${VAULT_ROOT}/_VaultLint_Selftest.md`;
	const violating = `---
created: 2026-05-04
modified: 2026-05-04
---
  ## Indented heading

* Bullet with star
+ Bullet with plus
- Bullet with dash

  - Nested with two spaces
1) Ordered with paren
2) Second item

Multiple    spaces    in    text.
`;
	writeFileSync(testPath, violating, "utf-8");
	const result = lintFile(testPath);
	try {
		unlinkSync(testPath);
	} catch {
		/* best-effort */
	}
	return result;
}

async function main(): Promise<void> {
	const arg = process.argv[2];
	if (!arg) {
		process.stderr.write("usage: bun LintNative.ts <absolute-path> | --selftest\n");
		process.exit(1);
	}
	const result = arg === "--selftest" ? selftest() : lintFile(arg);
	process.stdout.write(JSON.stringify(result) + "\n");
	process.exit(result.status === "error" ? 1 : 0);
}

main().catch((e) => {
	process.stdout.write(
		JSON.stringify({ status: "error", path: "", reason: `uncaught: ${e instanceof Error ? e.message : String(e)}` }) + "\n",
	);
	process.exit(1);
});
