import { describe, expect, test } from 'vite-plus/test';
import { reconcileDeletedDocumentNavigation } from './deletedDocumentState.ts';

describe('deleted document navigation state', () => {
  test('keeps the restore state while the deleted document is active', () => {
    expect(reconcileDeletedDocumentNavigation('docs/deleted.md', 'docs/deleted.md')).toEqual({
      abandonedPath: null,
      activeDeletedPath: 'docs/deleted.md',
    });
  });

  test('abandons the deleted document after navigation', () => {
    expect(reconcileDeletedDocumentNavigation('docs/deleted.md', 'docs/todo.md')).toEqual({
      abandonedPath: 'docs/deleted.md',
      activeDeletedPath: null,
    });
  });

  test('does nothing without a deleted document', () => {
    expect(reconcileDeletedDocumentNavigation(null, 'docs/todo.md')).toEqual({
      abandonedPath: null,
      activeDeletedPath: null,
    });
  });
});
