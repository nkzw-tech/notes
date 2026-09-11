// @ts-check

const { existsSync, watch } = require("node:fs");
const { basename, dirname, join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  screen,
  shell,
} = require("electron");
const squirrelStartup = require("electron-squirrel-startup");
const {
  DOCUMENT_DIRECTORIES,
  DocumentConflictError,
  createWorkspaceDocument,
  deleteDocument,
  deleteInterview,
  formatDocumentContent,
  isWorkspaceRoot,
  listDocuments,
  normalizeDocumentPath,
  readDocument,
  restoreDocument,
  writeDocument,
  writeDocumentSync,
} = require("./document-service.cjs");
const {
  readWorkspaceMetadataOrDefault,
  reconcileWorkspaceMetadataPaths,
  WORKSPACE_METADATA_PATH,
} = require("./workspace-metadata.cjs");
const {
  readWindowState,
  validateWindowStateOnScreen,
  writeWindowState,
} = require("./window-state.cjs");
const {
  initializeWorkspace,
  readWorkspacePath,
  writeWorkspacePath,
} = require("./workspace-config.cjs");

const appRoot = dirname(__dirname);
const expectedWriteHashes = new Map();
const expectedWriteTimers = new Map();
const pendingChanges = new Map();
const changeGenerations = new Map();
const knownDocumentHashes = new Map();
const activeDocumentWrites = new Map();
const documentWriteGenerations = new Map();
const workspaceWatchers = [];
const closingWindowIds = new Set();
let workspaceRoot = "";
let metadataChangeGeneration = 0;
let pendingMetadataChange = null;

/** @param {string} path @param {string} hash */
const rememberWriteHash = (path, hash) => {
  const previousTimer = expectedWriteTimers.get(path);
  if (previousTimer) {
    clearTimeout(previousTimer);
  }
  expectedWriteHashes.set(path, hash);
  expectedWriteTimers.set(
    path,
    setTimeout(() => {
      if (expectedWriteHashes.get(path) === hash) {
        expectedWriteHashes.delete(path);
      }
      expectedWriteTimers.delete(path);
    }, 2_000),
  );
};

/** @param {string} path @param {string} hash */
const consumeExpectedWrite = (path, hash) => {
  const expectedHash = expectedWriteHashes.get(path);
  if (expectedHash === undefined) {
    return false;
  }
  expectedWriteHashes.delete(path);
  const timer = expectedWriteTimers.get(path);
  if (timer) {
    clearTimeout(timer);
    expectedWriteTimers.delete(path);
  }
  return expectedHash === hash;
};

/** @param {{hash: string; path: string}} document */
const rememberWrite = (document) => {
  rememberWriteHash(document.path, document.hash);
  knownDocumentHashes.set(document.path, document.hash);
};

/** @param {string} path */
const beginDocumentWrite = (path) => {
  activeDocumentWrites.set(path, (activeDocumentWrites.get(path) ?? 0) + 1);
  documentWriteGenerations.set(path, (documentWriteGenerations.get(path) ?? 0) + 1);
};

/** @param {string} path */
const endDocumentWrite = (path) => {
  const remainingWrites = (activeDocumentWrites.get(path) ?? 1) - 1;
  if (remainingWrites > 0) {
    activeDocumentWrites.set(path, remainingWrites);
  } else {
    activeDocumentWrites.delete(path);
  }
};

/** @param {unknown} error */
const errorMessage = (error) => (error instanceof Error ? error.message : String(error));

