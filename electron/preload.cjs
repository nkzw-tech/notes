// @ts-check

const { contextBridge, ipcRenderer } = require("electron");

let systemAccent = ipcRenderer.sendSync("meetings:system-accent");

const applyAppearance = () => {
  const root = document.documentElement;
  if (!root) {
    return;
  }
  root.setAttribute("data-meetings-platform", process.platform);
  if (typeof systemAccent === "string" && /^#(?:[\da-f]{6}|[\da-f]{8})$/i.test(systemAccent)) {
    root.style.setProperty("--system-accent", systemAccent);
  } else {
    root.style.removeProperty("--system-accent");
  }
};

if (document.documentElement) {
  applyAppearance();
} else {
  window.addEventListener("DOMContentLoaded", applyAppearance, {
    once: true,
  });
}

ipcRenderer.on("meetings:system-accent-changed", (_event, color) => {
  systemAccent = color;
  applyAppearance();
});

const meetings = {
  initialWindowLayout: ipcRenderer.sendSync("meetings:window-layout"),
  updateWindowState: (state) => ipcRenderer.send("meetings:window-state", state),
  cancelClose: () => ipcRenderer.send("meetings:cancel-close"),
  recoveryDraftKey: ipcRenderer.sendSync("meetings:recovery-key"),
  chooseWorkspace: () => ipcRenderer.invoke("meetings:choose-workspace"),
  completeInterview: (request) => ipcRenderer.invoke("meetings:complete-interview", request),
  createDocument: (request) => ipcRenderer.invoke("meetings:create-document", request),
  deleteDocument: (request) => ipcRenderer.invoke("meetings:delete-document", request),
  formatDocument: (request) => ipcRenderer.invoke("meetings:format-document", request),
  loadWorkspace: () => ipcRenderer.invoke("meetings:load-workspace"),
  onDocumentChange: (callback) => {
    const listener = (_event, change) => callback(change);
    ipcRenderer.on("meetings:document-change", listener);
    return () => ipcRenderer.removeListener("meetings:document-change", listener);
  },
  onCloseBlocked: (callback) => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on("meetings:close-blocked", listener);
    return () => ipcRenderer.removeListener("meetings:close-blocked", listener);
  },
  onChooseWorkspaceRequested: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("meetings:choose-workspace-requested", listener);
    return () => ipcRenderer.removeListener("meetings:choose-workspace-requested", listener);
  },
  onWorkspaceMetadataChange: (callback) => {
    const listener = (_event, change) => callback(change);
    ipcRenderer.on("meetings:workspace-metadata-change", listener);
    return () => ipcRenderer.removeListener("meetings:workspace-metadata-change", listener);
  },
  readyToClose: () => ipcRenderer.send("meetings:close-ready"),
  restoreDocument: (request) => ipcRenderer.invoke("meetings:restore-document", request),
  saveDocument: (request, keepalive) =>
    keepalive
      ? ipcRenderer.sendSync("meetings:save-document-sync", {
          ...request,
          keepalive: true,
        })
      : ipcRenderer.invoke("meetings:save-document", request),
};

ipcRenderer.on("meetings:retry-close", () => window.close());

contextBridge.exposeInMainWorld("meetings", meetings);
