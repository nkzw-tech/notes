// @vitest-environment jsdom

import { act, useImperativeHandle } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vite-plus/test';
import { completeInterview, deleteDocument, subscribeToDocumentChanges } from './documentApi.ts';
import { readRecoveryDraft, writeRecoveryDraft } from './draftRecovery.ts';
import type { EditableMarkdownHandle } from './EditableMarkdown.tsx';

const { flush } = vi.hoisted(() => ({ flush: vi.fn<() => Promise<boolean>>() }));

vi.mock('./EditableMarkdown.tsx', () => ({
  default: function FakeEditor({ ref }: { ref: React.Ref<EditableMarkdownHandle> }) {
    useImperativeHandle(ref, () => ({
      applyExternalChange: vi.fn(),
      flush,
      formatAndSave: vi.fn().mockResolvedValue(true),
      hasUnsavedChanges: () => false,
      restoreDeletedDocument: vi.fn().mockResolvedValue(true),
    }));
    return <textarea aria-label="Editor" />;
  },
}));

vi.mock('./documentApi.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./documentApi.ts')>()),
  completeInterview: vi.fn(),
  deleteDocument: vi.fn(),
  loadWorkspace: vi.fn().mockResolvedValue({
    documents: [
      { content: '# ToDo\n', hash: 'todo', mtimeMs: 1, path: 'docs/todo.md' },
      { content: '# Design Notes\n', hash: 'design', mtimeMs: 1, path: 'docs/design.md' },
      {
        content: '# 1. Ada Example\n',
        hash: 'interview',
        mtimeMs: 1,
        path: 'interviews/01-ada-example.md',
      },
    ],
    metadataError: null,
    peoplePaths: [],
    workspacePath: '/fictional/workspace',
  }),
  subscribeToDocumentChanges: vi.fn(),
  subscribeToWorkspaceMetadataChanges: vi.fn(),
}));

import App from './App.tsx';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root;

beforeEach(async () => {
  localStorage.clear();
  window.history.replaceState(null, '', '#/docs/todo.md');
  flush.mockResolvedValue(true);
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<App />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  delete window.meetings;
  document.body.replaceChildren();
  vi.clearAllMocks();
});

const palette = () => document.querySelector('[role="dialog"]');
const paletteInput = () => palette()!.querySelector('input')!;
const press = async (key: string, modifiers: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    key,
    ...modifiers,
  });
  await act(async () => {
    (document.activeElement ?? window).dispatchEvent(event);
  });
  return event;
};
const search = async (value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      paletteInput(),
      value,
    );
    paletteInput().dispatchEvent(new Event('input', { bubbles: true }));
  });
};

