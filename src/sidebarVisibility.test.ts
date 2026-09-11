import { describe, expect, test, vi } from 'vitest';
import {
  isSidebarToggleShortcut,
  readSidebarCollapsed,
  writeSidebarCollapsed,
} from './sidebarVisibility.ts';

const createStorage = (initialValue: string | null = null) => {
  let value = initialValue;

  return {
    getItem: vi.fn(() => value),
    setItem: vi.fn((_key: string, nextValue: string) => {
      value = nextValue;
    }),
  };
};

describe('sidebar visibility', () => {
  test('persists and restores the collapsed state', () => {
    const storage = createStorage();

    expect(readSidebarCollapsed(storage)).toBe(false);
    writeSidebarCollapsed(true, storage);
    expect(readSidebarCollapsed(storage)).toBe(true);
    expect(storage.setItem).toHaveBeenCalledWith(
      'notes.sidebar.collapsed',
      'true',
    );
  });

  test('falls back to expanded when storage is unavailable', () => {
    const storage = {
      getItem: () => {
        throw new Error('unavailable');
      },
      setItem: () => {
        throw new Error('unavailable');
      },
    };

    expect(readSidebarCollapsed(storage)).toBe(false);
    expect(() => writeSidebarCollapsed(true, storage)).not.toThrow();
  });

  test('matches the Codiff Mod+Shift+B shortcut', () => {
    const event = {
      altKey: false,
      ctrlKey: false,
      key: 'B',
      metaKey: true,
      shiftKey: true,
    };

    expect(isSidebarToggleShortcut(event)).toBe(true);
    expect(
      isSidebarToggleShortcut({ ...event, ctrlKey: true, metaKey: false }),
    ).toBe(true);
    expect(isSidebarToggleShortcut({ ...event, shiftKey: false })).toBe(false);
    expect(isSidebarToggleShortcut({ ...event, altKey: true })).toBe(false);
  });
});
