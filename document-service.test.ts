import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vite-plus/test';
import {
  createDocumentMiddleware,
  createWorkspaceDocument,
  deleteDocument,
  deleteInterview,
  DocumentConflictError,
  formatDocumentContent,
  listDocuments,
  normalizeDocumentPath,
  readDocument,
  resolveDocumentPath,
  restoreDocument,
  writeDocument,
} from './document-service.ts';

const roots: Array<string> = [];
const servers: Array<Server> = [];

const createWorkspace = async () => {
  const root = await mkdtemp(join(tmpdir(), 'meetings-documents-'));
  roots.push(root);
  await Promise.all([
    mkdir(join(root, 'docs')),
    mkdir(join(root, 'config')),
    mkdir(join(root, 'interviews')),
    mkdir(join(root, 'meetings')),
    mkdir(join(root, 'people')),
    mkdir(join(root, 'reports')),
  ]);
  await Promise.all([
    writeFile(
      join(root, 'AGENTS.md'),
      '- **Next person number:** 34\n- **Next interview number:** 15\n',
    ),
    writeFile(join(root, 'docs', 'todo.md'), '# ToDo\n'),
    writeFile(join(root, 'docs', 'behavioral.md'), '# Behavioral\n\nQuestion?\n'),
    writeFile(
      join(root, 'config', 'people.json'),
      JSON.stringify({ peoplePaths: ['people/01-person.md'] }),
    ),
    writeFile(join(root, 'interviews', '01-candidate.md'), '# 1. Candidate\n'),
    writeFile(join(root, 'interviews', '_template.md'), '# 1. Full Name\n'),
    writeFile(join(root, 'meetings', '2026-06-23.md'), '# Meetings\n'),
    writeFile(join(root, 'README.md'), '# Hidden\n'),
    writeFile(join(root, 'people', '01-person.md'), '# Person\n'),
    writeFile(join(root, 'people', '_template.md'), '# Full Name\n\n**Role/team:**  \n'),
    writeFile(join(root, 'reports', 'report.md'), '# Report\n'),
    writeFile(
      join(root, 'reports', '_template.md'),
      '# Full Name\n\n**Person number:** 21\n**Title:**  \n',
    ),
  ]);
  return root;
};

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
            } else {
              resolve();
            }
          });
        }),
    ),
  );
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const startDocumentServer = async (root: string) => {
  const middleware = createDocumentMiddleware({ root });
  const server = createServer((request, response) => {
    void middleware(request, response, () => {
      response.statusCode = 404;
      response.end();
    });
  });
  servers.push(server);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
};

describe('document paths', () => {
  test('allows visible Markdown documents and rejects traversal or templates', () => {
    expect(normalizeDocumentPath('docs/todo.md')).toBe('docs/todo.md');
    expect(normalizeDocumentPath('interviews/01-candidate.md')).toBe('interviews/01-candidate.md');
    expect(normalizeDocumentPath('meetings/2026-06-23.md')).toBe('meetings/2026-06-23.md');
    expect(normalizeDocumentPath('people/01-person.md')).toBe('people/01-person.md');
    expect(normalizeDocumentPath('reports/report.md')).toBe('reports/report.md');
    expect(normalizeDocumentPath('../secret.md')).toBeNull();
    expect(normalizeDocumentPath('/tmp/secret.md')).toBeNull();
    expect(normalizeDocumentPath('people/_template.md')).toBeNull();
    expect(normalizeDocumentPath('README.md')).toBeNull();
    expect(normalizeDocumentPath('loose-notes.md')).toBeNull();
    expect(normalizeDocumentPath('people/nested/person.md')).toBeNull();
  });

  test('never resolves outside the workspace', async () => {
    const root = await createWorkspace();
    expect(() => resolveDocumentPath(root, '../../secret.md')).toThrow('Invalid document path');
  });
});

