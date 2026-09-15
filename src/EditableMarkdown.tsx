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
  // The parent also uses document.content for live sidebar/title previews.
  // It is not a persistence input after opening this keyed editor. Feeding
  // render snapshots back into persistence can roll back an acknowledged save.
  // Disk changes enter exclusively through applyExternalChange instead.
  const [openedDocument] = useState(() => toPersistentDocument(document));
  const [openedDraft] = useState(() => {
    const draft = readRecoveryDraft();
    return draft?.path === openedDocument.path ? draft : null;
  });
  const editorRef =
    useRef<PersistentMarkdownEditorHandle<PersistedMeetingDocument>>(null);
  const formatAndSaveRef = useRef<Promise<boolean> | null>(null);
  const storedDocumentRef = useRef<StoredDocument>(openedDocument);
  const [recoveryDraft, setRecoveryDraft] = useState<RecoveryDraft | null>(
    () => {
      return openedDraft &&
        openedDraft.content !== fromStorageContent(openedDocument.content) &&
        openedDraft.baseHash !== openedDocument.hash
        ? openedDraft
        : null;
    },
  );
  const [recoveryStorageError, setRecoveryStorageError] = useState(false);

  const recoveredRef = useRef(false);
  useEffect(() => {
    // Crash recovery is an opening operation, never a reaction to autosave or
    // parent rendering. The live draft is maintained by the save callbacks.
    if (recoveredRef.current || !openedDraft) {
      return;
    }
    recoveredRef.current = true;
    if (openedDraft.content === fromStorageContent(openedDocument.content)) {
      clearRecoveryDraft(openedDocument.path);
      return;
    }
    if (openedDraft.baseHash !== openedDocument.hash) {
      return;
    }

    const editor = editorRef.current;
    if (editor && editor.getMarkdown() !== openedDraft.content) {
      editor.setMarkdown(openedDraft.content);
      void editor.flush();
    }
  }, [openedDocument, openedDraft]);

  useEffect(() => {
    // Own lifecycle flushing here. A second beforeunload listener in the
    // persistence component can finish a synchronous save and block unloading
    // before this listener runs, leaving no one to acknowledge the close.
    const editor = editorRef.current;
    const flushPending = () =>
      formatAndSaveRef.current ?? editor?.flush({ keepalive: true });
    const onPageHide = () => {
      if (!recoveryDraft && (formatAndSaveRef.current || editor?.hasUnsavedChanges())) {
        void flushPending();
      }
    };
    const onVisibilityChange = () => {
      if (globalThis.document.visibilityState === 'hidden') {
        onPageHide();
      }
    };
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (recoveryDraft) {
        window.meetings?.cancelClose?.();
        event.preventDefault();
        event.returnValue = '';
        return;
      }
      const pendingFormat = formatAndSaveRef.current;
      if (!pendingFormat && !editor?.hasUnsavedChanges()) {
        return;
      }

      event.preventDefault();
      event.returnValue = '';
      void (async () => {
        let saved = await (pendingFormat ?? editor!.flush({ keepalive: true }));
        // Editor updates can arrive between a completed flush and this
        // continuation. Drain them too; only a failed save cancels closing.
        while (saved && editor?.hasUnsavedChanges()) {
          saved = await editor.flush({ keepalive: true });
        }
        if (saved && !editor?.hasUnsavedChanges()) {
          window.meetings?.readyToClose();
        } else {
          window.meetings?.cancelClose?.();
        }
      })();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    window.addEventListener('pagehide', onPageHide);
    globalThis.document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      window.removeEventListener('pagehide', onPageHide);
      globalThis.document.removeEventListener('visibilitychange', onVisibilityChange);
      onPageHide();
    };
  }, [recoveryDraft]);

  useImperativeHandle(
    forwardedRef,
    () => ({
      applyExternalChange(storedDocument) {
        editorRef.current?.applyExternalChange(
          toPersistentDocument(storedDocument),
        );
      },
      formatAndSave() {
        if (recoveryDraft) {
          return Promise.resolve(false);
        }
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
        if (recoveryDraft) {
          return Promise.resolve(false);
        }
        return (
          formatAndSaveRef.current ??
          editorRef.current?.flush() ??
          Promise.resolve(true)
        );
      },
      hasUnsavedChanges() {
        return (
          recoveryDraft !== null ||
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
    [document.path, onStatusChange, recoveryDraft],
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
        document={openedDocument}
        lifecycleFlush={false}
        onDocumentChange={(persistentDocument) => {
          const storedDocument = toStoredDocument(persistentDocument);
          storedDocumentRef.current = storedDocument;
          let editorContent = editorRef.current?.getMarkdown();
          if (editorContent === undefined) {
            // A navigation flush may acknowledge after the editor detaches.
            const draft = readRecoveryDraft();
            if (draft?.path === storedDocument.path) {
              editorContent = draft.content;
            }
          }
          // Keep recovered text until the user resolves it, even if another window saves.
          if (!recoveryDraft && editorContent === fromStorageContent(storedDocument.content)) {
            clearRecoveryDraft(storedDocument.path);
          } else if (!recoveryDraft && editorContent !== undefined) {
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
