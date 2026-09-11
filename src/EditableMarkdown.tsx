import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import {
  PersistentMarkdownEditor,
  type MarkdownDocument,
  type MarkdownPersistenceAdapter,
  type MarkdownSaveStatus,
  type PersistentMarkdownEditorHandle,
} from '@nkzw/mdx-editor/persistence';
import type { MeetingDocument, StoredDocument } from './content.ts';
import {
  formatDocument,
  SaveConflictError,
  restoreDocument,
  saveDocument,
} from './documentApi.ts';
import {
  beginEditorVisualSwap,
  captureEditorView,
  restoreEditorView,
  waitForEditorUpdate,
} from './editorView.ts';
import {
  clearRecoveryDraft,
  fromStorageContent,
  readRecoveryDraft,
  type RecoveryDraft,
  writeRecoveryDraft,
} from './draftRecovery.ts';

type PersistedMeetingDocument = MarkdownDocument & StoredDocument;

const toPersistentDocument = (
  document: StoredDocument,
): PersistedMeetingDocument => ({
  ...document,
  id: document.path,
  version: document.hash,
});

const toStoredDocument = (
  document: PersistedMeetingDocument,
): StoredDocument => ({
  content: document.content,
  hash: document.version,
  mtimeMs: document.mtimeMs,
  path: document.path,
});

const persistenceAdapter: MarkdownPersistenceAdapter<PersistedMeetingDocument> =
  {
    async save({ content, document, keepalive }) {
      try {
        return {
          document: toPersistentDocument(
            await saveDocument({
              baseHash: document.version,
              content,
              keepalive,
              path: document.path,
            }),
          ),
          status: 'saved',
        };
      } catch (error) {
        if (error instanceof SaveConflictError) {
          return {
            document: toPersistentDocument(error.document),
            status: 'conflict',
          };
        }
        throw error;
      }
    },
  };

export type SaveStatus = MarkdownSaveStatus;

export type EditableMarkdownHandle = {
  applyExternalChange: (document: StoredDocument) => void;
  formatAndSave: () => Promise<boolean>;
  flush: () => Promise<boolean>;
  hasUnsavedChanges: () => boolean;
  restoreDeletedDocument: () => Promise<boolean>;
};

export const EditableMarkdown = forwardRef<
  EditableMarkdownHandle,
  {
    document: MeetingDocument;
    onLocalChange: (path: string, content: string) => void;
    onNavigate: (path: string) => void;
    onStatusChange: (status: SaveStatus) => void;
    onStoredChange: (document: StoredDocument) => void;
    resolveLink: (href: string) => string | null;
  }
