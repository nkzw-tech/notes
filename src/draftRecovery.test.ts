import { describe, expect, test, vi } from 'vite-plus/test';
import {
  clearRecoveryDraft,
  readRecoveryDraft,
  RECOVERY_DRAFT_KEY,
  writeRecoveryDraft,
} from './draftRecovery.ts';

const createStorage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    removeItem: (key: string) => values.delete(key),
    setItem: (key: string, value: string) => values.set(key, value),
    values,
  };
};

describe('single-draft crash recovery', () => {
  test('windows retain independent drafts even while editing the same document', () => {
    const storage = createStorage();
    const fakeWindow = { meetings: { recoveryDraftKey: 'window-one' } };
    vi.stubGlobal('window', fakeWindow);
    try {
      writeRecoveryDraft(
        { baseHash: 'base', content: 'First draft', path: 'docs/todo.md' },
        storage,
      );
      fakeWindow.meetings.recoveryDraftKey = 'window-two';
      expect(readRecoveryDraft(storage)).toBeNull();
      writeRecoveryDraft(
        { baseHash: 'base', content: 'Second draft', path: 'docs/todo.md' },
        storage,
      );
      clearRecoveryDraft('docs/todo.md', storage);
      fakeWindow.meetings.recoveryDraftKey = 'window-one';
      expect(readRecoveryDraft(storage)?.content).toBe('First draft');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('keeps only the latest unsaved text and clears it after saving', () => {
    vi.spyOn(Date, 'now').mockReturnValue(123);
    const storage = createStorage();
    expect(
      writeRecoveryDraft({ baseHash: 'base', content: 'First', path: 'docs/todo.md' }, storage),
    ).toBe(true);
    writeRecoveryDraft({ baseHash: 'base', content: 'Newest', path: 'docs/todo.md' }, storage);

    expect(readRecoveryDraft(storage)).toEqual({
      baseHash: 'base',
      content: 'Newest',
      path: 'docs/todo.md',
      updatedAt: 123,
    });
    clearRecoveryDraft('docs/todo.md', storage);
    expect(storage.values.has(RECOVERY_DRAFT_KEY)).toBe(false);
  });

  test('does not clear another document draft', () => {
    const storage = createStorage();
    writeRecoveryDraft({ baseHash: 'base', content: 'Keep me', path: 'people/one.md' }, storage);
    clearRecoveryDraft('docs/todo.md', storage);
    expect(readRecoveryDraft(storage)?.content).toBe('Keep me');
  });

  test('reports storage failures so the UI can warn the user', () => {
    expect(
      writeRecoveryDraft(
        { baseHash: 'base', content: 'Text', path: 'docs/todo.md' },
        {
          setItem: () => {
            throw new Error('quota');
          },
        },
      ),
    ).toBe(false);
    expect(
      writeRecoveryDraft({ baseHash: 'base', content: 'Text', path: 'docs/todo.md' }, null),
    ).toBe(false);
    expect(readRecoveryDraft(null)).toBeNull();
  });

  test('never throws when corrupted recovery storage cannot be cleaned up', () => {
    expect(
      readRecoveryDraft({
        getItem: () => '{bad json',
        removeItem: () => {
          throw new Error('storage denied');
        },
      }),
    ).toBeNull();
  });

  test('never throws when a saved draft cannot be removed', () => {
    const serialized = JSON.stringify({
      baseHash: 'base',
      content: 'Saved text',
      path: 'docs/todo.md',
      updatedAt: 123,
    });
    expect(() =>
      clearRecoveryDraft('docs/todo.md', {
        getItem: () => serialized,
        removeItem: () => {
          throw new Error('storage denied');
        },
      }),
    ).not.toThrow();
  });
});
