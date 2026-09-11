export type StoredDocument = {
  content: string;
  hash: string;
  mtimeMs: number;
  path: string;
};

export type StoredDocumentChange =
  | { deleted: true; path: string }
  | { deleted: false; document: StoredDocument; path: string };

export const applyStoredDocumentChanges = (
  documents: ReadonlyArray<StoredDocument>,
  changes: Iterable<StoredDocumentChange>,
) => {
  const byPath = new Map(
    documents.map((document) => [document.path, document]),
  );
  for (const change of changes) {
    if (change.deleted) {
      byPath.delete(change.path);
    } else {
      byPath.set(change.path, change.document);
    }
  }
  return [...byPath.values()];
};

export type MeetingDocument = StoredDocument & {
  archived: boolean;
  cue: string | null;
  group:
    | 'Docs'
    | 'Archive'
    | 'Interviews'
    | 'People'
    | 'Reports'
    | 'Meetings Overview'
    | 'Upcoming Meetings';
  id: string;
  number: number | null;
  title: string;
};

const decodeCharacterReferences = (value: string) =>
  value.replace(
    /&(?:#(\d+)|#x([\da-f]+)|amp|apos|gt|lt|quot);/gi,
    (
      reference,
      decimal: string | undefined,
      hexadecimal: string | undefined,
    ) => {
      if (decimal || hexadecimal) {
        const codePoint = Number.parseInt(
          decimal ?? hexadecimal!,
          decimal ? 10 : 16,
        );
        return Number.isSafeInteger(codePoint) && codePoint <= 0x10ffff
          ? String.fromCodePoint(codePoint)
          : reference;
      }

      return (
        {
          '&amp;': '&',
          '&apos;': "'",
          '&gt;': '>',
          '&lt;': '<',
          '&quot;': '"',
        }[reference.toLocaleLowerCase()] ?? reference
      );
    },
  );

const decodeMarkdownEscapes = (value: string) =>
  value.replace(/\\(.)/g, (match, character: string) =>
    /[!-/:-@[-`{-~]/.test(character) ? character : match,
  );

const decodeSidebarText = (value: string) =>
  decodeMarkdownEscapes(decodeCharacterReferences(value));

const decodeSidebarLine = (value: string) =>
  decodeSidebarText(value)
    .replace(/\\\s*$/, '')
    .trim();

const getTitle = (content: string, path: string) => {
  const rawHeading = content.match(/^#\s+(.+)$/m)?.[1];
  const heading = rawHeading ? decodeSidebarText(rawHeading).trim() : null;
  return heading ?? path.replace(/\.md$/, '').split('/').at(-1) ?? path;
};

const getCue = (content: string) => {
  const cue = content.match(/^\*\*(?:Retrieval cue|Cue):\*\*\s*(.+)$/m)?.[1];
  return cue ? decodeSidebarLine(cue) : null;
};

const getUpcomingCue = (cue: string | null) => {
  if (!cue) {
    return null;
  }

  const separatorIndex = cue.indexOf(' = ');
  return separatorIndex === -1 ? cue : cue.slice(separatorIndex + 3).trim();
};

const getReportCue = (content: string) => {
  const rawLevel = content.match(/^\*\*Level:\*\*\s*(.+)$/m)?.[1];
  const rawTitle = content.match(/^\*\*Title:\*\*\s*(.+)$/m)?.[1];
  const level = rawLevel ? decodeSidebarLine(rawLevel) : null;
  const title = rawTitle ? decodeSidebarLine(rawTitle) : null;
  return (
    [level, title]
      .filter((value) => value && !value.startsWith('Not yet available'))
      .join(' · ') || null
  );
};

const getReportLevel = (content: string) => {
  const match = content.match(/^\*\*Level:\*\*\s*P(\d+)\s*$/m);
  return match ? Number(match[1]) : -1;
};

const isArchived = (content: string) =>
  /^\*\*Archived:\*\*\s*.+$/m.test(content);

const getNumber = (path: string) => {
  const match = path.match(/^(?:interviews|people)\/(\d+)-/);
  return match ? Number(match[1]) : null;
};

const getMeetingDate = (path: string) =>
  path.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? '';

const getGroup = (
  path: string,
  archived: boolean,
  met: boolean,
): MeetingDocument['group'] => {
  if (path.startsWith('docs/')) {
    return 'Docs';
  }
  if (path.startsWith('reports/')) {
    return 'Reports';
  }
  if (path.startsWith('interviews/')) {
    return 'Interviews';
  }
  if (path.startsWith('meetings/')) {
    return 'Meetings Overview';
  }
  if (path.startsWith('people/')) {
    if (archived) {
      return 'Archive';
    }
    return met ? 'People' : 'Upcoming Meetings';
  }
  return 'Docs';
};

export const createMeetingDocument = (
  document: StoredDocument,
  peoplePaths: ReadonlySet<string>,
): MeetingDocument => {
  const archived = isArchived(document.content);
  const group = getGroup(
    document.path,
    archived,
    peoplePaths.has(document.path),
  );
  const cue = document.path.startsWith('reports/')
    ? getReportCue(document.content)
    : getCue(document.content);

  return {
    ...document,
    archived,
    cue: group === 'Upcoming Meetings' ? getUpcomingCue(cue) : cue,
    group,
    id: document.path.replace(/\.md$/, ''),
    number: getNumber(document.path),
    title: getTitle(document.content, document.path),
  };
};

export const sortDocuments = (documents: ReadonlyArray<MeetingDocument>) =>
  [...documents].sort((a, b) => {
    if (a.group === 'Docs' || b.group === 'Docs') {
      if (a.group !== b.group) {
        return a.group === 'Docs' ? -1 : 1;
      }
      if (a.path === 'docs/todo.md' || b.path === 'docs/todo.md') {
        return a.path === 'docs/todo.md' ? -1 : 1;
      }
    }
    if (a.group === 'Meetings Overview' && b.group === 'Meetings Overview') {
      return getMeetingDate(a.path).localeCompare(getMeetingDate(b.path));
    }
    if (a.group === 'Reports' && b.group === 'Reports') {
      const levelDifference =
        getReportLevel(b.content) - getReportLevel(a.content);
      return levelDifference || a.title.localeCompare(b.title);
    }
    if (a.number !== null && b.number !== null) {
      return a.number - b.number;
    }
    return a.path.localeCompare(b.path);
  });

export const createMeetingDocuments = (
  documents: ReadonlyArray<StoredDocument>,
  peoplePaths: ReadonlySet<string>,
) =>
  sortDocuments(
    documents.map((document) => createMeetingDocument(document, peoplePaths)),
  );

export const replaceDocument = (
  documents: ReadonlyArray<MeetingDocument>,
  storedDocument: StoredDocument,
  peoplePaths: ReadonlySet<string>,
) => {
  const nextDocument = createMeetingDocument(storedDocument, peoplePaths);
  const existingIndex = documents.findIndex(
    (document) => document.path === storedDocument.path,
  );

  if (existingIndex === -1) {
    return sortDocuments([...documents, nextDocument]);
  }

  const nextDocuments = [...documents];
  nextDocuments[existingIndex] = nextDocument;
  return sortDocuments(nextDocuments);
};

export const resolveMarkdownPath = (currentPath: string, href: string) => {
  const withoutHash = href.split('#')[0];
  if (!withoutHash?.endsWith('.md')) {
    return null;
  }

  const currentSegments = currentPath.split('/');
  currentSegments.pop();

  for (const segment of withoutHash.split('/')) {
    if (segment === '..') {
      currentSegments.pop();
    } else if (segment !== '.') {
      currentSegments.push(segment);
    }
  }

  return currentSegments.join('/');
};
