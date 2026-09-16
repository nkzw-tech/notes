import { createHash, randomUUID } from 'node:crypto';
import { open, link, readdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, relative, resolve, sep } from 'node:path';
import { format } from 'oxfmt';
import {
  readWorkspaceMetadataOrDefault,
  reconcileWorkspaceMetadataPaths,
} from './workspace-metadata.ts';

const require = createRequire(import.meta.url);

export const WORKSPACE_ENDPOINT = '/__meetings/workspace';
export const CREATE_ENDPOINT = '/__meetings/create';
export const DELETE_INTERVIEW_ENDPOINT = '/__meetings/interview';
export const DOCUMENT_ENDPOINT = '/__meetings/document';
export const FORMAT_ENDPOINT = '/__meetings/format';
export const RESTORE_ENDPOINT = '/__meetings/restore';

const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
export const DOCUMENT_DIRECTORIES = new Set([
  'docs',
  'interviews',
  'meetings',
  'people',
  'reports',
]);
const pendingDocumentWrites = new Map<string, Promise<void>>();

const serializeDocumentWrite = async <Value>(
  root: string,
  path: string,
  operation: () => Promise<Value>,
) => {
  const key = resolveDocumentPath(root, path).absolutePath;
  const previousWrite = pendingDocumentWrites.get(key) ?? Promise.resolve();
  let releaseWrite!: () => void;
  const pendingWrite = new Promise<void>((resolveWrite) => {
    releaseWrite = resolveWrite;
  });
  pendingDocumentWrites.set(key, pendingWrite);

  await previousWrite;
  try {
    return await operation();
  } finally {
    releaseWrite();
    if (pendingDocumentWrites.get(key) === pendingWrite) {
      pendingDocumentWrites.delete(key);
    }
  }
};

