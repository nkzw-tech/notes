// @vitest-environment jsdom

import { StrictMode, act, useImperativeHandle } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vite-plus/test';
import type { MeetingDocument } from './content.ts';
import type { DocumentChangeEvent, WorkspaceSnapshot } from './documentApi.ts';
import type { EditableMarkdownHandle } from './EditableMarkdown.tsx';

const { applyExternalChange } = vi.hoisted(() => ({ applyExternalChange: vi.fn() }));
vi.mock('./EditableMarkdown.tsx', () => ({
  default: function Editor({
    document,
    ref,
  }: {
    document: MeetingDocument;
    ref: React.Ref<EditableMarkdownHandle>;
  }) {
    useImperativeHandle(ref, () => ({
      applyExternalChange,
      flush: async () => true,
      formatAndSave: async () => true,
      hasUnsavedChanges: () => false,
      restoreDeletedDocument: async () => true,
    }));
    return <article data-editor-path={document.path}>{document.content}</article>;
  },
}));
vi.mock('./documentApi.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./documentApi.ts')>()),
  loadWorkspace: vi.fn(),
  subscribeToDocumentChanges: vi.fn(),
  subscribeToWorkspaceMetadataChanges: vi.fn(),
}));

import App from './App.tsx';
import { loadWorkspace, subscribeToDocumentChanges } from './documentApi.ts';
import { writeRecoveryDraft } from './draftRecovery.ts';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
const workspace: WorkspaceSnapshot = {
  documents: [
    { content: '# Fictional ToDo\n', hash: 'todo', mtimeMs: 1, path: 'docs/todo.md' },
    { content: '# Fictional Example\n', hash: 'example', mtimeMs: 1, path: 'docs/example.md' },
  ],
  metadataError: null,
  peoplePaths: [],
  workspacePath: '/fictional/workspace',
};
let root: Root;
beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, '', '#/docs/todo.md');
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.resetAllMocks();
});
const render = async (props: Parameters<typeof App>[0]) => {
  await act(async () => {
    flushSync(() =>
      root.render(
        <StrictMode>
          <App {...props} />
        </StrictMode>,
      ),
    );
    expect(document.body.textContent).not.toMatch(/Loading/);
  });
};

test('commits the initial note immediately without another workspace request', async () => {
  await render({ initialWorkspace: workspace });
  expect(document.querySelector('[data-editor-path]')?.textContent).toBe('# Fictional ToDo\n');
  expect(loadWorkspace).not.toHaveBeenCalled();
});

test('a new window focuses the document picker without mounting a default note', async () => {
  window.history.replaceState(null, '', '#new');
  await render({ initialWorkspace: workspace });
  expect(document.querySelector('[data-editor-path]')).toBeNull();
  expect(document.querySelector('[aria-current="page"]')).toBeNull();
  const palette = document.querySelector('[role="dialog"]')!;
  expect(document.activeElement).toBe(palette.querySelector('input'));
  expect(palette.textContent).toContain('Fictional Example');
  expect(palette.textContent).not.toMatch(/Create document|Delete document|Complete Interview/);
  expect(window.location.hash).toBe('#new');
  await act(async () => {
    const navigated = new Promise((resolve) =>
      window.addEventListener('hashchange', resolve, { once: true }),
    );
    [...palette.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Fictional Example'))!
      .click();
    await navigated;
  });
  expect(document.querySelector('[data-editor-path]')?.getAttribute('data-editor-path')).toBe(
    'docs/example.md',
  );
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(window.location.hash).toBe('#/docs/example.md');
});

test('dismissing a new window picker leaves it blank and allows reopening or creating', async () => {
  window.history.replaceState(null, '', '#new');
  await render({ initialWorkspace: workspace });
  await act(async () => {
    document.activeElement!.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }),
    );
  });
  expect(document.querySelector('[data-editor-path]')).toBeNull();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.body.textContent).toContain('No document selected');
  expect(window.location.hash).toBe('#new');
  await act(async () => {
    [...document.querySelectorAll('button')]
      .find((button) => button.textContent === 'Open document…')!
      .click();
  });
  expect(document.activeElement).toBe(document.querySelector('[role="dialog"] input'));
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'k', metaKey: true }));
  });
  const palette = document.querySelector('[role="dialog"]')!;
  expect(palette.textContent).toContain('Create document');
  expect(palette.textContent).not.toMatch(/Delete document|Complete Interview/);
});

test('a new window in an empty workspace offers creation without mounting an editor', async () => {
  window.history.replaceState(null, '', '#new');
  await render({ initialWorkspace: { ...workspace, documents: [] } });
  expect(document.querySelector('[data-editor-path]')).toBeNull();
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Create document');
});

test.each(['#/docs/todo.md', '', '#/docs/missing.md'])(
  'delivers buffered startup edits to the mounted persistence owner at %s',
  async (hash) => {
    window.history.replaceState(null, '', `/${hash}`);
    const changed = { ...workspace.documents[0]!, content: '# Updated on disk\n', hash: 'updated' };
    vi.mocked(subscribeToDocumentChanges).mockImplementationOnce(
      (callback: (change: DocumentChangeEvent) => void) => {
        callback({ deleted: false, document: changed, path: changed.path });
        return () => {};
      },
    );
    await render({ initialWorkspace: workspace });
    expect(applyExternalChange).toHaveBeenCalledExactlyOnceWith(changed);
    expect(window.location.hash).toBe('#/docs/todo.md');
  },
);

test.each(['#/docs/todo.md', '#new'])(
  'opens the recoverable note in the first commit at %s',
  async (hash) => {
    window.history.replaceState(null, '', hash);
    writeRecoveryDraft({
      baseHash: 'example',
      content: '# Unsaved fictional text',
      path: 'docs/example.md',
    });
    await render({ initialWorkspace: workspace });
    expect(document.querySelector('[data-editor-path]')?.getAttribute('data-editor-path')).toBe(
      'docs/example.md',
    );
    expect(window.location.hash).toBe('#/docs/example.md');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  },
);

test('shows orphaned recovery controls immediately', async () => {
  writeRecoveryDraft({
    baseHash: 'deleted',
    content: '# Unsaved fictional text',
    path: 'docs/deleted.md',
  });
  await render({ initialWorkspace: workspace });
  expect(document.body.textContent).toContain('Restore recovered file');
});

test.each([
  [
    { initialWorkspace: { ...workspace, documents: [], workspacePath: null } },
    'Choose your notes workspace',
  ],
  [{ initialWorkspace: { ...workspace, documents: [] } }, 'Create your first document'],
  [{ initialLoadError: 'Fictional disk failure' }, 'Could not load notes'],
] satisfies Array<[Parameters<typeof App>[0], string]>)(
  'renders startup state without a loading intermediate: %s',
  async (props, text) => {
    await render(props);
    expect(document.body.textContent).toContain(text);
    expect(loadWorkspace).not.toHaveBeenCalled();
  },
);
