// @ts-check

const { randomUUID } = require('node:crypto');
const { dirname, join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  screen,
  shell,
  systemPreferences,
} = require('electron');
const squirrelStartup = require('electron-squirrel-startup');
const {
  createWorkspaceDocument,
  deleteDocument,
  deleteInterview,
  formatDocumentContent,
  isWorkspaceRoot,
  normalizeDocumentPath,
  restoreDocument,
} = require('./document-service.cjs');
const {
  readWindowState,
  validateWindowStateOnScreen,
  writeWindowState,
} = require('./window-state.cjs');
const {
  initializeWorkspace,
  readWorkspacePath,
  writeWorkspacePath,
} = require('./workspace-config.cjs');

const { createWorkspaceSession } = require('./workspace-session.cjs');
const { readOpenWindows, writeOpenWindows } = require('./open-windows.cjs');
const { normalizeWindowLayout } = require('./window-layout.cjs');

const appRoot = dirname(__dirname);
const closingWindowIds = new Set();
const windowSessions = new Map();
const workspaceSessions = new Map();
let workspaceRoot = '';
let explicitWorkspaceRoot = null;
let quitSessions = null;
let pendingWindowState = null;
let colorPreferencesSubscription = null;

const getSystemAccent = () => {
  try {
    const color = systemPreferences.getAccentColor().replace(/^#/, '');
    return /^(?:[\da-f]{6}|[\da-f]{8})$/i.test(color) ? `#${color}` : null;
  } catch {
    return null;
  }
};

const updateSystemAccent = () => {
  const color = getSystemAccent();
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send('meetings:system-accent-changed', color);
    }
  }
};

const persistOpenWindows = () => {
  if (pendingWindowState) {
    clearTimeout(pendingWindowState);
    pendingWindowState = null;
  }
  try {
    writeOpenWindows([...(quitSessions ?? windowSessions).values()], app.getPath('userData'));
  } catch (error) {
    console.error('Failed to remember Notes windows:', error);
  }
};

const scheduleWindowState = () => {
  if (!pendingWindowState) {
    pendingWindowState = setTimeout(persistOpenWindows, 100);
  }
};

const cancelQuit = () => {
  quitSessions = null;
  persistOpenWindows();
};

const captureWindowBounds = (window) => ({
  ...window.getNormalBounds(),
  isFullScreen: window.isFullScreen(),
  isMaximized: window.isMaximized(),
});

const getWorkspaceSession = (root) => {
  if (!workspaceSessions.has(root)) {
    workspaceSessions.set(
      root,
      createWorkspaceSession(root, () =>
        BrowserWindow.getAllWindows().filter(
          (window) =>
            !window.isDestroyed() &&
            windowSessions.get(window.webContents.id)?.workspaceRoot === root,
        ),
      ),
    );
  }
  return workspaceSessions.get(root);
};

