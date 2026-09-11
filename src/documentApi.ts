import type { StoredDocument } from "./content.ts";
import type { WorkspaceMetadata } from "../workspace-metadata.ts";

const WORKSPACE_ENDPOINT = "/__meetings/workspace";
const CREATE_ENDPOINT = "/__meetings/create";
const DELETE_INTERVIEW_ENDPOINT = "/__meetings/interview";
const DOCUMENT_ENDPOINT = "/__meetings/document";
const FORMAT_ENDPOINT = "/__meetings/format";
const RESTORE_ENDPOINT = "/__meetings/restore";

export type DocumentChangeEvent =
  | {
      deleted: true;
      path: string;
    }
  | {
      deleted: false;
      document: StoredDocument;
      path: string;
    };

export type WorkspaceMetadataChangeEvent =
  | { error: string; metadata?: never }
  | { error?: string; metadata: WorkspaceMetadata };

export type WorkspaceSnapshot = WorkspaceMetadata & {
  documents: StoredDocument[];
  metadataError: string | null;
  workspacePath: string | null;
};

export type CreateDocumentKind = "doc" | "interview" | "person" | "report";

export type CreateDocumentRequest = {
  kind: CreateDocumentKind;
  title: string;
};

export const diffWorkspaceSnapshots = (previous: WorkspaceSnapshot, next: WorkspaceSnapshot) => {
  const changes: DocumentChangeEvent[] = [];
  const previousByPath = new Map(previous.documents.map((document) => [document.path, document]));
  const nextPaths = new Set<string>();
  for (const document of next.documents) {
    nextPaths.add(document.path);
    if (previousByPath.get(document.path)?.hash !== document.hash) {
      changes.push({ deleted: false, document, path: document.path });
    }
  }
  for (const path of previousByPath.keys()) {
    if (!nextPaths.has(path)) {
      changes.push({ deleted: true, path });
    }
  }
  return {
    documentChanges: changes,
    metadataChanged:
      previous.metadataError !== next.metadataError ||
      previous.peoplePaths.join("\0") !== next.peoplePaths.join("\0"),
  };
};

export const createPreviewWorkspacePoller = (load: () => Promise<WorkspaceSnapshot>) => {
  const documentListeners = new Set<(change: DocumentChangeEvent) => void>();
  const metadataListeners = new Set<(change: WorkspaceMetadataChangeEvent) => void>();
  let inFlight = false;
  let timer: number | null = null;
  let workspace: WorkspaceSnapshot | null = null;

  const poll = async () => {
    if (inFlight) {
      return;
    }
    inFlight = true;
    try {
      const next = await load();
      const previous = workspace;
      workspace = next;
      if (!previous) {
        return;
      }
      const difference = diffWorkspaceSnapshots(previous, next);
      for (const change of difference.documentChanges) {
        for (const listener of documentListeners) {
          listener(change);
        }
      }
      if (difference.metadataChanged) {
        const change: WorkspaceMetadataChangeEvent = {
          ...(next.metadataError ? { error: next.metadataError } : {}),
          metadata: { peoplePaths: next.peoplePaths },
        };
        for (const listener of metadataListeners) {
          listener(change);
        }
      }
    } catch (error) {
      const change: WorkspaceMetadataChangeEvent = {
        error: error instanceof Error ? error.message : "Failed to reconcile preview workspace.",
      };
      for (const listener of metadataListeners) {
        listener(change);
      }
    } finally {
      inFlight = false;
    }
  };

  const start = () => {
    if (timer === null) {
      void poll();
      timer = window.setInterval(() => void poll(), 1_000);
    }
    return () => {
      if (timer !== null && documentListeners.size === 0 && metadataListeners.size === 0) {
        window.clearInterval(timer);
        timer = null;
        workspace = null;
      }
    };
  };

  return {
    subscribeToDocumentChanges(listener: (change: DocumentChangeEvent) => void) {
      documentListeners.add(listener);
      const stop = start();
      return () => {
        documentListeners.delete(listener);
        stop();
      };
    },
    subscribeToWorkspaceMetadataChanges(listener: (change: WorkspaceMetadataChangeEvent) => void) {
      metadataListeners.add(listener);
      const stop = start();
      return () => {
        metadataListeners.delete(listener);
        stop();
      };
    },
  };
};

let previewWorkspacePoller: ReturnType<typeof createPreviewWorkspacePoller> | null = null;

const getPreviewWorkspacePoller = () =>
  (previewWorkspacePoller ??= createPreviewWorkspacePoller(loadWorkspace));

export class SaveConflictError extends Error {
  document: StoredDocument;

  constructor(document: StoredDocument) {
    super(`Document changed on disk: ${document.path}`);
    this.name = "SaveConflictError";
    this.document = document;
  }
}

const getResponseError = async (response: Response) => {
  const body = (await response.json().catch(() => null)) as {
    error?: string;
  } | null;
  return body?.error ?? `Request failed with status ${response.status}.`;
};

