import { describe, expect, test } from "vitest";
import type { MeetingDocument } from "./content.ts";
import { filterPaletteDocuments, getPaletteDocumentTitle } from "./documentPalette.ts";

const document = (
  title: string,
  group: MeetingDocument["group"],
  path: string,
  cue: string | null = null,
): MeetingDocument => ({
  archived: false,
  content: "",
  cue,
  group,
  hash: path,
  id: path,
  mtimeMs: 0,
  number: path.startsWith("people/") ? Number(path.slice(7, 9)) : null,
  path,
  title,
});

const documents = [
  document("ToDo", "Docs", "docs/todo.md"),
  document("31. Ada Example", "People", "people/31-ada-example.md", "Developer tooling"),
  document("12. Adam Sample", "Archive", "people/12-adam-sample.md"),
  document("Jane Example", "Reports", "reports/jane-example.md", "P5 · EM"),
  document("7. Applicant Example", "Interviews", "interviews/07-applicant-example.md"),
];

describe("document palette", () => {
  test("groups documents in navigation order with archive last", () => {
    expect(filterPaletteDocuments(documents, "").map(({ group }) => group)).toEqual([
      "Docs",
      "Reports",
      "Interviews",
      "People",
      "Archive",
    ]);
  });

  test("matches names as a fuzzy subsequence", () => {
    expect(filterPaletteDocuments(documents, "adex").map(({ title }) => title)).toEqual([
      "31. Ada Example",
    ]);
  });

  test("ranks title matches before metadata matches", () => {
    expect(filterPaletteDocuments(documents, "ada").map(({ title }) => title)).toEqual([
      "31. Ada Example",
      "12. Adam Sample",
    ]);
  });

  test("matches group, path, and cue metadata", () => {
    expect(filterPaletteDocuments(documents, "reports")[0]?.title).toBe("Jane Example");
    expect(filterPaletteDocuments(documents, "devtool")[0]?.title).toBe("31. Ada Example");
  });

  test("removes a person number from the displayed title", () => {
    expect(getPaletteDocumentTitle(documents[1]!)).toBe("Ada Example");
  });
});
