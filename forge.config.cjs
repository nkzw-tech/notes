// @ts-check

/* eslint-disable @typescript-eslint/no-require-imports */
const { existsSync } = require('node:fs');
const { join } = require('node:path');

const electronCachePath = process.env.ELECTRON_CACHE || join(__dirname, '.cache/electron');
const iconPath = existsSync(join(__dirname, 'electron/icons/icon.icns'))
  ? './electron/icons/icon'
  : undefined;
const osxNotarize =
  process.env.APPLE_ID && process.env.APPLE_PASSWORD && process.env.APPLE_TEAM_ID
    ? {
        appleId: process.env.APPLE_ID,
        appleIdPassword: process.env.APPLE_PASSWORD,
        teamId: process.env.APPLE_TEAM_ID,
        tool: 'notarytool',
      }
    : undefined;
// Notarization requires a signed bundle. Let osx-sign discover the installed
// Developer ID Application certificate when no explicit identity is provided.
const osxSign =
  process.env.APPLE_SIGNING_IDENTITY || osxNotarize
    ? {
        continueOnError: false,
        hardenedRuntime: true,
        identity: process.env.APPLE_SIGNING_IDENTITY,
        optionsForFile: () => ({
          entitlements: join(__dirname, 'electron/entitlements.plist'),
        }),
      }
    : undefined;

/**
 * @typedef {import('@electron-forge/shared-types').ForgeConfig} ForgeConfig
 * @typedef {import('@electron-forge/shared-types').ForgeArch} ForgeArch
 * @typedef {import('@electron-forge/shared-types').ForgePlatform} ForgePlatform
 * @typedef {{
 *   arch?: Array<ForgeArch>;
 *   config?: Record<string, unknown>;
 *   name: string;
 *   platforms?: Array<ForgePlatform> | null;
 * }} NotesMakerConfig
 */

/** @type {Omit<ForgeConfig, 'makers'> & { makers: Array<NotesMakerConfig> }} */
module.exports = {
  makers: [
    {
      arch: ['arm64'],
      name: '@electron-forge/maker-zip',
      platforms: ['darwin'],
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['win32'],
    },
    {
      config: {
        options: {
          bin: 'Notes',
          icon: './electron/icons/icon.png',
          productName: 'Notes',
        },
      },
      name: '@electron-forge/maker-deb',
    },
    {
      config: {
        options: {
          bin: 'Notes',
          icon: './electron/icons/icon.png',
          productName: 'Notes',
        },
      },
      name: '@electron-forge/maker-rpm',
    },
  ],
  packagerConfig: {
    appBundleId: 'dev.nkzw-tech.notes',
    appCopyright: 'Copyright (c) 2026-current Nakazawa Tech',
    asar: false,
    download: {
      cacheRoot: electronCachePath,
    },
    executableName: 'Notes',
    ...(iconPath ? { icon: iconPath } : {}),
    ignore: [
      /^\/\.DS_Store$/,
      /^\/\.cache(?:$|\/)/,
      /^\/\.env(?:$|[.])/,
      /^\/\.git(?:$|\/)/,
      /^\/\.gitattributes$/,
      /^\/\.github(?:$|\/)/,
      /^\/\.gitignore$/,
      /^\/\.vite-hooks(?:$|\/)/,
      /^\/AGENTS\.md$/,
      /^\/CONTRIBUTING\.md$/,
      /^\/README\.md$/,
      /^\/coverage(?:$|\/)/,
      /^\/document-service(?:\.test)?\.ts$/,
      /^\/config(?:$|\/)/,
      /^\/docs(?:$|\/)/,
      /^\/electron\/.*\.test\.ts$/,
      /^\/forge\.config\.cjs$/,
      /^\/index\.html$/,
      /^\/interviews(?:$|\/)/,
      /^\/meetings(?:$|\/)/,
      /^\/native(?:$|\/)/,
      /^\/out(?:$|\/)/,
      /^\/packaging\.test\.ts$/,
      /^\/people(?:$|\/)/,
      /^\/pnpm-workspace\.yaml$/,
      /^\/public(?:$|\/)/,
      /^\/reports(?:$|\/)/,
      /^\/scripts(?:$|\/)/,
      /^\/src(?:$|\/)/,
      /^\/tsconfig/,
      /^\/vite\.config\./,
      /^\/workspace-metadata(?:\.test)?\.ts$/,
    ],
    name: 'Notes',
    ...(osxNotarize ? { osxNotarize } : {}),
    ...(osxSign ? { osxSign } : {}),
  },
  rebuildConfig: {},
};
