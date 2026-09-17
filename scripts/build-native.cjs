// @ts-check

const { execFileSync } = require('node:child_process');
const { existsSync, mkdirSync, renameSync } = require('node:fs');
const { dirname, join, resolve } = require('node:path');

const buildNative = (platform = process.platform) => {
  if (platform !== 'darwin') {
    return;
  }
  if (process.platform !== 'darwin') {
    throw new Error('Packaging Clear Liquid Glass requires a macOS build host.');
  }
  const root = resolve(__dirname, '..');
  const headers = [
    process.env.NOTES_NODE_HEADERS,
    resolve(dirname(process.execPath), '../include/node'),
    '/opt/homebrew/include/node',
    '/usr/local/include/node',
  ].find((path) => path && existsSync(join(path, 'node_api.h')));
  if (!headers) {
    throw new Error(
      'Install Node.js development headers or set NOTES_NODE_HEADERS to their directory.',
    );
  }
  const output = join(root, 'electron/native/liquid-glass.node');
  mkdirSync(dirname(output), { recursive: true });
  // Node-API is ABI-stable across Node and Electron. A universal binary also
  // supports Intel release builds without a second, architecture-specific cache.
  execFileSync(
    'xcrun',
    [
      'clang++',
      '-std=c++17',
      '-fobjc-arc',
      '-fobjc-exceptions',
      '-DNAPI_VERSION=8',
      '-DNODE_GYP_MODULE_NAME=liquid_glass',
      '-mmacosx-version-min=12.0',
      '-arch',
      'arm64',
      '-arch',
      'x86_64',
      '-bundle',
      '-undefined',
      'dynamic_lookup',
      '-framework',
      'AppKit',
      '-framework',
      'QuartzCore',
      '-I',
      headers,
      join(root, 'native/liquid-glass.mm'),
      '-o',
      `${output}.tmp`,
    ],
    { stdio: 'inherit' },
  );
  renameSync(`${output}.tmp`, output);
  console.log('Built native Clear Liquid Glass (arm64 + x64).');
};

if (require.main === module) {
  buildNative();
}
module.exports = { buildNative };
