// Text for the Search rows, actions and details panel. No @raycast/api import.
import type { BookmarkRow } from "../store/types";

/** "#rust #read +2": the first two tags, then the overflow count. */
export function tagText(tags: string[], shown = 2): string | undefined {
  if (tags.length === 0) return undefined;
  const head = `#${tags.slice(0, shown).join(" #")}`;
  return tags.length > shown ? `${head} +${tags.length - shown}` : head;
}

/** `[title](url)`, with `[`, `]` and `\` escaped in the title and `(`, `)`, spaces encoded in the URL. */
export function markdownLink(title: string, url: string): string {
  const text = (title.trim() || url).replace(/[\\[\]]/g, (c) => `\\${c}`).replace(/\s+/g, " ");
  const target = url.replace(/\(/g, "%28").replace(/\)/g, "%29").replace(/ /g, "%20");
  return `[${text}](${target})`;
}

/** The bookmark in the Raindrop web app. */
export function webAppUrl(row: Pick<BookmarkRow, "id" | "collectionId">): string {
  return `https://app.raindrop.io/my/${row.collectionId}/item/${row.id}/web`;
}

/** "2026-10-01" from an ISO time; the raw text when it does not parse; "" when empty. */
export function shortDate(iso: string): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : iso;
}

/** Escapes Markdown control characters at line starts, so a note cannot turn into a heading or list. */
function plain(text: string): string {
  return text
    .trim()
    .split(/\r?\n/)
    .map((line) => line.replace(/^(\s*)([#>*+-]|\d+\.)/, "$1\\$2"))
    .join("  \n");
}

/** The details panel Markdown: excerpt, note, then highlights with their notes. */
export function detailMarkdown(row: Pick<BookmarkRow, "title" | "link" | "excerpt" | "note" | "highlights">): string {
  const parts: string[] = [`## ${plain(row.title || row.link)}`];
  if (row.excerpt.trim()) parts.push(plain(row.excerpt));
  if (row.note.trim()) parts.push(`**Note**\n\n${plain(row.note)}`);
  if (row.highlights.length > 0) {
    const items = row.highlights.map((h) => {
      const quote = `> ${plain(h.text).replace(/ {2}\n/g, "  \n> ")}`;
      return h.note?.trim() ? `${quote}\n\n${plain(h.note)}` : quote;
    });
    parts.push(`**Highlights**\n\n${items.join("\n\n")}`);
  }
  if (parts.length === 1) parts.push("No excerpt, note or highlight.");
  return parts.join("\n\n");
}

/** "Synced 5 min ago" for the navigation title. */
export function syncAgo(lastSync: number | undefined, now: number): string {
  if (lastSync === undefined) return "Never synced";
  const minutes = Math.floor((now - lastSync) / 60_000);
  if (minutes < 1) return "Synced just now";
  if (minutes < 60) return `Synced ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Synced ${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `Synced ${days} day${days === 1 ? "" : "s"} ago`;
}
