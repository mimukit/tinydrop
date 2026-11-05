// The only place that builds a SQL literal. The sqlite3 CLI has no bind
// parameters, so every value goes into the SQL text through these functions.
//
// sqlString() doubles every `'`. It also turns a line break into `char(10)` and
// a carriage return into `char(13)`, so a literal never spans two lines of a
// CLI script, and it drops NUL, which a command line cannot carry.
// ftsTerm() wraps one FTS5 term in double quotes with every `"` doubled, so
// FTS5 reads it as a plain string and never as syntax (AND, NEAR, *, ^, :).

/** A SQL string literal (an expression when the value holds a line break). */
export function sqlString(value: string): string {
  const parts = value.replace(/\u0000/g, "").split(/(\r|\n)/);
  const out: string[] = [];
  for (const part of parts) {
    if (part === "\n") out.push("char(10)");
    else if (part === "\r") out.push("char(13)");
    else if (part !== "" || parts.length === 1) out.push(`'${part.replace(/'/g, "''")}'`);
  }
  return out.join(" || ");
}

/** A SQL integer literal. Throws on anything that is not a safe integer. */
export function sqlInt(value: number): string {
  if (!Number.isSafeInteger(value)) throw new TypeError(`Not a safe integer for SQL: ${value}`);
  return String(value);
}

/** A SQL real literal. Throws on NaN and Infinity. */
export function sqlReal(value: number): string {
  if (!Number.isFinite(value)) throw new TypeError(`Not a finite number for SQL: ${value}`);
  return String(value);
}

/** 1 or 0. */
export function sqlBool(value: boolean | undefined): string {
  return value ? "1" : "0";
}

/** A string literal, or NULL for undefined and null. */
export function sqlNullable(value: string | null | undefined): string {
  return value === undefined || value === null ? "NULL" : sqlString(value);
}

/** A comma list of integer literals for `IN (…)`. */
export function sqlIntList(values: number[]): string {
  return values.map(sqlInt).join(", ");
}

/** One FTS5 string term: the text in double quotes, with `"` doubled. Control characters become spaces. */
export function ftsTerm(term: string): string {
  const clean = term.replace(/[\u0000-\u001f\u007f]/g, " ");
  return `"${clean.replace(/"/g, '""')}"`;
}

/** An FTS5 query that needs every word as a prefix: `"foo"* "bar"*`. Empty words drop out. */
export function ftsPrefixQuery(words: string[]): string {
  return words
    .map((w) => w.trim())
    .filter((w) => w !== "")
    .map((w) => `${ftsTerm(w)}*`)
    .join(" ");
}
