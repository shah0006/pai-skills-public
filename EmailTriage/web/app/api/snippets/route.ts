import { NextResponse } from "next/server";
import { join } from "path";
import { readFileSync } from "fs";
import yaml from "js-yaml";

const SNIPPETS_PATH = join(
  (process.env.HOME ?? (() => { throw new Error("HOME env var not set"); })()),
  ".claude/skills/EmailTriage/References/snippets.yaml"
);

export async function GET() {
  try {
    const text = readFileSync(SNIPPETS_PATH, "utf-8");
    const raw = yaml.load(text) as { snippets: Array<{ id: string; label: string; text: string }> };
    return NextResponse.json({ snippets: raw.snippets ?? [] });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg, snippets: [] }, { status: 500 });
  }
}
