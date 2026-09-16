import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { expect, test, vi } from 'vite-plus/test';

test('uses asynchronous saves normally and synchronous saves only for lifecycle flushes', async () => {
  const directory = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(directory, 'preload.cjs'), 'utf8');
  const nativeRequire = createRequire(import.meta.url);
  const sendSync = vi.fn(() => ({ status: 'saved' }));
  const send = vi.fn();
  const invoke = vi.fn(() => Promise.resolve({ status: 'saved' }));
  let exposedMeetings: {
    updateWindowState: (state: unknown) => void;
    cancelClose: () => void;
    chooseWorkspace: () => Promise<unknown>;
    completeInterview: (request: { path: string }) => Promise<unknown>;
    createDocument: (request: { kind: 'doc'; title: string }) => Promise<unknown>;
    deleteDocument: (request: { path: string }) => Promise<unknown>;
    readyToClose: () => void;
    saveDocument: (
      request: { baseHash: string; content: string; path: string },
      keepalive: boolean,
    ) => unknown;
  } | null = null;

  const mockedRequire = (specifier: string) => {
    if (specifier === 'electron') {
      return {
        contextBridge: {
          exposeInMainWorld: (_name: string, value: typeof exposedMeetings) => {
            exposedMeetings = value;
          },
        },
        ipcRenderer: {
          invoke,
          on: vi.fn(),
          removeListener: vi.fn(),
          send,
          sendSync,
        },
      };
    }
    return nativeRequire(specifier);
  };

  vm.runInNewContext(source, {
    console,
    document: {
      documentElement: {
        setAttribute: vi.fn(),
        style: { setProperty: vi.fn(), removeProperty: vi.fn() },
      },
    },
    process,
    require: mockedRequire,
    window: { addEventListener: vi.fn() },
  });

  expect(sendSync).toHaveBeenCalledExactlyOnceWith('meetings:bootstrap');
  sendSync.mockClear();

  const viewState = {
    layout: { sidebarCollapsed: true, sidebarWidth: 280, sectionExpanded: {} },
    activePath: 'docs/example.md',
  };
  exposedMeetings!.updateWindowState(viewState);
  expect(send).toHaveBeenCalledWith('meetings:window-state', viewState);
  expect(sendSync).not.toHaveBeenCalled();
  exposedMeetings!.cancelClose();
  expect(send).toHaveBeenCalledWith('meetings:cancel-close');

  const request = {
    baseHash: 'old',
    content: 'Newest text\n',
    path: 'docs/todo.md',
  };
  await exposedMeetings!.chooseWorkspace();
  expect(invoke).toHaveBeenCalledWith('meetings:choose-workspace');
  await exposedMeetings!.createDocument({ kind: 'doc', title: 'New notes' });
  expect(invoke).toHaveBeenCalledWith('meetings:create-document', {
    kind: 'doc',
    title: 'New notes',
  });
  await exposedMeetings!.deleteDocument({ path: 'docs/old-notes.md' });
  expect(invoke).toHaveBeenCalledWith('meetings:delete-document', {
    path: 'docs/old-notes.md',
  });
  await exposedMeetings!.completeInterview({
    path: 'interviews/15-candidate.md',
  });
  expect(invoke).toHaveBeenCalledWith('meetings:complete-interview', {
    path: 'interviews/15-candidate.md',
  });

  exposedMeetings!.saveDocument(request, true);

  expect(sendSync).toHaveBeenCalledWith('meetings:save-document-sync', {
    ...request,
    keepalive: true,
  });

  await exposedMeetings!.saveDocument(request, false);
  expect(invoke).toHaveBeenCalledWith('meetings:save-document', request);
  expect(sendSync).toHaveBeenCalledTimes(1);

  exposedMeetings!.readyToClose();
  expect(send).toHaveBeenCalledWith('meetings:close-ready');
});