/** @param {string} path */
const publishDocumentChange = async (path, generation) => {
  if (activeDocumentWrites.has(path)) {
    scheduleDocumentChange(path);
    return;
  }
  const writeGeneration = documentWriteGenerations.get(path) ?? 0;
  try {
    const document = await readDocument(workspaceRoot, path);
    if (changeGenerations.get(path) !== generation) {
      return;
    }
    if (
      activeDocumentWrites.has(path) ||
      (documentWriteGenerations.get(path) ?? 0) !== writeGeneration
    ) {
      scheduleDocumentChange(path);
      return;
    }
    if (knownDocumentHashes.get(path) === document.hash) {
      consumeExpectedWrite(path, document.hash);
      return;
    }
    if (consumeExpectedWrite(path, document.hash)) {
      knownDocumentHashes.set(path, document.hash);
      return;
    }
    knownDocumentHashes.set(path, document.hash);
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send("meetings:document-change", {
          deleted: false,
          document,
          path,
        });
      }
    }
  } catch (error) {
    if (changeGenerations.get(path) !== generation) {
      return;
    }
    if (
      activeDocumentWrites.has(path) ||
      (documentWriteGenerations.get(path) ?? 0) !== writeGeneration
    ) {
      scheduleDocumentChange(path);
      return;
    }
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT") {
      console.error(`Failed to publish Markdown change for ${path}: ${errorMessage(error)}`);
      return;
    }
    knownDocumentHashes.delete(path);
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send("meetings:document-change", {
          deleted: true,
          path,
        });
      }
    }
  }
};

const reconcileWorkspaceDocuments = async () => {
  try {
    const documents = await listDocuments(workspaceRoot);
    const currentPaths = new Set(documents.map(({ path }) => path));
    for (const document of documents) {
      if (knownDocumentHashes.get(document.path) === document.hash) {
        continue;
      }
      const generation = (changeGenerations.get(document.path) ?? 0) + 1;
      changeGenerations.set(document.path, generation);
      await publishDocumentChange(document.path, generation);
    }
    for (const path of knownDocumentHashes.keys()) {
      if (!currentPaths.has(path)) {
        const generation = (changeGenerations.get(path) ?? 0) + 1;
        changeGenerations.set(path, generation);
        await publishDocumentChange(path, generation);
      }
    }
  } catch (error) {
    console.error(`Failed to reconcile Markdown files: ${errorMessage(error)}`);
  }
};

/** @param {string} path */
const scheduleDocumentChange = (path) => {
  const normalizedPath = normalizeDocumentPath(path);
  if (!normalizedPath) {
    return;
  }
  const generation = (changeGenerations.get(normalizedPath) ?? 0) + 1;
  changeGenerations.set(normalizedPath, generation);
  const existing = pendingChanges.get(normalizedPath);
  if (existing) {
    clearTimeout(existing);
  }
  pendingChanges.set(
    normalizedPath,
    setTimeout(() => {
      pendingChanges.delete(normalizedPath);
      void publishDocumentChange(normalizedPath, generation);
    }, 40),
  );
};

const publishWorkspaceMetadataChange = async (generation) => {
  let change;
  try {
    const [documents, metadata] = await Promise.all([
      listDocuments(workspaceRoot),
      readWorkspaceMetadataOrDefault(workspaceRoot),
    ]);
    const reconciled = reconcileWorkspaceMetadataPaths(
      metadata,
      new Set(documents.map(({ path }) => path)),
    );
    change = {
      ...(reconciled.metadataError ? { error: reconciled.metadataError } : {}),
      metadata: { peoplePaths: reconciled.peoplePaths },
    };
  } catch (error) {
    change = {
      error: `Failed to load ${WORKSPACE_METADATA_PATH}: ${errorMessage(error)}`,
    };
  }
  if (metadataChangeGeneration !== generation) {
    return;
  }
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send("meetings:workspace-metadata-change", change);
    }
  }
};

const scheduleWorkspaceMetadataChange = () => {
  metadataChangeGeneration += 1;
  const generation = metadataChangeGeneration;
  if (pendingMetadataChange) {
    clearTimeout(pendingMetadataChange);
  }
  pendingMetadataChange = setTimeout(() => {
    pendingMetadataChange = null;
    void publishWorkspaceMetadataChange(generation);
  }, 40);
};

