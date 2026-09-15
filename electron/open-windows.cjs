// @ts-check

const { mkdirSync, readFileSync, renameSync, writeFileSync } = require("node:fs");
const { isAbsolute, join } = require("node:path");
const { normalizeWindowLayout } = require("./window-layout.cjs");
const { normalizeWindowState } = require("./window-state.cjs");
const { normalizeDocumentPath } = require("./document-service.cjs");

// Retain stable identities and view state for relaunch and crash recovery.
const readOpenWindows = (configDir) => {
  try {
    const sessions = JSON.parse(readFileSync(join(configDir, "open-windows.json"), "utf8"));
    if (!Array.isArray(sessions)) {
      return [];
    }
    const seen = new Set();
    return sessions
      .filter((session) => {
        if (
          !session ||
          typeof session.recoveryId !== "string" ||
          !/^(primary|[0-9a-f-]{36})$/.test(session.recoveryId) ||
          seen.has(session.recoveryId) ||
          typeof session.workspaceRoot !== "string" ||
          (session.workspaceRoot !== "" && !isAbsolute(session.workspaceRoot))
        ) {
          return false;
        }
        seen.add(session.recoveryId);
        return true;
      })
      .map((session) => {
        const layout = normalizeWindowLayout(session.layout);
        const bounds = normalizeWindowState(session.bounds);
        const activePath =
          typeof session.activePath === "string" ? normalizeDocumentPath(session.activePath) : null;
        return {
          recoveryId: session.recoveryId,
          workspaceRoot: session.workspaceRoot,
          ...(layout ? { layout } : {}),
          ...(bounds ? { bounds } : {}),
          ...(activePath ? { activePath } : {}),
        };
      });
  } catch {
    return [];
  }
};

const writeOpenWindows = (sessions, configDir) => {
  mkdirSync(configDir, { recursive: true });
  const target = join(configDir, "open-windows.json");
  const temporaryPath = `${target}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(sessions)}\n`, { mode: 0o600 });
  renameSync(temporaryPath, target);
};

module.exports = { readOpenWindows, writeOpenWindows };
