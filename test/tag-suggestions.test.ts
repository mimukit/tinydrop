import { describe, expect, it } from "vitest";
import { tagSuggestions } from "../src/search/tags";

describe("tag suggestions", () => {
  it("matches a tag prefix without regard to case", () => {
    expect(tagSuggestions("#SH", ["read", "shadcn", "shell"]).map((s) => s.name)).toEqual(["shadcn", "shell"]);
  });
  it("completes only the final tag and quotes spaces and escapes", () => {
    const [suggestion] = tagSuggestions('rust -#"long', ['long "tag"']);
    expect(suggestion.text).toBe('rust -#"long \\"tag\\"" ');
  });
  it("shows tags for a bare hash and limits the list", () => {
    expect(tagSuggestions("#", Array.from({ length: 20 }, (_, i) => `tag${i}`))).toHaveLength(10);
  });
  it("does not complete a finished tag, a phrase, or a URL", () => {
    for (const text of ["#read ", '"a #re', "https://example.com/#re", '#"read"', "rust"]) {
      expect(tagSuggestions(text, ["read"])).toEqual([]);
    }
  });
  it("preserves earlier filters and deduplicates tags", () => {
    expect(tagSuggestions('in:"Side projects" #re', ["read", "read"])).toEqual([
      { name: "read", text: 'in:"Side projects" #read ' },
    ]);
  });
});
