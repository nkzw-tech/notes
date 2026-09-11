// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createPreviewWorkspacePoller,
  diffWorkspaceSnapshots,
  loadWorkspace,
  type WorkspaceSnapshot,
} from "./documentApi.ts";

const workspace = (overrides: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot => ({
  documents: [],
  metadataError: null,
  peoplePaths: [],
  workspacePath: "/tmp/example-notes",
  ...overrides,
});

describe("preview workspace reconciliation", () => {
  test("coalesces concurrent full-workspace reads", async () => {
    const snapshot = workspace();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response(JSON.stringify(snapshot)));

    await expect(Promise.all([loadWorkspace(), loadWorkspace()])).resolves.toEqual([
      snapshot,
      snapshot,
    ]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  test("finds changed, added, and deleted documents plus metadata changes", () => {
    const oldDocument = {
      content: "Old\n",
      hash: "old",
      mtimeMs: 1,
      path: "docs/todo.md",
    };
    const deletedDocument = {
      ...oldDocument,
      path: "people/deleted.md",
    };
    const nextDocument = {
      ...oldDocument,
      content: "New\n",
      hash: "new",
      mtimeMs: 2,
    };
    const addedDocument = {
      ...nextDocument,
      path: "people/added.md",
    };

    expect(
      diffWorkspaceSnapshots(
        workspace({ documents: [oldDocument, deletedDocument] }),
        workspace({
          documents: [nextDocument, addedDocument],
          peoplePaths: ["people/added.md"],
        }),
      ),
    ).toEqual({
      documentChanges: [
        { deleted: false, document: nextDocument, path: nextDocument.path },
        { deleted: false, document: addedDocument, path: addedDocument.path },
        { deleted: true, path: deletedDocument.path },
      ],
      metadataChanged: true,
    });
  });

  test("polls once for all subscribers and publishes later disk changes", async () => {
    vi.useFakeTimers();
    const original = workspace({
      documents: [
        {
          content: "Original\n",
          hash: "original",
          mtimeMs: 1,
          path: "docs/todo.md",
        },
      ],
    });
    const changed = workspace({
      documents: [
        {
          content: "Changed\n",
          hash: "changed",
          mtimeMs: 2,
          path: "docs/todo.md",
        },
      ],
      peoplePaths: ["docs/todo.md"],
    });
    const load = vi
      .fn<() => Promise<WorkspaceSnapshot>>()
      .mockResolvedValueOnce(original)
      .mockResolvedValueOnce(changed);
    const poller = createPreviewWorkspacePoller(load);
    const documentListener = vi.fn();
    const metadataListener = vi.fn();
    const unsubscribeDocument = poller.subscribeToDocumentChanges(documentListener);
    const unsubscribeMetadata = poller.subscribeToWorkspaceMetadataChanges(metadataListener);

    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));

    expect(documentListener).toHaveBeenCalledWith({
      deleted: false,
      document: changed.documents[0],
      path: "docs/todo.md",
    });
    expect(metadataListener).toHaveBeenCalledWith({
      metadata: { peoplePaths: ["docs/todo.md"] },
    });

    unsubscribeDocument();
    unsubscribeMetadata();
  });

  test("publishes safe metadata fallback together with its warning", async () => {
    vi.useFakeTimers();
    const load = vi
      .fn<() => Promise<WorkspaceSnapshot>>()
      .mockResolvedValueOnce(workspace({ peoplePaths: ["people/one.md"] }))
      .mockResolvedValueOnce(
        workspace({
          metadataError: "config/people.json is invalid",
          peoplePaths: [],
        }),
      );
    const poller = createPreviewWorkspacePoller(load);
    const listener = vi.fn();
    const unsubscribe = poller.subscribeToWorkspaceMetadataChanges(listener);

    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));

    expect(listener).toHaveBeenCalledWith({
      error: "config/people.json is invalid",
      metadata: { peoplePaths: [] },
    });
    unsubscribe();
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