test.each([true, false])(
  'applies the OS accent and live changes when the DOM starts ready: %s',
  (domReady) => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'preload.cjs'),
      'utf8',
    );
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const setProperty = vi.fn();
    const removeProperty = vi.fn();
    const root = { setAttribute: vi.fn(), style: { setProperty, removeProperty } };
    const document = { documentElement: domReady ? root : null };
    let onReady: (() => void) | undefined;
    vm.runInNewContext(source, {
      document,
      process,
      window: {
        addEventListener: (_event: string, callback: () => void) => {
          onReady = callback;
        },
      },
      require: () => ({
        contextBridge: { exposeInMainWorld: vi.fn() },
        ipcRenderer: {
          sendSync: () => ({ systemAccent: '#3478f6ff' }),
          invoke: () => Promise.resolve({}),
          on: (channel: string, callback: (...args: unknown[]) => void) =>
            listeners.set(channel, callback),
        },
      }),
    });
    if (!domReady) {
      expect(setProperty).not.toHaveBeenCalled();
      document.documentElement = root;
      onReady!();
    }
    expect(setProperty).toHaveBeenLastCalledWith('--system-accent', '#3478f6ff');
    listeners.get('meetings:system-accent-changed')!({}, '#a070ccff');
    expect(setProperty).toHaveBeenLastCalledWith('--system-accent', '#a070ccff');
    for (const unavailable of [null, 'invalid', {}]) {
      listeners.get('meetings:system-accent-changed')!({}, unavailable);
      expect(removeProperty).toHaveBeenLastCalledWith('--system-accent');
    }
  },
);

test('prefetches once and replays changes received while the renderer loads', async () => {
  const listeners = new Map<string, (_event: unknown, change: unknown) => void>();
  const snapshot = {
    documents: [],
    peoplePaths: [],
    metadataError: null,
    workspacePath: '/fictional',
  };
  const invoke = vi.fn().mockResolvedValue(snapshot);
  const send = vi.fn();
  let meetings!: NonNullable<Window['meetings']>;
  vm.runInNewContext(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'preload.cjs'), 'utf8'),
    {
      document: { documentElement: null },
      process,
      window: { addEventListener: vi.fn() },
      require: () => ({
        contextBridge: {
          exposeInMainWorld: (_name: string, value: typeof meetings) => {
            meetings = value;
          },
        },
        ipcRenderer: {
          invoke,
          send,
          sendSync: () => ({ layout: null, recoveryDraftKey: 'fictional', systemAccent: null }),
          on: (channel: string, callback: (_event: unknown, change: unknown) => void) =>
            listeners.set(channel, callback),
        },
      }),
    },
  );
  expect(invoke).toHaveBeenCalledExactlyOnceWith('meetings:load-workspace');
  const changes = vi.fn();
  const metadata = vi.fn();
  const first = {
    deleted: false,
    path: 'docs/example.md',
    document: { path: 'docs/example.md', content: '# First', hash: 'first', mtimeMs: 1 },
  };
  const latest = { ...first, document: { ...first.document, content: '# Latest', hash: 'latest' } };
  const deleted = { deleted: true, path: 'docs/deleted.md' };
  listeners.get('meetings:document-change')!({}, first);
  listeners.get('meetings:document-change')!({}, latest);
  listeners.get('meetings:document-change')!({}, deleted);
  const metadataChange = { metadata: { peoplePaths: ['people/example.md'] } };
  listeners.get('meetings:workspace-metadata-change')!({}, metadataChange);
  expect(await meetings.loadWorkspace()).toBe(snapshot);
  expect(invoke).toHaveBeenCalledTimes(1);
  const unsubscribe = meetings.onDocumentChange(changes);
  meetings.onWorkspaceMetadataChange(metadata);
  expect(changes.mock.calls.map(([change]) => change)).toEqual([latest, deleted]);
  expect(metadata).toHaveBeenCalledExactlyOnceWith(metadataChange);
  // StrictMode resubscription must not replay already consumed events.
  unsubscribe();
  meetings.onDocumentChange(changes);
  expect(changes).toHaveBeenCalledTimes(2);
  listeners.get('meetings:document-change')!({}, first);
  expect(changes).toHaveBeenLastCalledWith(first);
  await meetings.loadWorkspace();
  expect(invoke).toHaveBeenCalledTimes(2);
  meetings.rendererReady!();
  meetings.rendererReady!();
  expect(send).toHaveBeenCalledExactlyOnceWith('meetings:renderer-ready');
});
