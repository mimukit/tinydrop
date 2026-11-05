import { describe, expect, it } from "vitest";
import { ftsPrefixQuery, ftsTerm, sqlInt, sqlString } from "../src/store/sql";

describe("sqlString", () => {
  it("wraps a plain value in single quotes", () => {
    expect(sqlString("hello")).toBe("'hello'");
    expect(sqlString("")).toBe("''");
  });

  it("doubles every single quote", () => {
    expect(sqlString("it's")).toBe("'it''s'");
    expect(sqlString("'; DROP TABLE bookmarks; --")).toBe("'''; DROP TABLE bookmarks; --'");
    expect(sqlString("''")).toBe("''''''");
  });

  it("keeps -- and ; inside the literal", () => {
    expect(sqlString("a -- b; c")).toBe("'a -- b; c'");
  });

  it("turns line breaks into char() so a literal never spans two script lines", () => {
    expect(sqlString("a\nb")).toBe("'a' || char(10) || 'b'");
    expect(sqlString("a\r\nb")).toBe("'a' || char(13) || char(10) || 'b'");
    expect(sqlString("\n.quit\n")).toBe("char(10) || '.quit' || char(10)");
    expect(sqlString("x\n'y")).not.toMatch(/[\r\n]/);
  });

  it("drops NUL", () => {
    expect(sqlString("a\u0000b")).toBe("'ab'");
  });
});

describe("sqlInt", () => {
  it("accepts safe integers and rejects anything else", () => {
    expect(sqlInt(-99)).toBe("-99");
    expect(() => sqlInt(1.5)).toThrow();
    expect(() => sqlInt(Number.NaN)).toThrow();
    expect(() => sqlInt("1; DROP" as unknown as number)).toThrow();
  });
});

describe("ftsTerm", () => {
  it("wraps a term in double quotes", () => {
    expect(ftsTerm("rust")).toBe('"rust"');
  });

  it("doubles every double quote", () => {
    expect(ftsTerm('say "hi"')).toBe('"say ""hi"""');
    expect(ftsTerm('"')).toBe('""""');
  });

  it("keeps FTS syntax characters and keywords inside the string", () => {
    for (const t of ["*", "^start", "title:foo", "(a OR b)", "NEAR", "NEAR(a b)", "AND", "OR", "NOT", "a -b", "x;--"]) {
      const out = ftsTerm(t);
      expect(out.startsWith('"') && out.endsWith('"')).toBe(true);
      // Inside the quotes, every `"` comes in a pair, so the string never ends early.
      expect(out.slice(1, -1).replace(/""/g, "")).not.toContain('"');
    }
  });

  it("turns control characters into spaces", () => {
    expect(ftsTerm("a\nb\tc")).toBe('"a b c"');
  });
});

describe("ftsPrefixQuery", () => {
  it("makes every word a quoted prefix term and drops empty words", () => {
    expect(ftsPrefixQuery(["ru", "", "  ", 'lan"g'])).toBe('"ru"* "lan""g"*');
    expect(ftsPrefixQuery([])).toBe("");
  });
});