>(function EditableMarkdown(
  {
    document,
    onLocalChange,
    onNavigate,
    onStatusChange,
    onStoredChange,
    resolveLink,
  },
  forwardedRef,
) {
  const editorRef =
    useRef<PersistentMarkdownEditorHandle<PersistedMeetingDocument>>(null);
  const formatAndSaveRef = useRef<Promise<boolean> | null>(null);
  const storedDocumentRef = useRef<StoredDocument>(document);
  const [recoveryDraft, setRecoveryDraft] = useState<RecoveryDraft | null>(
    () => {
      const draft = readRecoveryDraft();
      return draft?.path === document.path &&
        draft.content !== fromStorageContent(document.content) &&
        draft.baseHash !== document.hash
        ? draft
        : null;
    },
  );
  const [recoveryStorageError, setRecoveryStorageError] = useState(false);

  useEffect(() => {
    storedDocumentRef.current = document;
  }, [document.hash, document.mtimeMs, document.path]);

  useEffect(() => {
    const draft = readRecoveryDraft();
    if (!draft || draft.path !== document.path) {
      return;
    }
    if (draft.content === fromStorageContent(document.content)) {
      clearRecoveryDraft(document.path);
      return;
    }
    if (draft.baseHash !== document.hash) {
      setRecoveryDraft(draft);
      return;
    }

    const editor = editorRef.current;
    if (editor && editor.getMarkdown() !== draft.content) {
      editor.setMarkdown(draft.content);
      void editor.flush();
    }
  }, [document.hash, document.path]);

  useEffect(() => {
    if (!window.meetings) {
      return;
    }
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      const editor = editorRef.current;
      const pendingFormat = formatAndSaveRef.current;
      if (!pendingFormat && !editor?.hasUnsavedChanges()) {
        return;
      }

      event.preventDefault();
      event.returnValue = '';
      const flush = pendingFormat ?? editor!.flush({ keepalive: true });
      void flush.then((saved) => {
        if (saved && !editor?.hasUnsavedChanges()) {
          window.meetings?.readyToClose();
        }
      });
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  useImperativeHandle(
    forwardedRef,
    () => ({
      applyExternalChange(storedDocument) {
        editorRef.current?.applyExternalChange(
          toPersistentDocument(storedDocument),
        );
      },
      formatAndSave() {
        const editor = editorRef.current;
        if (!editor) {
          return Promise.resolve(true);
        }
        if (formatAndSaveRef.current) {
          return formatAndSaveRef.current;
        }

        const request = (async () => {
          let content = editor.getMarkdown();

          while (true) {
            const formattedContent = await formatDocument({
              content,
              path: document.path,
            });
            const currentContent = editor.getMarkdown();

            if (currentContent !== content) {
              content = currentContent;
              continue;
            }

            const editorContent = formattedContent.endsWith('\n')
              ? formattedContent.slice(0, -1)
              : formattedContent;
            if (editorContent === currentContent) {
              return editor.flush();
            }

            const contentEditable =
              globalThis.document.querySelector<HTMLElement>(
                '.meetings-markdown-editor .mdx-editor-content[contenteditable="true"]',
              );
            const scrollContainer =
              contentEditable?.closest<HTMLElement>('.document-scroll');
            const viewSnapshot =
              contentEditable && scrollContainer
                ? captureEditorView(contentEditable, scrollContainer)
                : null;
            const editorUpdate = contentEditable
              ? waitForEditorUpdate(contentEditable)
              : Promise.resolve();
            let finishVisualSwap = contentEditable
              ? beginEditorVisualSwap(contentEditable)
              : null;

            try {
              editor.setMarkdown(editorContent);
              const save = editor.flush();
              await editorUpdate;

              finishVisualSwap?.();
              finishVisualSwap = null;

              if (contentEditable && scrollContainer && viewSnapshot) {
                restoreEditorView(
                  contentEditable,
                  scrollContainer,
                  viewSnapshot,
                );
              }

              return save;
            } finally {
              finishVisualSwap?.();
            }
          }
        })()
          .catch(() => {
            onStatusChange('error');
            return false;
          })
          .finally(() => {
            formatAndSaveRef.current = null;
          });

        formatAndSaveRef.current = request;
        return request;
      },
      flush() {
        return (
          formatAndSaveRef.current ??
          editorRef.current?.flush() ??
          Promise.resolve(true)
        );
      },
      hasUnsavedChanges() {
        return (
          formatAndSaveRef.current !== null ||
          editorRef.current?.hasUnsavedChanges() === true
        );
      },
      async restoreDeletedDocument() {
        const editor = editorRef.current;
        if (!editor) {
          return false;
        }
        try {
          const restored = await restoreDocument({
            content: `${editor.getMarkdown()}\n`,
            path: document.path,
          });
          editor.applyExternalChange(toPersistentDocument(restored));
          return true;
        } catch {
          onStatusChange('error');
          return false;
        }
      },
    }),
    [document.path, onStatusChange],
  );

  return (
    <div>
      {recoveryDraft ? (
        <div className="mdx-editor-notice" data-kind="conflict" role="alert">
          <span>
            Unsaved text from the previous session was recovered, but the file
            also changed on disk.
          </span>
          <div>
            <button
              onClick={() => {
                const editor = editorRef.current;
                if (editor) {
                  editor.setMarkdown(recoveryDraft.content);
                  setRecoveryDraft(null);
                  void editor.flush();
                }
              }}
              type="button"
            >
              Restore recovered text
            </button>
            <button
              onClick={() => {
                clearRecoveryDraft(document.path);
                setRecoveryDraft(null);
              }}
              type="button"
            >
              Discard recovered text
            </button>
          </div>
        </div>
      ) : null}
      {recoveryStorageError ? (
        <div className="mdx-editor-notice" data-kind="error" role="alert">
          Crash recovery storage is unavailable. Keep Notes open until the save
          succeeds.
        </div>
      ) : null}
      <PersistentMarkdownEditor
        adapter={persistenceAdapter}
        className="meetings-markdown-editor"
        document={toPersistentDocument(document)}
        onDocumentChange={(persistentDocument) => {
          const storedDocument = toStoredDocument(persistentDocument);
          storedDocumentRef.current = storedDocument;
          const editorContent = editorRef.current?.getMarkdown();
          if (editorContent === fromStorageContent(storedDocument.content)) {
            clearRecoveryDraft(storedDocument.path);
          } else if (editorContent !== undefined) {
            setRecoveryStorageError(
              !writeRecoveryDraft({
                baseHash: storedDocument.hash,
                content: editorContent,
                path: storedDocument.path,
              }),
            );
          }
          onStoredChange(storedDocument);
        }}
        onLocalChange={(content) => {
          const storedDocument = storedDocumentRef.current;
          setRecoveryStorageError(
            !writeRecoveryDraft({
              baseHash: storedDocument.hash,
              content,
              path: document.path,
            }),
          );
          onLocalChange(document.path, content);
        }}
        onNavigate={onNavigate}
        onStatusChange={onStatusChange}
        readOnly={recoveryDraft !== null}
        ref={editorRef}
        resolveLink={resolveLink}
      />
    </div>
  );
});

export default EditableMarkdown;
