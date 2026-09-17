import type { StoredDocument } from './content.ts';
import type { DocumentChangeEvent } from './documentApi.ts';
import type { WorkspaceMetadataChangeEvent, WorkspaceSnapshot } from './documentApi.ts';
import type { WindowAppearance } from './windowAppearance.ts';
import type { WindowLayout } from './windowLayout.ts';

type SaveDocumentResult =
  | {
      document: StoredDocument;
      status: 'conflict' | 'saved';
    }
  | {
      error: string;
      status: 'error';
    };

declare global {
  interface Window {
    meetings?: {
      cancelClose?: () => void;
      chooseWorkspace: () => Promise<
        { canceled: true; workspacePath?: never } | { canceled: false; workspacePath: string }
      >;
      clearGlassAvailable?: boolean;
      closeWindowIfOthersOpen?: () => Promise<boolean>;
      completeInterview: (request: { path: string }) => Promise<{ path: string }>;
      createDocument: (request: {
        kind: 'doc' | 'interview' | 'person' | 'report';
        title: string;
      }) => Promise<StoredDocument>;
      deleteDocument: (request: { path: string }) => Promise<{ path: string }>;
      formatDocument: (request: { content: string; path: string }) => Promise<string>;
      initialWindowAppearance?: WindowAppearance;
      initialWindowLayout?: WindowLayout | null;
      loadWorkspace: () => Promise<WorkspaceSnapshot>;
      onChooseWorkspaceRequested: (callback: () => void) => () => void;
      onCloseBlocked: (callback: (message: string) => void) => () => void;
      onDocumentChange: (callback: (change: DocumentChangeEvent) => void) => () => void;
      onWorkspaceMetadataChange: (
        callback: (change: WorkspaceMetadataChangeEvent) => void,
      ) => () => void;
      readyToClose: () => void;
      recoveryDraftKey?: string;
      rendererReady?: () => void;
      restoreDocument: (request: { content: string; path: string }) => Promise<StoredDocument>;
      saveDocument: (
        request: {
          baseHash: string;
          content: string;
          path: string;
        },
        keepalive: boolean,
      ) => Promise<SaveDocumentResult> | SaveDocumentResult;
      updateWindowAppearance?: (appearance: WindowAppearance) => Promise<WindowAppearance>;
      updateWindowState?: (state: { activePath?: string | null; layout: WindowLayout }) => void;
    };
  }
}

export {};
