// @vitest-environment jsdom

import type {
  PersistentMarkdownEditorHandle,
  MarkdownDocument,
} from '@nkzw/mdx-editor/persistence';
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vite-plus/test';
import { createMeetingDocument, type StoredDocument } from './content.ts';
import { readRecoveryDraft } from './draftRecovery.ts';

// Observe the real persistence component; do not mock its save queue or editor.
const observed = vi.hoisted(() => ({
  editor: null as PersistentMarkdownEditorHandle<MarkdownDocument> | null,
  onLocalChange: null as ((content: string) => void) | null,
}));
vi.mock('@nkzw/mdx-editor/persistence', async (importOriginal) => {
  const original = await importOriginal<typeof import('@nkzw/mdx-editor/persistence')>();
  const React = await import('react');
  return {
    ...original,
    PersistentMarkdownEditor: React.forwardRef<
      PersistentMarkdownEditorHandle<MarkdownDocument>,
      React.ComponentProps<typeof original.PersistentMarkdownEditor>
    >((props, ref) => {
      const inner = React.useRef<PersistentMarkdownEditorHandle<MarkdownDocument>>(null);
      React.useImperativeHandle(ref, () => inner.current!);
      React.useLayoutEffect(() => {
        observed.editor = inner.current;
        observed.onLocalChange = props.onLocalChange ?? null;
      });
      return <original.PersistentMarkdownEditor {...props} ref={inner} />;
    }),
  };
});

import EditableMarkdown, { type EditableMarkdownHandle } from './EditableMarkdown.tsx';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root;
let container: HTMLDivElement;
let disk: StoredDocument;
const storage = new Map<string, string>();
const initial: StoredDocument = {
  content: 'Original\n',
  hash: 'initial',
  mtimeMs: 1,
  path: 'docs/example.md',
};

beforeEach(() => {
  disk = initial;
  storage.clear();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      removeItem: (key: string) => storage.delete(key),
      setItem: (key: string, value: string) => storage.set(key, value),
    },
  });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({
      addEventListener() {},
      matches: false,
      removeEventListener() {},
    }),
  });
  window.meetings = {
    saveDocument: vi.fn(async (request: { baseHash: string; content: string }) => {
      if (request.baseHash !== disk.hash) {
        return { document: disk, status: 'conflict' };
      }
      disk = {
        ...disk,
        content: request.content,
        hash: request.content,
        mtimeMs: disk.mtimeMs + 1,
      };
      return { document: disk, status: 'saved' };
    }),
  } as unknown as Window['meetings'];
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
  delete window.meetings;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

const randomFor = (seed: number) => () => {
  seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
  return seed / 0x1_00_00_00_00;
};

test('exposes the current unsaved Markdown for copying', async () => {
  const ref = createRef<EditableMarkdownHandle>();
  await act(async () => {
    root.render(
      <EditableMarkdown
        document={createMeetingDocument(initial, new Set())}
        onLocalChange={vi.fn()}
        onNavigate={vi.fn()}
        onStatusChange={vi.fn()}
        onStoredChange={vi.fn()}
        ref={ref}
        resolveLink={() => null}
      />,
    );
  });

  await act(async () => observed.editor!.setMarkdown('# Latest *draft*'));
  expect(ref.current!.getMarkdown()).toBe('# Latest *draft*');
  expect(disk.content).toBe('Original\n');
});

test.each([1, 17, 73, 2026])(
  'six minutes of typing with delayed saves and stale renders (seed %i)',
  async (seed) => {
    vi.useFakeTimers();
    const random = randomFor(seed);
    const delay = (maximum: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, Math.floor(random() * maximum)));
    const ref = createRef<EditableMarkdownHandle>();
    const onStatusChange = vi.fn();
    const history = [initial];
    let activeSaves = 0;
    let maximumActiveSaves = 0;
    let edits = 0;
    const tokens: Array<string> = [];
    window.meetings!.saveDocument = vi.fn(
      async (request: { baseHash: string; content: string }) => {
        activeSaves++;
        maximumActiveSaves = Math.max(maximumActiveSaves, activeSaves);
        await delay(180);
        expect(request.baseHash).toBe(disk.hash);
        const saved = {
          ...disk,
          content: request.content,
          hash: request.content,
          mtimeMs: disk.mtimeMs + 1,
        };
        disk = saved;
        await delay(450);
        activeSaves--;
        return { document: saved, status: 'saved' as const };
      },
    );
    const render = (document: StoredDocument) =>
      root.render(
        <EditableMarkdown
          document={createMeetingDocument(document, new Set())}
          onLocalChange={vi.fn()}
          onNavigate={vi.fn()}
          onStatusChange={onStatusChange}
          onStoredChange={(saved) => history.push(saved)}
          ref={ref}
          resolveLink={() => null}
        />,
      );
    await act(async () => render(initial));
    let elapsed = 0;
    while (elapsed < 360_000) {
      const step =
        random() < 0.03 ? 500 + Math.floor(random() * 3000) : 20 + Math.floor(random() * 120);
      if (edits > 0 && edits % 100 === 0) {
        // Exercise replacements too, keeping document size bounded so this
        // timing test spends its time on save interleavings, not large layout.
        expect(observed.editor!.getMarkdown().match(/token\d+x\d+x/g)).toEqual(tokens);
        tokens.length = 0;
        await act(async () => {
          observed.editor!.setMarkdown('Original');
          observed.onLocalChange!('Original');
        });
      }
      await act(async () => {
        const token = `token${seed}x${edits++}x`;
        tokens.push(token);
        observed.editor!.focus({ defaultSelection: 'rootEnd' });
        observed.editor!.insertMarkdown(token);
      });
      if (random() < 0.35) {
        await act(async () => render(history[Math.floor(random() * history.length)]!));
      }
      if (random() < 0.02) {
        // A lifecycle flush must drain the same queue even during a slow save.
        await act(async () => window.dispatchEvent(new Event('pagehide')));
      }
      await act(async () => {
        await vi.advanceTimersByTimeAsync(step);
      });
      elapsed += step;
      expect(
        container.querySelector('[data-kind="conflict"]'),
        `seed ${seed}, edit ${edits}`,
      ).toBeNull();
      expect(ref.current!.hasUnsavedChanges() || readRecoveryDraft() === null).toBe(true);
    }
    const expected = observed.editor!.getMarkdown();
    await act(async () => {
      const flush = ref.current!.flush();
      await vi.advanceTimersByTimeAsync(2000);
      expect(await flush).toBe(true);
    });
    expect(disk.content).toBe(expected.endsWith('\n') ? expected : `${expected}\n`);
    expect(disk.content.match(/token\d+x\d+x/g)).toEqual(tokens);
    expect(maximumActiveSaves).toBe(1);
    expect(onStatusChange).not.toHaveBeenCalledWith('conflict');
    expect(onStatusChange).not.toHaveBeenCalledWith('error');
    expect(readRecoveryDraft()).toBeNull();
    expect(edits).toBeGreaterThan(1000);
  },
  120_000,
);

