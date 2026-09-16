// @ts-check

const { existsSync, watch } = require('node:fs');
const { basename, dirname, resolve } = require('node:path');
const {
  DOCUMENT_DIRECTORIES,
  DocumentConflictError,
  listDocuments,
  normalizeDocumentPath,
  readDocument,
  writeDocument,
  writeDocumentSync,
} = require('./document-service.cjs');
const {
  readWorkspaceMetadataOrDefault,
  reconcileWorkspaceMetadataPaths,
  WORKSPACE_METADATA_PATH,
} = require('./workspace-metadata.cjs');

// All windows on a workspace share watcher state; other workspaces are isolated.
const createWorkspaceSession = (workspaceRoot, getWindows) => {
  const pendingChanges = new Map();
  const changeGenerations = new Map();
  const knownDocumentHashes = new Map();
  const activeDocumentWrites = new Map();
  const documentWriteGenerations = new Map();
  const workspaceWatchers = [];
  let metadataChangeGeneration = 0;
  let pendingMetadataChange = null;

  // A committed version is remembered for the whole workspace session. Watch
  // notifications are hints to read disk, not evidence of an external edit.
  // There are no expiring self-write tokens or time-based conflict decisions.
  /** @param {{hash: string; path: string}} document */
  const rememberWrite = (document) => {
    knownDocumentHashes.set(document.path, document.hash);
    documentWriteGenerations.set(
      document.path,
      (documentWriteGenerations.get(document.path) ?? 0) + 1,
    );
  };

  /** @param {string} path */
  const beginDocumentWrite = (path) => {
    activeDocumentWrites.set(path, (activeDocumentWrites.get(path) ?? 0) + 1);
    documentWriteGenerations.set(path, (documentWriteGenerations.get(path) ?? 0) + 1);
  };

  /** @param {string} path */
  const endDocumentWrite = (path) => {
    const remainingWrites = (activeDocumentWrites.get(path) ?? 1) - 1;
    if (remainingWrites > 0) {
      activeDocumentWrites.set(path, remainingWrites);
    } else {
      activeDocumentWrites.delete(path);
    }
  };

  /** @param {unknown} error */
  const errorMessage = (error) => (error instanceof Error ? error.message : String(error));

  /** @param {string} path */
  const publishDocumentChange = async (path, generation) => {
    if (activeDocumentWrites.has(path)) {
      scheduleDocumentChange(path);
      return;
    }
    const writeGeneration = documentWriteGenerations.get(path) ?? 0;
    try {
      const document = await readDocument(workspaceRoot, path);
      if (changeGenerations.get(path) !== generation) {
        return;
      }
      if (
        activeDocumentWrites.has(path) ||
        (documentWriteGenerations.get(path) ?? 0) !== writeGeneration
      ) {
        scheduleDocumentChange(path);
        return;
      }
      if (knownDocumentHashes.get(path) === document.hash) {
        return;
      }
      knownDocumentHashes.set(path, document.hash);
      for (const window of getWindows()) {
        if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
          window.webContents.send('meetings:document-change', {
            deleted: false,
            document,
            path,
          });
        }
      }
    } catch (error) {
      if (changeGenerations.get(path) !== generation) {
        return;
      }
      if (
        activeDocumentWrites.has(path) ||
        (documentWriteGenerations.get(path) ?? 0) !== writeGeneration
      ) {
        scheduleDocumentChange(path);
        return;
      }
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') {
        console.error(`Failed to publish Markdown change for ${path}: ${errorMessage(error)}`);
        return;
      }
      knownDocumentHashes.delete(path);
      for (const window of getWindows()) {
        if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
          window.webContents.send('meetings:document-change', {
            deleted: true,
            path,
          });
        }
      }
    }
  };

  const reconcileWorkspaceDocuments = async () => {
    try {
      const documents = await listDocuments(workspaceRoot);
      const currentPaths = new Set(documents.map(({ path }) => path));
      for (const document of documents) {
        if (knownDocumentHashes.get(document.path) === document.hash) {
          continue;
        }
        const generation = (changeGenerations.get(document.path) ?? 0) + 1;
        changeGenerations.set(document.path, generation);
        await publishDocumentChange(document.path, generation);
      }
      for (const path of knownDocumentHashes.keys()) {
        if (!currentPaths.has(path)) {
          const generation = (changeGenerations.get(path) ?? 0) + 1;
          changeGenerations.set(path, generation);
          await publishDocumentChange(path, generation);
        }
      }
    } catch (error) {
      console.error(`Failed to reconcile Markdown files: ${errorMessage(error)}`);
    }
  };

  /** @param {string} path */
  const scheduleDocumentChange = (path) => {
    const normalizedPath = normalizeDocumentPath(path);
    if (!normalizedPath) {
      return;
    }
    const generation = (changeGenerations.get(normalizedPath) ?? 0) + 1;
    changeGenerations.set(normalizedPath, generation);
    const existing = pendingChanges.get(normalizedPath);
    if (existing) {
      clearTimeout(existing);
    }
    pendingChanges.set(
      normalizedPath,
      setTimeout(() => {
        pendingChanges.delete(normalizedPath);
        void publishDocumentChange(normalizedPath, generation);
      }, 40),
    );
  };

  const publishWorkspaceMetadataChange = async (generation) => {
    let change;
    try {
      const [documents, metadata] = await Promise.all([
        listDocuments(workspaceRoot),
        readWorkspaceMetadataOrDefault(workspaceRoot),
      ]);
      const reconciled = reconcileWorkspaceMetadataPaths(
        metadata,
        new Set(documents.map(({ path }) => path)),
      );
      change = {
        ...(reconciled.metadataError ? { error: reconciled.metadataError } : {}),
        metadata: { peoplePaths: reconciled.peoplePaths },
      };
    } catch (error) {
      change = {
        error: `Failed to load ${WORKSPACE_METADATA_PATH}: ${errorMessage(error)}`,
      };
    }
    if (metadataChangeGeneration !== generation) {
      return;
    }
    for (const window of getWindows()) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send('meetings:workspace-metadata-change', change);
      }
    }
  };

  const scheduleWorkspaceMetadataChange = () => {
    metadataChangeGeneration += 1;
    const generation = metadataChangeGeneration;
    if (pendingMetadataChange) {
      clearTimeout(pendingMetadataChange);
    }
    pendingMetadataChange = setTimeout(() => {
      pendingMetadataChange = null;
      void publishWorkspaceMetadataChange(generation);
    }, 40);
  };

  const startWorkspaceWatchers = () => {
    if (!workspaceRoot) {
      return;
    }
    for (const directory of DOCUMENT_DIRECTORIES) {
      const directoryPath = resolve(workspaceRoot, directory);
      if (!existsSync(directoryPath)) {
        continue;
      }
      const watcher = watch(directoryPath, { persistent: false }, (_eventType, filename) => {
        if (filename) {
          scheduleDocumentChange(`${directory}/${String(filename)}`);
        } else {
          void reconcileWorkspaceDocuments();
        }
      });
      watcher.on('error', (error) => {
        console.error(`Failed to watch ${directoryPath}: ${errorMessage(error)}`);
        void reconcileWorkspaceDocuments();
      });
      workspaceWatchers.push(watcher);
    }

    const metadataDirectory = resolve(workspaceRoot, dirname(WORKSPACE_METADATA_PATH));
    if (existsSync(metadataDirectory)) {
      const watcher = watch(metadataDirectory, { persistent: false }, (_eventType, filename) => {
        if (filename === null || String(filename) === basename(WORKSPACE_METADATA_PATH)) {
          scheduleWorkspaceMetadataChange();
        }
      });
      watcher.on('error', (error) => {
        console.error(`Failed to watch ${metadataDirectory}: ${errorMessage(error)}`);
        void publishWorkspaceMetadataChange(++metadataChangeGeneration);
      });
      workspaceWatchers.push(watcher);
    }
  };

  const stopWorkspaceWatchers = () => {
    for (const watcher of workspaceWatchers.splice(0)) {
      watcher.close();
    }
    for (const timer of pendingChanges.values()) {
      clearTimeout(timer);
    }
    pendingChanges.clear();
    changeGenerations.clear();
    knownDocumentHashes.clear();
    activeDocumentWrites.clear();
    documentWriteGenerations.clear();
    if (pendingMetadataChange) {
      clearTimeout(pendingMetadataChange);
      pendingMetadataChange = null;
    }
    metadataChangeGeneration += 1;
  };

  const requireWorkspaceRoot = () => {
    if (!workspaceRoot) {
      throw new Error('Choose a Notes workspace first.');
    }
    return workspaceRoot;
  };

  const readWorkspaceSnapshot = async () => {
    if (!workspaceRoot) {
      return {
        documents: [],
        metadataError: null,
        peoplePaths: [],
        workspacePath: null,
      };
    }
    const [documents, metadata] = await Promise.all([
      listDocuments(workspaceRoot),
      readWorkspaceMetadataOrDefault(workspaceRoot),
    ]);
    return {
      documents,
      ...reconcileWorkspaceMetadataPaths(metadata, new Set(documents.map(({ path }) => path))),
      workspacePath: workspaceRoot,
    };
  };

  // Restoring several windows should scan a workspace once. Share only an
  // in-flight read; later opens still read disk instead of using stale content.
  let workspaceLoadInFlight = null;
  const loadWorkspaceSnapshot = () => {
    if (!workspaceLoadInFlight) {
      workspaceLoadInFlight = readWorkspaceSnapshot().finally(() => {
        workspaceLoadInFlight = null;
      });
    }
    return workspaceLoadInFlight;
  };

  const publishSavedDocument = (document, sender) => {
    for (const window of getWindows()) {
      if (
        !window.isDestroyed() &&
        !window.webContents.isDestroyed() &&
        window.webContents !== sender
      ) {
        window.webContents.send('meetings:document-change', {
          deleted: false,
          document,
          path: document.path,
        });
      }
    }
  };

  /** @param {{baseHash: string; content: string; path: string}} request */
  const saveDocumentSync = (request, sender) => {
    const trackedPath =
      typeof request.path === 'string' ? normalizeDocumentPath(request.path) : null;
    if (trackedPath) {
      beginDocumentWrite(trackedPath);
    }
    try {
      const document = writeDocumentSync({
        ...request,
        root: requireWorkspaceRoot(),
      });
      rememberWrite(document);
      publishSavedDocument(document, sender);
      return { document, status: 'saved' };
    } catch (error) {
      if (error instanceof DocumentConflictError) {
        return { document: error.document, status: 'conflict' };
      }
      return { error: errorMessage(error), status: 'error' };
    } finally {
      if (trackedPath) {
        endDocumentWrite(trackedPath);
      }
    }
  };

  /** @param {{baseHash: string; content: string; path: string}} request */
  const saveDocument = async (request, sender) => {
    const trackedPath =
      typeof request.path === 'string' ? normalizeDocumentPath(request.path) : null;
    if (trackedPath) {
      beginDocumentWrite(trackedPath);
    }
    try {
      const document = await writeDocument({
        ...request,
        root: requireWorkspaceRoot(),
      });
      rememberWrite(document);
      publishSavedDocument(document, sender);
      return { document, status: 'saved' };
    } catch (error) {
      if (error instanceof DocumentConflictError) {
        return { document: error.document, status: 'conflict' };
      }
      return { error: errorMessage(error), status: 'error' };
    } finally {
      if (trackedPath) {
        endDocumentWrite(trackedPath);
      }
    }
  };

  startWorkspaceWatchers();
  return {
    loadWorkspaceSnapshot,
    publishSavedDocument,
    rememberWrite,
    requireWorkspaceRoot,
    saveDocument,
    saveDocumentSync,
    stopWorkspaceWatchers,
  };
};

module.exports = { createWorkspaceSession };
