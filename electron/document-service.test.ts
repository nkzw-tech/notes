import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const {
  DocumentConflictError,
  createWorkspaceDocument,
  deleteDocument,
  deleteInterview,
  formatDocumentContent,
  listDocuments,
  readDocument,
  readDocumentSync,
  restoreDocument,
  writeDocument,
  writeDocumentSync,
} = require('./document-service.cjs') as {
  DocumentConflictError: new (
    document: StoredDocument,
  ) => Error & { document: StoredDocument };
  createWorkspaceDocument: (request: {
    kind: 'doc' | 'interview' | 'person' | 'report';
    root: string;
    title: string;
  }) => Promise<StoredDocument>;
  deleteDocument: (request: {
    path: string;
    root: string;
  }) => Promise<{ path: string }>;
  deleteInterview: (request: {
    path: string;
    root: string;
  }) => Promise<{ path: string }>;
  formatDocumentContent: (request: {
    content: string;
    path: string;
    root: string;
  }) => Promise<string>;
  listDocuments: (root: string) => Promise<StoredDocument[]>;
  readDocument: (root: string, path: string) => Promise<StoredDocument>;
  readDocumentSync: (root: string, path: string) => StoredDocument;
  restoreDocument: (request: {
    content: string;
    path: string;
    root: string;
  }) => Promise<StoredDocument>;
  writeDocument: (request: {
    baseHash: string;
    content: string;
    path: string;
    root: string;
  }) => Promise<StoredDocument>;
  writeDocumentSync: (request: {
    baseHash: string;
    content: string;
    path: string;
    root: string;
  }) => StoredDocument;
};

type StoredDocument = {
  content: string;
  hash: string;
  mtimeMs: number;
  path: string;
};

const roots: string[] = [];

const createWorkspace = async () => {
  const root = await mkdtemp(join(tmpdir(), 'meetings-electron-'));
  roots.push(root);
  await Promise.all(
    ['docs', 'interviews', 'meetings', 'people', 'reports'].map((directory) =>
      mkdir(join(root, directory)),
    ),
  );
  await Promise.all([
    writeFile(
      join(root, 'AGENTS.md'),
      '- **Next person number:** 34\n- **Next interview number:** 15\n',
    ),
    writeFile(join(root, 'docs', 'todo.md'), '# ToDo\n'),
    writeFile(join(root, 'interviews', '01-candidate.md'), '# 1. Candidate\n'),
    writeFile(join(root, 'people', '01-person.md'), '# Person\n'),
    writeFile(join(root, 'people', '_template.md'), '# Hidden\n'),
  ]);
  return root;
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe('Electron document service', () => {
  test("a synchronous close flush cannot overtake another window autosave", async () => {
    const root = await createWorkspace();
    const original = readDocumentSync(root, "docs/todo.md");
    const pending = writeDocument({
      baseHash: original.hash,
      content: "# First window\n",
      path: original.path,
      root,
    });
    expect(() =>
      writeDocumentSync({
        baseHash: original.hash,
        content: "# Closing window\n",
        path: original.path,
        root,
      }),
    ).toThrow("Another save is in progress");
    await pending;
    expect(readDocumentSync(root, original.path).content).toBe("# First window\n");
    expect(() =>
      writeDocumentSync({
        baseHash: original.hash,
        content: "# Closing window\n",
        path: original.path,
        root,
      }),
    ).toThrow(DocumentConflictError);
  });


  test('lists visible Markdown and saves synchronously', async () => {
    const root = await createWorkspace();
    await expect(listDocuments(root)).resolves.toMatchObject([
      { path: 'docs/todo.md' },
      { path: 'interviews/01-candidate.md' },
      { path: 'people/01-person.md' },
    ]);

    const current = readDocumentSync(root, 'docs/todo.md');
    const saved = writeDocumentSync({
      baseHash: current.hash,
      content: '# ToDo\n\n- [ ] Test the desktop app.\n',
      path: current.path,
      root,
    });
    expect(saved.content).toContain('desktop app');

    expect(() =>
      writeDocumentSync({
        baseHash: current.hash,
        content: '# Stale\n',
        path: current.path,
        root,
      }),
    ).toThrow(DocumentConflictError);
  });

  test('formats Markdown through the packaged oxfmt API', async () => {
    const root = await createWorkspace();
    await expect(
      formatDocumentContent({
        content: '# ToDo\n\n-   First item\n\nText   with spaces',
        path: 'docs/todo.md',
        root,
      }),
    ).resolves.toBe('# ToDo\n\n- First item\n\nText with spaces\n');
  });

  test('serializes concurrent packaged-app writes so only one stale base can commit', async () => {
    const root = await createWorkspace();
    const original = await readDocument(root, 'docs/todo.md');

    const results = await Promise.allSettled([
      writeDocument({
        baseHash: original.hash,
        content: '# First packaged-app edit\n',
        path: original.path,
        root,
      }),
      writeDocument({
        baseHash: original.hash,
        content: '# Second packaged-app edit\n',
        path: original.path,
        root,
      }),
    ]);

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(
      1,
    );
    expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(
      1,
    );
  });

  test('restores a deleted packaged-app document without overwriting', async () => {
    const root = await createWorkspace();
    const path = 'docs/todo.md';
    await rm(join(root, path));

    await expect(
      restoreDocument({ content: '# Recovered\n', path, root }),
    ).resolves.toMatchObject({
      content: '# Recovered\n',
      path,
    });
    await expect(
      restoreDocument({ content: '# Overwrite\n', path, root }),
    ).rejects.toMatchObject({
      code: 'EEXIST',
    });
  });

  test('creates a numbered document through the packaged service', async () => {
    const root = await createWorkspace();
    await expect(
      createWorkspaceDocument({ kind: 'person', root, title: 'Jane Doe' }),
    ).resolves.toMatchObject({
      content: '# 34. Jane Doe\n',
      path: 'people/34-jane-doe.md',
    });
  });

  test('completes an interview through the packaged service', async () => {
    const root = await createWorkspace();
    await expect(
      deleteInterview({ path: 'interviews/01-candidate.md', root }),
    ).resolves.toEqual({ path: 'interviews/01-candidate.md' });
  });

  test('deletes any unreferenced visible document through the packaged service', async () => {
    const root = await createWorkspace();
    await expect(
      deleteDocument({ path: 'docs/todo.md', root }),
    ).resolves.toEqual({ path: 'docs/todo.md' });
    await expect(
      readDocument(root, 'docs/todo.md'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      deleteDocument({ path: 'reports/_template.md', root }),
    ).rejects.toThrow('Invalid document path');
  });
});
