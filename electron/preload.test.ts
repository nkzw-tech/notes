import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { expect, test, vi } from "vitest";

test("uses asynchronous saves normally and synchronous saves only for lifecycle flushes", async () => {
  const directory = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(directory, "preload.cjs"), "utf8");
  const nativeRequire = createRequire(import.meta.url);
  const sendSync = vi.fn(() => ({ status: "saved" }));
  const send = vi.fn();
  const invoke = vi.fn(() => Promise.resolve({ status: "saved" }));
  let exposedMeetings: {
    updateWindowState: (state: unknown) => void;
    cancelClose: () => void;
    chooseWorkspace: () => Promise<unknown>;
    completeInterview: (request: { path: string }) => Promise<unknown>;
    createDocument: (request: { kind: "doc"; title: string }) => Promise<unknown>;
    deleteDocument: (request: { path: string }) => Promise<unknown>;
    readyToClose: () => void;
    saveDocument: (
      request: { baseHash: string; content: string; path: string },
      keepalive: boolean,
    ) => unknown;
  } | null = null;

  const mockedRequire = (specifier: string) => {
    if (specifier === "electron") {
      return {
        contextBridge: {
          exposeInMainWorld: (_name: string, value: typeof exposedMeetings) => {
            exposedMeetings = value;
          },
        },
        ipcRenderer: {
          invoke,
          on: vi.fn(),
          removeListener: vi.fn(),
          send,
          sendSync,
        },
      };
    }
    return nativeRequire(specifier);
  };

  vm.runInNewContext(source, {
    console,
    document: {
      documentElement: { setAttribute: vi.fn() },
    },
    process,
    require: mockedRequire,
    window: { addEventListener: vi.fn() },
  });

  expect(sendSync).toHaveBeenCalledWith("meetings:recovery-key");
  expect(sendSync).toHaveBeenCalledWith("meetings:window-layout");
  sendSync.mockClear();

  const viewState = {
    layout: { sidebarCollapsed: true, sidebarWidth: 280, sectionExpanded: {} },
    activePath: "docs/example.md",
  };
  exposedMeetings!.updateWindowState(viewState);
  expect(send).toHaveBeenCalledWith("meetings:window-state", viewState);
  expect(sendSync).not.toHaveBeenCalled();
  exposedMeetings!.cancelClose();
  expect(send).toHaveBeenCalledWith("meetings:cancel-close");

  const request = {
    baseHash: "old",
    content: "Newest text\n",
    path: "docs/todo.md",
  };
  await exposedMeetings!.chooseWorkspace();
  expect(invoke).toHaveBeenCalledWith("meetings:choose-workspace");
  await exposedMeetings!.createDocument({ kind: "doc", title: "New notes" });
  expect(invoke).toHaveBeenCalledWith("meetings:create-document", {
    kind: "doc",
    title: "New notes",
  });
  await exposedMeetings!.deleteDocument({ path: "docs/old-notes.md" });
  expect(invoke).toHaveBeenCalledWith("meetings:delete-document", {
    path: "docs/old-notes.md",
  });
  await exposedMeetings!.completeInterview({
    path: "interviews/15-candidate.md",
  });
  expect(invoke).toHaveBeenCalledWith("meetings:complete-interview", {
    path: "interviews/15-candidate.md",
  });

  exposedMeetings!.saveDocument(request, true);

  expect(sendSync).toHaveBeenCalledWith("meetings:save-document-sync", {
    ...request,
    keepalive: true,
  });

  await exposedMeetings!.saveDocument(request, false);
  expect(invoke).toHaveBeenCalledWith("meetings:save-document", request);
  expect(sendSync).toHaveBeenCalledTimes(1);

  exposedMeetings!.readyToClose();
  expect(send).toHaveBeenCalledWith("meetings:close-ready");
});