const requestWorkspace = async (): Promise<WorkspaceSnapshot> => {
  if (window.meetings) {
    return window.meetings.loadWorkspace();
  }

  const response = await fetch(WORKSPACE_ENDPOINT, {
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(await getResponseError(response));
  }

  const body = (await response.json()) as {
    documents: StoredDocument[];
    metadataError: string | null;
    peoplePaths: string[];
    workspacePath?: string;
  };
  return { ...body, workspacePath: body.workspacePath ?? "preview" };
};

let workspaceLoadInFlight: Promise<WorkspaceSnapshot> | null = null;

export const loadWorkspace = () => {
  if (!workspaceLoadInFlight) {
    const request = requestWorkspace();
    workspaceLoadInFlight = request;
    void request.then(
      () => {
        if (workspaceLoadInFlight === request) {
          workspaceLoadInFlight = null;
        }
      },
      () => {
        if (workspaceLoadInFlight === request) {
          workspaceLoadInFlight = null;
        }
      },
    );
  }
  return workspaceLoadInFlight;
};

export const createDocument = async (request: CreateDocumentRequest) => {
  if (window.meetings) {
    return window.meetings.createDocument(request);
  }

  const response = await fetch(CREATE_ENDPOINT, {
    body: JSON.stringify(request),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const body = (await response.json().catch(() => null)) as {
    document?: StoredDocument;
    error?: string;
  } | null;
  if (!response.ok || !body?.document) {
    throw new Error(body?.error ?? `Create failed with status ${response.status}.`);
  }
  return body.document;
};

export const completeInterview = async (path: string) => {
  if (window.meetings) {
    return window.meetings.completeInterview({ path });
  }

  const response = await fetch(DELETE_INTERVIEW_ENDPOINT, {
    body: JSON.stringify({ path }),
    headers: { "Content-Type": "application/json" },
    method: "DELETE",
  });
  const body = (await response.json().catch(() => null)) as {
    error?: string;
    path?: string;
  } | null;
  if (!response.ok || body?.path !== path) {
    throw new Error(body?.error ?? `Interview completion failed with status ${response.status}.`);
  }
  return { path: body.path };
};

export const deleteDocument = async (path: string) => {
  if (window.meetings) {
    return window.meetings.deleteDocument({ path });
  }

  const response = await fetch(DOCUMENT_ENDPOINT, {
    body: JSON.stringify({ path }),
    headers: { "Content-Type": "application/json" },
    method: "DELETE",
  });
  const body = (await response.json().catch(() => null)) as {
    error?: string;
    path?: string;
  } | null;
  if (!response.ok || body?.path !== path) {
    throw new Error(body?.error ?? `Document deletion failed with status ${response.status}.`);
  }
  return { path: body.path };
};

export const saveDocument = async ({
  baseHash,
  content,
  keepalive = false,
  path,
}: {
  baseHash: string;
  content: string;
  keepalive?: boolean;
  path: string;
}) => {
  if (window.meetings) {
    const result = await window.meetings.saveDocument(
      {
        baseHash,
        content,
        path,
      },
      keepalive,
    );
    if (result.status === "conflict") {
      throw new SaveConflictError(result.document);
    }
    if (result.status === "error") {
      throw new Error(result.error);
    }
    return result.document;
  }

  const response = await fetch(DOCUMENT_ENDPOINT, {
    body: JSON.stringify({
      baseHash,
      content,
      path,
    }),
    headers: {
      "Content-Type": "application/json",
    },
    keepalive,
    method: "PUT",
  });

  const body = (await response.json().catch(() => null)) as {
    document?: StoredDocument;
    error?: string;
  } | null;

  if (response.status === 409 && body?.document) {
    throw new SaveConflictError(body.document);
  }
  if (!response.ok || !body?.document) {
    throw new Error(body?.error ?? `Save failed with status ${response.status}.`);
  }

  return body.document;
};

export const formatDocument = async ({ content, path }: { content: string; path: string }) => {
  if (window.meetings) {
    return window.meetings.formatDocument({ content, path });
  }

  const response = await fetch(FORMAT_ENDPOINT, {
    body: JSON.stringify({
      content,
      path,
    }),
    headers: {
      "Content-Type": "application/json",
    },
    method: "POST",
  });
  const body = (await response.json().catch(() => null)) as {
    content?: string;
    error?: string;
  } | null;

  if (!response.ok || typeof body?.content !== "string") {
    throw new Error(body?.error ?? `Format failed with status ${response.status}.`);
  }

  return body.content;
};

export const restoreDocument = async ({ content, path }: { content: string; path: string }) => {
  if (window.meetings) {
    return window.meetings.restoreDocument({ content, path });
  }
  const response = await fetch(RESTORE_ENDPOINT, {
    body: JSON.stringify({ content, path }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const body = (await response.json().catch(() => null)) as {
    document?: StoredDocument;
    error?: string;
  } | null;
  if (!response.ok || !body?.document) {
    throw new Error(body?.error ?? `Restore failed with status ${response.status}.`);
  }
  return body.document;
};

export const subscribeToDocumentChanges = (callback: (change: DocumentChangeEvent) => void) => {
  if (window.meetings) {
    return window.meetings.onDocumentChange(callback);
  }

  const hot = import.meta.hot;
  if (!hot) {
    return getPreviewWorkspacePoller().subscribeToDocumentChanges(callback);
  }
  hot.on("meetings:document-change", callback);
  return () => hot.off("meetings:document-change", callback);
};

export const subscribeToWorkspaceMetadataChanges = (
  callback: (change: WorkspaceMetadataChangeEvent) => void,
) => {
  if (window.meetings) {
    return window.meetings.onWorkspaceMetadataChange(callback);
  }

  const hot = import.meta.hot;
  if (!hot) {
    return getPreviewWorkspacePoller().subscribeToWorkspaceMetadataChanges(callback);
  }
  hot.on("meetings:workspace-metadata-change", callback);
  return () => hot.off("meetings:workspace-metadata-change", callback);
};