const startWorkspaceWatchers = () => {
  if (!workspaceRoot) {
    return;
  }
  for (const directory of DOCUMENT_DIRECTORIES) {
    const directoryPath = resolve(workspaceRoot, directory);
    if (!existsSync(directoryPath)) {
      continue;
    }
    const watcher = watch(directoryPath, { persistent: false }, (_eventType, filename) => {
      if (filename) {
        scheduleDocumentChange(`${directory}/${String(filename)}`);
      } else {
        void reconcileWorkspaceDocuments();
      }
    });
    watcher.on("error", (error) => {
      console.error(`Failed to watch ${directoryPath}: ${errorMessage(error)}`);
      void reconcileWorkspaceDocuments();
    });
    workspaceWatchers.push(watcher);
  }

  const metadataDirectory = resolve(workspaceRoot, dirname(WORKSPACE_METADATA_PATH));
  if (existsSync(metadataDirectory)) {
    const watcher = watch(metadataDirectory, { persistent: false }, (_eventType, filename) => {
      if (filename === null || String(filename) === basename(WORKSPACE_METADATA_PATH)) {
        scheduleWorkspaceMetadataChange();
      }
    });
    watcher.on("error", (error) => {
      console.error(`Failed to watch ${metadataDirectory}: ${errorMessage(error)}`);
      void publishWorkspaceMetadataChange(++metadataChangeGeneration);
    });
    workspaceWatchers.push(watcher);
  }
};

const stopWorkspaceWatchers = () => {
  for (const watcher of workspaceWatchers.splice(0)) {
    watcher.close();
  }
  for (const timer of pendingChanges.values()) {
    clearTimeout(timer);
  }
  pendingChanges.clear();
  changeGenerations.clear();
  expectedWriteHashes.clear();
  for (const timer of expectedWriteTimers.values()) {
    clearTimeout(timer);
  }
  expectedWriteTimers.clear();
  knownDocumentHashes.clear();
  activeDocumentWrites.clear();
  documentWriteGenerations.clear();
  if (pendingMetadataChange) {
    clearTimeout(pendingMetadataChange);
    pendingMetadataChange = null;
  }
  metadataChangeGeneration += 1;
};

const resolveWorkspaceRoot = () => {
  const workspaceArgumentIndex = process.argv.indexOf("--workspace");
  const workspaceArgument =
    workspaceArgumentIndex >= 0 ? process.argv[workspaceArgumentIndex + 1] : undefined;
  const inlineWorkspaceArgument = process.argv
    .find((argument) => argument.startsWith("--workspace="))
    ?.slice("--workspace=".length);
  const explicitCandidates = [
    process.env.NOTES_WORKSPACE,
    process.env.MEETINGS_WORKSPACE,
    workspaceArgument,
    inlineWorkspaceArgument,
  ];

  for (const candidate of explicitCandidates) {
    if (candidate) {
      const absolutePath = resolve(candidate);
      if (isWorkspaceRoot(absolutePath)) {
        return absolutePath;
      }
    }
  }

  const savedWorkspacePath = readWorkspacePath();
  if (savedWorkspacePath) {
    return isWorkspaceRoot(savedWorkspacePath) ? savedWorkspacePath : null;
  }

  return null;
};

const requireWorkspaceRoot = () => {
  if (!workspaceRoot) {
    throw new Error("Choose a Notes workspace first.");
  }
  return workspaceRoot;
};

const loadWorkspaceSnapshot = async () => {
  if (!workspaceRoot) {
    return {
      documents: [],
      metadataError: null,
      peoplePaths: [],
      workspacePath: null,
    };
  }
  const [documents, metadata] = await Promise.all([
    listDocuments(workspaceRoot),
    readWorkspaceMetadataOrDefault(workspaceRoot),
  ]);
  for (const document of documents) {
    knownDocumentHashes.set(document.path, document.hash);
  }
  return {
    documents,
    ...reconcileWorkspaceMetadataPaths(metadata, new Set(documents.map(({ path }) => path))),
    workspacePath: workspaceRoot,
  };
};

const chooseWorkspace = async (browserWindow) => {
  const options = {
    buttonLabel: "Choose Workspace",
    message: "Choose a folder containing your Notes workspace",
    properties: ["openDirectory", "createDirectory"],
    title: "Open Notes Workspace",
  };
  const selection = browserWindow
    ? await dialog.showOpenDialog(browserWindow, options)
    : await dialog.showOpenDialog(options);
  if (selection.canceled || !selection.filePaths[0]) {
    return { canceled: true };
  }

  const selectedWorkspace = initializeWorkspace(selection.filePaths[0]);
  writeWorkspacePath(selectedWorkspace);
  stopWorkspaceWatchers();
  workspaceRoot = selectedWorkspace;
  startWorkspaceWatchers();
  return { canceled: false, workspacePath: selectedWorkspace };
};