const sessionForSender = (sender) => {
  const session = windowSessions.get(sender.id);
  if (!session) {
    throw new Error('This Notes window is no longer available.');
  }
  return getWorkspaceSession(session.workspaceRoot);
};
const resolveWorkspaceRoot = () => {
  const workspaceArgumentIndex = process.argv.indexOf('--workspace');
  const workspaceArgument =
    workspaceArgumentIndex >= 0 ? process.argv[workspaceArgumentIndex + 1] : undefined;
  const inlineWorkspaceArgument = process.argv
    .find((argument) => argument.startsWith('--workspace='))
    ?.slice('--workspace='.length);
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
        explicitWorkspaceRoot = absolutePath;
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

const chooseWorkspace = async (browserWindow) => {
  const options = {
    buttonLabel: 'Choose Workspace',
    message: 'Choose a folder containing your Notes workspace',
    properties: ['openDirectory', 'createDirectory'],
    title: 'Open Notes Workspace',
  };
  const selection = browserWindow
    ? await dialog.showOpenDialog(browserWindow, options)
    : await dialog.showOpenDialog(options);
  if (selection.canceled || !selection.filePaths[0]) {
    return { canceled: true };
  }
  if (!browserWindow || browserWindow.isDestroyed()) {
    return { canceled: true };
  }

  const selectedWorkspace = initializeWorkspace(selection.filePaths[0]);
  writeWorkspacePath(selectedWorkspace);
  const session = windowSessions.get(browserWindow.webContents.id);
  session.workspaceRoot = selectedWorkspace;
  delete session.activePath;
  workspaceRoot = selectedWorkspace;
  getWorkspaceSession(selectedWorkspace);
  persistOpenWindows();
  return { canceled: false, workspacePath: selectedWorkspace };
};

const sendToWebContents = (webContents, channel, value) => {
  if (!webContents.isDestroyed()) {
    webContents.send(channel, value);
  }
};

const reportClosingSaveFailure = (webContents, result) => {
  if (!closingWindowIds.has(webContents.id) || result.status === 'saved') {
    return;
  }
  cancelQuit();
  sendToWebContents(
    webContents,
    'meetings:close-blocked',
    result.status === 'conflict'
      ? 'Notes could not close because the file changed on disk. Resolve the conflict to finish closing.'
      : `Notes could not close because saving failed: ${result.error}`,
  );
};

const buildApplicationMenu = () =>
  Menu.buildFromTemplate([
    ...(process.platform === 'darwin'
      ? [
          {
            label: 'Notes',
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ]
      : []),
    {
      label: 'File',
      submenu: [
        {
          accelerator: 'CommandOrControl+N',
          click: (_menuItem, browserWindow) => createWindow(browserWindow),
          label: 'New Window',
        },
        {
          accelerator: 'CommandOrControl+O',
          click: (_menuItem, browserWindow) => {
            if (browserWindow instanceof BrowserWindow) {
              browserWindow.webContents.send('meetings:choose-workspace-requested');
            }
          },
          label: 'Open Workspace…',
        },
        { type: 'separator' },
        { accelerator: 'CommandOrControl+W', role: 'close' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        {
          accelerator: 'CommandOrControl+Alt+J',
          click: (_menuItem, browserWindow) => {
            if (browserWindow instanceof BrowserWindow) {
              browserWindow.webContents.toggleDevTools();
            }
          },
          label: 'Toggle Developer Tools',
        },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ]);

const createWindow = (sourceWindow, restoredSession) => {
  const sourceSession = sourceWindow && windowSessions.get(sourceWindow.webContents.id);
  const savedState = readWindowState(app.getPath('userData'));
  const inheritedLayout = sourceSession?.layout ?? savedState?.layout;
  const session = restoredSession
    ? { ...restoredSession }
    : {
        recoveryId: randomUUID(),
        workspaceRoot: sourceSession?.workspaceRoot ?? workspaceRoot,
      };
  session.layout = normalizeWindowLayout(session.layout ?? inheritedLayout);
  if (quitSessions) {
    cancelQuit();
  }
  const sourceBounds = sourceWindow?.getNormalBounds();
  const preferredState = sourceBounds
    ? { ...sourceBounds, x: sourceBounds.x + 24, y: sourceBounds.y + 24 }
    : (session.bounds ?? savedState);
  const validatedState = preferredState
    ? validateWindowStateOnScreen(preferredState, screen.getAllDisplays())
    : null;
  const { height, width } = screen.getPrimaryDisplay().workAreaSize;
  const useMacVibrancy = process.platform === 'darwin';
  const window = new BrowserWindow({
    autoHideMenuBar: process.platform !== 'linux',
    backgroundColor: useMacVibrancy
      ? '#00000000'
      : nativeTheme.shouldUseDarkColors
        ? '#141414'
        : '#f8f8f6',
    height: validatedState?.height ?? Math.max(720, Math.floor(height * 0.86)),
    minHeight: 520,
    minWidth: 320,
    show: false,
    title: 'Notes',
    titleBarStyle: useMacVibrancy ? 'hiddenInset' : 'default',
    ...(useMacVibrancy
      ? {
          // Center the 12px native controls in the 44px renderer title bar.
          trafficLightPosition: { x: 12, y: 16 },
          transparent: true,
          vibrancy: 'under-window',
          visualEffectState: 'followWindow',
        }
      : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(__dirname, 'preload.cjs'),
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
  session.bounds = captureWindowBounds(window);
  windowSessions.set(windowWebContentsId, session);
  getWorkspaceSession(session.workspaceRoot);
  persistOpenWindows();
  // Show the committed editor (or workspace/error screen) as the first frame.
  // ready-to-show can fire on the empty HTML before renderer initialization.
  window.webContents.once('did-fail-load', () => window.show());
  window.webContents.once('render-process-gone', () => window.show());
  const rememberBounds = () => {
    if (!quitSessions) {
      session.bounds = captureWindowBounds(window);
      scheduleWindowState();
    }
  };
  for (const event of [
    'move',
    'resize',
    'maximize',
    'unmaximize',
    'enter-full-screen',
    'leave-full-screen',
  ]) {
    window.on(event, rememberBounds);
  }
  window.on('close', () => {
    closingWindowIds.add(windowWebContentsId);
    if (!quitSessions) {
      session.bounds = captureWindowBounds(window);
    }
    persistOpenWindows();
  });
  window.on('closed', () => {
    closingWindowIds.delete(windowWebContentsId);
    // Only a completed close changes the default. A canceled close must not win.
    try {
      writeWindowState({ ...session.bounds, layout: session.layout }, app.getPath('userData'));
    } catch (error) {
      console.error('Failed to remember the last Notes window:', error);
    }
    windowSessions.delete(windowWebContentsId);
    persistOpenWindows();
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    const target = new URL(url);
    if (target.protocol !== 'file:' && target.origin !== process.env.ELECTRON_RENDERER_URL) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });
  const rendererURL = process.env.ELECTRON_RENDERER_URL;
  const target = new URL(rendererURL ?? pathToFileURL(join(appRoot, 'dist/index.html')).toString());
  const sourceURL = sourceWindow?.webContents.getURL();
  if (sourceURL) {
    target.hash = new URL(sourceURL).hash;
  } else if (session.activePath) {
    target.hash = `#/${encodeURI(session.activePath)}`;
  }
  void window.loadURL(target.toString());
};

ipcMain.on('meetings:bootstrap', (event) => {
  const session = windowSessions.get(event.sender.id);
  event.returnValue = {
    layout: session?.layout ?? null,
    recoveryDraftKey:
      session?.recoveryId === 'primary'
        ? 'notes.current-draft.v1'
        : `notes.current-draft.v1.${session.recoveryId}.${encodeURIComponent(session.workspaceRoot)}`,
    systemAccent: getSystemAccent(),
  };
});
ipcMain.on('meetings:renderer-ready', (event) => {
  const window = BrowserWindow.getAllWindows().find(
    (window) => window.webContents === event.sender,
  );
  if (window && !window.isDestroyed() && !closingWindowIds.has(event.sender.id)) {
    window.show();
  }
});
ipcMain.on('meetings:window-state', (event, state) => {
  const session = windowSessions.get(event.sender.id);
  const layout = normalizeWindowLayout(state?.layout);
  if (!session || !layout) {
    return;
  }
  session.layout = layout;
  if (typeof state.activePath === 'string') {
    const path = normalizeDocumentPath(state.activePath);
    if (path) {
      session.activePath = path;
    }
  }
  scheduleWindowState();
});
ipcMain.on('meetings:cancel-close', (event) => {
  closingWindowIds.delete(event.sender.id);
  cancelQuit();
});
ipcMain.handle('meetings:load-workspace', (event) =>
  sessionForSender(event.sender).loadWorkspaceSnapshot(),
);
ipcMain.handle('meetings:choose-workspace', (event) => {
  const browserWindow = BrowserWindow.getAllWindows().find(
    (window) => window.webContents === event.sender,
  );
  return chooseWorkspace(browserWindow);
});
ipcMain.handle('meetings:create-document', async (event, request) => {
  const session = sessionForSender(event.sender);
  const document = await createWorkspaceDocument({
    ...request,
    root: session.requireWorkspaceRoot(),
  });
  session.rememberWrite(document);
  session.publishSavedDocument(document, event.sender);
  return document;
});
ipcMain.handle('meetings:delete-document', (event, request) =>
  deleteDocument({ ...request, root: sessionForSender(event.sender).requireWorkspaceRoot() }),
);
ipcMain.handle('meetings:complete-interview', (event, request) =>
  deleteInterview({ ...request, root: sessionForSender(event.sender).requireWorkspaceRoot() }),
);
ipcMain.handle('meetings:save-document', async (event, request) => {
  const result = await sessionForSender(event.sender).saveDocument(request, event.sender);
  reportClosingSaveFailure(event.sender, result);
  return result;
});
ipcMain.on('meetings:close-ready', (event) => {
  if (closingWindowIds.has(event.sender.id)) {
    sendToWebContents(event.sender, 'meetings:retry-close');
  }
});
ipcMain.on('meetings:save-document-sync', (event, request) => {
  const { keepalive, ...saveRequest } = request;
  const result = sessionForSender(event.sender).saveDocumentSync(saveRequest, event.sender);
  if (keepalive && closingWindowIds.has(event.sender.id)) {
    if (result.status !== 'saved') {
      cancelQuit();
      sendToWebContents(
        event.sender,
        'meetings:close-blocked',
        result.status === 'conflict'
          ? 'Notes could not close because the file changed on disk. Resolve the conflict to finish closing.'
          : `Notes could not close because saving failed: ${result.error}`,
      );
    }
  }
  event.returnValue = result;
});
ipcMain.handle('meetings:format-document', (event, request) =>
  formatDocumentContent({
    ...request,
    root: sessionForSender(event.sender).requireWorkspaceRoot(),
  }),
);
ipcMain.handle('meetings:restore-document', async (event, request) => {
  const session = sessionForSender(event.sender);
  const document = await restoreDocument({
    ...request,
    root: session.requireWorkspaceRoot(),
  });
  session.rememberWrite(document);
  session.publishSavedDocument(document, event.sender);
  return document;
});

const lock = !squirrelStartup && app.requestSingleInstanceLock();
if (squirrelStartup || !lock) {
  app.quit();
} else {
  app.setName('Notes');
  app.on('second-instance', () => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window) {
      if (window.isMinimized()) {
        window.restore();
      }
      window.show();
      window.focus();
    }
  });
  app.on('ready', () => {
    nativeTheme.on('updated', updateSystemAccent);
    if (process.platform === 'darwin') {
      colorPreferencesSubscription = systemPreferences.subscribeNotification(
        'AppleColorPreferencesChangedNotification',
        updateSystemAccent,
      );
    } else {
      systemPreferences.on('accent-color-changed', updateSystemAccent);
    }
    const resolvedWorkspaceRoot = resolveWorkspaceRoot();
    workspaceRoot = resolvedWorkspaceRoot ? initializeWorkspace(resolvedWorkspaceRoot) : '';
    Menu.setApplicationMenu(buildApplicationMenu());
    const openWindows = readOpenWindows(app.getPath('userData'));
    if (openWindows.length) {
      for (const session of openWindows) {
        createWindow(undefined, session);
      }
      if (
        explicitWorkspaceRoot &&
        !openWindows.some((session) => session.workspaceRoot === explicitWorkspaceRoot)
      ) {
        createWindow();
      }
    } else {
      createWindow(undefined, { recoveryId: 'primary', workspaceRoot });
    }
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
  app.on('before-quit', () => {
    if (!quitSessions) {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) {
          const session = windowSessions.get(window.webContents.id);
          if (session) {
            session.bounds = captureWindowBounds(window);
          }
        }
      }
      // Keep references so late layout updates and lifecycle flushes remain current.
      quitSessions = new Map(windowSessions);
    }
    persistOpenWindows();
  });
  app.on('will-quit', () => {
    if (colorPreferencesSubscription !== null) {
      systemPreferences.unsubscribeNotification(colorPreferencesSubscription);
    }
    persistOpenWindows();
    for (const session of workspaceSessions.values()) {
      session.stopWorkspaceWatchers();
    }
  });
  app.on('window-all-closed', () => {
    if (quitSessions || process.platform !== 'darwin') {
      app.quit();
    }
  });
}
