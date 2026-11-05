import { expect, it } from "vitest";
import { defaultCollection, formTags, formTagSuggestions } from "../src/parse/add-form";

const collections = [{ id: 11, title: "Bookmarks", count: 0, sort: 0 }, { id: 12, title: "Dev", count: 0, sort: 1 }];

it("uses the last valid collection before Bookmarks", () => {
  expect(defaultCollection(collections, "12")).toBe("12");
  expect(defaultCollection(collections, "-1")).toBe("-1");
  expect(defaultCollection(collections)).toBe("11");
  expect(defaultCollection(collections, "99")).toBe("11");
  expect(defaultCollection([])).toBe("-1");
});

it("combines existing and new tags without duplicates", () => {
  expect(formTags("#READ, new tag, read, ", ["Read"])).toEqual(["Read", "new tag"]);
});

it("completes the current tag and keeps earlier tags", () => {
  expect(formTagSuggestions("Read, sh", ["Read", "shell", "shadcn"])).toEqual([
    { name: "shell", text: "Read, shell, " }, { name: "shadcn", text: "Read, shadcn, " },
  ]);
  expect(formTagSuggestions("Read, ", ["Read", "shell"])).toEqual([{ name: "shell", text: "Read, shell, " }]);
});
