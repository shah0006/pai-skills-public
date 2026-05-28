// web/tests/web-build-resolution.test.ts — static `import … from` / export-from relative paths in API routes (not dynamic import()).
// (Next dev/build module resolution). Complements root tests/ which do not run Turbopack.

import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";

const WEB_ROOT = join(import.meta.dirname, "..");
const REPO_ROOT = join(WEB_ROOT, "..");
const API_ROOT = join(WEB_ROOT, "app", "api");

function* walkRouteFiles(dir: string): Generator<string> {
	for (const ent of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, ent.name);
		if (ent.isDirectory()) yield* walkRouteFiles(p);
		else if (ent.isFile() && ent.name === "route.ts") yield p;
	}
}

function physicalModulePath(resolvedNoExt: string): string | null {
	const candidates = [
		resolvedNoExt,
		`${resolvedNoExt}.ts`,
		`${resolvedNoExt}.tsx`,
		`${resolvedNoExt}.mts`,
		join(resolvedNoExt, "index.ts"),
		join(resolvedNoExt, "index.tsx"),
	];
	for (const c of candidates) {
		if (existsSync(c) && statSync(c).isFile()) return c;
	}
	return null;
}

function collectRelativeSpecifiers(source: string): string[] {
	const out = new Set<string>();
	const patterns = [
		/from\s+["'](\.[^"']+)["']/g,
		/export\s+[^;]*?from\s+["'](\.[^"']+)["']/g,
	];
	for (const re of patterns) {
		re.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = re.exec(source)) !== null) out.add(m[1]);
	}
	return [...out];
}

function assertUnderAllowedRoots(abs: string): void {
	const norm = normalize(abs);
	const webNorm = normalize(WEB_ROOT);
	const repoNorm = normalize(REPO_ROOT);
	if (!norm.startsWith(webNorm) && !norm.startsWith(repoNorm)) {
		throw new Error(`Resolved import escapes web/ and repo root: ${norm}`);
	}
}

describe("web/app/api route module resolution", () => {
	test("every relative import in route.ts files resolves to an existing module file", () => {
		const failures: string[] = [];
		for (const routeFile of walkRouteFiles(API_ROOT)) {
			const src = readFileSync(routeFile, "utf8");
			for (const spec of collectRelativeSpecifiers(src)) {
				const baseDir = dirname(routeFile);
				const resolved = normalize(resolve(baseDir, spec));
				try {
					assertUnderAllowedRoots(resolved);
				} catch (e) {
					failures.push(`${routeFile}: ${spec} -> ${e instanceof Error ? e.message : e}`);
					continue;
				}
				const hit = physicalModulePath(resolved);
				if (!hit) failures.push(`${routeFile}: missing target for "${spec}" (resolved ${resolved})`);
			}
		}
		expect(failures, failures.join("\n")).toEqual([]);
	});
});
