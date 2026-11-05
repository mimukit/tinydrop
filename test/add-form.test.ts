import { expect, it } from "vitest";
import { defaultCollection } from "../src/parse/add-form";

const collections = [{ id: 11, title: "Bookmarks", count: 0, sort: 0 }, { id: 12, title: "Dev", count: 0, sort: 1 }];

it("uses the last valid collection before Bookmarks", () => {
  expect(defaultCollection(collections, "12")).toBe("12");
  expect(defaultCollection(collections, "-1")).toBe("-1");
  expect(defaultCollection(collections)).toBe("11");
  expect(defaultCollection(collections, "99")).toBe("11");
  expect(defaultCollection([])).toBe("-1");
});
