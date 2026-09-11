import { diffChars } from 'diff';

type SelectionPoint = {
  logicalOffset: number;
};

export type EditorViewSnapshot = {
  anchor: SelectionPoint;
  focus: SelectionPoint;
  focused: boolean;
  logicalText: string;
  scrollTop: number;
};

const getTopLevelBlock = (root: HTMLElement, node: Node) => {
  let current: Node | null = node;

  while (current?.parentNode && current.parentNode !== root) {
    current = current.parentNode;
  }

  return current?.parentNode === root ? current : null;
};

const getBlockText = (node: Node) => node.textContent ?? '';

const getLogicalText = (root: HTMLElement) =>
  Array.from(root.childNodes, getBlockText).join('\n');

const getBlockTextOffset = (block: Node, node: Node, offset: number) => {
  const range = globalThis.document.createRange();
  range.selectNodeContents(block);
  range.setEnd(node, offset);
  return range.toString().length;
};

const capturePoint = (
  root: HTMLElement,
  node: Node | null,
  offset: number,
) => {
  if (!node || !root.contains(node)) {
    return null;
  }
  const block = getTopLevelBlock(root, node);
  if (!block) {
    return null;
  }

  let logicalOffset = 0;
  for (const sibling of root.childNodes) {
    if (sibling === block) {
      logicalOffset += getBlockTextOffset(block, node, offset);
      return { logicalOffset };
    }
    logicalOffset += getBlockText(sibling).length + 1;
  }

  return null;
};

export const captureEditorView = (
  contentEditable: HTMLElement,
  scrollContainer: HTMLElement,
): EditorViewSnapshot | null => {
  const selection = globalThis.getSelection();
  const anchor = capturePoint(
    contentEditable,
    selection?.anchorNode ?? null,
    selection?.anchorOffset ?? 0,
  );
  const focus = capturePoint(
    contentEditable,
    selection?.focusNode ?? null,
    selection?.focusOffset ?? 0,
  );

  if (!anchor || !focus) {
    return null;
  }

  return {
    anchor,
    focus,
    focused:
      globalThis.document.activeElement === contentEditable ||
      contentEditable.contains(globalThis.document.activeElement),
    logicalText: getLogicalText(contentEditable),
    scrollTop: scrollContainer.scrollTop,
  };
};

export const mapOffsetThroughEdits = (
  before: string,
  after: string,
  targetOffset: number,
) => {
  let beforeOffset = 0;
  let afterOffset = 0;

  for (const change of diffChars(before, after)) {
    const length = change.value.length;

    if (change.added) {
      afterOffset += length;
      continue;
    }

    if (change.removed) {
      if (targetOffset <= beforeOffset + length) {
        return afterOffset;
      }
      beforeOffset += length;
      continue;
    }

    if (targetOffset <= beforeOffset + length) {
      return afterOffset + targetOffset - beforeOffset;
    }
    beforeOffset += length;
    afterOffset += length;
  }

  return after.length;
};

const resolveTextOffset = (root: Node, targetOffset: number) => {
  const walker = globalThis.document.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT,
  );
  let remaining = targetOffset;
  let node = walker.nextNode();
  let lastTextNode: Node | null = null;

  while (node) {
    lastTextNode = node;
    const length = node.textContent?.length ?? 0;
    if (remaining <= length) {
      return {
        node,
        offset: remaining,
      };
    }
    remaining -= length;
    node = walker.nextNode();
  }

  if (lastTextNode) {
    return {
      node: lastTextNode,
      offset: lastTextNode.textContent?.length ?? 0,
    };
  }

  return {
    node: root,
    offset: 0,
  };
};

const resolveLogicalOffset = (root: HTMLElement, targetOffset: number) => {
  const blocks = Array.from(root.childNodes);
  let logicalOffset = 0;

  for (const [index, block] of blocks.entries()) {
    const blockLength = getBlockText(block).length;
    if (targetOffset <= logicalOffset + blockLength) {
      return resolveTextOffset(block, targetOffset - logicalOffset);
    }

    logicalOffset += blockLength;
    if (index < blocks.length - 1) {
      logicalOffset += 1;
      if (targetOffset <= logicalOffset) {
        return resolveTextOffset(blocks[index + 1]!, 0);
      }
    }
  }

  const lastBlock = blocks.at(-1);
  return lastBlock
    ? resolveTextOffset(lastBlock, getBlockText(lastBlock).length)
    : { node: root, offset: 0 };
};

export const restoreEditorView = (
  contentEditable: HTMLElement,
  scrollContainer: HTMLElement,
  snapshot: EditorViewSnapshot,
) => {
  if (snapshot.focused) {
    contentEditable.focus({ preventScroll: true });
  }

  const selection = globalThis.getSelection();
  if (selection) {
    const logicalText = getLogicalText(contentEditable);
    const anchor = resolveLogicalOffset(
      contentEditable,
      mapOffsetThroughEdits(
        snapshot.logicalText,
        logicalText,
        snapshot.anchor.logicalOffset,
      ),
    );
    const focus = resolveLogicalOffset(
      contentEditable,
      mapOffsetThroughEdits(
        snapshot.logicalText,
        logicalText,
        snapshot.focus.logicalOffset,
      ),
    );
    selection.setBaseAndExtent(
      anchor.node,
      anchor.offset,
      focus.node,
      focus.offset,
    );
  }

  scrollContainer.scrollTop = snapshot.scrollTop;
};

export const beginEditorVisualSwap = (contentEditable: HTMLElement) => {
  const parent = contentEditable.parentElement;
  if (!parent) {
    return () => undefined;
  }

  const parentPosition = parent.style.position;
  const visibility = contentEditable.style.visibility;
  const clone = contentEditable.cloneNode(true) as HTMLElement;

  if (globalThis.getComputedStyle(parent).position === 'static') {
    parent.style.position = 'relative';
  }
  clone.removeAttribute('contenteditable');
  clone.setAttribute('aria-hidden', 'true');
  Object.assign(clone.style, {
    caretColor: 'transparent',
    height: `${contentEditable.offsetHeight}px`,
    inset: '0',
    overflow: 'hidden',
    pointerEvents: 'none',
    position: 'absolute',
    visibility: 'visible',
    width: '100%',
    zIndex: '1',
  });
  contentEditable.style.visibility = 'hidden';
  parent.append(clone);

  let finished = false;
  return () => {
    if (finished) {
      return;
    }
    finished = true;
    clone.remove();
    contentEditable.style.visibility = visibility;
    parent.style.position = parentPosition;
  };
};

export const waitForEditorUpdate = (contentEditable: HTMLElement) =>
  new Promise<void>((resolve) => {
    let frame = 0;
    let version = 0;
    let finished = false;
    const finish = () => {
      if (finished) {
        return;
      }
      finished = true;
      observer.disconnect();
      cancelAnimationFrame(frame);
      clearTimeout(timeout);
      resolve();
    };
    const waitForStableFrames = () => {
      const expectedVersion = version;
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          if (version === expectedVersion) {
            finish();
          } else {
            waitForStableFrames();
          }
        });
      });
    };
    const timeout = globalThis.setTimeout(() => {
      finish();
    }, 150);
    const observer = new MutationObserver(() => {
      version += 1;
      if (version === 1) {
        waitForStableFrames();
      }
    });

    observer.observe(contentEditable, {
      characterData: true,
      childList: true,
      subtree: true,
    });
  });
