import type { MeetingDocument } from "./content.ts";

const normalize = (value: string) => value.trim().toLocaleLowerCase();

const groupOrder: Record<MeetingDocument["group"], number> = {
  Docs: 0,
  Reports: 1,
  Interviews: 2,
  "Meetings Overview": 3,
  "Upcoming Meetings": 4,
  People: 5,
  Archive: 6,
};

const fuzzyScore = (value: string, query: string) => {
  const normalizedValue = normalize(value);
  const substringIndex = normalizedValue.indexOf(query);
  if (substringIndex !== -1) {
    return substringIndex * 2 + normalizedValue.length - query.length;
  }

  let firstIndex = -1;
  let previousIndex = -1;
  let queryIndex = 0;
  let gapCount = 0;

  for (
    let valueIndex = 0;
    valueIndex < normalizedValue.length && queryIndex < query.length;
    valueIndex++
  ) {
    if (normalizedValue[valueIndex] !== query[queryIndex]) {
      continue;
    }

    if (firstIndex === -1) {
      firstIndex = valueIndex;
    } else {
      gapCount += valueIndex - previousIndex - 1;
    }
    previousIndex = valueIndex;
    queryIndex++;
  }

  return queryIndex === query.length
    ? 100 + firstIndex * 2 + gapCount * 3 + normalizedValue.length
    : null;
};

export const getPaletteDocumentTitle = (document: MeetingDocument) =>
  document.title.replace(/^\d+\.\s*/, "");

export const filterPaletteDocuments = (
  documents: ReadonlyArray<MeetingDocument>,
  query: string,
) => {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) {
    return documents
      .map((document, index) => ({ document, index }))
      .sort(
        (left, right) =>
          groupOrder[left.document.group] - groupOrder[right.document.group] ||
          left.index - right.index,
      )
      .map(({ document }) => document);
  }

  return documents
    .map((document, index) => {
      const titleScore = fuzzyScore(getPaletteDocumentTitle(document), normalizedQuery);
      const metadataScore = fuzzyScore(
        `${document.group} ${document.path} ${document.cue ?? ""}`,
        normalizedQuery,
      );
      const score = Math.min(
        titleScore ?? Number.POSITIVE_INFINITY,
        metadataScore === null ? Number.POSITIVE_INFINITY : metadataScore + 250,
      );

      return { document, group: groupOrder[document.group], index, score };
    })
    .filter(({ score }) => Number.isFinite(score))
    .sort(
      (left, right) =>
        left.score - right.score || left.group - right.group || left.index - right.index,
    )
    .map(({ document }) => document);
};
