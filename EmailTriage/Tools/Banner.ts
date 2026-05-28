// Banner.ts — Obsidian warning callouts for pre-cron / reconciler messages

const BANNER_PREFIX = "> [!warning]";

export function formatWarningBanner(title: string, lines: string[]): string {
  const body = lines.filter(Boolean).map(l => `> ${l}`).join("\n");
  return `${BANNER_PREFIX} ${title}\n${body}\n`;
}

/** Merge multiple banner blocks; dedupe identical lines. */
export function mergeBanners(...parts: (string | undefined)[]): string | undefined {
  const chunks = parts.map(p => p?.trim()).filter(Boolean) as string[];
  if (chunks.length === 0) return undefined;
  if (chunks.length === 1) return chunks[0];
  return chunks.join("\n\n");
}

/** Inject banner after YAML frontmatter (first --- block pair). */
export function injectBannerAfterFrontmatter(markdown: string, banner: string): string {
  const trimmed = banner.trim();
  if (!trimmed) return markdown;
  const end = markdown.indexOf("\n---\n", 4);
  if (end === -1) return `${trimmed}\n\n${markdown}`;
  const insertAt = end + 5;
  return markdown.slice(0, insertAt) + `\n${trimmed}\n` + markdown.slice(insertAt);
}

/** Remove existing warning callouts (pre-cron / reconciler) before re-inject. */
export function stripOperationalBanners(markdown: string): string {
  const lines = markdown.split("\n");
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (line.startsWith("> [!warning]") &&
        (line.includes("Gmail") || line.includes("Reconciler") || line.includes("drift") || line.includes("auth"))) {
      skipping = true;
      continue;
    }
    if (skipping) {
      if (line.startsWith("> ") && !line.startsWith("> [!")) continue;
      skipping = false;
    }
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}
