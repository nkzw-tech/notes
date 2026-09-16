// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, test, vi } from 'vite-plus/test';
import { createMeetingDocument } from './content.ts';
import { DocumentPalette } from './DocumentPalette.tsx';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const roots: Array<Root> = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => root.unmount());
  }
  document.body.replaceChildren();
  vi.clearAllMocks();
});

describe('DocumentPalette creation flow', () => {
  test.each([true, false])(
    'chooses a type and submits the entered name (active document: %s)',
    async (hasActiveDocument) => {
      const onClose = vi.fn();
      const onCreate = vi.fn().mockResolvedValue(undefined);
      const container = document.createElement('div');
      document.body.append(container);
      const root = createRoot(container);
      roots.push(root);

      await act(async () => {
        root.render(
          <DocumentPalette
            activeDocument={
              hasActiveDocument
                ? createMeetingDocument(
                    {
                      content: '# ToDo\n',
                      hash: 'todo',
                      mtimeMs: 1,
                      path: 'docs/todo.md',
                    },
                    new Set(),
                  )
                : undefined
            }
            documents={[
              createMeetingDocument(
                {
                  content: '# ToDo\n',
                  hash: 'todo',
                  mtimeMs: 1,
                  path: 'docs/todo.md',
                },
                new Set(),
              ),
            ]}
            onClose={onClose}
            onCompleteInterview={vi.fn()}
            onCreate={onCreate}
            onDeleteDocument={vi.fn()}
            onNavigate={vi.fn()}
          />,
        );
      });

      const findButton = (label: string) =>
        [...container.querySelectorAll('button')].find((button) =>
          button.textContent?.includes(label),
        );

      await act(async () => findButton('Create document')?.click());
      expect(container.textContent).toContain('Regular doc');
      expect(container.textContent).toContain('Interview');
      expect(container.textContent).toContain('Report');
      expect(container.textContent).toContain('Person');

      await act(async () => findButton('Interview')?.click());
      const input = container.querySelector('input')!;
      await act(async () => {
        const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        setValue?.call(input, 'Ada Example');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });

      await act(async () => findButton('Create “Ada Example”')?.click());
      expect(onCreate).toHaveBeenCalledWith({
        kind: 'interview',
        title: 'Ada Example',
      });
      expect(onClose).toHaveBeenCalledOnce();
    },
  );

  test('offers interview completion only for the active interview and confirms deletion', async () => {
    const onCompleteInterview = vi.fn().mockResolvedValue(undefined);
    const interview = createMeetingDocument(
      {
        content: '# 15. Candidate Name\n',
        hash: 'candidate',
        mtimeMs: 1,
        path: 'interviews/15-candidate-name.md',
      },
      new Set(),
    );
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);

    await act(async () => {
      root.render(
        <DocumentPalette
          activeDocument={interview}
          documents={[interview]}
          onClose={vi.fn()}
          onCompleteInterview={onCompleteInterview}
          onCreate={vi.fn()}
          onDeleteDocument={vi.fn()}
          onNavigate={vi.fn()}
        />,
      );
    });

    const findCompleteButton = () =>
      [...container.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('Complete Interview'),
      );
    await act(async () => findCompleteButton()?.click());
    expect(container.textContent).toContain('Permanently delete interviews/15-candidate-name.md');

    await act(async () => findCompleteButton()?.click());
    expect(onCompleteInterview).toHaveBeenCalledWith('interviews/15-candidate-name.md');
  });

  test('offers document deletion and requires a confirmation step', async () => {
    const onClose = vi.fn();
    const onDeleteDocument = vi.fn().mockResolvedValue(undefined);
    const activeDocument = createMeetingDocument(
      {
        content: '# Design Notes\n',
        hash: 'design-notes',
        mtimeMs: 1,
        path: 'docs/design-notes.md',
      },
      new Set(),
    );
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);

    await act(async () => {
      root.render(
        <DocumentPalette
          activeDocument={activeDocument}
          documents={[activeDocument]}
          onClose={onClose}
          onCompleteInterview={vi.fn()}
          onCreate={vi.fn()}
          onDeleteDocument={onDeleteDocument}
          onNavigate={vi.fn()}
        />,
      );
    });

    const findDeleteButton = () =>
      [...container.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('Delete document'),
      );

    await act(async () => findDeleteButton()?.click());
    expect(container.textContent).toContain('Permanently delete docs/design-notes.md');
    expect(onDeleteDocument).not.toHaveBeenCalled();

    await act(async () => findDeleteButton()?.click());
    expect(onDeleteDocument).toHaveBeenCalledWith('docs/design-notes.md');
    expect(onClose).toHaveBeenCalledOnce();
  });
});