const syncDirectory = async (path: string) => {
  try {
    const directory = await open(dirname(path), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    if (!['EINVAL', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      throw error;
    }
  }
};

export type StoredDocument = {
  content: string;
  hash: string;
  mtimeMs: number;
  path: string;
};

export type CreateDocumentKind = 'doc' | 'interview' | 'person' | 'report';

const creationService = require('./electron/document-creation.cjs') as {
  createWorkspaceDocument: (request: {
    kind: CreateDocumentKind;
    root: string;
    title: string;
  }) => Promise<StoredDocument>;
};

export const createWorkspaceDocument = (request: {
  kind: CreateDocumentKind;
  root: string;
  title: string;
}) => creationService.createWorkspaceDocument(request);

export type DocumentChangeEvent =
  | {
      deleted: true;
      path: string;
    }
  | {
      deleted: false;
      document: StoredDocument;
      path: string;
    };

export class DocumentConflictError extends Error {
  document: StoredDocument;

  constructor(document: StoredDocument) {
    super(`Document changed on disk: ${document.path}`);
    this.name = 'DocumentConflictError';
    this.document = document;
  }
}

const hashContent = (content: string) => createHash('sha256').update(content).digest('hex');

export const normalizeDocumentPath = (value: string) => {
  const normalized = value.replaceAll('\\', '/');
  if (normalized.length === 0 || normalized.startsWith('/') || normalized.includes('\0')) {
    return null;
  }

  const segments = normalized.split('/');
  if (segments.some((segment) => segment === '' || segment === '..' || segment === '.')) {
    return null;
  }

  if (segments.length === 2) {
    const [directory, filename] = segments;
    if (
      !directory ||
      !DOCUMENT_DIRECTORIES.has(directory) ||
      !filename?.endsWith('.md') ||
      filename.startsWith('_') ||
      filename.startsWith('.')
    ) {
      return null;
    }
    return `${directory}/${filename}`;
  }

  return null;
};

export const resolveDocumentPath = (root: string, documentPath: string) => {
  const normalized = normalizeDocumentPath(documentPath);
  if (!normalized) {
    throw new Error(`Invalid document path: ${documentPath}`);
  }

  const absolutePath = resolve(root, normalized);
  const relativePath = relative(resolve(root), absolutePath);
  if (
    relativePath.startsWith(`..${sep}`) ||
    relativePath === '..' ||
    relativePath.startsWith(sep)
  ) {
    throw new Error(`Document path escapes workspace: ${documentPath}`);
  }

  return {
    absolutePath,
    path: normalized,
  };
};

export const readDocument = async (root: string, documentPath: string): Promise<StoredDocument> => {
  const resolved = resolveDocumentPath(root, documentPath);
  const [content, fileStat] = await Promise.all([
    readFile(resolved.absolutePath, 'utf8'),
    stat(resolved.absolutePath),
  ]);

  if (!fileStat.isFile()) {
    throw new Error(`Not a file: ${documentPath}`);
  }

  return {
    content,
    hash: hashContent(content),
    mtimeMs: fileStat.mtimeMs,
    path: resolved.path,
  };
};

export const listDocuments = async (root: string) => {
  const rootEntries = await readdir(root, { withFileTypes: true });
  const paths = rootEntries
    .filter((entry) => entry.isFile() && normalizeDocumentPath(entry.name) !== null)
    .map((entry) => entry.name);

  for (const directory of DOCUMENT_DIRECTORIES) {
    const directoryPath = resolve(root, directory);
    try {
      const entries = await readdir(directoryPath, { withFileTypes: true });
      for (const entry of entries) {
        const documentPath = `${directory}/${entry.name}`;
        if (entry.isFile() && normalizeDocumentPath(documentPath)) {
          paths.push(documentPath);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  return Promise.all(paths.sort().map((documentPath) => readDocument(root, documentPath)));
};

export const loadWorkspace = async (root: string) => {
  const [documents, metadata] = await Promise.all([
    listDocuments(root),
    readWorkspaceMetadataOrDefault(root),
  ]);
  return {
    documents,
    ...reconcileWorkspaceMetadataPaths(metadata, new Set(documents.map(({ path }) => path))),
  };
};

const writeDocumentUnlocked = async ({
  baseHash,
  content,
  path,
  root,
}: {
  baseHash: string;
  content: string;
  path: string;
  root: string;
}) => {
  if (Buffer.byteLength(content, 'utf8') > MAX_DOCUMENT_BYTES) {
    throw new Error('Document exceeds the 2 MB limit.');
  }

  const current = await readDocument(root, path);
  if (current.hash !== baseHash) {
    throw new DocumentConflictError(current);
  }

  if (current.content === content) {
    return current;
  }

  const resolved = resolveDocumentPath(root, path);
  const temporaryPath = resolve(
    dirname(resolved.absolutePath),
    `.${resolved.path.split('/').at(-1)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const file = await open(temporaryPath, 'wx', 0o644);

  try {
    await file.writeFile(content, 'utf8');
    await file.sync();
  } finally {
    await file.close();
  }

  try {
    await rename(temporaryPath, resolved.absolutePath);
    await syncDirectory(resolved.absolutePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }

  return readDocument(root, path);
};

export const writeDocument = async (request: {
  baseHash: string;
  content: string;
  path: string;
  root: string;
}) => {
  return serializeDocumentWrite(request.root, request.path, () => writeDocumentUnlocked(request));
};

const deleteResolvedDocument = async ({
  path,
  referenceAction,
  root,
}: {
  path: string;
  referenceAction: string;
  root: string;
}) => {
  const resolved = resolveDocumentPath(root, path);
  const filename = resolved.path.split('/').at(-1)!;
  const references = (await listDocuments(root))
    .filter((document) => document.path !== resolved.path && document.content.includes(filename))
    .map((document) => document.path);
  if (references.length > 0) {
    throw new Error(
      `Remove references to this document before ${referenceAction}: ${references.join(', ')}.`,
    );
  }
  await unlink(resolved.absolutePath);
  await syncDirectory(resolved.absolutePath);
  return { path: resolved.path };
};

export const deleteDocument = async ({ path, root }: { path: string; root: string }) =>
  serializeDocumentWrite(root, path, () =>
    deleteResolvedDocument({ path, referenceAction: 'deleting it', root }),
  );

export const deleteInterview = async ({ path, root }: { path: string; root: string }) =>
  serializeDocumentWrite(root, path, async () => {
    const resolved = resolveDocumentPath(root, path);
    if (!resolved.path.startsWith('interviews/')) {
      throw new Error('Only interview documents can be completed and deleted.');
    }
    return deleteResolvedDocument({
      path: resolved.path,
      referenceAction: 'completing the interview',
      root,
    });
  });

const restoreDocumentUnlocked = async ({
  content,
  path,
  root,
}: {
  content: string;
  path: string;
  root: string;
}) => {
  if (Buffer.byteLength(content, 'utf8') > MAX_DOCUMENT_BYTES) {
    throw new Error('Document exceeds the 2 MB limit.');
  }
  const resolved = resolveDocumentPath(root, path);
  const temporaryPath = resolve(
    dirname(resolved.absolutePath),
    `.${resolved.path.split('/').at(-1)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const file = await open(temporaryPath, 'wx', 0o644);
  try {
    await file.writeFile(content, 'utf8');
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await link(temporaryPath, resolved.absolutePath);
    await syncDirectory(resolved.absolutePath);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
  return readDocument(root, path);
};

export const restoreDocument = async (request: { content: string; path: string; root: string }) =>
  serializeDocumentWrite(request.root, request.path, () => restoreDocumentUnlocked(request));

export const formatDocumentContent = async ({
  content,
  path,
  root,
}: {
  content: string;
  path: string;
  root: string;
}) => {
  if (Buffer.byteLength(content, 'utf8') > MAX_DOCUMENT_BYTES) {
    throw new Error('Document exceeds the 2 MB limit.');
  }

  const resolved = resolveDocumentPath(root, path);
  const result = await format(resolved.absolutePath, content, {
    proseWrap: 'never',
  });
  const formattingError = result.errors.find(({ severity }) => severity === 'Error');
  if (formattingError) {
    throw new Error(formattingError.message);
  }
  if (Buffer.byteLength(result.code, 'utf8') > MAX_DOCUMENT_BYTES) {
    throw new Error('Formatted document exceeds the 2 MB limit.');
  }
  return result.code;
};

const sendJson = (response: ServerResponse, statusCode: number, value: unknown) => {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(JSON.stringify(value));
};

const requestIsSameOrigin = (request: IncomingMessage) => {
  const fetchSite = request.headers['sec-fetch-site'];
  if (fetchSite && fetchSite !== 'same-origin') {
    return false;
  }

  const origin = request.headers.origin;
  const host = request.headers.host;
  if (!origin || !host) {
    return true;
  }

  try {
    const originUrl = new URL(origin);
    return (
      originUrl.protocol === 'http:' &&
      originUrl.host === host &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(originUrl.hostname)
    );
  } catch {
    return false;
  }
};

const readJsonBody = async (request: IncomingMessage) => {
  let size = 0;
  const chunks: Array<Buffer> = [];

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_DOCUMENT_BYTES + 64 * 1024) {
      throw new Error('Request body is too large.');
    }
    chunks.push(buffer);
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
};

export const createDocumentMiddleware = ({
  onDocumentWriteStarted,
  onDocumentWritten,
  root,
}: {
  onDocumentWriteStarted?: (write: { content: string; path: string }) => void;
  onDocumentWritten?: (document: StoredDocument) => void;
  root: string;
}) => {
  return async (
    request: IncomingMessage,
    response: ServerResponse,
    next: (error?: unknown) => void,
  ) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;

    if (pathname === WORKSPACE_ENDPOINT && request.method === 'GET') {
      try {
        sendJson(response, 200, await loadWorkspace(root));
      } catch (error) {
        sendJson(response, 500, {
          error: error instanceof Error ? error.message : 'Failed to load documents.',
        });
      }
      return;
    }

    if (
      pathname !== CREATE_ENDPOINT &&
      pathname !== DELETE_INTERVIEW_ENDPOINT &&
      pathname !== DOCUMENT_ENDPOINT &&
      pathname !== FORMAT_ENDPOINT &&
      pathname !== RESTORE_ENDPOINT
    ) {
      next();
      return;
    }

    const expectedMethods =
      pathname === DOCUMENT_ENDPOINT
        ? ['DELETE', 'PUT']
        : pathname === DELETE_INTERVIEW_ENDPOINT
          ? ['DELETE']
          : ['POST'];
    if (!request.method || !expectedMethods.includes(request.method)) {
      response.setHeader('Allow', expectedMethods.join(', '));
      sendJson(response, 405, { error: 'Method not allowed.' });
      return;
    }

    if (
      !requestIsSameOrigin(request) ||
      !request.headers['content-type']?.startsWith('application/json')
    ) {
      sendJson(response, 403, {
        error: 'Document writes require a same-origin JSON request.',
      });
      return;
    }

    try {
      const body = await readJsonBody(request);
      if (pathname === DELETE_INTERVIEW_ENDPOINT) {
        if (
          typeof body !== 'object' ||
          body === null ||
          !('path' in body) ||
          typeof body.path !== 'string'
        ) {
          sendJson(response, 400, { error: 'Invalid interview completion payload.' });
          return;
        }
        sendJson(response, 200, await deleteInterview({ path: body.path, root }));
        return;
      }
      if (pathname === DOCUMENT_ENDPOINT && request.method === 'DELETE') {
        if (
          typeof body !== 'object' ||
          body === null ||
          !('path' in body) ||
          typeof body.path !== 'string'
        ) {
          sendJson(response, 400, { error: 'Invalid document deletion payload.' });
          return;
        }
        sendJson(response, 200, await deleteDocument({ path: body.path, root }));
        return;
      }
      if (pathname === CREATE_ENDPOINT) {
        if (
          typeof body !== 'object' ||
          body === null ||
          !('kind' in body) ||
          !('title' in body) ||
          typeof body.kind !== 'string' ||
          !(['doc', 'interview', 'person', 'report'] as const).includes(
            body.kind as CreateDocumentKind,
          ) ||
          typeof body.title !== 'string'
        ) {
          sendJson(response, 400, { error: 'Invalid create payload.' });
          return;
        }
        const document = await createWorkspaceDocument({
          kind: body.kind as CreateDocumentKind,
          root,
          title: body.title,
        });
        onDocumentWritten?.(document);
        sendJson(response, 201, { document });
        return;
      }
      if (pathname === RESTORE_ENDPOINT) {
        if (
          typeof body !== 'object' ||
          body === null ||
          !('path' in body) ||
          !('content' in body) ||
          typeof body.path !== 'string' ||
          typeof body.content !== 'string'
        ) {
          sendJson(response, 400, { error: 'Invalid restore payload.' });
          return;
        }
        sendJson(response, 200, {
          document: await restoreDocument({
            content: body.content,
            path: body.path,
            root,
          }),
        });
        return;
      }
      if (pathname === FORMAT_ENDPOINT) {
        if (
          typeof body !== 'object' ||
          body === null ||
          !('path' in body) ||
          !('content' in body) ||
          typeof body.path !== 'string' ||
          typeof body.content !== 'string'
        ) {
          sendJson(response, 400, { error: 'Invalid format payload.' });
          return;
        }

        sendJson(response, 200, {
          content: await formatDocumentContent({
            content: body.content,
            path: body.path,
            root,
          }),
        });
        return;
      }

      if (
        typeof body !== 'object' ||
        body === null ||
        !('path' in body) ||
        !('content' in body) ||
        !('baseHash' in body) ||
        typeof body.path !== 'string' ||
        typeof body.content !== 'string' ||
        typeof body.baseHash !== 'string'
      ) {
        sendJson(response, 400, { error: 'Invalid document payload.' });
        return;
      }

      onDocumentWriteStarted?.({
        content: body.content,
        path: body.path,
      });
      const document = await writeDocument({
        baseHash: body.baseHash,
        content: body.content,
        path: body.path,
        root,
      });
      onDocumentWritten?.(document);
      sendJson(response, 200, { document });
    } catch (error) {
      if (error instanceof DocumentConflictError) {
        sendJson(response, 409, {
          document: error.document,
          error: error.message,
        });
        return;
      }

      const code = (error as NodeJS.ErrnoException).code;
      sendJson(response, code === 'ENOENT' ? 404 : code === 'EEXIST' ? 409 : 400, {
        error: error instanceof Error ? error.message : 'Failed to save document.',
      });
    }
  };
};