/** @param {{baseHash: string; content: string; path: string}} request */
const saveDocumentSync = (request) => {
  const trackedPath = typeof request.path === "string" ? normalizeDocumentPath(request.path) : null;
  if (trackedPath) {
    beginDocumentWrite(trackedPath);
  }
  try {
    const document = writeDocumentSync({
      ...request,
      root: requireWorkspaceRoot(),
    });
    rememberWrite(document);
    return { document, status: "saved" };
  } catch (error) {
    if (error instanceof DocumentConflictError) {
      return { document: error.document, status: "conflict" };
    }
    return { error: errorMessage(error), status: "error" };
  } finally {
    if (trackedPath) {
      endDocumentWrite(trackedPath);
    }
  }
};

/** @param {{baseHash: string; content: string; path: string}} request */
const saveDocument = async (request) => {
  const trackedPath = typeof request.path === "string" ? normalizeDocumentPath(request.path) : null;
  if (trackedPath) {
    beginDocumentWrite(trackedPath);
  }
  try {
    const document = await writeDocument({
      ...request,
      root: requireWorkspaceRoot(),
    });
    rememberWrite(document);
    return { document, status: "saved" };
  } catch (error) {
    if (error instanceof DocumentConflictError) {
      return { document: error.document, status: "conflict" };
    }
    return { error: errorMessage(error), status: "error" };
  } finally {
    if (trackedPath) {
      endDocumentWrite(trackedPath);
    }
  }
};

const sendToWebContents = (webContents, channel, value) => {
  if (!webContents.isDestroyed()) {
    webContents.send(channel, value);
  }
};

const reportClosingSaveFailure = (webContents, result) => {
  if (!closingWindowIds.has(webContents.id) || result.status === "saved") {
    return;
  }
  sendToWebContents(
    webContents,
    "meetings:close-blocked",
    result.status === "conflict"
      ? "Notes could not close because the file changed on disk. Resolve the conflict to finish closing."
      : `Notes could not close because saving failed: ${result.error}`,
  );
};