test.each([false, true])('real disk edits still reload or conflict (dirty: %s)', async (dirty) => {
  const ref = createRef<EditableMarkdownHandle>();
  await act(async () =>
    root.render(
      <EditableMarkdown
        document={createMeetingDocument(initial, new Set())}
        onLocalChange={vi.fn()}
        onNavigate={vi.fn()}
        onStatusChange={vi.fn()}
        onStoredChange={vi.fn()}
        ref={ref}
        resolveLink={() => null}
      />,
    ),
  );
  if (dirty) {
    await act(async () => {
      observed.editor!.setMarkdown('My unfinished text');
      observed.onLocalChange!('My unfinished text');
    });
  }
  disk = { ...initial, content: 'Actually changed elsewhere\n', hash: 'external' };
  await act(async () => ref.current!.applyExternalChange(disk));
  expect(Boolean(container.querySelector('[data-kind="conflict"]'))).toBe(dirty);
  expect(observed.editor!.getMarkdown()).toBe(
    dirty ? 'My unfinished text' : 'Actually changed elsewhere',
  );
  if (dirty) {
    await act(async () => {
      expect(await ref.current!.flush()).toBe(false);
    });
    expect(disk.content).toBe('Actually changed elsewhere\n');
    expect(readRecoveryDraft()?.content).toBe('My unfinished text');
  }
});

test('unmounting drains unsaved text after the editor ref detaches', async () => {
  await act(async () =>
    root.render(
      <EditableMarkdown
        document={createMeetingDocument(initial, new Set())}
        onLocalChange={vi.fn()}
        onNavigate={vi.fn()}
        onStatusChange={vi.fn()}
        onStoredChange={vi.fn()}
        resolveLink={() => null}
      />,
    ),
  );
  await act(async () => {
    observed.editor!.setMarkdown('Text before navigation');
    observed.onLocalChange!('Text before navigation');
  });
  await act(async () => root.unmount());
  expect(disk.content).toBe('Text before navigation\n');
  expect(readRecoveryDraft()).toBeNull();
  expect(window.meetings!.saveDocument).toHaveBeenCalledWith(
    expect.objectContaining({ content: 'Text before navigation\n' }),
    true,
  );
});

test('a delayed parent render cannot turn our own saved version into a disk conflict', async () => {
  const ref = createRef<EditableMarkdownHandle>();
  const onStoredChange = vi.fn();
  const onStatusChange = vi.fn();
  const render = (document: StoredDocument) =>
    root.render(
      <EditableMarkdown
        document={createMeetingDocument(document, new Set())}
        onLocalChange={vi.fn()}
        onNavigate={vi.fn()}
        onStatusChange={onStatusChange}
        onStoredChange={onStoredChange}
        ref={ref}
        resolveLink={() => null}
      />,
    );
  await act(async () => render(initial));
  await act(async () => {
    observed.editor!.setMarkdown('First edit');
    observed.onLocalChange!('First edit');
    await ref.current!.flush();
  });
  const firstSave = disk;
  await act(async () => {
    observed.editor!.setMarkdown('Second edit');
    observed.onLocalChange!('Second edit');
    await ref.current!.flush();
  });
  await act(async () => {
    observed.editor!.setMarkdown('Third edit still being typed');
    observed.onLocalChange!('Third edit still being typed');
    // Parent document state is presentation data. An older commit may land
    // after the persistence session has already acknowledged a newer save.
    render(firstSave);
  });
  expect(container.querySelector('[data-kind="conflict"]')).toBeNull();
  expect(onStatusChange).not.toHaveBeenCalledWith('conflict');
  await act(async () => {
    expect(await ref.current!.flush()).toBe(true);
  });
  expect(disk.content).toBe('Third edit still being typed\n');
  expect(readRecoveryDraft()).toBeNull();
});
