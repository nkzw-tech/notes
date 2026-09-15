import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { WindowLayout } from "../src/windowLayout.ts";

type StoredDocument = {
  content: string;
  hash: string;
  mtimeMs: number;
  path: string;
};

type Deferred<Value> = {
  promise: Promise<Value>;
  resolve: (value: Value) => void;
};

const createDeferred = <Value>(): Deferred<Value> => {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

type SavedWindowState = {
  height: number;
  width: number;
  x: number;
  y: number;
  isFullScreen?: boolean;
  isMaximized?: boolean;
  layout?: WindowLayout;
};
type WindowSession = {
  recoveryId: string;
  workspaceRoot: string;
  layout?: WindowLayout;
  bounds?: SavedWindowState;
  activePath?: string;
};

type MainHarness = ReturnType<typeof loadMainHarness>;

const loadMainHarness = (
  platform = process.platform,
  workspaceAvailable = true,
  restoredWindows: WindowSession[] = [],
  savedDefault: SavedWindowState | null = null,
) => {
  const electronDirectory = dirname(fileURLToPath(import.meta.url));
  const mainPath = join(electronDirectory, "main.cjs");
  const source = readFileSync(mainPath, "utf8");
  const require = createRequire(import.meta.url);
  const appEvents = new Map<string, (...arguments_: unknown[]) => void>();
  const ipcHandlers = new Map<string, (...arguments_: unknown[]) => unknown>();
  const ipcListeners = new Map<string, (...arguments_: unknown[]) => void>();
  const watcherCallbacks: Array<(eventType: string, filename: string | Buffer | null) => void> = [];
  const sentChanges: unknown[] = [];
  const sentChannels: string[] = [];
  let applicationMenu: unknown[] = [];

  const readDocument = vi.fn<(root: string, path: string) => Promise<StoredDocument>>();
  const listDocuments = vi.fn().mockResolvedValue([]);
  const writeDocumentSync =
    vi.fn<
      (request: { baseHash: string; content: string; path: string; root: string }) => StoredDocument
    >();
  const writeDocument =
    vi.fn<
      (request: {
        baseHash: string;
        content: string;
        path: string;
        root: string;
      }) => Promise<StoredDocument>
    >();
  const readWorkspaceMetadataOrDefault = vi.fn().mockResolvedValue({
    metadataError: null,
    peoplePaths: [],
  });
  const createWorkspaceDocument = vi.fn();
  const deleteDocument = vi.fn();
  const writeOpenWindows = vi.fn(
    (sessions: WindowSession[], _root: string) =>
      JSON.parse(JSON.stringify(sessions)) as WindowSession[],
  );
  const watcherClose = vi.fn();
  const restoreDocument = vi.fn();
  const initializeWorkspace = vi.fn((path: string) => path);
  const readWorkspacePath = vi.fn(() => (workspaceAvailable ? "/tmp/notes-workspace" : null));
  const writeWorkspacePath = vi.fn();
  const showOpenDialog = vi.fn().mockResolvedValue({
    canceled: true,
    filePaths: [],
  });

  class FakeBrowserWindow {
    static instances: FakeBrowserWindow[] = [];
    static nextId = 1;

    handlers = new Map<string, (...arguments_: unknown[]) => void>();
    options: { minWidth?: number; height?: number; width?: number; x?: number; y?: number };
    bounds = { height: 800, width: 1200, x: 0, y: 0 };
    webContentsUnavailable = false;

    fakeWebContents = {
      handlers: new Map<string, (...arguments_: unknown[]) => void>(),
      id: FakeBrowserWindow.nextId++,
      isDestroyed: () => false,
      on: (event: string, callback: (...arguments_: unknown[]) => void) => {
        this.fakeWebContents.handlers.set(event, callback);
      },
      send: vi.fn((channel: string, change: unknown) => {
        sentChannels.push(channel);
        sentChanges.push(change);
      }),
      setWindowOpenHandler: vi.fn(),
      toggleDevTools: vi.fn(),
      getURL: () => "file:///notes/index.html#/docs/todo.md",
    };

    get webContents() {
      if (this.webContentsUnavailable) {
        throw new Error("Object has been destroyed");
      }
      return this.fakeWebContents;
    }

    constructor(options: FakeBrowserWindow["options"]) {
      this.options = options;
      this.bounds = {
        height: options.height ?? 800,
        width: options.width ?? 1200,
        x: options.x ?? 0,
        y: options.y ?? 0,
      };
      FakeBrowserWindow.instances.push(this);
    }

    static getAllWindows() {
      return FakeBrowserWindow.instances;
    }

    center() {}
    destroyWebContents() {
      this.webContentsUnavailable = true;
    }
    focus() {}
    getNormalBounds() {
      return this.bounds;
    }
    isDestroyed() {
      return false;
    }
    isFullScreen() {
      return false;
    }
    isMaximized() {
      return false;
    }
    isMinimized() {
      return false;
    }
    loadURL = vi.fn((_url: string) => Promise.resolve());
    maximize() {}
    on(event: string, callback: (...arguments_: unknown[]) => void) {
      this.handlers.set(event, callback);
    }
    once(_event: string, _callback: (...arguments_: unknown[]) => void) {}
    restore() {}
    setFullScreen(_value: boolean) {}
    show() {}
  }

  const app = {
    getPath: (_name: string) => "/tmp/meetings-test-user-data",
    on: (event: string, callback: (...arguments_: unknown[]) => void) => {
      appEvents.set(event, callback);
    },
    quit: vi.fn(),
    requestSingleInstanceLock: () => true,
    setName: vi.fn(),
  };
  const electron = {
    app,
    BrowserWindow: FakeBrowserWindow,
    dialog: { showOpenDialog },
    ipcMain: {
      handle: (channel: string, callback: (...arguments_: unknown[]) => unknown) => {
        ipcHandlers.set(channel, callback);
      },
      on: (channel: string, callback: (...arguments_: unknown[]) => void) => {
        ipcListeners.set(channel, callback);
      },
    },
    Menu: {
      buildFromTemplate: (template: unknown[]) => {
        applicationMenu = template;
        return template;
      },
      setApplicationMenu: vi.fn(),
    },
    nativeTheme: { shouldUseDarkColors: false },
    screen: {
      getAllDisplays: () => [],
      getPrimaryDisplay: () => ({
        workAreaSize: { height: 900, width: 1440 },
      }),
    },
    shell: { openExternal: vi.fn() },
  };
  const documentService = {
    DOCUMENT_DIRECTORIES: ["docs"],
    DocumentConflictError: class DocumentConflictError extends Error {
      document: StoredDocument;

      constructor(document: StoredDocument) {
        super("conflict");
        this.document = document;
      }
    },
    createWorkspaceDocument,
    deleteDocument,
    formatDocumentContent: vi.fn(),
    hashContent: (content: string) => createHash("sha256").update(content).digest("hex"),
    isWorkspaceRoot: () => workspaceAvailable,
    listDocuments,
    normalizeDocumentPath: (path: string) =>
      /^docs\/[A-Za-z0-9._-]+\.md$/.test(path) ? path : null,
    readDocument,
    restoreDocument,
    writeDocument,
    writeDocumentSync,
  };
  const windowState = {
    readWindowState: () => savedDefault,
    validateWindowStateOnScreen: (state: SavedWindowState) => state,
    writeWindowState: vi.fn((state: SavedWindowState) => {
      savedDefault = state;
    }),
  };

  const mockedRequire = (specifier: string) => {
    if (specifier === "./workspace-session.cjs") {
      const nestedModule = { exports: {} };
      vm.runInNewContext(readFileSync(join(electronDirectory, "workspace-session.cjs"), "utf8"), {
        require: mockedRequire,
        module: nestedModule,
        setTimeout,
        clearTimeout,
        console,
      });
      return nestedModule.exports;
    }
    if (specifier === "./open-windows.cjs") {
      return { readOpenWindows: () => restoredWindows, writeOpenWindows };
    }
    if (specifier === "electron") {
      return electron;
    }
    if (specifier === "electron-squirrel-startup") {
      return false;
    }
    if (specifier === "node:fs") {
      return {
        existsSync: () => true,
        watch: (
          _path: string,
          _options: unknown,
          callback: (eventType: string, filename: string | Buffer | null) => void,
        ) => {
          watcherCallbacks.push(callback);
          return { close: watcherClose, on: vi.fn() };
        },
      };
    }
    if (specifier === "./document-service.cjs") {
      return documentService;
    }
    if (specifier === "./workspace-metadata.cjs") {
      return {
        readWorkspaceMetadataOrDefault,
        reconcileWorkspaceMetadataPaths: (
          metadata: { metadataError: string | null; peoplePaths: string[] },
          paths: Set<string>,
        ) => ({
          metadataError: metadata.peoplePaths.some((path) => !paths.has(path))
            ? "missing registry target"
            : metadata.metadataError,
          peoplePaths: metadata.peoplePaths.filter((path) => paths.has(path)),
        }),
        WORKSPACE_METADATA_PATH: "config/people.json",
      };
    }
    if (specifier === "./workspace-config.cjs") {
      return {
        initializeWorkspace,
        readWorkspacePath,
        writeWorkspacePath,
      };
    }
    if (specifier === "./window-state.cjs") {
      return windowState;
    }
    return require(specifier);
  };

  const module = { exports: {} };
  const runtimeProcess = {
    argv: process.argv,
    cwd: () => process.cwd(),
    env: process.env,
    platform,
  };
  vm.runInNewContext(source, {
    Buffer,
    URL,
    __dirname: electronDirectory,
    __filename: mainPath,
    clearTimeout,
    console,
    Date,
    exports: module.exports,
    module,
    process: runtimeProcess,
    require: mockedRequire,
    setTimeout,
  });

  appEvents.get("ready")?.();

  return {
    app,
    appEvents,
    createWorkspaceDocument,
    restoreDocument,
    writeOpenWindows,
    writeWindowState: windowState.writeWindowState,
    watcherClose,
    applicationMenu: () => applicationMenu,
    ipcHandlers,
    ipcListeners,
    initializeWorkspace,
    listDocuments,
    readDocument,
    readWorkspaceMetadataOrDefault,
    showOpenDialog,
    sentChanges,
    sentChannels,
    watcherCallbacks,
    windows: FakeBrowserWindow.instances,
    writeWorkspacePath,
    writeDocument,
    writeDocumentSync,
  };
};

const getViewMenuRoles = (harness: MainHarness) => {
  const viewMenu = harness
    .applicationMenu()
    .find(
      (item) =>
        typeof item === "object" && item !== null && "label" in item && item.label === "View",
    ) as { submenu?: Array<{ role?: string }> } | undefined;
  return viewMenu?.submenu?.map((item) => item.role).filter(Boolean) ?? [];
};

const getFileMenuItems = (harness: MainHarness) => {
  const fileMenu = harness
    .applicationMenu()
    .find(
      (item) =>
        typeof item === "object" && item !== null && "label" in item && item.label === "File",
    ) as
    | {
        submenu?: Array<{
          accelerator?: string;
          click?: (...arguments_: unknown[]) => void;
          label?: string;
          role?: string;
          type?: string;
        }>;
      }
    | undefined;
  return fileMenu?.submenu ?? [];
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Electron persistence safety", () => {
  const hiddenLayout: WindowLayout = {
    sidebarCollapsed: true,
    sidebarWidth: 280,
    sectionExpanded: { Reports: true, People: false },
  };
  const visibleLayout: WindowLayout = {
    sidebarCollapsed: false,
    sidebarWidth: 450,
    sectionExpanded: { Reports: false, People: true },
  };
  const newWindow = (harness: MainHarness, source = harness.windows[0]) => {
    getFileMenuItems(harness)
      .find((item) => item.label === "New Window")
      ?.click?.({}, source);
    return harness.windows.at(-1)!;
  };
  const updateView = (
    harness: MainHarness,
    window: MainHarness["windows"][number],
    layout: WindowLayout,
    activePath = "docs/todo.md",
  ) => {
    harness.ipcListeners.get("meetings:window-state")?.(
      { sender: window.webContents },
      { layout, activePath },
    );
  };
  const readLayout = (harness: MainHarness, window: MainHarness["windows"][number]) => {
    const event = { sender: window.webContents, returnValue: undefined };
    harness.ipcListeners.get("meetings:window-layout")?.(event);
    return event.returnValue;
  };
  const closeWindow = (harness: MainHarness, window: MainHarness["windows"][number]) => {
    window.handlers.get("close")?.();
    window.handlers.get("closed")?.();
    harness.windows.splice(harness.windows.indexOf(window), 1);
  };
  const savedSessions = (harness: MainHarness) =>
    harness.writeOpenWindows.mock.results.at(-1)!.value as WindowSession[];

  test("new windows copy the focused layout immediately and then remember changes independently", () => {
    const harness = loadMainHarness("darwin");
    const first = harness.windows[0]!;
    updateView(harness, first, hiddenLayout);
    const second = newWindow(harness);
    expect(readLayout(harness, second)).toEqual(hiddenLayout);
    updateView(harness, second, visibleLayout);
    expect(readLayout(harness, first)).toEqual(hiddenLayout);
    expect(readLayout(harness, second)).toEqual(visibleLayout);
    expect(readLayout(harness, newWindow(harness, first))).toEqual(hiddenLayout);
  });

  test("quitting restores all open windows with their own notes, layouts, and positions", () => {
    const harness = loadMainHarness("darwin");
    const first = harness.windows[0]!;
    const second = newWindow(harness);
    updateView(harness, first, hiddenLayout, "docs/first.md");
    updateView(harness, second, visibleLayout, "docs/second.md");
    first.bounds = { height: 850, width: 680, x: 20, y: 50 };
    second.bounds = { height: 900, width: 710, x: 740, y: 60 };
    harness.appEvents.get("before-quit")?.();
    closeWindow(harness, first);
    closeWindow(harness, second);
    harness.appEvents.get("window-all-closed")?.();
    expect(harness.app.quit).toHaveBeenCalled();
    // The final quit after delayed save flushes must not replace the session with an empty list.
    harness.appEvents.get("before-quit")?.();
    harness.appEvents.get("will-quit")?.();
    const restarted = loadMainHarness("darwin", true, savedSessions(harness));
    expect(restarted.windows).toHaveLength(2);
    expect(readLayout(restarted, restarted.windows[0]!)).toEqual(hiddenLayout);
    expect(readLayout(restarted, restarted.windows[1]!)).toEqual(visibleLayout);
    expect(restarted.windows[0]!.options).toMatchObject(first.bounds);
    expect(restarted.windows[1]!.options).toMatchObject(second.bounds);
    expect(restarted.windows[0]!.loadURL).toHaveBeenCalledWith(
      expect.stringContaining("#/docs/first.md"),
    );
    expect(restarted.windows[1]!.loadURL).toHaveBeenCalledWith(
      expect.stringContaining("#/docs/second.md"),
    );
  });

  test("closing every window uses the last closed layout even when another window changed settings last", () => {
    const harness = loadMainHarness("darwin");
    const first = harness.windows[0]!;
    const second = newWindow(harness);
    updateView(harness, first, hiddenLayout);
    updateView(harness, second, visibleLayout);
    closeWindow(harness, second);
    closeWindow(harness, first);
    expect(savedSessions(harness)).toEqual([]);
    const savedDefault = harness.writeWindowState.mock.calls.at(-1)![0];
    expect(savedDefault.layout).toEqual(hiddenLayout);
    const restarted = loadMainHarness("darwin", true, [], savedDefault);
    expect(readLayout(restarted, restarted.windows[0]!)).toEqual(hiddenLayout);
    harness.appEvents.get("activate")?.();
    expect(readLayout(harness, harness.windows[0]!)).toEqual(hiddenLayout);
  });

  test("a manually closed window stays excluded when the remaining window quits", () => {
    const harness = loadMainHarness("darwin");
    const first = harness.windows[0]!;
    const second = newWindow(harness);
    updateView(harness, second, visibleLayout);
    closeWindow(harness, first);
    harness.appEvents.get("before-quit")?.();
    closeWindow(harness, second);
    expect(savedSessions(harness)).toHaveLength(1);
    expect(savedSessions(harness)[0]!.layout).toEqual(visibleLayout);
  });

  test("an unresolved save cancels quitting and a subsequent manual close stays closed", () => {
    const harness = loadMainHarness("darwin");
    const first = harness.windows[0]!;
    harness.appEvents.get("before-quit")?.();
    first.handlers.get("close")?.();
    expect(harness.writeWindowState).not.toHaveBeenCalled();
    harness.ipcListeners.get("meetings:cancel-close")?.({ sender: first.webContents });
    closeWindow(harness, first);
    expect(savedSessions(harness)).toEqual([]);
  });

  test("layout and geometry changes persist without waiting for a close", async () => {
    vi.useFakeTimers();
    const harness = loadMainHarness("darwin");
    const first = harness.windows[0]!;
    first.bounds = { height: 750, width: 800, x: 80, y: 40 };
    first.handlers.get("resize")?.();
    updateView(harness, first, visibleLayout, "docs/current.md");
    await vi.advanceTimersByTimeAsync(100);
    expect(savedSessions(harness)[0]).toMatchObject({
      bounds: first.bounds,
      layout: visibleLayout,
      activePath: "docs/current.md",
    });
    expect(harness.writeWindowState).not.toHaveBeenCalled();
  });

  test("honors an explicit workspace while retaining crashed windows for recovery", async () => {
    vi.stubEnv("NOTES_WORKSPACE", "/tmp/explicit-notes");
    try {
      const harness = loadMainHarness("darwin", true, [
        { recoveryId: "primary", workspaceRoot: "/tmp/recovery-notes" },
      ]);
      expect(harness.windows).toHaveLength(2);
      await expect(
        harness.ipcHandlers.get("meetings:load-workspace")?.({
          sender: harness.windows[1]!.webContents,
        }),
      ).resolves.toMatchObject({ workspacePath: "/tmp/explicit-notes" });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("Command+N opens an independent window on the same note and workspace", async () => {
    const harness = loadMainHarness("darwin");
    const newWindow = getFileMenuItems(harness).find((item) => item.label === "New Window");
    expect(newWindow?.accelerator).toBe("CommandOrControl+N");
    newWindow?.click?.({}, harness.windows[0]);

    expect(harness.windows).toHaveLength(2);
    const second = harness.windows[1]!;
    expect(second.loadURL).toHaveBeenCalledWith(expect.stringContaining("#/docs/todo.md"));
    await expect(
      harness.ipcHandlers.get("meetings:load-workspace")?.({ sender: second.webContents }),
    ).resolves.toMatchObject({ workspacePath: "/tmp/notes-workspace" });
    expect(harness.watcherCallbacks).toHaveLength(2);
    expect(second.handlers.has("close")).toBe(true);
    expect(second.webContents.setWindowOpenHandler).toHaveBeenCalledOnce();
  });

  test("New Window also works after the last macOS window closes", () => {
    const harness = loadMainHarness("darwin");
    harness.windows[0]!.handlers.get("closed")?.();
    harness.windows.splice(0);
    getFileMenuItems(harness)
      .find((item) => item.label === "New Window")
      ?.click?.({}, undefined);
    expect(harness.windows).toHaveLength(1);
  });

  test.each([false, true])(
    "publishes a save to peer windows only (lifecycle: %s)",
    async (sync) => {
      const harness = loadMainHarness("darwin");
      const first = harness.windows[0]!;
      getFileMenuItems(harness)
        .find((item) => item.label === "New Window")
        ?.click?.({}, first);
      const second = harness.windows[1]!;
      const document = { content: "Updated\n", hash: "updated", mtimeMs: 2, path: "docs/todo.md" };
      harness.writeDocument.mockResolvedValue(document);
      harness.writeDocumentSync.mockReturnValue(document);
      const request = { baseHash: "old", content: document.content, path: document.path };
      if (sync) {
        harness.ipcListeners.get("meetings:save-document-sync")?.(
          { sender: first.webContents },
          request,
        );
      } else {
        await harness.ipcHandlers.get("meetings:save-document")?.(
          { sender: first.webContents },
          request,
        );
      }
      expect(first.webContents.send).not.toHaveBeenCalled();
      expect(second.webContents.send).toHaveBeenCalledExactlyOnceWith("meetings:document-change", {
        deleted: false,
        document,
        path: document.path,
      });
    },
  );

  test.each(["create", "restore"])("publishes %s operations to peer windows", async (operation) => {
    const harness = loadMainHarness("darwin");
    const first = harness.windows[0]!;
    getFileMenuItems(harness)
      .find((item) => item.label === "New Window")
      ?.click?.({}, first);
    const document = { content: "Created\n", hash: "created", mtimeMs: 2, path: "docs/new.md" };
    harness.createWorkspaceDocument.mockResolvedValue(document);
    harness.restoreDocument.mockResolvedValue(document);
    await harness.ipcHandlers.get(`meetings:${operation}-document`)?.(
      { sender: first.webContents },
      {},
    );
    expect(harness.windows[1]!.webContents.send).toHaveBeenCalledWith("meetings:document-change", {
      deleted: false,
      document,
      path: document.path,
    });
    expect(first.webContents.send).not.toHaveBeenCalled();
  });

  test("switching one window's workspace leaves other windows and writes isolated", async () => {
    const harness = loadMainHarness("darwin");
    const first = harness.windows[0]!;
    const newWindow = getFileMenuItems(harness).find((item) => item.label === "New Window");
    newWindow?.click?.({}, first);
    const second = harness.windows[1]!;
    harness.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ["/tmp/other-notes"] });
    await harness.ipcHandlers.get("meetings:choose-workspace")?.({ sender: second.webContents });
    const document = { content: "Updated\n", hash: "updated", mtimeMs: 2, path: "docs/todo.md" };
    harness.writeDocument.mockResolvedValue(document);
    await harness.ipcHandlers.get("meetings:save-document")?.(
      { sender: first.webContents },
      {
        baseHash: "old",
        content: document.content,
        path: document.path,
      },
    );
    expect(harness.writeDocument).toHaveBeenCalledWith(
      expect.objectContaining({ root: "/tmp/notes-workspace" }),
    );
    expect(second.webContents.send).not.toHaveBeenCalled();
    newWindow?.click?.({}, second);
    await expect(
      harness.ipcHandlers.get("meetings:load-workspace")?.({
        sender: harness.windows[2]!.webContents,
      }),
    ).resolves.toMatchObject({ workspacePath: "/tmp/other-notes" });
  });

  test("restores each crashed window's recovery identity and removes only fully closed windows", () => {
    const sessions = [
      { recoveryId: "primary", workspaceRoot: "/tmp/notes-workspace" },
      { recoveryId: "12345678-1234-1234-1234-123456789abc", workspaceRoot: "/tmp/notes-workspace" },
    ];
    const harness = loadMainHarness("darwin", true, sessions);
    expect(harness.windows).toHaveLength(2);
    const keys = harness.windows.map((window) => {
      const event = { sender: window.webContents, returnValue: undefined };
      harness.ipcListeners.get("meetings:recovery-key")?.(event);
      return event.returnValue;
    });
    expect(keys[0]).toBe("notes.current-draft.v1");
    expect(keys[1]).toContain(sessions[1]!.recoveryId);
    harness.windows[1]!.handlers.get("close")?.();
    expect(harness.writeOpenWindows).toHaveBeenLastCalledWith(
      sessions.map((session) => expect.objectContaining(session)),
      expect.any(String),
    );
    harness.windows[1]!.handlers.get("closed")?.();
    expect(harness.writeOpenWindows).toHaveBeenLastCalledWith(
      [expect.objectContaining(sessions[0]!)],
      expect.any(String),
    );
  });

  test("a blocked quit keeps watching documents until the app actually quits", () => {
    const harness = loadMainHarness("darwin");
    harness.appEvents.get("before-quit")?.();
    expect(harness.watcherClose).not.toHaveBeenCalled();
    harness.appEvents.get("will-quit")?.();
    expect(harness.watcherClose).toHaveBeenCalled();
  });

  test("allows the desktop window to resize to a compact width", () => {
    const harness = loadMainHarness("darwin");

    expect(harness.windows[0]?.options.minWidth).toBe(320);
  });

  test("maps Command+W to closing the current window", () => {
    const harness = loadMainHarness("darwin");

    expect(getFileMenuItems(harness)).toContainEqual({
      accelerator: "CommandOrControl+W",
      role: "close",
    });
  });

  test("requests a workspace picker from File → Open Workspace", () => {
    const harness = loadMainHarness("darwin");
    const openWorkspace = getFileMenuItems(harness).find(
      (item) => item.label === "Open Workspace…",
    );

    expect(openWorkspace?.accelerator).toBe("CommandOrControl+O");
    openWorkspace?.click?.({}, harness.windows[0]);
    expect(harness.sentChannels).toContain("meetings:choose-workspace-requested");
  });

  test("initializes and persists a workspace selected by the renderer", async () => {
    const harness = loadMainHarness("darwin");
    harness.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ["/tmp/selected-notes"],
    });
    const window = harness.windows[0]!;

    await expect(
      harness.ipcHandlers.get("meetings:choose-workspace")?.({
        sender: window.webContents,
      }),
    ).resolves.toEqual({
      canceled: false,
      workspacePath: "/tmp/selected-notes",
    });
    expect(harness.initializeWorkspace).toHaveBeenCalledWith("/tmp/selected-notes");
    expect(harness.writeWorkspacePath).toHaveBeenCalledWith("/tmp/selected-notes");
  });

  test("keeps the macOS app running after its last window closes and recreates it on activation", () => {
    const harness = loadMainHarness("darwin");
    harness.windows.splice(0);

    harness.appEvents.get("window-all-closed")?.();
    expect(harness.app.quit).not.toHaveBeenCalled();

    harness.appEvents.get("activate")?.();
    expect(harness.windows).toHaveLength(1);
  });

  test("opens the first-run window instead of quitting when no workspace exists", async () => {
    const harness = loadMainHarness("darwin", false);

    expect(harness.windows).toHaveLength(1);
    expect(harness.app.quit).not.toHaveBeenCalled();
    await expect(
      harness.ipcHandlers.get("meetings:load-workspace")?.({
        sender: harness.windows[0]!.webContents,
      }),
    ).resolves.toEqual({
      documents: [],
      metadataError: null,
      peoplePaths: [],
      workspacePath: null,
    });
  });

  test("still quits after the last window closes on other platforms", () => {
    const harness = loadMainHarness("linux");

    harness.appEvents.get("window-all-closed")?.();

    expect(harness.app.quit).toHaveBeenCalledOnce();
  });

  test("uses the asynchronous writer for ordinary autosaves", async () => {
    const harness = loadMainHarness();
    const savedDocument: StoredDocument = {
      content: "Newest text\n",
      hash: "newest",
      mtimeMs: 2,
      path: "docs/todo.md",
    };
    harness.writeDocument.mockResolvedValue(savedDocument);

    await expect(
      harness.ipcHandlers.get("meetings:save-document")?.(
        { sender: harness.windows[0]!.webContents },
        {
          baseHash: "old",
          content: savedDocument.content,
          path: savedDocument.path,
        },
      ),
    ).resolves.toEqual({ document: savedDocument, status: "saved" });
    expect(harness.writeDocument).toHaveBeenCalledOnce();
    expect(harness.writeDocumentSync).not.toHaveBeenCalled();
  });

  test("does not treat an older in-flight autosave as permission to close", async () => {
    vi.useFakeTimers();
    const harness = loadMainHarness();
    const window = harness.windows[0]!;
    const savedDocument: StoredDocument = {
      content: "Newest text\n",
      hash: "newest",
      mtimeMs: 2,
      path: "docs/todo.md",
    };
    harness.writeDocument.mockResolvedValue(savedDocument);
    window.handlers.get("close")?.();

    await harness.ipcHandlers.get("meetings:save-document")?.(
      { sender: window.webContents },
      {
        baseHash: "old",
        content: savedDocument.content,
        path: savedDocument.path,
      },
    );
    await vi.runAllTimersAsync();

    expect(harness.sentChannels).not.toContain("meetings:retry-close");
  });

  test("retries closing only after the renderer confirms its full flush", () => {
    const harness = loadMainHarness();
    const window = harness.windows[0]!;
    window.handlers.get("close")?.();

    harness.ipcListeners.get("meetings:close-ready")?.({
      sender: window.webContents,
    });

    expect(harness.sentChannels).toContain("meetings:retry-close");
  });

  test("does not access destroyed web contents after a window closes", () => {
    const harness = loadMainHarness();
    const window = harness.windows[0]!;
    window.handlers.get("close")?.();
    window.destroyWebContents();

    expect(() => window.handlers.get("closed")?.()).not.toThrow();
  });

  test("explains why closing remains blocked after a save failure", () => {
    const harness = loadMainHarness();
    const window = harness.windows[0]!;
    harness.writeDocumentSync.mockImplementation(() => {
      throw new Error("disk full");
    });
    window.handlers.get("close")?.();
    const event = { returnValue: undefined, sender: window.webContents };

    harness.ipcListeners.get("meetings:save-document-sync")?.(event, {
      baseHash: "old",
      content: "Newest text\n",
      keepalive: true,
      path: "docs/todo.md",
    });

    expect(harness.sentChannels).toContain("meetings:close-blocked");
    expect(harness.sentChanges).toEqual([expect.stringContaining("disk full")]);
  });

  test("loads the people registry from the external workspace with the documents", async () => {
    const harness = loadMainHarness();
    harness.listDocuments.mockResolvedValue([
      {
        content: "# Tom\n",
        hash: "tom",
        mtimeMs: 1,
        path: "people/33-riley-example.md",
      },
    ]);
    harness.readWorkspaceMetadataOrDefault.mockResolvedValue({
      metadataError: null,
      peoplePaths: ["people/33-riley-example.md"],
    });

    await expect(
      harness.ipcHandlers.get("meetings:load-workspace")?.({
        sender: harness.windows[0]!.webContents,
      }),
    ).resolves.toEqual({
      documents: [
        {
          content: "# Tom\n",
          hash: "tom",
          mtimeMs: 1,
          path: "people/33-riley-example.md",
        },
      ],
      metadataError: null,
      peoplePaths: ["people/33-riley-example.md"],
      workspacePath: "/tmp/notes-workspace",
    });
  });

  test("does not override the renderer when beforeunload blocks a reload with unsaved text", () => {
    const harness = loadMainHarness();
    const unloadHandler = harness.windows[0]?.webContents.handlers.get("will-prevent-unload");
    const event = { preventDefault: vi.fn() };

    unloadHandler?.(event);

    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  test("never bypasses a later beforeunload based on an earlier save", () => {
    const harness = loadMainHarness();
    const window = harness.windows[0]!;
    expect(window.webContents.handlers.has("will-prevent-unload")).toBe(false);
  });

  test("keeps a closing window blocked when its lifecycle save fails", () => {
    const harness = loadMainHarness();
    const window = harness.windows[0]!;
    harness.writeDocumentSync.mockImplementation(() => {
      throw new Error("disk full");
    });
    window.handlers.get("close")?.();

    const saveEvent = {
      returnValue: undefined,
      sender: window.webContents,
    };
    harness.ipcListeners.get("meetings:save-document-sync")?.(saveEvent, {
      baseHash: "old",
      content: "Newest text\n",
      keepalive: true,
      path: "docs/todo.md",
    });
    const unloadEvent = { preventDefault: vi.fn() };
    window.webContents.handlers.get("will-prevent-unload")?.(unloadEvent);

    expect(saveEvent.returnValue).toEqual({
      error: "Error: disk full",
      status: "error",
    });
    expect(unloadEvent.preventDefault).not.toHaveBeenCalled();
  });

  test("does not expose force reload because it bypasses all renderer save guards", () => {
    const harness = loadMainHarness();

    expect(getViewMenuRoles(harness)).not.toContain("forceReload");
  });

  test("never republishes an app-originated write as an external change when its watcher read is delayed", async () => {
    vi.useFakeTimers();
    const harness = loadMainHarness();
    const savedDocument: StoredDocument = {
      content: "Local edit\n",
      hash: createHash("sha256").update("Local edit\n").digest("hex"),
      mtimeMs: 1,
      path: "docs/todo.md",
    };
    harness.writeDocument.mockResolvedValue(savedDocument);
    const save = harness.ipcHandlers.get("meetings:save-document");
    await save?.(
      { sender: harness.windows[0]!.webContents },
      {
        baseHash: "old",
        content: savedDocument.content,
        path: savedDocument.path,
      },
    );

    const watcherRead = createDeferred<StoredDocument>();
    harness.readDocument.mockReturnValueOnce(watcherRead.promise);
    harness.watcherCallbacks[0]?.("rename", "todo.md");
    await vi.advanceTimersByTimeAsync(40);
    await vi.advanceTimersByTimeAsync(1_600);
    watcherRead.resolve(savedDocument);
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.sentChanges).toEqual([]);
  });

  test("defers watcher events until an app-originated write is registered", async () => {
    vi.useFakeTimers();
    const harness = loadMainHarness();
    const savedDocument: StoredDocument = {
      content: "Local edit\n",
      hash: "local-edit",
      mtimeMs: 1,
      path: "docs/todo.md",
    };
    const pendingWrite = createDeferred<StoredDocument>();
    harness.writeDocument.mockReturnValue(pendingWrite.promise);
    harness.readDocument.mockResolvedValue(savedDocument);

    const savePromise = harness.ipcHandlers.get("meetings:save-document")?.(
      { sender: harness.windows[0]!.webContents },
      {
        baseHash: "old",
        content: savedDocument.content,
        path: savedDocument.path,
      },
    );
    harness.watcherCallbacks[0]?.("rename", "todo.md");
    await vi.advanceTimersByTimeAsync(40);

    expect(harness.readDocument).not.toHaveBeenCalled();

    pendingWrite.resolve(savedDocument);
    await savePromise;
    await vi.advanceTimersByTimeAsync(40);
    await Promise.resolve();

    expect(harness.sentChanges).toEqual([]);
  });

  test("recognizes a self-write regardless of how late its notification arrives", async () => {
    vi.useFakeTimers();
    const harness = loadMainHarness();
    const savedDocument: StoredDocument = {
      content: "Local edit\n",
      hash: "local-edit",
      mtimeMs: 1,
      path: "docs/todo.md",
    };
    harness.writeDocument.mockResolvedValue(savedDocument);
    harness.readDocument.mockResolvedValue(savedDocument);
    await harness.ipcHandlers.get("meetings:save-document")?.(
      { sender: harness.windows[0]!.webContents },
      {
        baseHash: "old",
        content: savedDocument.content,
        path: savedDocument.path,
      },
    );

    await vi.advanceTimersByTimeAsync(2_500);
    harness.watcherCallbacks[0]?.("rename", "todo.md");
    await vi.advanceTimersByTimeAsync(40);
    await Promise.resolve();

    expect(harness.sentChanges).toEqual([]);
  });

  test.each([1, 7, 23, 89, 511, 2026, 8191, 65537])(
    "randomized watcher reads never publish our own saves (seed %i)",
    async (seed) => {
      vi.useFakeTimers();
      const random = () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 0x100000000;
      };
      const delay = (maximum: number) => new Promise<void>((resolve) =>
        setTimeout(resolve, Math.floor(random() * maximum)),
      );
      const harness = loadMainHarness();
      let disk: StoredDocument = { content: "Original\n", hash: "initial", mtimeMs: 1, path: "docs/todo.md" };
      const notify = () => harness.watcherCallbacks[0]?.("rename", random() < 0.2 ? null : "todo.md");
      harness.readDocument.mockImplementation(async () => {
        const snapshot = disk;
        await delay(1_500);
        return snapshot;
      });
      harness.listDocuments.mockImplementation(async () => {
        const snapshot = disk;
        await delay(750);
        return [snapshot];
      });
      harness.writeDocument.mockImplementation(async ({ baseHash, content }) => {
        await delay(200);
        expect(baseHash).toBe(disk.hash);
        disk = { ...disk, content, hash: content, mtimeMs: disk.mtimeMs + 1 };
        notify();
        await delay(500);
        return disk;
      });
      const save = harness.ipcHandlers.get("meetings:save-document")!;
      const sender = harness.windows[0]!.webContents;
      // Prime a committed version before allowing old read snapshots to race.
      const first = save({ sender }, { baseHash: disk.hash, content: "First\n", path: disk.path });
      await vi.advanceTimersByTimeAsync(2_000);
      await first;
      for (let edit = 0; edit < 300; edit++) {
        notify();
        await vi.advanceTimersByTimeAsync(Math.floor(random() * 150));
        const pending = save({ sender }, { baseHash: disk.hash, content: `Edit ${edit}\n`, path: disk.path });
        notify();
        await vi.advanceTimersByTimeAsync(1_000 + Math.floor(random() * 500));
        expect(await pending).toMatchObject({ status: "saved" });
        expect(harness.sentChanges, `edit ${edit}`).toEqual([]);
      }
      await vi.advanceTimersByTimeAsync(5_000);
      expect(harness.sentChanges).toEqual([]);
      // The same watcher must still publish a real external replacement.
      disk = { ...disk, content: "External edit\n", hash: "external" };
      notify();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(harness.sentChanges).toEqual([expect.objectContaining({ document: disk })]);
    },
    30_000,
  );

  test("reconciles the workspace when fs.watch omits the filename", async () => {
    const harness = loadMainHarness();
    const document: StoredDocument = {
      content: "Found by rescan\n",
      hash: "rescan",
      mtimeMs: 2,
      path: "docs/todo.md",
    };
    harness.listDocuments.mockResolvedValue([document]);
    harness.readDocument.mockResolvedValue(document);

    harness.watcherCallbacks[0]?.("change", null);
    await vi.waitFor(() => {
      expect(JSON.parse(JSON.stringify(harness.sentChanges))).toContainEqual({
        deleted: false,
        document,
        path: document.path,
      });
    });
  });

  test("never delivers an older watcher read after a newer document version", async () => {
    vi.useFakeTimers();
    const harness = loadMainHarness();
    const olderRead = createDeferred<StoredDocument>();
    const newerRead = createDeferred<StoredDocument>();
    harness.readDocument
      .mockReturnValueOnce(olderRead.promise)
      .mockReturnValueOnce(newerRead.promise);

    harness.watcherCallbacks[0]?.("change", "todo.md");
    await vi.advanceTimersByTimeAsync(40);
    harness.watcherCallbacks[0]?.("change", "todo.md");
    await vi.advanceTimersByTimeAsync(40);

    newerRead.resolve({
      content: "Newer text\n",
      hash: "newer",
      mtimeMs: 2,
      path: "docs/todo.md",
    });
    await Promise.resolve();
    await Promise.resolve();
    olderRead.resolve({
      content: "Older text\n",
      hash: "older",
      mtimeMs: 1,
      path: "docs/todo.md",
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.sentChanges).toEqual([
      expect.objectContaining({
        document: expect.objectContaining({ hash: "newer" }),
      }),
    ]);
  });

  test("publishes live workspace grouping changes without an app rebuild", async () => {
    vi.useFakeTimers();
    const harness = loadMainHarness();
    const document = {
      content: "# Tom\n",
      hash: "tom",
      mtimeMs: 1,
      path: "people/33-riley-example.md",
    };
    harness.listDocuments.mockResolvedValue([document]);
    harness.readWorkspaceMetadataOrDefault.mockResolvedValue({
      metadataError: null,
      peoplePaths: ["people/33-riley-example.md"],
    });

    harness.watcherCallbacks[1]?.("change", "people.json");
    await vi.advanceTimersByTimeAsync(40);
    await Promise.resolve();

    expect(harness.sentChanges).toContainEqual({
      metadata: { peoplePaths: ["people/33-riley-example.md"] },
    });
  });
});
