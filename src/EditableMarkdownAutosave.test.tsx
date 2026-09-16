// @vitest-environment jsdom

import { act, forwardRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test';
import { createMeetingDocument, type StoredDocument } from './content.ts';
import { readRecoveryDraft } from './draftRecovery.ts';

type PersistentDocument = StoredDocument & {
  id: string;
  version: string;
};

type FakeEditorProps = {
  document: PersistentDocument;
  onDocumentChange?: (document: PersistentDocument) => void;
  onLocalChange?: (content: string) => void;
  readOnly?: boolean;
};

const fakeEditor = vi.hoisted(() => ({
  content: '',
  props: null as FakeEditorProps | null,
}));

vi.mock('@nkzw/mdx-editor/persistence', async () => {
  const React = await import('react');
  return {
    PersistentMarkdownEditor: React.forwardRef(function FakePersistentEditor(
      props: FakeEditorProps,
      ref,
    ) {
      const documentId = React.useRef<string | null>(null);
      /* eslint-disable react/immutability -- The test double exposes mutable editor state to the harness. */
      if (documentId.current !== props.document.id) {
        documentId.current = props.document.id;
        fakeEditor.content = props.document.content.replace(/\n$/, '');
      }
      fakeEditor.props = props;
      /* eslint-enable react/immutability */
      React.useImperativeHandle(ref, () => ({
        applyExternalChange: vi.fn(),
        flush: vi.fn(async () => true),
        getMarkdown: () => fakeEditor.content,
        hasUnsavedChanges: () => false,
        setMarkdown: (content: string) => {
          fakeEditor.content = content;
        },
      }));
      return React.createElement('div', {
        className: 'mdx-editor-content',
        contentEditable: !props.readOnly,
      });
    }),
  };
});

import EditableMarkdown from './EditableMarkdown.tsx';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const roots: Array<Root> = [];
const storageValues = new Map<string, string>();

beforeEach(() => {
  storageValues.clear();
  fakeEditor.content = '';
  fakeEditor.props = null;
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => storageValues.get(key) ?? null,
      removeItem: (key: string) => storageValues.delete(key),
      setItem: (key: string, value: string) => storageValues.set(key, value),
    },
  });
});

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => root.unmount());
  }
  document.body.replaceChildren();
  vi.clearAllMocks();
});

describe('EditableMarkdown autosave recovery', () => {
  test('rebases a newer recovery draft after a partial save without locking the editor', async () => {
    const initialDocument: StoredDocument = {
      content: 'Original\n',
      hash: 'original-hash',
      mtimeMs: 1,
      path: 'interviews/15-candidate-example.md',
    };
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);

    const Harness = forwardRef(function Harness() {
      const [document, setDocument] = useState(initialDocument);
      const [peoplePaths] = useState(() => new Set<string>());
      return (
        <EditableMarkdown
          document={createMeetingDocument(document, peoplePaths)}
          onLocalChange={vi.fn()}
          onNavigate={vi.fn()}
          onStatusChange={vi.fn()}
          onStoredChange={setDocument}
          resolveLink={() => null}
        />
      );
    });

    await act(async () => root.render(<Harness />));

    await act(async () => {
      fakeEditor.content = 'First edit';
      fakeEditor.props!.onLocalChange?.(fakeEditor.content);
      fakeEditor.content = 'First edit plus newer text';
      fakeEditor.props!.onLocalChange?.(fakeEditor.content);
    });

    await act(async () => {
      fakeEditor.props!.onDocumentChange?.({
        ...initialDocument,
        content: 'First edit\n',
        hash: 'saved-hash',
        id: initialDocument.path,
        mtimeMs: 2,
        version: 'saved-hash',
      });
    });

    expect(readRecoveryDraft()).toMatchObject({
      baseHash: 'saved-hash',
      content: 'First edit plus newer text',
      path: initialDocument.path,
    });
    expect(container.textContent).not.toContain(
      'Unsaved text from the previous session was recovered',
    );
    expect(container.querySelector('.mdx-editor-content')?.getAttribute('contenteditable')).toBe(
      'true',
    );
  });
});
