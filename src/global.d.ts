import type { StoredDocument } from "./content.ts";
import type { DocumentChangeEvent } from "./documentApi.ts";
import type { WorkspaceMetadataChangeEvent, WorkspaceSnapshot } from "./documentApi.ts";
import type { WindowLayout } from "./windowLayout.ts";

type SaveDocumentResult =
  | {
      document: StoredDocument;
      status: "conflict" | "saved";
    }
  | {
      error: string;
      status: "error";
    };

declare global {
  interface Window {
    meetings?: {
      initialWindowLayout?: WindowLayout | null;
      updateWindowState?: (state: { layout: WindowLayout; activePath?: string }) => void;
      cancelClose?: () => void;
      recoveryDraftKey?: string;
      chooseWorkspace: () => Promise<
        { canceled: true; workspacePath?: never } | { canceled: false; workspacePath: string }
      >;
      completeInterview: (request: { path: string }) => Promise<{ path: string }>;
      createDocument: (request: {
        kind: "doc" | "interview" | "person" | "report";
        title: string;
      }) => Promise<StoredDocument>;
      deleteDocument: (request: { path: string }) => Promise<{ path: string }>;
      formatDocument: (request: { content: string; path: string }) => Promise<string>;
      loadWorkspace: () => Promise<WorkspaceSnapshot>;
      onCloseBlocked: (callback: (message: string) => void) => () => void;
      onChooseWorkspaceRequested: (callback: () => void) => () => void;
      onDocumentChange: (callback: (change: DocumentChangeEvent) => void) => () => void;
      onWorkspaceMetadataChange: (
        callback: (change: WorkspaceMetadataChangeEvent) => void,
      ) => () => void;
      readyToClose: () => void;
      restoreDocument: (request: { content: string; path: string }) => Promise<StoredDocument>;
      saveDocument: (
        request: {
          baseHash: string;
          content: string;
          path: string;
        },
        keepalive: boolean,
      ) => Promise<SaveDocumentResult> | SaveDocumentResult;
    };
  }
}

export {};
