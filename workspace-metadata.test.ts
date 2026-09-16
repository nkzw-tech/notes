import { createRequire } from 'node:module';
import { describe, expect, test } from 'vite-plus/test';
import {
  parseWorkspaceMetadata,
  readWorkspaceMetadataOrDefault,
  reconcileWorkspaceMetadataPaths,
} from './workspace-metadata.ts';

const require = createRequire(import.meta.url);
const electronMetadata = require('./electron/workspace-metadata.cjs') as {
  parseWorkspaceMetadata: typeof parseWorkspaceMetadata;
};

const parsers = [parseWorkspaceMetadata, electronMetadata.parseWorkspaceMetadata];

describe.each(parsers)('workspace metadata parser', (parse) => {
  test('accepts unique visible people paths', () => {
    expect(
      parse(
        JSON.stringify({
          peoplePaths: ['people/02-samuel-macleod.md', 'people/33-riley-example.md'],
        }),
      ),
    ).toEqual({
      peoplePaths: ['people/02-samuel-macleod.md', 'people/33-riley-example.md'],
    });
  });

  test.each([
    ['non-JSON content', 'not JSON'],
    ['a missing array', '{}'],
    ['paths outside people', JSON.stringify({ peoplePaths: ['reports/person.md'] })],
    ['nested and traversal paths', JSON.stringify({ peoplePaths: ['people/../docs/todo.md'] })],
    ['hidden and template paths', JSON.stringify({ peoplePaths: ['people/_template.md'] })],
    [
      'duplicate paths',
      JSON.stringify({
        peoplePaths: ['people/01-person.md', 'people/01-person.md'],
      }),
    ],
  ])('rejects %s', (_label, value) => {
    expect(() => parse(value)).toThrow();
  });
});

test('missing workspace metadata falls back without rejecting document loading', async () => {
  await expect(
    readWorkspaceMetadataOrDefault('/definitely/missing/meetings-workspace'),
  ).resolves.toMatchObject({
    metadataError: expect.stringContaining('config/people.json'),
    peoplePaths: [],
  });
});

test('reports and removes registry entries for missing person files', () => {
  expect(
    reconcileWorkspaceMetadataPaths(
      {
        metadataError: null,
        peoplePaths: ['people/exists.md', 'people/missing.md'],
      },
      new Set(['people/exists.md']),
    ),
  ).toEqual({
    metadataError: 'config/people.json references missing files: people/missing.md',
    peoplePaths: ['people/exists.md'],
  });
});
