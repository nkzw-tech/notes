import { createHash } from 'node:crypto';
import { availableParallelism } from 'node:os';
import { relative, resolve } from 'node:path';
import nkzw from '@nkzw/oxlint-config';
import babel from '@rolldown/plugin-babel';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import type { Plugin, ViteDevServer } from 'vite-plus';
import { defineConfig } from 'vite-plus';
import {
  createDocumentMiddleware,
  DOCUMENT_DIRECTORIES,
  listDocuments,
  normalizeDocumentPath,
  readDocument,
  type StoredDocument,
} from './document-service.ts';
import {
  readWorkspaceMetadataOrDefault,
  reconcileWorkspaceMetadataPaths,
  WORKSPACE_METADATA_PATH,
} from './workspace-metadata.ts';

const appRoot = import.meta.dirname;
const workspaceRoot = resolve(
  process.env.NOTES_WORKSPACE ??
    process.env.MEETINGS_WORKSPACE ??
    resolve(appRoot, 'workspace-starter'),
);
const DOCUMENT_CHANGE_EVENT = 'meetings:document-change';
const WORKSPACE_METADATA_CHANGE_EVENT = 'meetings:workspace-metadata-change';

const documentServicePlugin = (): Plugin => {
  const expectedWriteHashes = new Map<string, string>();
  const expectedWriteTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const changeGenerations = new Map<string, number>();
  const knownDocumentHashes = new Map<string, string>();

  const rememberWriteHash = (path: string, hash: string) => {
    const previousTimer = expectedWriteTimers.get(path);
    if (previousTimer) {
      clearTimeout(previousTimer);
    }
    expectedWriteHashes.set(path, hash);
    expectedWriteTimers.set(
      path,
      setTimeout(() => {
        if (expectedWriteHashes.get(path) === hash) {
          expectedWriteHashes.delete(path);
        }
        expectedWriteTimers.delete(path);
      }, 2000),
    );
  };

  const consumeExpectedWrite = (path: string, hash: string) => {
    const expectedHash = expectedWriteHashes.get(path);
    if (expectedHash === undefined) {
      return false;
    }
    expectedWriteHashes.delete(path);
    const timer = expectedWriteTimers.get(path);
    if (timer) {
      clearTimeout(timer);
      expectedWriteTimers.delete(path);
    }
    return expectedHash === hash;
  };

  const rememberExpectedWrite = ({ content, path }: { content: string; path: string }) => {
    const normalizedPath = normalizeDocumentPath(path);
    if (!normalizedPath) {
      return;
    }
    rememberWriteHash(normalizedPath, createHash('sha256').update(content).digest('hex'));
  };

  const rememberWrite = (document: StoredDocument) => {
    rememberWriteHash(document.path, document.hash);
    knownDocumentHashes.set(document.path, document.hash);
  };

  const getDocumentPath = (absolutePath: string) =>
    normalizeDocumentPath(relative(workspaceRoot, absolutePath).replaceAll('\\', '/'));

  const isWorkspaceMetadataPath = (absolutePath: string) =>
    relative(workspaceRoot, absolutePath).replaceAll('\\', '/') === WORKSPACE_METADATA_PATH;

  const attachWatcher = (server: ViteDevServer) => {
    server.watcher.add([
      ...[...DOCUMENT_DIRECTORIES].map((directory) => resolve(workspaceRoot, directory)),
      resolve(workspaceRoot, WORKSPACE_METADATA_PATH),
    ]);

    let metadataGeneration = 0;

    const publishWorkspaceMetadata = async () => {
      const generation = ++metadataGeneration;
      let data;
      try {
        const [documents, metadata] = await Promise.all([
          listDocuments(workspaceRoot),
          readWorkspaceMetadataOrDefault(workspaceRoot),
        ]);
        const reconciled = reconcileWorkspaceMetadataPaths(
          metadata,
          new Set(documents.map(({ path }) => path)),
        );
        data = {
          ...(reconciled.metadataError ? { error: reconciled.metadataError } : {}),
          metadata: { peoplePaths: reconciled.peoplePaths },
        };
      } catch (error) {
        data = {
          error: `Failed to load ${WORKSPACE_METADATA_PATH}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
      if (metadataGeneration !== generation) {
        return;
      }
      server.ws.send({
        data,
        event: WORKSPACE_METADATA_CHANGE_EVENT,
        type: 'custom',
      });
    };

    const publishDocument = async (absolutePath: string) => {
      const path = getDocumentPath(absolutePath);
      if (!path) {
        return;
      }
      const generation = (changeGenerations.get(path) ?? 0) + 1;
      changeGenerations.set(path, generation);

      try {
        const document = await readDocument(workspaceRoot, path);
        if (changeGenerations.get(path) !== generation) {
          return;
        }
        if (knownDocumentHashes.get(path) === document.hash) {
          consumeExpectedWrite(path, document.hash);
          return;
        }
        if (consumeExpectedWrite(path, document.hash)) {
          return;
        }

        knownDocumentHashes.set(path, document.hash);

        server.ws.send({
          data: {
            deleted: false,
            document,
            path,
          },
          event: DOCUMENT_CHANGE_EVENT,
          type: 'custom',
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          server.config.logger.error(
            `Failed to publish external Markdown change: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    };

    const publishWorkspaceChange = (absolutePath: string) => {
      if (isWorkspaceMetadataPath(absolutePath)) {
        void publishWorkspaceMetadata();
      } else {
        void publishDocument(absolutePath);
      }
    };

    server.watcher.on('add', publishWorkspaceChange);
    server.watcher.on('change', publishWorkspaceChange);
    server.watcher.on('unlink', (absolutePath) => {
      if (isWorkspaceMetadataPath(absolutePath)) {
        metadataGeneration += 1;
        server.ws.send({
          data: {
            error: `${WORKSPACE_METADATA_PATH} was deleted. People are shown as upcoming until it is restored.`,
            metadata: { peoplePaths: [] },
          },
          event: WORKSPACE_METADATA_CHANGE_EVENT,
          type: 'custom',
        });
        return;
      }
      const path = getDocumentPath(absolutePath);
      if (!path) {
        return;
      }
      changeGenerations.set(path, (changeGenerations.get(path) ?? 0) + 1);
      knownDocumentHashes.delete(path);
      server.ws.send({
        data: {
          deleted: true,
          path,
        },
        event: DOCUMENT_CHANGE_EVENT,
        type: 'custom',
      });
    });
  };

  return {
    configurePreviewServer(server) {
      server.middlewares.use(
        createDocumentMiddleware({
          root: workspaceRoot,
        }),
      );
    },
    configureServer(server) {
      server.middlewares.use(
        createDocumentMiddleware({
          onDocumentWriteStarted: rememberExpectedWrite,
          onDocumentWritten: rememberWrite,
          root: workspaceRoot,
        }),
      );
      attachWatcher(server);
    },
    name: 'meetings-document-service',
  };
};

export default defineConfig({
  base: './',
  fmt: {
    experimentalSortImports: { newlinesBetween: false },
    experimentalSortPackageJson: { sortScripts: true },
    ignorePatterns: [
      'coverage/',
      'dist/',
      'out/',
      '.cache/',
      '.vite-hooks/',
      'index.html',
      'pnpm-lock.yaml',
    ],
    singleQuote: true,
  },
  lint: {
    extends: [nkzw],
    ignorePatterns: [
      'dist/',
      'out/',
      '.cache/',
      '.vite-hooks/',
      'electron/',
      'scripts/',
      'vite.config.ts.timestamp-*',
    ],
    options: { typeAware: true, typeCheck: true },
    overrides: [{ env: { node: true }, files: ['forge.config.cjs'] }],
  },
  plugins: [react(), babel({ presets: [reactCompilerPreset()] }), documentServicePlugin()],
  run: {
    tasks: {
      'test:all': { command: 'vp check && vp test' },
    },
  },
  staged: { '*': 'vp check --fix' },
  test: {
    include: [
      'document-service.test.ts',
      'packaging.test.ts',
      'workspace-metadata.test.ts',
      'electron/**/*.test.ts',
      'src/**/*.test.{ts,tsx}',
    ],
    maxWorkers: Math.max(1, Math.min(4, Math.floor(availableParallelism() / 6))),
  },
});
