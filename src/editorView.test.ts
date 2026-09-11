// @vitest-environment jsdom

import { describe, expect, test } from 'vitest';
import {
  beginEditorVisualSwap,
  captureEditorView,
  mapOffsetThroughEdits,
  restoreEditorView,
} from './editorView.ts';

describe('editor view restoration', () => {
  test('restores focus, selection, and scroll after the editor DOM is rebuilt', () => {
    const scrollContainer = document.createElement('div');
    const contentEditable = document.createElement('div');
    contentEditable.contentEditable = 'true';
    contentEditable.tabIndex = 0;
    contentEditable.innerHTML =
      '<p>First paragraph</p><p>Second paragraph</p>';
    scrollContainer.append(contentEditable);
    document.body.append(scrollContainer);

    const textNode = contentEditable.querySelectorAll('p')[1]?.firstChild;
    expect(textNode).toBeTruthy();
    contentEditable.focus();
    const selection = getSelection();
    selection?.setBaseAndExtent(textNode!, 6, textNode!, 6);
    scrollContainer.scrollTop = 120;

    const snapshot = captureEditorView(contentEditable, scrollContainer);
    expect(snapshot).not.toBeNull();

    contentEditable.innerHTML =
      '<p>First paragraph</p><p>Second paragraph</p>';
    scrollContainer.scrollTop = 0;
    restoreEditorView(contentEditable, scrollContainer, snapshot!);

    expect(document.activeElement).toBe(contentEditable);
    expect(getSelection()?.anchorNode?.textContent).toBe('Second paragraph');
    expect(getSelection()?.anchorOffset).toBe(6);
    expect(scrollContainer.scrollTop).toBe(120);
  });

  test('maps a caret after removed blank lines to the preceding content', () => {
    const scrollContainer = document.createElement('div');
    const contentEditable = document.createElement('div');
    contentEditable.contentEditable = 'true';
    contentEditable.tabIndex = 0;
    contentEditable.innerHTML =
      '<p>Paragraph</p><p><br></p><p><br></p><p><br></p><p><br></p><p><br></p>';
    scrollContainer.append(contentEditable);
    document.body.append(scrollContainer);

    const lastBlankLine = contentEditable.lastChild;
    expect(lastBlankLine).toBeTruthy();
    contentEditable.focus();
    getSelection()?.setBaseAndExtent(
      lastBlankLine!,
      0,
      lastBlankLine!,
      0,
    );

    const snapshot = captureEditorView(contentEditable, scrollContainer);
    expect(snapshot).not.toBeNull();

    contentEditable.innerHTML = '<p>Paragraph</p>';
    restoreEditorView(contentEditable, scrollContainer, snapshot!);

    expect(getSelection()?.anchorNode?.textContent).toBe('Paragraph');
    expect(getSelection()?.anchorOffset).toBe('Paragraph'.length);
  });

  test('reveals the replacement before restoring its focus and selection', () => {
    const parent = document.createElement('div');
    const scrollContainer = document.createElement('div');
    const contentEditable = document.createElement('div');
    contentEditable.contentEditable = 'true';
    contentEditable.tabIndex = 0;
    contentEditable.innerHTML = '<p>Before formatting</p>';
    scrollContainer.append(contentEditable);
    parent.append(scrollContainer);
    document.body.append(parent);

    const textNode = contentEditable.querySelector('p')?.firstChild;
    expect(textNode).toBeTruthy();
    contentEditable.focus();
    getSelection()?.setBaseAndExtent(textNode!, 7, textNode!, 7);
    const snapshot = captureEditorView(contentEditable, scrollContainer);
    expect(snapshot).not.toBeNull();

    const finishVisualSwap = beginEditorVisualSwap(contentEditable);
    const clone = scrollContainer.lastElementChild as HTMLElement;

    expect(contentEditable.style.visibility).toBe('hidden');
    expect(clone).not.toBe(contentEditable);
    expect(clone.textContent).toBe('Before formatting');
    expect(clone.getAttribute('aria-hidden')).toBe('true');

    contentEditable.innerHTML = '<p>After formatting</p>';
    expect(clone.textContent).toBe('Before formatting');
    finishVisualSwap();

    expect(contentEditable.style.visibility).toBe('');
    restoreEditorView(contentEditable, scrollContainer, snapshot!);

    expect(document.activeElement).toBe(contentEditable);
    expect(getSelection()?.anchorNode?.textContent).toBe('After formatting');
    expect(getSelection()?.anchorOffset).toBe(6);
    expect(scrollContainer.children).toHaveLength(1);
    expect(parent.textContent).toBe('After formatting');

    finishVisualSwap();
    expect(scrollContainer.children).toHaveLength(1);
  });
});

describe('offset mapping', () => {
  test('maps offsets after deleted content to the edit boundary', () => {
    expect(mapOffsetThroughEdits('Paragraph\n\n\n\n\n', 'Paragraph', 13)).toBe(
      9,
    );
  });

  test('preserves offsets in unchanged content after a deletion', () => {
    expect(
      mapOffsetThroughEdits(
        'First paragraph\n\n\nSecond paragraph',
        'First paragraph\nSecond paragraph',
        18,
      ),
    ).toBe(16);
  });
});