const buildApplicationMenu = () =>
  Menu.buildFromTemplate([
    ...(process.platform === "darwin"
      ? [
          {
            label: "Notes",
            submenu: [
              { role: "about" },
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          },
        ]
      : []),
    {
      label: "File",
      submenu: [
        {
          accelerator: "CommandOrControl+O",
          click: (_menuItem, browserWindow) => {
            if (browserWindow instanceof BrowserWindow) {
              browserWindow.webContents.send("meetings:choose-workspace-requested");
            }
          },
          label: "Open Workspace…",
        },
        { type: "separator" },
        { accelerator: "CommandOrControl+W", role: "close" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        {
          accelerator: "CommandOrControl+Alt+J",
          click: (_menuItem, browserWindow) => {
            if (browserWindow instanceof BrowserWindow) {
              browserWindow.webContents.toggleDevTools();
            }
          },
          label: "Toggle Developer Tools",
        },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ]);

const createWindow = () => {
  const savedState = readWindowState(app.getPath("userData"));
  const validatedState = savedState
    ? validateWindowStateOnScreen(savedState, screen.getAllDisplays())
    : null;
  const { height, width } = screen.getPrimaryDisplay().workAreaSize;
  const useMacVibrancy = process.platform === "darwin";
  const window = new BrowserWindow({
    autoHideMenuBar: process.platform !== "linux",
    backgroundColor: useMacVibrancy
      ? "#00000000"
      : nativeTheme.shouldUseDarkColors
        ? "#141414"
        : "#f8f8f6",
    height: validatedState?.height ?? Math.max(720, Math.floor(height * 0.86)),
    minHeight: 520,
    minWidth: 320,
    show: false,
    title: "Notes",
    titleBarStyle: useMacVibrancy ? "hiddenInset" : "default",
    ...(useMacVibrancy
      ? {
          trafficLightPosition: { x: 12, y: 12 },
          transparent: true,
          vibrancy: "under-window",
          visualEffectState: "followWindow",
        }
      : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(__dirname, "preload.cjs"),
    },
    width: validatedState?.width ?? Math.max(1120, Math.floor(width * 0.86)),
    ...(validatedState ? { x: validatedState.x, y: validatedState.y } : { center: true }),
  });

  if (validatedState?.isMaximized) {
    window.maximize();
  }
  if (validatedState?.isFullScreen) {
    window.setFullScreen(true);
  }

  const windowWebContentsId = window.webContents.id;
  window.once("ready-to-show", () => window.show());
  window.on("close", () => {
    closingWindowIds.add(windowWebContentsId);
    try {
      const bounds = window.getNormalBounds();
      writeWindowState(
        {
          height: bounds.height,
          isFullScreen: window.isFullScreen(),
          isMaximized: window.isMaximized(),
          width: bounds.width,
          x: bounds.x,
          y: bounds.y,
        },
        app.getPath("userData"),
      );
    } catch {}
  });
  window.on("closed", () => {
    closingWindowIds.delete(windowWebContentsId);
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    const target = new URL(url);
    if (target.protocol !== "file:" && target.origin !== process.env.ELECTRON_RENDERER_URL) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });
  const rendererURL = process.env.ELECTRON_RENDERER_URL;
  if (rendererURL) {
    void window.loadURL(rendererURL);
  } else {
    void window.loadURL(pathToFileURL(join(appRoot, "dist/index.html")).toString());
  }
};

ipcMain.handle("meetings:load-workspace", loadWorkspaceSnapshot);
ipcMain.handle("meetings:choose-workspace", (event) => {
  const browserWindow = BrowserWindow.getAllWindows().find(
    (window) => window.webContents === event.sender,
  );
  return chooseWorkspace(browserWindow);
});
ipcMain.handle("meetings:create-document", async (_event, request) => {
  const document = await createWorkspaceDocument({
    ...request,
    root: requireWorkspaceRoot(),
  });
  rememberWrite(document);
  return document;
});
ipcMain.handle("meetings:delete-document", (_event, request) =>
  deleteDocument({ ...request, root: requireWorkspaceRoot() }),
);
ipcMain.handle("meetings:complete-interview", (_event, request) =>
  deleteInterview({ ...request, root: requireWorkspaceRoot() }),
);
ipcMain.handle("meetings:save-document", async (event, request) => {
  const result = await saveDocument(request);
  reportClosingSaveFailure(event.sender, result);
  return result;
});
ipcMain.on("meetings:close-ready", (event) => {
  if (closingWindowIds.has(event.sender.id)) {
    sendToWebContents(event.sender, "meetings:retry-close");
  }
});
ipcMain.on("meetings:save-document-sync", (event, request) => {
  const { keepalive, ...saveRequest } = request;
  const result = saveDocumentSync(saveRequest);
  if (keepalive && closingWindowIds.has(event.sender.id)) {
    if (result.status !== "saved") {
      sendToWebContents(
        event.sender,
        "meetings:close-blocked",
        result.status === "conflict"
          ? "Notes could not close because the file changed on disk. Resolve the conflict to finish closing."
          : `Notes could not close because saving failed: ${result.error}`,
      );
    }
  }
  event.returnValue = result;
});
ipcMain.handle("meetings:format-document", (_event, request) =>
  formatDocumentContent({ ...request, root: requireWorkspaceRoot() }),
);
ipcMain.handle("meetings:restore-document", async (_event, request) => {
  const document = await restoreDocument({
    ...request,
    root: requireWorkspaceRoot(),
  });
  rememberWrite(document);
  return document;
});

const lock = !squirrelStartup && app.requestSingleInstanceLock();
if (squirrelStartup || !lock) {
  app.quit();
} else {
  app.setName("Notes");
  app.on("second-instance", () => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window) {
      if (window.isMinimized()) {
        window.restore();
      }
      window.show();
      window.focus();
    }
  });
  app.on("ready", () => {
    const resolvedWorkspaceRoot = resolveWorkspaceRoot();
    workspaceRoot = resolvedWorkspaceRoot
      ? initializeWorkspace(resolvedWorkspaceRoot)
      : "";
    Menu.setApplicationMenu(buildApplicationMenu());
    startWorkspaceWatchers();
    createWindow();
  });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
  app.on("before-quit", stopWorkspaceWatchers);
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });
}