describe('document storage', () => {
  test('lists only visible documents', async () => {
    const root = await createWorkspace();
    const documents = await listDocuments(root);
    expect(documents.map(({ path }) => path)).toEqual([
      'docs/behavioral.md',
      'docs/todo.md',
      'interviews/01-candidate.md',
      'meetings/2026-06-23.md',
      'people/01-person.md',
      'reports/report.md',
    ]);
  });

  test('atomically replaces a document when its base hash matches', async () => {
    const root = await createWorkspace();
    const current = await readDocument(root, 'docs/todo.md');
    const updated = await writeDocument({
      baseHash: current.hash,
      content: '# ToDo\n\n- [ ] Test autosave.\n',
      path: 'docs/todo.md',
      root,
    });

    expect(updated.content).toContain('Test autosave');
    expect(updated.hash).not.toBe(current.hash);
    expect((await readdir(root)).some((name) => name.endsWith('.tmp'))).toBe(false);
  });

  test('returns the disk document on an optimistic concurrency conflict', async () => {
    const root = await createWorkspace();
    const original = await readDocument(root, 'docs/todo.md');
    await writeFile(join(root, 'docs', 'todo.md'), '# Changed elsewhere\n');

    await expect(
      writeDocument({
        baseHash: original.hash,
        content: '# Local edit\n',
        path: 'docs/todo.md',
        root,
      }),
    ).rejects.toMatchObject({
      document: {
        content: '# Changed elsewhere\n',
        path: 'docs/todo.md',
      },
    } satisfies { document: Partial<DocumentConflictError['document']> });
  });

  test('serializes concurrent writes so the same base version can only be accepted once', async () => {
    const root = await createWorkspace();
    const original = await readDocument(root, 'docs/todo.md');

    const results = await Promise.allSettled([
      writeDocument({
        baseHash: original.hash,
        content: '# First concurrent edit\n',
        path: original.path,
        root,
      }),
      writeDocument({
        baseHash: original.hash,
        content: '# Second concurrent edit\n',
        path: original.path,
        root,
      }),
    ]);

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(1);
  });

  test('formats Markdown without writing it to disk', async () => {
    const root = await createWorkspace();
    const original = await readDocument(root, 'docs/todo.md');
    const content = '# ToDo\n\n-   First item\n\nText   with spaces';

    await expect(
      formatDocumentContent({
        content,
        path: 'docs/todo.md',
        root,
      }),
    ).resolves.toBe('# ToDo\n\n- First item\n\nText with spaces\n');
    await expect(readDocument(root, 'docs/todo.md')).resolves.toEqual(original);
  });

  test('atomically restores a deleted document without overwriting a replacement', async () => {
    const root = await createWorkspace();
    const path = 'docs/todo.md';
    await rm(join(root, path));
    await expect(restoreDocument({ content: '# Recovered\n', path, root })).resolves.toMatchObject({
      content: '# Recovered\n',
      path,
    });
    await expect(
      restoreDocument({ content: '# Must not overwrite\n', path, root }),
    ).rejects.toMatchObject({ code: 'EEXIST' });
    await expect(readDocument(root, path)).resolves.toMatchObject({
      content: '# Recovered\n',
    });
  });

  test('creates template-backed documents and advances permanent counters', async () => {
    const root = await createWorkspace();
    const doc = await createWorkspaceDocument({
      kind: 'doc',
      root,
      title: 'Architecture Notes',
    });
    expect(doc).toMatchObject({
      content: '# Architecture Notes\n',
      path: 'docs/architecture-notes.md',
    });

    const person = await createWorkspaceDocument({
      kind: 'person',
      root,
      title: 'Jane Doe',
    });
    expect(person).toMatchObject({
      content: expect.stringContaining('# 34. Jane Doe'),
      path: 'people/34-jane-doe.md',
    });

    const report = await createWorkspaceDocument({
      kind: 'report',
      root,
      title: 'Alex Smith',
    });
    expect(report).toMatchObject({
      content: expect.stringContaining('**Person number:** 35'),
      path: 'reports/alex-smith.md',
    });

    const interview = await createWorkspaceDocument({
      kind: 'interview',
      root,
      title: 'Candidate Name',
    });
    expect(interview).toMatchObject({
      content: '# 15. Candidate Name\n\n# Behavioral\n\nQuestion?\n',
      path: 'interviews/15-candidate-name.md',
    });

    await expect(
      readFile(join(root, 'config', 'workspace.json'), 'utf8').then(JSON.parse),
    ).resolves.toEqual({
      nextInterviewNumber: 16,
      nextPersonNumber: 36,
    });
    await expect(readFile(join(root, 'AGENTS.md'), 'utf8')).resolves.toBe(
      '- **Next person number:** 34\n- **Next interview number:** 15\n',
    );
    await expect(
      createWorkspaceDocument({
        kind: 'doc',
        root,
        title: 'Architecture Notes',
      }),
    ).rejects.toThrow('already exists');
  });

  test('deletes only unreferenced interview documents', async () => {
    const root = await createWorkspace();
    await expect(deleteInterview({ path: 'interviews/01-candidate.md', root })).resolves.toEqual({
      path: 'interviews/01-candidate.md',
    });
    await expect(readDocument(root, 'interviews/01-candidate.md')).rejects.toMatchObject({
      code: 'ENOENT',
    });

    await writeFile(join(root, 'interviews', '02-linked.md'), '# 2. Linked Candidate\n');
    await writeFile(
      join(root, 'docs', 'references.md'),
      '[Candidate](../interviews/02-linked.md)\n',
    );
    await expect(deleteInterview({ path: 'interviews/02-linked.md', root })).rejects.toThrow(
      'docs/references.md',
    );
    await expect(deleteInterview({ path: 'docs/todo.md', root })).rejects.toThrow(
      'Only interview documents',
    );
  });

  test('deletes any unreferenced visible document', async () => {
    const root = await createWorkspace();
    await expect(deleteDocument({ path: 'reports/report.md', root })).resolves.toEqual({
      path: 'reports/report.md',
    });
    await expect(readDocument(root, 'reports/report.md')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(deleteDocument({ path: 'reports/_template.md', root })).rejects.toThrow(
      'Invalid document path',
    );
  });
});

describe('document middleware', () => {
  test('loads documents and workspace grouping together at runtime', async () => {
    const root = await createWorkspace();
    const origin = await startDocumentServer(root);
    const response = await fetch(`${origin}/__meetings/workspace`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      documents: expect.arrayContaining([expect.objectContaining({ path: 'people/01-person.md' })]),
      metadataError: null,
      peoplePaths: ['people/01-person.md'],
    });
  });

  test('keeps notes accessible when optional grouping metadata is missing', async () => {
    const root = await createWorkspace();
    await rm(join(root, 'config', 'people.json'));
    const origin = await startDocumentServer(root);
    const response = await fetch(`${origin}/__meetings/workspace`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      documents: expect.arrayContaining([expect.objectContaining({ path: 'docs/todo.md' })]),
      metadataError: expect.stringContaining('config/people.json'),
      peoplePaths: [],
    });
  });

  test('rejects cross-origin and non-JSON writes', async () => {
    const root = await createWorkspace();
    const origin = await startDocumentServer(root);
    const current = await readDocument(root, 'docs/todo.md');
    const payload = JSON.stringify({
      baseHash: current.hash,
      content: '# Updated\n',
      path: 'docs/todo.md',
    });

    const crossOrigin = await fetch(`${origin}/__meetings/document`, {
      body: payload,
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://example.com',
      },
      method: 'PUT',
    });
    expect(crossOrigin.status).toBe(403);

    const nonJson = await fetch(`${origin}/__meetings/document`, {
      body: payload,
      headers: { Origin: origin },
      method: 'PUT',
    });
    expect(nonJson.status).toBe(403);
  });

  test('writes matching versions and returns 409 with the disk version', async () => {
    const root = await createWorkspace();
    const origin = await startDocumentServer(root);
    const current = await readDocument(root, 'docs/todo.md');

    const savedResponse = await fetch(`${origin}/__meetings/document`, {
      body: JSON.stringify({
        baseHash: current.hash,
        content: '# ToDo\n\n- [ ] Saved through middleware.\n',
        path: 'docs/todo.md',
      }),
      headers: {
        'Content-Type': 'application/json',
        Origin: origin,
      },
      method: 'PUT',
    });
    expect(savedResponse.status).toBe(200);
    const savedBody = await savedResponse.json();
    expect(savedBody.document.content).toContain('Saved through middleware');

    await writeFile(join(root, 'docs', 'todo.md'), '# Changed on disk\n');
    const conflictResponse = await fetch(`${origin}/__meetings/document`, {
      body: JSON.stringify({
        baseHash: savedBody.document.hash,
        content: '# Stale browser edit\n',
        path: 'docs/todo.md',
      }),
      headers: {
        'Content-Type': 'application/json',
        Origin: origin,
      },
      method: 'PUT',
    });
    expect(conflictResponse.status).toBe(409);
    const conflictBody = await conflictResponse.json();
    expect(conflictBody.document).toMatchObject({
      content: '# Changed on disk\n',
      path: 'docs/todo.md',
    });
  });

  test('creates documents through the same-origin JSON endpoint', async () => {
    const root = await createWorkspace();
    const origin = await startDocumentServer(root);
    const response = await fetch(`${origin}/__meetings/create`, {
      body: JSON.stringify({ kind: 'doc', title: 'Design Notes' }),
      headers: {
        'Content-Type': 'application/json',
        Origin: origin,
      },
      method: 'POST',
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      document: { content: '# Design Notes\n', path: 'docs/design-notes.md' },
    });
  });

  test('completes interviews through the explicit delete endpoint', async () => {
    const root = await createWorkspace();
    const origin = await startDocumentServer(root);
    const response = await fetch(`${origin}/__meetings/interview`, {
      body: JSON.stringify({ path: 'interviews/01-candidate.md' }),
      headers: {
        'Content-Type': 'application/json',
        Origin: origin,
      },
      method: 'DELETE',
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      path: 'interviews/01-candidate.md',
    });
  });

  test('deletes documents through the document endpoint', async () => {
    const root = await createWorkspace();
    const origin = await startDocumentServer(root);
    const response = await fetch(`${origin}/__meetings/document`, {
      body: JSON.stringify({ path: 'reports/report.md' }),
      headers: {
        'Content-Type': 'application/json',
        Origin: origin,
      },
      method: 'DELETE',
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      path: 'reports/report.md',
    });
  });

  test('formats only through the explicit format endpoint', async () => {
    const root = await createWorkspace();
    const origin = await startDocumentServer(root);
    const current = await readDocument(root, 'docs/todo.md');
    const unformatted = '# ToDo\n\n-   Keep autosave literal\n';

    const savedResponse = await fetch(`${origin}/__meetings/document`, {
      body: JSON.stringify({
        baseHash: current.hash,
        content: unformatted,
        path: 'docs/todo.md',
      }),
      headers: {
        'Content-Type': 'application/json',
        Origin: origin,
      },
      method: 'PUT',
    });
    expect(savedResponse.status).toBe(200);
    await expect(readDocument(root, 'docs/todo.md')).resolves.toMatchObject({
      content: unformatted,
    });

    const formattedResponse = await fetch(`${origin}/__meetings/format`, {
      body: JSON.stringify({
        content: unformatted,
        path: 'docs/todo.md',
      }),
      headers: {
        'Content-Type': 'application/json',
        Origin: origin,
      },
      method: 'POST',
    });
    expect(formattedResponse.status).toBe(200);
    await expect(formattedResponse.json()).resolves.toEqual({
      content: '# ToDo\n\n- Keep autosave literal\n',
    });
    await expect(readDocument(root, 'docs/todo.md')).resolves.toMatchObject({
      content: unformatted,
    });
  });
});
