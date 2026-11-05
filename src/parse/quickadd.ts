// The Quick Add parser. It turns one line such as
// `https://example.com #read ~Dev !fav a good read` into a bookmark draft.
// The symbol tokens follow tinytick's parser (`#tag`, `~"quoted name"`, `!flag`,
// `\` escape), without chrono. Pure TypeScript with no @raycast/api import.
//
// Grammar (plan, "Quick Add grammar"):
//   URL         the first token that parses as an http or https URL; else the clipboard URL; else blocked
//   #tag        a tag; #"long tag" for one with spaces
//   ~Collection a collection; ~"Side projects" for one with spaces. Exact title first, then a unique prefix
//   !fav        important: true
//   \#1         a literal # (or ~, !, ", \) in the title
//   rest        the title; with none, pleaseParse fills it
//   no ~        Unsorted
import { UNSORTED_COLLECTION, type RaindropPatch } from "../api/types";
import { UNSORTED_TITLE } from "../search/collections";
import type { CollectionRow } from "../store/types";
import { httpUrl } from "./link";

export type TokenKind = "url" | "tag" | "collection" | "favorite";

export interface ParsedToken {
  kind: TokenKind;
  /** The input text of the token. */
  text: string;
  /** The value: the link, the tag, the collection name, or "fav". */
  value: string;
}

export interface QuickAddDraft {
  /** The link, from the text or the clipboard. Undefined blocks the save. */
  link?: string;
  linkSource?: "text" | "clipboard";
  /** The title; empty means pleaseParse fills it. */
  title: string;
  tags: string[];
  /** The raw `~` name. Resolve it with resolveTarget(). Undefined means Unsorted. */
  collection?: string;
  favorite: boolean;
  tokens: ParsedToken[];
}

interface RawToken {
  /** `#`, `~` or `!` when the token starts with that symbol, unescaped. */
  lead?: "#" | "~" | "!";
  /** The token text after the lead, with escapes resolved and quotes removed. */
  value: string;
  /** The token as typed. */
  text: string;
  /** The value came from `"…"`. */
  quoted: boolean;
  /** Some character of the value was escaped with `\`. */
  escaped: boolean;
}

const isSpace = (c: string) => /\s/.test(c);

/** Splits the line into tokens: whitespace separates them, `\` escapes one character, `#"…"` and `~"…"` quote. */
export function tokenize(input: string): RawToken[] {
  const out: RawToken[] = [];
  let i = 0;
  while (i < input.length) {
    while (i < input.length && isSpace(input[i])) i++;
    if (i >= input.length) break;
    const start = i;
    let lead: RawToken["lead"];
    let value = "";
    let quoted = false;
    let escaped = false;
    if (input[i] === "#" || input[i] === "~" || input[i] === "!") {
      lead = input[i] as RawToken["lead"];
      i++;
      if ((lead === "#" || lead === "~") && input[i] === '"') {
        quoted = true;
        i++;
        while (i < input.length && input[i] !== '"') {
          if (input[i] === "\\" && i + 1 < input.length) {
            value += input[i + 1];
            escaped = true;
            i += 2;
          } else {
            value += input[i++];
          }
        }
        if (input[i] === '"') i++;
        // Text glued to the closing quote stays part of the name.
        while (i < input.length && !isSpace(input[i])) value += input[i++];
        out.push({ lead, value, text: input.slice(start, i), quoted, escaped });
        continue;
      }
    }
    while (i < input.length && !isSpace(input[i])) {
      if (input[i] === "\\" && i + 1 < input.length && !isSpace(input[i + 1])) {
        value += input[i + 1];
        escaped = true;
        i += 2;
      } else {
        value += input[i++];
      }
    }
    out.push({ lead, value, text: input.slice(start, i), quoted, escaped });
  }
  return out;
}

export interface ParseOptions {
  /** The clipboard text. Used when the line holds no URL. */
  clipboard?: string;
}

