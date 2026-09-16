import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vite-plus/test';

const require = createRequire(import.meta.url);
const { readOpenWindows, writeOpenWindows } = require('./open-windows.cjs');
const roots: string[] = [];
const createConfig = async () => {
  const root = await mkdtemp(join(tmpdir(), 'notes-windows-'));
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test('persists recovery identities until their windows close', async () => {
  const root = await createConfig();
  const sessions = [
    {
      recoveryId: 'primary',
      workspaceRoot: '/tmp/notes-one',
      activePath: 'docs/example.md',
      layout: { sidebarCollapsed: true, sidebarWidth: 280, sectionExpanded: { People: false } },
      bounds: { x: 10, y: 20, width: 680, height: 900, isFullScreen: false, isMaximized: false },
    },
    { recoveryId: '12345678-1234-1234-1234-123456789abc', workspaceRoot: '/tmp/notes-two' },
  ];
  writeOpenWindows(sessions, root);
  expect(readOpenWindows(root)).toEqual(sessions);
  writeOpenWindows([sessions[1]], root);
  expect(readOpenWindows(root)).toEqual([sessions[1]]);
  expect(JSON.parse(await readFile(join(root, 'open-windows.json'), 'utf8'))).toEqual([
    sessions[1],
  ]);
  writeOpenWindows([], root);
  expect(readOpenWindows(root)).toEqual([]);
});

test('invalid view state cannot prevent recovery of a valid window', async () => {
  const root = await createConfig();
  const session = { recoveryId: 'primary', workspaceRoot: '/tmp/notes-one' };
  await writeFile(
    join(root, 'open-windows.json'),
    JSON.stringify([
      {
        ...session,
        activePath: '../outside.md',
        bounds: { x: 0, y: 0, width: 20, height: 10 },
        layout: { sidebarCollapsed: 'true', sidebarWidth: 'invalid', sectionExpanded: {} },
      },
    ]),
  );
  expect(readOpenWindows(root)).toEqual([session]);
});

test('ignores malformed and duplicate window identities', async () => {
  const root = await createConfig();
  expect(readOpenWindows(root)).toEqual([]);
  await writeFile(join(root, 'open-windows.json'), 'broken');
  expect(readOpenWindows(root)).toEqual([]);
  const session = { recoveryId: 'primary', workspaceRoot: '/tmp/notes-one' };
  await writeFile(
    join(root, 'open-windows.json'),
    JSON.stringify([
      null,
      {},
      session,
      session,
      { recoveryId: '12345678-1234-1234-1234-123456789abc', workspaceRoot: 'relative' },
    ]),
  );
  expect(readOpenWindows(root)).toEqual([session]);
});
