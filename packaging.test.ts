import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);

describe('packaged app boundaries', () => {
  test('keeps workspace data out and runtime loaders in', () => {
    const forge = require('./forge.config.cjs') as {
      packagerConfig: { ignore: RegExp[] };
    };
    const ignored = (path: string) =>
      forge.packagerConfig.ignore.some((pattern) => pattern.test(path));

    expect(ignored('/config/people.json')).toBe(true);
    expect(ignored('/people/01-person.md')).toBe(true);
    expect(ignored('/electron/workspace-metadata.cjs')).toBe(false);
    expect(ignored('/electron/document-creation.cjs')).toBe(false);
    expect(ignored('/electron/document-service.cjs')).toBe(false);
    expect(ignored('/workspace-starter/AGENTS.md')).toBe(false);
    expect(ignored('/workspace-starter/config/workspace.json')).toBe(false);
  });

  test('ships only main-process packages as production dependencies', async () => {
    const packageJson = JSON.parse(
      await readFile(new URL('./package.json', import.meta.url), 'utf8'),
    ) as { dependencies: Record<string, string> };
    expect(Object.keys(packageJson.dependencies).sort()).toEqual([
      'electron-squirrel-startup',
      'oxfmt',
    ]);
  });
});