export function parseQuickAdd(input: string, options: ParseOptions = {}): QuickAddDraft {
  const draft: QuickAddDraft = { title: "", tags: [], favorite: false, tokens: [] };
  const words: string[] = [];
  for (const t of tokenize(input)) {
    if (t.lead === "#" && t.value.trim()) {
      const tag = t.value.trim();
      if (!draft.tags.some((x) => x.toLowerCase() === tag.toLowerCase())) draft.tags.push(tag);
      draft.tokens.push({ kind: "tag", text: t.text, value: tag });
    } else if (t.lead === "~" && t.value.trim()) {
      // The last ~ wins.
      draft.collection = t.value.trim();
      draft.tokens.push({ kind: "collection", text: t.text, value: draft.collection });
    } else if (t.lead === "!" && t.value.toLowerCase() === "fav") {
      draft.favorite = true;
      draft.tokens.push({ kind: "favorite", text: t.text, value: "fav" });
    } else if (!t.lead && !t.escaped && draft.link === undefined && httpUrl(t.value)) {
      draft.link = t.value;
      draft.linkSource = "text";
      draft.tokens.push({ kind: "url", text: t.text, value: t.value });
    } else {
      words.push(`${t.lead ?? ""}${t.quoted ? `"${t.value}"` : t.value}`);
    }
  }
  draft.title = words.join(" ").trim();
  if (draft.link === undefined && httpUrl(options.clipboard)) {
    draft.link = options.clipboard!.trim();
    draft.linkSource = "clipboard";
  }
  return draft;
}

export type Target = { ok: true; id: number; title: string } | { ok: false; error: string };

/**
 * The collection for a `~` name: Unsorted with no name; else the one collection whose title
 * equals it (case-insensitive), else the one whose title starts with it. No match, or two
 * matches, blocks the save. "Unsorted" means Unsorted when no collection has that title.
 */
export function resolveTarget(name: string | undefined, collections: CollectionRow[]): Target {
  if (name === undefined) return { ok: true, id: UNSORTED_COLLECTION, title: UNSORTED_TITLE };
  const want = name.trim().toLowerCase();
  const exact = collections.filter((c) => c.title.toLowerCase() === want);
  if (exact.length === 1) return { ok: true, id: exact[0].id, title: exact[0].title };
  if (exact.length > 1) return { ok: false, error: `"${name}" matches ${exact.length} collections named ${exact[0].title}` };
  if (want === UNSORTED_TITLE.toLowerCase()) return { ok: true, id: UNSORTED_COLLECTION, title: UNSORTED_TITLE };
  const prefix = collections.filter((c) => c.title.toLowerCase().startsWith(want));
  if (prefix.length === 1) return { ok: true, id: prefix[0].id, title: prefix[0].title };
  if (prefix.length === 0) return { ok: false, error: `No collection named "${name}"` };
  return { ok: false, error: `"${name}" matches ${prefix.length} collections: ${prefix.map((c) => c.title).join(", ")}` };
}

/** Why the draft cannot be saved, or undefined when it can. */
export function blockReason(draft: QuickAddDraft, target: Target): string | undefined {
  if (!target.ok) return target.error;
  if (!draft.link) return "No URL: type one, or copy one to the clipboard first";
  return undefined;
}

/** The `POST /raindrop` body. An empty title is left out, so pleaseParse fills it. */
export function draftToPatch(draft: QuickAddDraft, collectionId: number): RaindropPatch {
  const patch: RaindropPatch = { link: draft.link, collection: { $id: collectionId }, pleaseParse: {} };
  if (draft.title) patch.title = draft.title;
  if (draft.tags.length) patch.tags = draft.tags;
  if (draft.favorite) patch.important = true;
  return patch;
}

/** The `~name` being typed at the end of the line, for collection autocomplete. */
export function trailingCollection(text: string): { query: string; start: number } | undefined {
  const quoted = /(?:^|\s)~"([^"]*)$/.exec(text);
  if (quoted) return { query: quoted[1].toLowerCase(), start: text.length - quoted[1].length - 2 };
  const m = /(?:^|\s)~([^\s"]*)$/.exec(text);
  if (!m) return undefined;
  return { query: m[1].toLowerCase(), start: text.length - m[1].length - 1 };
}

/** The `~` token that inserts a collection name, quoted when it has a space or a quote. */
export function collectionToken(title: string): string {
  return /[\s"\\]/.test(title) ? `~"${title.replace(/["\\]/g, (c) => `\\${c}`)}"` : `~${title}`;
}

/** Tags from a comma list, such as the forms' "New Tags" field, plus the picked ones, without repeats. */
export function mergeTags(picked: string[], typed: string): string[] {
  const out: string[] = [];
  for (const tag of [...picked, ...typed.split(",")].map((t) => t.trim().replace(/^#/, "")).filter(Boolean)) {
    if (!out.some((x) => x.toLowerCase() === tag.toLowerCase())) out.push(tag);
  }
  return out;
}
