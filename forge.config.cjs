// @ts-check

const { existsSync } = require('node:fs');
const { join } = require('node:path');

const iconPath = existsSync(join(__dirname, 'electron/icons/icon.icns'))
  ? './electron/icons/icon'
  : undefined;
const osxNotarize =
  process.env.APPLE_ID &&
  process.env.APPLE_PASSWORD &&
  process.env.APPLE_TEAM_ID
    ? {
        appleId: process.env.APPLE_ID,
        appleIdPassword: process.env.APPLE_PASSWORD,
        teamId: process.env.APPLE_TEAM_ID,
        tool: 'notarytool',
      }
    : undefined;
const osxSign = process.env.APPLE_SIGNING_IDENTITY
  ? {
      continueOnError: false,
      hardenedRuntime: true,
      identity: process.env.APPLE_SIGNING_IDENTITY,
      optionsForFile: () => ({
        entitlements: join(__dirname, 'electron/entitlements.plist'),
      }),
    }
  : undefined;

/** @type {import('@electron-forge/shared-types').ForgeConfig} */
module.exports = {
  makers: [
    {
      arch: ['arm64'],
      name: '@electron-forge/maker-zip',
      platforms: ['darwin'],
    },
  ],
  packagerConfig: {
    appBundleId: 'dev.nkzw-tech.notes',
    appCopyright: 'Copyright (c) 2026-current Nakazawa Tech',
    asar: false,
    executableName: 'Notes',
    ...(iconPath ? { icon: iconPath } : {}),
    ignore: [
      /^\/\.DS_Store$/,
      /^\/\.cache(?:$|\/)/,
      /^\/\.env(?:$|[.])/,
      /^\/\.git(?:$|\/)/,
      /^\/\.github(?:$|\/)/,
      /^\/\.gitignore$/,
      /^\/\.oxfmtrc\.json$/,
      /^\/AGENTS\.md$/,
      /^\/CONTRIBUTING\.md$/,
      /^\/README\.md$/,
      /^\/document-service(?:\.test)?\.ts$/,
      /^\/config(?:$|\/)/,
      /^\/docs(?:$|\/)/,
      /^\/electron\/.*\.test\.ts$/,
      /^\/forge\.config\.cjs$/,
      /^\/index\.html$/,
      /^\/interviews(?:$|\/)/,
      /^\/meetings(?:$|\/)/,
      /^\/out(?:$|\/)/,
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
