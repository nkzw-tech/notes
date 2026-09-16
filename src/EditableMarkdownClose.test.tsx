// @vitest-environment jsdom

import { act, forwardRef, useImperativeHandle } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, test, vi } from 'vite-plus/test';
import { createMeetingDocument } from './content.ts';

const state = vi.hoisted(() => ({
  dirty: true,
  flush: vi.fn<() => Promise<boolean>>(),
}));

vi.mock('@nkzw/mdx-editor/persistence', () => ({
  PersistentMarkdownEditor: forwardRef(function FakeEditor(_props, ref) {
    useImperativeHandle(ref, () => ({
      applyExternalChange: vi.fn(),
      flush: state.flush,
      getMarkdown: () => 'Unsaved text',
      hasUnsavedChanges: () => state.dirty,
      setMarkdown: vi.fn(),
    }));
    return <div />;
  }),
}));

import EditableMarkdown from './EditableMarkdown.tsx';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const roots: Array<Root> = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => root.unmount());
  }
  document.body.replaceChildren();
  delete window.meetings;
  vi.clearAllMocks();
  state.flush.mockReset();
  state.dirty = true;
});

describe('desktop close coordination', () => {
  test.each([true, false])(
    'drains an edit that arrives as the first flush completes (saved: %s)',
    async (saved) => {
      state.flush.mockResolvedValueOnce(true).mockImplementationOnce(async () => {
        state.dirty = !saved;
        return saved;
      });
      const readyToClose = vi.fn();
      const cancelClose = vi.fn();
      window.meetings = { cancelClose, readyToClose } as unknown as Window['meetings'];
      const container = document.createElement('div');
      document.body.append(container);
      const root = createRoot(container);
      roots.push(root);
      await act(async () =>
        root.render(
          <EditableMarkdown
            document={createMeetingDocument(
              {
                content: 'Disk text\n',
                hash: 'disk',
                mtimeMs: 1,
                path: 'docs/example.md',
              },
              new Set(),
            )}
            onLocalChange={vi.fn()}
            onNavigate={vi.fn()}
            onStatusChange={vi.fn()}
            onStoredChange={vi.fn()}
            resolveLink={() => null}
          />,
        ),
      );
      await act(async () => window.dispatchEvent(new Event('beforeunload', { cancelable: true })));
      expect(state.flush).toHaveBeenCalledTimes(2);
      expect(readyToClose).toHaveBeenCalledTimes(saved ? 1 : 0);
      expect(cancelClose).toHaveBeenCalledTimes(saved ? 0 : 1);
    },
  );

  test.each([true, false])('coordinates the complete editor flush (saved: %s)', async (saved) => {
    let resolveFlush!: (saved: boolean) => void;
    state.flush.mockReturnValue(
      new Promise((resolve) => {
        resolveFlush = resolve;
      }),
    );
    const readyToClose = vi.fn();
    const cancelClose = vi.fn();
    window.meetings = {
      cancelClose,
      readyToClose,
    } as unknown as Window['meetings'];
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(
        <EditableMarkdown
          document={createMeetingDocument(
            {
              content: 'Disk text\n',
              hash: 'disk',
              mtimeMs: 1,
              path: 'docs/todo.md',
            },
            new Set(),
          )}
          onLocalChange={vi.fn()}
          onNavigate={vi.fn()}
          onStatusChange={vi.fn()}
          onStoredChange={vi.fn()}
          resolveLink={() => null}
        />,
      );
    });

    window.dispatchEvent(new Event('beforeunload', { cancelable: true }));
    expect(readyToClose).not.toHaveBeenCalled();

    state.dirty = false;
    await act(async () => resolveFlush(saved));
    expect(readyToClose).toHaveBeenCalledTimes(saved ? 1 : 0);
    expect(cancelClose).toHaveBeenCalledTimes(saved ? 0 : 1);
  });
});
