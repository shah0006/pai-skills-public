// UX-6 (2026-05-19): infer a human-readable "what kind of link is this?" label
// from a URL. Used inline next to URLs surfaced in the AI Insight Panel body
// view, calendar event descriptions, and any other place the UI renders a
// link that's not just chrome.
//
// Returns null when nothing useful can be inferred — caller decides whether to
// render a generic "(Web link)" badge or render nothing at all.

export function inferLinkType(url: string): string | null {
  if (!url) return null;
  let host = "";
  let path = "";
  try {
    const u = new URL(url);
    host = u.host.toLowerCase();
    path = u.pathname.toLowerCase();
  } catch {
    // Not a URL the URL parser can handle — bail.
    return null;
  }

  // Calendar / scheduling
  if (path.endsWith(".ics")) return "Calendar invite — .ics";
  if (/(^|\.)calendly\.com$/.test(host)) return "Calendly scheduling";
  if (/(^|\.)cal\.com$/.test(host)) return "Cal.com scheduling";
  if (host === "calendar.google.com") return "Google Calendar";

  // Meeting links
  if (host.includes("zoom.us")) return "Zoom meeting";
  if (host === "meet.google.com") return "Google Meet";
  if (host.includes("teams.microsoft.com") || host.includes("teams.live.com")) return "Microsoft Teams";
  if (host === "meet.jit.si") return "Jitsi meeting";
  if (host.includes("webex.com")) return "Webex meeting";

  // Documents
  if (path.endsWith(".pdf")) return "PDF";
  if (/\.(docx?|odt|rtf)$/.test(path)) return "Document";
  if (/\.(xlsx?|csv|ods)$/.test(path)) return "Spreadsheet";
  if (/\.(pptx?|odp)$/.test(path)) return "Slides";
  if (/\.(jpe?g|png|gif|webp|heic|svg)$/.test(path)) return "Image";
  if (/\.(mp4|mov|webm|m4v|avi|mkv)$/.test(path)) return "Video";
  if (/\.(mp3|m4a|wav|ogg|flac)$/.test(path)) return "Audio";
  if (/\.(zip|tar|gz|tgz|bz2|7z|rar)$/.test(path)) return "Archive";

  // Forms / surveys
  if (host === "forms.gle" || /^docs\.google\.com$/.test(host) && path.startsWith("/forms")) return "Google Form";
  if (/(^|\.)surveymonkey\.com$/.test(host)) return "SurveyMonkey form";
  if (/(^|\.)typeform\.com$/.test(host)) return "Typeform";
  if (/(^|\.)formstack\.com$/.test(host)) return "Formstack form";

  // Mobile-app deep links
  if (/(^|\.)app\.link$/.test(host)) return "Branch.io deep link";
  if (/(^|\.)onelink\.me$/.test(host)) return "OneLink deep link";
  if (/(^|\.)page\.link$/.test(host)) return "Firebase Dynamic Link";

  // Auth / verification
  if (path.includes("verify") || path.includes("confirm")) return "Verification / confirmation link";
  if (path.includes("unsubscribe")) return "Unsubscribe";

  // Tracking / unsafe
  if (host.includes("click.") || host.includes("link.") || /(^|\.)mailgun\.org$/.test(host)) return "Tracking redirect";

  // Common knowledge surfaces
  if (host === "github.com") return "GitHub";
  if (host === "drive.google.com" || host === "docs.google.com") return "Google Drive";
  if (host.includes("dropbox.com")) return "Dropbox";
  if (host === "notion.so" || /(^|\.)notion\.site$/.test(host)) return "Notion";
  if (host.includes("youtube.com") || host === "youtu.be") return "YouTube";

  // Bare-domain heuristic — looks like a marketing site / company homepage
  if (path === "" || path === "/") return "Website";

  return null;
}

/** Convenience: returns "<url> (<label>)" string when a label can be inferred,
 *  otherwise returns the URL unchanged. Useful in plain-text contexts like
 *  calendar event descriptions.
 */
export function urlWithLabel(url: string): string {
  const label = inferLinkType(url);
  return label ? `${url} (${label})` : url;
}
