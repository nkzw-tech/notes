// @vitest-environment jsdom

import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test';
import { createMeetingDocument } from './content.ts';
import { RECOVERY_DRAFT_KEY } from './draftRecovery.ts';

const api = vi.hoisted(() => ({
  formatDocument: vi.fn(),
  restoreDocument: vi.fn(),
  saveDocument: vi.fn(),
}));

vi.mock('./documentApi.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./documentApi.ts')>()),
  ...api,
}));

import EditableMarkdown, { type EditableMarkdownHandle } from './EditableMarkdown.tsx';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const roots: Array<Root> = [];
const storageValues = new Map<string, string>();
const storage = {
  clear: () => storageValues.clear(),
  getItem: (key: string) => storageValues.get(key) ?? null,
  removeItem: (key: string) => storageValues.delete(key),
  setItem: (key: string, value: string) => storageValues.set(key, value),
};

beforeEach(() => {
  storage.clear();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: storage,
  });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockReturnValue({
      addEventListener: vi.fn(),
      matches: false,
      removeEventListener: vi.fn(),
    }),
  });
});

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => root.unmount());
  }
  document.body.replaceChildren();
  storage.clear();
  delete window.meetings;
  vi.clearAllMocks();
});

describe('EditableMarkdown recovery integration', () => {
  test('recovers an interrupted session once and saves against its original disk version', async () => {
    const ref = createRef<EditableMarkdownHandle>();
    const diskDocument = {
      content: 'Saved disk text\n',
      hash: 'disk-hash',
      mtimeMs: 1,
      path: 'docs/example.md',
    };
    window.localStorage.setItem(
      RECOVERY_DRAFT_KEY,
      JSON.stringify({
        baseHash: diskDocument.hash,
        content: 'Text from the interrupted session',
        path: diskDocument.path,
        updatedAt: 123,
      }),
    );
    api.saveDocument.mockImplementation(async ({ content }) => ({
      ...diskDocument,
      content,
      hash: 'recovered-hash',
    }));
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () =>
      root.render(
        <EditableMarkdown
          document={createMeetingDocument(diskDocument, new Set())}
          onLocalChange={vi.fn()}
          onNavigate={vi.fn()}
          onStatusChange={vi.fn()}
          onStoredChange={vi.fn()}
          ref={ref}
          resolveLink={() => null}
        />,
      ),
    );
    expect(api.saveDocument).toHaveBeenCalledExactlyOnceWith({
      baseHash: 'disk-hash',
      content: 'Text from the interrupted session\n',
      keepalive: false,
      path: diskDocument.path,
    });
    expect(container.querySelector('[data-kind="conflict"]')).toBeNull();
    expect(container.querySelector('.mdx-editor-content')?.textContent).toBe(
      'Text from the interrupted session',
    );
    expect(ref.current!.hasUnsavedChanges()).toBe(false);
    expect(window.localStorage.getItem(RECOVERY_DRAFT_KEY)).toBeNull();
  });

  test('locks the disk copy until a conflicting recovered draft is resolved', async () => {
    window.meetings = { readyToClose: vi.fn() } as unknown as Window['meetings'];
    const ref = createRef<EditableMarkdownHandle>();
    const path = 'docs/todo.md';
    const diskDocument = {
      content: 'Changed on disk\n',
      hash: 'disk-hash',
      mtimeMs: 2,
      path,
    };
    window.localStorage.setItem(
      RECOVERY_DRAFT_KEY,
      JSON.stringify({
        baseHash: 'old-hash',
        content: 'Recovered unsaved text',
        path,
        updatedAt: 123,
      }),
    );
    api.saveDocument.mockImplementation(async ({ content }) => ({
      ...diskDocument,
      content,
      hash: 'recovered-hash',
    }));
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);

    await act(async () => {
      root.render(
        <EditableMarkdown
          document={createMeetingDocument(diskDocument, new Set())}
          onLocalChange={vi.fn()}
          onNavigate={vi.fn()}
          onStatusChange={vi.fn()}
          onStoredChange={vi.fn()}
          ref={ref}
          resolveLink={() => null}
        />,
      );
    });

    expect(container.textContent).toContain('Unsaved text from the previous session was recovered');
    expect(container.querySelector('.mdx-editor-content')?.getAttribute('contenteditable')).toBe(
      'false',
    );

    const closeEvent = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(closeEvent);
    expect(closeEvent.defaultPrevented).toBe(true);
    await expect(ref.current!.flush()).resolves.toBe(false);
    expect(ref.current!.hasUnsavedChanges()).toBe(true);
    await act(async () => {
      ref.current!.applyExternalChange({
        ...diskDocument,
        content: 'Another window saved\n',
        hash: 'peer-hash',
      });
    });
    expect(window.localStorage.getItem(RECOVERY_DRAFT_KEY)).toContain('Recovered unsaved text');

    const restoreButton = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Restore recovered text',
    );
    await act(async () => restoreButton?.click());
    await vi.waitFor(() =>
      expect(api.saveDocument).toHaveBeenCalledWith(
        expect.objectContaining({ content: 'Recovered unsaved text\n' }),
      ),
    );
    expect(window.localStorage.getItem(RECOVERY_DRAFT_KEY)).toBeNull();
  });
});
