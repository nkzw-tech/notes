// @vitest-environment jsdom

import {
  PersistentMarkdownEditor,
  type MarkdownDocument,
  type MarkdownPersistenceAdapter,
  type PersistentMarkdownEditorHandle,
} from '@nkzw/mdx-editor/persistence';
import { createRef, type RefObject } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

type TestDocument = MarkdownDocument & {
  path: string;
};

type Deferred<Value> = {
  promise: Promise<Value>;
  resolve: (value: Value) => void;
};

const createDeferred = <Value,>(): Deferred<Value> => {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

const initialDocument: TestDocument = {
  content: 'Original text\n',
  id: 'interviews/01-candidate.md',
  path: 'interviews/01-candidate.md',
  version: 'original',
};

const mountedRoots: Array<Root> = [];

const renderPersistentEditor = async (adapter: MarkdownPersistenceAdapter<TestDocument>) => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const ref = createRef<PersistentMarkdownEditorHandle<TestDocument>>();
  mountedRoots.push(root);

  await act(async () => {
    root.render(
      <PersistentMarkdownEditor
        adapter={adapter}
        document={initialDocument}
        lifecycleFlush
        ref={ref}
      />,
    );
  });

  return { ref, root } satisfies {
    ref: RefObject<PersistentMarkdownEditorHandle<TestDocument> | null>;
    root: Root;
  };
};

beforeEach(() => {
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
  for (const root of mountedRoots.splice(0)) {
    await act(async () => root.unmount());
  }
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('critical persistence guarantees', () => {
  test('pagehide carries keepalive through to the newest text when an older save is in flight', async () => {
    const firstSave = createDeferred<{
      document: TestDocument;
      status: 'saved';
    }>();
    const adapter: MarkdownPersistenceAdapter<TestDocument> = {
      save: vi
        .fn()
        .mockImplementationOnce(() => firstSave.promise)
        .mockImplementation(({ content, document }) =>
          Promise.resolve({
            document: {
              ...document,
              content,
              version: `saved-${content}`,
            },
            status: 'saved' as const,
          }),
        ),
    };
    const { ref } = await renderPersistentEditor(adapter);

    await act(async () => {
      ref.current!.setMarkdown('First edit');
    });
    const firstFlush = ref.current!.flush();
    expect(adapter.save).toHaveBeenCalledTimes(1);

    await act(async () => {
      ref.current!.setMarkdown('Newest text that must survive reload');
      window.dispatchEvent(new Event('pagehide'));
    });

    try {
      expect(adapter.save).toHaveBeenCalledTimes(1);
      await act(async () => {
        firstSave.resolve({
          document: {
            ...initialDocument,
            content: 'First edit\n',
            version: 'first-edit',
          },
          status: 'saved',
        });
        await firstFlush;
      });
      expect(adapter.save).toHaveBeenCalledTimes(2);
      expect(adapter.save).toHaveBeenLastCalledWith(
        expect.objectContaining({
          content: 'Newest text that must survive reload\n',
          keepalive: true,
        }),
      );
    } finally {
      firstSave.resolve({
        document: {
          ...initialDocument,
          content: 'First edit\n',
          version: 'first-edit',
        },
        status: 'saved',
      });
      await firstFlush;
    }
  });

  test('unmounting a dirty editor persists its latest text before clearing save timers', async () => {
    const adapter: MarkdownPersistenceAdapter<TestDocument> = {
      save: vi.fn(({ content, document, keepalive }) =>
        Promise.resolve({
          document: {
            ...document,
            content,
            version: `saved-${String(keepalive)}`,
          },
          status: 'saved' as const,
        }),
      ),
    };
    const { ref, root } = await renderPersistentEditor(adapter);

    await act(async () => {
      ref.current!.setMarkdown('Unsaved text before document switch');
      root.unmount();
    });
    mountedRoots.splice(mountedRoots.indexOf(root), 1);

    expect(adapter.save).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'Unsaved text before document switch\n',
        keepalive: true,
      }),
    );
  });
});
