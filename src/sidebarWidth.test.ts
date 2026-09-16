import { describe, expect, test } from 'vite-plus/test';
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  clampSidebarWidth,
  readSidebarWidth,
  writeSidebarWidth,
} from './sidebarWidth.ts';

const createStorage = (initialValue: string | null = null) => {
  let value = initialValue;

  return {
    getItem: () => value,
    setItem: (_key: string, nextValue: string) => {
      value = nextValue;
    },
  };
};

describe('sidebar width', () => {
  test('clamps widths to the supported range', () => {
    expect(clampSidebarWidth(SIDEBAR_MIN_WIDTH - 50)).toBe(SIDEBAR_MIN_WIDTH);
    expect(clampSidebarWidth(412.6)).toBe(413);
    expect(clampSidebarWidth(SIDEBAR_MAX_WIDTH + 50)).toBe(SIDEBAR_MAX_WIDTH);
  });

  test('uses the default for missing or invalid stored values', () => {
    expect(readSidebarWidth(createStorage())).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(readSidebarWidth(createStorage('invalid'))).toBe(SIDEBAR_DEFAULT_WIDTH);
  });

  test('clamps persisted widths when reading and writing', () => {
    const storage = createStorage(String(SIDEBAR_MAX_WIDTH + 100));
    expect(readSidebarWidth(storage)).toBe(SIDEBAR_MAX_WIDTH);

    writeSidebarWidth(SIDEBAR_MIN_WIDTH - 100, storage);
    expect(readSidebarWidth(storage)).toBe(SIDEBAR_MIN_WIDTH);
  });
});
