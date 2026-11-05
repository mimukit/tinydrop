// The search grammar. It turns the search bar text into a query object; src/store/sql.ts
// turns that object into SQL. No @raycast/api import: vitest runs this in Node.
//
//   #tag  #"long tag"      the bookmark has the tag (case-insensitive)
//   -#tag                  the bookmark does not have the tag
//   type:article           the bookmark type (link, article, image, video, document, audio)
//   in:Dev  in:"Side jobs" the collection, matched by title: exact first, then a unique prefix
//   is:fav                 a favorite
//   "exact phrase"         an FTS5 phrase
//   -word  -"a phrase"     the text does not hold the word or phrase
//   anything else          a free-text FTS5 prefix term
//
// Inside quotes, `\"` is a literal `"` and `\\` a literal `\`. A quote with no end runs to
// the end of the text. An operator with an unknown value (type:foo, is:bar) is free text.
// A free-text term with no letter or digit (a lone `-` or `*`) drops out.
import type { RaindropType } from "../api/types";

export const BOOKMARK_TYPES: readonly RaindropType[] = ["link", "article", "image", "video", "document", "audio"];
const HAS_TOKEN = /[\p{L}\p{N}]/u;
const FAVORITE_WORDS = new Set(["fav", "favorite", "favourite", "important"]);

export interface ParsedSearch {
  /** Free-text words, each an FTS5 prefix term. */
  words: string[];
  /** Exact phrases. */
  phrases: string[];
  /** Words and phrases the text must not hold. */
  excludes: string[];
  tags: string[];
  excludeTags: string[];
  /** Any of these types (OR). */
  types: RaindropType[];
  /** The raw `in:` names. Resolve them with resolveCollections(). */
  collections: string[];
  favorite: boolean;
}

interface Token {
  negated: boolean;
  /** The operator key in lower case (`#`, `type`, `in`, `is`), or "" for a plain term. */
  key: string;
  value: string;
  /** True when the value came from quotes. */
  quoted: boolean;
}

const KEYS = ["type", "in", "is"] as const;

/** Reads a quoted value from `text` at `i` (just past the opening quote). */
function readQuoted(text: string, i: number): { value: string; end: number } {
  let value = "";
  while (i < text.length) {
    const c = text[i];
    if (c === "\\" && (text[i + 1] === '"' || text[i + 1] === "\\")) {
      value += text[i + 1];
      i += 2;
    } else if (c === '"') {
      return { value, end: i + 1 };
    } else {
      value += c;
      i += 1;
    }
  }
  return { value, end: i };
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    if (/\s/.test(text[i])) {
      i += 1;
      continue;
    }
    let negated = false;
    if (text[i] === "-" && i + 1 < text.length && !/\s/.test(text[i + 1])) {
      negated = true;
      i += 1;
    }
    let key = "";
    if (text[i] === "#") {
      key = "#";
      i += 1;
    } else {
      const rest = text.slice(i, i + 6).toLowerCase();
      const found = KEYS.find((k) => rest.startsWith(`${k}:`));
      if (found) {
        key = found;
        i += found.length + 1;
      }
    }
    let value: string;
    let quoted = false;
    if (text[i] === '"') {
      const read = readQuoted(text, i + 1);
      value = read.value;
      quoted = true;
      i = read.end;
    } else {
      const start = i;
      while (i < text.length && !/\s/.test(text[i])) i += 1;
      value = text.slice(start, i);
    }
    tokens.push({ negated, key, value, quoted });
  }
  return tokens;
}

/** The raw text of a token, for an operator that falls back to free text. */
function rawText(t: Token): string {
  const prefix = t.key === "" ? "" : t.key === "#" ? "#" : `${t.key}:`;
  return `${prefix}${t.value}`;
}

export function emptySearch(): ParsedSearch {
  return { words: [], phrases: [], excludes: [], tags: [], excludeTags: [], types: [], collections: [], favorite: false };
}

/** Parses the search bar text. Never throws. */
export function parseSearch(text: string): ParsedSearch {
  const out = emptySearch();
  const addText = (value: string, quoted: boolean, negated: boolean) => {
    const v = value.trim();
    // FTS5 drops punctuation, so a term with no letter or digit would match nothing.
    if (!HAS_TOKEN.test(v)) return;
    if (negated) out.excludes.push(v);
    else if (quoted) out.phrases.push(v);
    else out.words.push(v);
  };
  for (const t of tokenize(text)) {
    const value = t.value.trim();
    switch (t.key) {
      case "#":
        if (value) (t.negated ? out.excludeTags : out.tags).push(value);
        break;
      case "type": {
        const type = BOOKMARK_TYPES.find((x) => x === value.toLowerCase());
        if (type && !t.negated) {
          if (!out.types.includes(type)) out.types.push(type);
        } else addText(rawText(t), t.quoted, t.negated);
        break;
      }
      case "in":
        if (value && !t.negated) out.collections.push(value);
        else addText(rawText(t), t.quoted, t.negated);
        break;
      case "is":
        if (FAVORITE_WORDS.has(value.toLowerCase()) && !t.negated) out.favorite = true;
        else addText(rawText(t), t.quoted, t.negated);
        break;
      default:
        addText(t.value, t.quoted, t.negated);
    }
  }
  return out;
}

/** True when the search has no term, operator or filter. */
export function isEmptySearch(p: ParsedSearch): boolean {
  return (
    p.words.length === 0 &&
    p.phrases.length === 0 &&
    p.excludes.length === 0 &&
    p.tags.length === 0 &&
    p.excludeTags.length === 0 &&
    p.types.length === 0 &&
    p.collections.length === 0 &&
    !p.favorite
  );
}
