// @ts-check

const { createHash, randomUUID } = require('node:crypto');
const {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} = require('node:fs');
const { open, link, readdir, readFile, rename, stat, unlink } = require('node:fs/promises');
const { dirname, relative, resolve, sep } = require('node:path');
const { createWorkspaceDocument } = require('./document-creation.cjs');

const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
const DOCUMENT_DIRECTORIES = new Set(['docs', 'interviews', 'meetings', 'people', 'reports']);
const pendingDocumentWrites = new Map();

/**
 * @template Value
 * @param {string} root
 * @param {string} path
 * @param {() => Promise<Value>} operation
 * @returns {Promise<Value>}
 */
const serializeDocumentWrite = async (root, path, operation) => {
  const key = resolveDocumentPath(root, path).absolutePath;
  const previousWrite = pendingDocumentWrites.get(key) ?? Promise.resolve();
  /** @type {() => void} */
  let releaseWrite;
  const pendingWrite = new Promise((resolveWrite) => {
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

/** @param {string} path */
const syncDirectory = async (path) => {
  try {
    const directory = await open(dirname(path), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    if (!['EINVAL', 'EPERM'].includes(error.code ?? '')) {
      throw error;
    }
  }
};

/** @param {string} path */
const syncDirectorySync = (path) => {
  let descriptor;
  try {
    descriptor = openSync(dirname(path), 'r');
    fsyncSync(descriptor);
  } catch (error) {
    if (!['EINVAL', 'EPERM'].includes(error.code ?? '')) {
      throw error;
    }
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
};

class DocumentConflictError extends Error {
  /** @param {StoredDocument} document */
  constructor(document) {
    super(`Document changed on disk: ${document.path}`);
    this.name = 'DocumentConflictError';
    this.document = document;
  }
}

/** @typedef {{content: string; hash: string; mtimeMs: number; path: string}} StoredDocument */

/** @param {string} content */
const hashContent = (content) => createHash('sha256').update(content).digest('hex');

/** @param {string} value */
const normalizeDocumentPath = (value) => {
  const normalized = value.replaceAll('\\', '/');
  if (normalized.length === 0 || normalized.startsWith('/') || normalized.includes('\0')) {
    return null;
  }

  const segments = normalized.split('/');
  if (segments.some((segment) => segment === '' || segment === '..' || segment === '.')) {
    return null;
  }

  if (segments.length !== 2) {
    return null;
  }

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
};

/** @param {string} root @param {string} documentPath */
const resolveDocumentPath = (root, documentPath) => {
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

  return { absolutePath, path: normalized };
};

/** @param {string} root @param {string} documentPath @returns {Promise<StoredDocument>} */
const readDocument = async (root, documentPath) => {
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

/** @param {string} root @param {string} documentPath @returns {StoredDocument} */
const readDocumentSync = (root, documentPath) => {
  const resolved = resolveDocumentPath(root, documentPath);
  const content = readFileSync(resolved.absolutePath, 'utf8');
  const fileStat = statSync(resolved.absolutePath);
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

/** @param {string} root */
const listDocuments = async (root) => {
  const paths = [];
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
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') {
        throw error;
      }
    }
  }
  return Promise.all(paths.sort().map((documentPath) => readDocument(root, documentPath)));
};

/** @param {string} root */
const isWorkspaceRoot = (root) =>
  [...DOCUMENT_DIRECTORIES].every((directory) => existsSync(resolve(root, directory)));

/**
 * @param {{baseHash: string; content: string; path: string; root: string}} request
 * @returns {Promise<StoredDocument>}
 */
const writeDocumentUnlocked = async ({ baseHash, content, path, root }) => {
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

/**
 * @param {{baseHash: string; content: string; path: string; root: string}} request
 * @returns {Promise<StoredDocument>}
 */
const writeDocument = async (request) => {
  return serializeDocumentWrite(request.root, request.path, () => writeDocumentUnlocked(request));
};

/**
 * @param {{path: string; referenceAction: string; root: string}} request
 */
const deleteResolvedDocument = async ({ path, referenceAction, root }) => {
  const resolved = resolveDocumentPath(root, path);
  const filename = resolved.path.split('/').at(-1);
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

/** @param {{path: string; root: string}} request */
const deleteDocument = async ({ path, root }) =>
  serializeDocumentWrite(root, path, () =>
    deleteResolvedDocument({ path, referenceAction: 'deleting it', root }),
  );

/** @param {{path: string; root: string}} request */
const deleteInterview = async ({ path, root }) =>
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

/** @param {{content: string; path: string; root: string}} request */
const restoreDocumentUnlocked = async ({ content, path, root }) => {
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

/** @param {{content: string; path: string; root: string}} request */
const restoreDocument = async (request) =>
  serializeDocumentWrite(request.root, request.path, () => restoreDocumentUnlocked(request));

/**
 * @param {{baseHash: string; content: string; path: string; root: string}} request
 * @returns {StoredDocument}
 */
const writeDocumentSync = ({ baseHash, content, path, root }) => {
  // A lifecycle flush from another window must not overtake an async autosave.
  if (pendingDocumentWrites.has(resolveDocumentPath(root, path).absolutePath)) {
    throw new Error('Another save is in progress. Try again when it finishes.');
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_DOCUMENT_BYTES) {
    throw new Error('Document exceeds the 2 MB limit.');
  }

  const current = readDocumentSync(root, path);
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
  const descriptor = openSync(temporaryPath, 'wx', 0o644);
  try {
    writeFileSync(descriptor, content, 'utf8');
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }

  try {
    renameSync(temporaryPath, resolved.absolutePath);
    syncDirectorySync(resolved.absolutePath);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {}
    throw error;
  }
  return readDocumentSync(root, path);
};

/**
 * @param {{content: string; path: string; root: string}} request
 */
const formatDocumentContent = async ({ content, path, root }) => {
  if (Buffer.byteLength(content, 'utf8') > MAX_DOCUMENT_BYTES) {
    throw new Error('Document exceeds the 2 MB limit.');
  }
  const resolved = resolveDocumentPath(root, path);
  const { format } = await import('oxfmt');
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

module.exports = {
  DOCUMENT_DIRECTORIES,
  DocumentConflictError,
  createWorkspaceDocument,
  deleteDocument,
  deleteInterview,
  formatDocumentContent,
  hashContent,
  isWorkspaceRoot,
  listDocuments,
  normalizeDocumentPath,
  readDocument,
  readDocumentSync,
  resolveDocumentPath,
  restoreDocument,
  writeDocument,
  writeDocumentSync,
};
