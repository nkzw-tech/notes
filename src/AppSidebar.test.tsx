// @vitest-environment jsdom

import { act, useImperativeHandle } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vite-plus/test';
import type { WorkspaceSnapshot } from './documentApi.ts';
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
  subscribeToDocumentChanges: vi.fn(),
  subscribeToWorkspaceMetadataChanges: vi.fn(),
}));

import App from './App.tsx';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
const workspace: WorkspaceSnapshot = {
  documents: [{ content: '# Fictional ToDo\n', hash: 'todo', mtimeMs: 1, path: 'docs/todo.md' }],
  metadataError: null,
  peoplePaths: [],
  workspacePath: '/fictional/workspace',
};
let root: Root;
let width: number;
beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, '', '#/docs/todo.md');
  width = 390;
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: width <= 780,
      media: query,
    })),
  );
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
const render = async (collapsed = false) => {
  localStorage.setItem('notes.sidebar.collapsed', String(collapsed));
  await act(async () => root.render(<App initialWorkspace={workspace} />));
};
const press = async (key: string, modifiers: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    key,
    ...modifiers,
  });
  await act(async () => (document.activeElement ?? window).dispatchEvent(event));
  return event;
};
const toggle = (modifier = 'metaKey') => press('B', { [modifier]: true, shiftKey: true });
const isOpen = () => document.querySelector('.sidebar')!.classList.contains('mobile-open');
const isCollapsed = () =>
  document.querySelector('.app-shell')!.classList.contains('sidebar-collapsed');
const menu = () => document.querySelector<HTMLButtonElement>('.mobile-menu')!;

test.each([
  ['metaKey', false],
  ['metaKey', true],
  ['ctrlKey', false],
  ['ctrlKey', true],
] as const)(
  '%s+Shift+B toggles the narrow sidebar with desktop collapsed=%s',
  async (modifier, collapsed) => {
    await render(collapsed);
    const editor = document.querySelector('textarea')!;
    editor.focus();
    expect((await toggle(modifier)).defaultPrevented).toBe(true);
    expect(isOpen()).toBe(true);
    expect(menu().getAttribute('aria-expanded')).toBe('true');
    expect(isCollapsed()).toBe(collapsed);
    expect(localStorage.getItem('notes.sidebar.collapsed')).toBe(String(collapsed));
    await toggle(modifier);
    expect(isOpen()).toBe(false);
    expect(menu().getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('textarea')).toBe(editor);
    expect(flush).not.toHaveBeenCalled();
  },
);

test('uses the current window width after crossing the sidebar breakpoint', async () => {
  width = 781;
  await render();
  await toggle();
  expect(isCollapsed()).toBe(true);
  expect(isOpen()).toBe(false);
  width = 780;
  await toggle();
  expect(isOpen()).toBe(true);
  expect(isCollapsed()).toBe(true);
  await toggle();
  expect(isOpen()).toBe(false);
  width = 781;
  await toggle();
  expect(isCollapsed()).toBe(false);
  expect(localStorage.getItem('notes.sidebar.collapsed')).toBe('false');
});

test('opens on primary pointer press without waiting for release, with a keyboard click fallback', async () => {
  await render();
  await act(async () => {
    menu().dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 2 }));
  });
  expect(isOpen()).toBe(false);
  await act(async () => {
    menu().dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
  });
  expect(isOpen()).toBe(true);
  await act(async () => menu().click());
  expect(isOpen()).toBe(true);
  await press('Escape');
  expect(isOpen()).toBe(false);
  await act(async () => menu().click());
  expect(isOpen()).toBe(true);
  await toggle();
  expect(isOpen()).toBe(false);
});

test('ignores unrelated shortcut modifiers', async () => {
  await render();
  for (const modifiers of [{ metaKey: true }, { altKey: true, metaKey: true, shiftKey: true }]) {
    expect((await press('B', modifiers)).defaultPrevented).toBe(false);
    expect(isOpen()).toBe(false);
    expect(isCollapsed()).toBe(false);
  }
});