test.each(['metaKey', 'ctrlKey'])(
  '%s+P searches only files and saves before switching',
  async (modifier) => {
    document.querySelector('textarea')!.focus();
    expect((await press('p', { [modifier]: true })).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(paletteInput());
    expect(palette()!.querySelectorAll('button')).toHaveLength(3);
    expect(palette()!.textContent).not.toMatch(
      /Create document|Delete document|Complete Interview/,
    );
    expect(palette()!.querySelector('.selected')!.textContent).toContain('ToDo');

    await search('create');
    expect(palette()!.textContent).toBe('No matching documents');
    await press('Enter');
    expect(flush).not.toHaveBeenCalled();

    await search('Design');
    expect(palette()!.querySelectorAll('button')).toHaveLength(1);
    await press('Enter');
    expect(flush).toHaveBeenCalledOnce();
    expect(window.location.hash).toBe('#/docs/design.md');
    expect(palette()).toBeNull();
  },
);

test('switching shortcuts resets command steps and keeps the full palette available', async () => {
  await press('k', { metaKey: true });
  expect(palette()!.textContent).toContain('Create document');
  expect(palette()!.textContent).toContain('Delete document');
  await press('Enter');
  expect(paletteInput().placeholder).toBe('Choose a document type…');

  await press('p', { metaKey: true });
  expect(palette()!.querySelectorAll('button')).toHaveLength(3);
  expect(palette()!.textContent).not.toContain('Regular doc');
  await search('Design');
  await press('k', { metaKey: true });
  expect(paletteInput().value).toBe('');
  expect(palette()!.textContent).toContain('Create document');
  expect(palette()!.textContent).toContain('Delete document');
  await press('k', { metaKey: true });
  expect(palette()).toBeNull();

  await press('p', { metaKey: true });
  await press('p', { metaKey: true });
  expect(palette()).toBeNull();
  await press('p', { metaKey: true });
  await press('Escape');
  expect(palette()).toBeNull();
});

test('file quick open omits interview completion and ignores modified shortcuts', async () => {
  await act(async () => {
    window.history.replaceState(null, '', '#/interviews/01-ada-example.md');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
  for (const modifiers of [
    {},
    { metaKey: true, shiftKey: true },
    { altKey: true, metaKey: true },
  ]) {
    expect((await press('p', modifiers)).defaultPrevented).toBe(false);
    expect(palette()).toBeNull();
  }
  await press('p', { metaKey: true });
  expect(palette()!.querySelectorAll('button')).toHaveLength(3);
  expect(palette()!.textContent).not.toContain('Complete Interview');
  await press('k', { metaKey: true });
  expect(palette()!.textContent).toContain('Complete Interview');
});

const deletionActions = [
  { label: 'Delete document', path: 'docs/design.md', remove: deleteDocument },
  {
    label: 'Complete Interview',
    path: 'interviews/01-ada-example.md',
    remove: completeInterview,
  },
];

const startDeletion = async (path: string, label: string) => {
  await act(async () => {
    window.history.replaceState(null, '', `#/${path}`);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
  await press('k', { metaKey: true });
  await search(label);
  await press('Enter');
  await press('Enter');
};

test.each(
  deletionActions.flatMap((action) =>
    [true, false, undefined].map((closesWindow) => ({ ...action, closesWindow })),
  ),
)(
  '$label handles a watcher event before deletion resolves (closes: $closesWindow)',
  async ({ closesWindow, label, path, remove }) => {
    const closeWindowIfOthersOpen = vi.fn(async () => {
      expect(readRecoveryDraft()).toBeNull();
      return closesWindow ?? false;
    });
    if (closesWindow !== undefined) {
      Object.defineProperty(window, 'meetings', {
        configurable: true,
        value: { closeWindowIfOthersOpen },
      });
    }
    const pending = Promise.withResolvers<{ path: string }>();
    vi.mocked(remove).mockImplementationOnce(() => pending.promise);
    writeRecoveryDraft({ baseHash: 'old', content: 'Fictional notes', path });
    await startDeletion(path, label);
    expect(flush).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith(path);

    await act(async () => {
      vi.mocked(subscribeToDocumentChanges).mock.calls[0]![0]({ deleted: true, path });
    });
    expect(window.location.hash).toBe(`#/${path}`);
    expect(closeWindowIfOthersOpen).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')).toBeNull();

    await act(async () => pending.resolve({ path }));
    expect(readRecoveryDraft()).toBeNull();
    expect(closeWindowIfOthersOpen).toHaveBeenCalledTimes(closesWindow === undefined ? 0 : 1);
    expect(window.location.hash).toBe(closesWindow ? `#/${path}` : '#/docs/todo.md');
    expect(palette()).toBeNull();
    if (!closesWindow) {
      expect(document.querySelector('.document-path')!.textContent).toContain('ToDo');
      expect(document.querySelector('nav')!.textContent).not.toContain(
        path.startsWith('interviews/') ? 'Ada Example' : 'Design Notes',
      );
    }
  },
);

test.each(['save', 'delete'])('a failed %s keeps the document and window open', async (failure) => {
  const closeWindowIfOthersOpen = vi.fn().mockResolvedValue(true);
  Object.defineProperty(window, 'meetings', {
    configurable: true,
    value: { closeWindowIfOthersOpen },
  });
  if (failure === 'save') {
    flush.mockResolvedValueOnce(false);
  } else {
    vi.mocked(deleteDocument).mockRejectedValueOnce(new Error('Deletion failed.'));
  }
  const path = 'docs/design.md';
  writeRecoveryDraft({ baseHash: 'old', content: 'Fictional notes', path });
  await startDeletion(path, 'Delete document');
  expect(closeWindowIfOthersOpen).not.toHaveBeenCalled();
  expect(window.location.hash).toBe(`#/${path}`);
  expect(readRecoveryDraft()?.path).toBe(path);
  expect(palette()!.textContent).toContain(failure === 'save' ? 'save issue' : 'Deletion failed');
});
