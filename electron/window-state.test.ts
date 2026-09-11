import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const { readWindowState } = require('./window-state.cjs') as {
  readWindowState: (configDirectory: string) => {
    height: number;
    width: number;
    x: number;
    y: number;
  } | null;
};

const temporaryDirectories: string[] = [];

const writeState = (width: number) => {
  const directory = mkdtempSync(join(tmpdir(), 'meetings-window-state-'));
  temporaryDirectories.push(directory);
  writeFileSync(
    join(directory, 'window-state.json'),
    JSON.stringify({ height: 520, width, x: 0, y: 0 }),
  );
  return directory;
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('window state', () => {
  test('accepts persisted compact window widths down to 320px', () => {
    expect(readWindowState(writeState(320))?.width).toBe(320);
    expect(readWindowState(writeState(319))).toBeNull();
  });
});
