import { describe, expect, test } from 'vitest';
import {
  applyStoredDocumentChanges,
  createMeetingDocument,
  createMeetingDocuments,
} from './content.ts';

const noPeople = new Set<string>();

describe('meeting document metadata', () => {
  test('replays watcher changes over an older initial workspace snapshot', () => {
    const old = {
      content: 'Old\n',
      hash: 'old',
      mtimeMs: 1,
      path: 'docs/todo.md',
    };
    const newer = { ...old, content: 'Newer\n', hash: 'newer', mtimeMs: 2 };

    expect(
      applyStoredDocumentChanges(
        [old, { ...old, path: 'people/deleted.md' }],
        [
          { deleted: false, document: newer, path: newer.path },
          { deleted: true, path: 'people/deleted.md' },
        ],
      ),
    ).toEqual([newer]);
  });

  test('decodes character references in sidebar titles', () => {
    const document = createMeetingDocument(
      {
        content: '# Management at&#x20;\n',
        hash: 'hash',
        mtimeMs: 0,
        path: 'meetings/2026-06-22.md',
      },
      noPeople,
    );

    expect(document.title).toBe('Management at');
    expect(document.group).toBe('Meetings Overview');
  });

  test('sorts reports by descending level and then name', () => {
    const documents = createMeetingDocuments(
      [
        {
          content: '# Delta Example\n\n**Level:** P3\n',
          hash: 'a',
          mtimeMs: 0,
          path: 'reports/delta-example.md',
        },
        {
          content: '# Charlie Example\n\n**Level:** P4\n',
          hash: 'v',
          mtimeMs: 0,
          path: 'reports/charlie-example.md',
        },
        {
          content: '# Alpha Example\n\n**Level:** P5\n',
          hash: 'y',
          mtimeMs: 0,
          path: 'reports/alpha-example.md',
        },
        {
          content: '# Bravo Example\n\n**Level:** P4\n',
          hash: 'h',
          mtimeMs: 0,
          path: 'reports/bravo-example.md',
        },
      ],
      noPeople,
    );

    expect(documents.map(({ title }) => title)).toEqual([
      'Alpha Example',
      'Bravo Example',
      'Charlie Example',
      'Delta Example',
    ]);
  });

  test('removes markdown hard-break markers from report bylines', () => {
    const document = createMeetingDocument(
      {
        content: [
          '# Casey Example',
          '',
          '**Title:** Senior Systems Engineer \\',
          '**Level:** P4',
        ].join('\n'),
        hash: 'casey',
        mtimeMs: 0,
        path: 'reports/casey-example.md',
      },
      noPeople,
    );

    expect(document.cue).toBe('P4 · Senior Systems Engineer');
  });

  test('removes markdown hard-break markers from retrieval cues', () => {
    const document = createMeetingDocument(
      {
        content: [
          '# 4. Morgan Example',
          '',
          '**Retrieval cue:** Morgan Example = Product + roadmap \\',
        ].join('\n'),
        hash: 'morgan',
        mtimeMs: 0,
        path: 'people/04-morgan-example.md',
      },
      new Set(['people/04-morgan-example.md']),
    );

    expect(document.cue).toBe('Morgan Example = Product + roadmap');
  });

  test('sorts meeting overviews by ascending date', () => {
    const documents = createMeetingDocuments(
      [
        {
          content: '# Older\n',
          hash: 'older',
          mtimeMs: 0,
          path: 'meetings/2026-06-22.md',
        },
        {
          content: '# Newer\n',
          hash: 'newer',
          mtimeMs: 0,
          path: 'meetings/2026-06-23.md',
        },
      ],
      noPeople,
    );

    expect(documents.map(({ path }) => path)).toEqual([
      'meetings/2026-06-22.md',
      'meetings/2026-06-23.md',
    ]);
  });

  test('groups and numbers interview profiles separately from people', () => {
    const documents = createMeetingDocuments(
      [
        {
          content: '# 3. Taylor Example\n\n**Interview date:** 2026-08-26\n',
          hash: 'taylor',
          mtimeMs: 0,
          path: 'interviews/03-taylor-example.md',
        },
        {
          content: '# 2. Alex Example\n\n**Interview date:** 2026-08-26\n',
          hash: 'alex',
          mtimeMs: 0,
          path: 'interviews/02-alex-example.md',
        },
      ],
      noPeople,
    );

    expect(
      documents.map(({ group, number, title }) => ({
        group,
        number,
        title,
      })),
    ).toEqual([
      { group: 'Interviews', number: 2, title: '2. Alex Example' },
      { group: 'Interviews', number: 3, title: '3. Taylor Example' },
    ]);
  });

  test('uses the people registry to group people and format cues', () => {
    const upcoming = createMeetingDocument(
      {
        content: [
          '# 21. Upcoming Person',
          '',
          '**Retrieval cue:** Upcoming Person = Astro + EmDash',
        ].join('\n'),
        hash: 'upcoming',
        mtimeMs: 0,
        path: 'people/21-upcoming-person.md',
      },
      noPeople,
    );
    const completed = createMeetingDocument(
      {
        content: [
          '# 3. Jamie Example',
          '',
          '**Retrieval cue:** Jamie = platform lead + config contracts',
        ].join('\n'),
        hash: 'completed',
        mtimeMs: 0,
        path: 'people/03-jamie-example.md',
      },
      new Set(['people/03-jamie-example.md']),
    );
    const archived = createMeetingDocument(
      {
        content: [
          '# 1. Avery Example',
          '',
          '**Retrieval cue:** Avery = security + testing platform',
          '**Archived:** 2026-06-22',
        ].join('\n'),
        hash: 'archived',
        mtimeMs: 0,
        path: 'people/01-avery-example.md',
      },
      noPeople,
    );

    expect(upcoming.group).toBe('Upcoming Meetings');
    expect(upcoming.cue).toBe('Astro + EmDash');
    expect(completed.group).toBe('People');
    expect(completed.cue).toBe('Jamie = platform lead + config contracts');
    expect(archived.group).toBe('Archive');
  });

  test('regroups existing documents when the runtime people registry changes', () => {
    const storedDocument = {
      content: '# 33. Riley Example\n\n**Retrieval cue:** Riley = UI platform',
      hash: 'riley',
      mtimeMs: 0,
      path: 'people/33-riley-example.md',
    };
    const before = createMeetingDocuments([storedDocument], noPeople);
    const after = createMeetingDocuments(
      before,
      new Set(['people/33-riley-example.md']),
    );

    expect(before[0]?.group).toBe('Upcoming Meetings');
    expect(after[0]?.group).toBe('People');
  });
});
