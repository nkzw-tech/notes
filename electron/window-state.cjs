// @ts-check

const { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { normalizeWindowLayout } = require('./window-layout.cjs');

const MIN_WIDTH = 320;
const MIN_HEIGHT = 520;
const MIN_OVERLAP = 100;

/** @param {string} configDir */
const readWindowState = (configDir) => {
  const filePath = join(configDir, 'window-state.json');
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    const state = JSON.parse(readFileSync(filePath, 'utf8'));
    return normalizeWindowState(state);
  } catch {
    return null;
  }
};

const normalizeWindowState = (state) => {
  if (
    typeof state?.x !== 'number' ||
    typeof state?.y !== 'number' ||
    typeof state?.width !== 'number' ||
    typeof state?.height !== 'number' ||
    !Number.isFinite(state.x) ||
    !Number.isFinite(state.y) ||
    !Number.isFinite(state.width) ||
    !Number.isFinite(state.height) ||
    state.width < MIN_WIDTH ||
    state.height < MIN_HEIGHT
  ) {
    return null;
  }
  const layout = normalizeWindowLayout(state.layout);
  return {
    ...(layout ? { layout } : {}),
    height: state.height,
    isFullScreen: state.isFullScreen === true,
    isMaximized: state.isMaximized === true,
    width: state.width,
    x: state.x,
    y: state.y,
  };
};

/** @param {Record<string, unknown>} state @param {string} configDir */
const writeWindowState = (state, configDir) => {
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }
  const target = join(configDir, 'window-state.json');
  writeFileSync(`${target}.tmp`, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${target}.tmp`, target);
};

/**
 * @param {{x: number; y: number; width: number; height: number}} state
 * @param {ReadonlyArray<{workArea: {x: number; y: number; width: number; height: number}}>} displays
 */
const validateWindowStateOnScreen = (state, displays) => {
  for (const { workArea } of displays) {
    const overlapX = Math.max(
      0,
      Math.min(state.x + state.width, workArea.x + workArea.width) - Math.max(state.x, workArea.x),
    );
    const overlapY = Math.max(
      0,
      Math.min(state.y + state.height, workArea.y + workArea.height) -
        Math.max(state.y, workArea.y),
    );
    if (overlapX >= MIN_OVERLAP && overlapY >= MIN_OVERLAP) {
      return state;
    }
  }
  return null;
};

module.exports = {
  normalizeWindowState,
  readWindowState,
  validateWindowStateOnScreen,
  writeWindowState,
};
