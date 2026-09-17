// @ts-check

const { contextBridge, ipcRenderer } = require('electron');

const bootstrap = ipcRenderer.sendSync('meetings:bootstrap');
let systemAccent = bootstrap.systemAccent;

// Subscribe before requesting the snapshot: edits arriving while renderer
// modules load must survive until React installs its subscriptions.
const bufferedSubscription = (channel, key) => {
  const listeners = new Set();
  const pending = new Map();
  let subscribed = false;
  ipcRenderer.on(channel, (_event, change) => {
    if (!subscribed) {
      pending.set(key(change), change);
    }
    for (const listener of listeners) {
      listener(change);
    }
  });
  return (callback) => {
    listeners.add(callback);
    subscribed = true;
    for (const change of pending.values()) {
      callback(change);
    }
    pending.clear();
    return () => listeners.delete(callback);
  };
};
const onDocumentChange = bufferedSubscription('meetings:document-change', (change) => change.path);
const onWorkspaceMetadataChange = bufferedSubscription(
  'meetings:workspace-metadata-change',
  () => 'metadata',
);
let initialWorkspace = ipcRenderer.invoke('meetings:load-workspace');
// Keep a failed request available for the renderer to report without an
// unhandled rejection if the editor bundle is still loading.
void initialWorkspace.catch(() => {});
let rendererReady = false;

const applyAppearance = () => {
  const root = document.documentElement;
  if (!root) {
    return;
  }
  root.setAttribute('data-meetings-platform', process.platform);
  if (typeof systemAccent === 'string' && /^#(?:[\da-f]{6}|[\da-f]{8})$/i.test(systemAccent)) {
    root.style.setProperty('--system-accent', systemAccent);
  } else {
    root.style.removeProperty('--system-accent');
  }
};

if (document.documentElement) {
  applyAppearance();
} else {
  window.addEventListener('DOMContentLoaded', applyAppearance, {
    once: true,
  });
}

ipcRenderer.on('meetings:system-accent-changed', (_event, color) => {
  systemAccent = color;
  applyAppearance();
});

const meetings = {
  clearGlassAvailable: bootstrap.clearGlassAvailable === true,
  initialWindowAppearance: bootstrap.windowAppearance,
  updateWindowAppearance: (appearance) =>
    ipcRenderer.invoke('meetings:window-appearance', appearance),
  initialWindowLayout: bootstrap.layout,
  updateWindowState: (state) => ipcRenderer.send('meetings:window-state', state),
  cancelClose: () => ipcRenderer.send('meetings:cancel-close'),
  closeWindowIfOthersOpen: () => ipcRenderer.invoke('meetings:close-window-if-others-open'),
  recoveryDraftKey: bootstrap.recoveryDraftKey,
  chooseWorkspace: () => ipcRenderer.invoke('meetings:choose-workspace'),
  completeInterview: (request) => ipcRenderer.invoke('meetings:complete-interview', request),
  createDocument: (request) => ipcRenderer.invoke('meetings:create-document', request),
  deleteDocument: (request) => ipcRenderer.invoke('meetings:delete-document', request),
  formatDocument: (request) => ipcRenderer.invoke('meetings:format-document', request),
  loadWorkspace: () => {
    const request = initialWorkspace;
    initialWorkspace = null;
    return request ?? ipcRenderer.invoke('meetings:load-workspace');
  },
  onDocumentChange,
  onCloseBlocked: (callback) => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on('meetings:close-blocked', listener);
    return () => ipcRenderer.removeListener('meetings:close-blocked', listener);
  },
  onChooseWorkspaceRequested: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('meetings:choose-workspace-requested', listener);
    return () => ipcRenderer.removeListener('meetings:choose-workspace-requested', listener);
  },
  onWorkspaceMetadataChange,
  readyToClose: () => ipcRenderer.send('meetings:close-ready'),
  rendererReady: () => {
    if (!rendererReady) {
      rendererReady = true;
      ipcRenderer.send('meetings:renderer-ready');
    }
  },
  restoreDocument: (request) => ipcRenderer.invoke('meetings:restore-document', request),
  saveDocument: (request, keepalive) =>
    keepalive
      ? ipcRenderer.sendSync('meetings:save-document-sync', {
          ...request,
          keepalive: true,
        })
      : ipcRenderer.invoke('meetings:save-document', request),
};

ipcRenderer.on('meetings:retry-close', () => window.close());

contextBridge.exposeInMainWorld('meetings', meetings);
