// Minimal `cn` helper — concatenates truthy class strings.
// Replaces the typical clsx + tailwind-merge pair; we don't have a Tailwind-
// utility-heavy component surface yet (see Phase 25 — Tailwind refactor), so
// this no-merge version is sufficient.
export function cn(...inputs: Array<string | undefined | null | false>): string {
  return inputs.filter(Boolean).join(" ");
}
