// @ts-check

const { existsSync } = require('node:fs');
const { dirname, join } = require('node:path');
const { spawnSync } = require('node:child_process');

const installedNode22 = [
  process.env.ELECTRON_FORGE_NODE,
  '/opt/homebrew/opt/node@22/bin/node',
  '/usr/local/opt/node@22/bin/node',
].find((candidate) => candidate && existsSync(candidate));
const currentNodeMajor = Number.parseInt(process.versions.node, 10);
const node = currentNodeMajor >= 26 && installedNode22 ? installedNode22 : process.execPath;
const forgeCli = join(
  dirname(require.resolve('@electron-forge/cli/package.json')),
  'dist/electron-forge.js',
);
const result = spawnSync(node, [forgeCli, ...process.argv.slice(2)], {
  env: process.env,
  stdio: 'inherit',
});

if (result.error) {
  throw result.error;
}
process.exit(result.status ?? 1);
