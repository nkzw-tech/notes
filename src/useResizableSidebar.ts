import {
  useCallback,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { clampSidebarWidth } from './sidebarWidth.ts';

type UseResizableSidebarOptions = {
  onWidthCommit: (width: number) => void;
  readWidth: () => number;
};

export function useResizableSidebar({
  onWidthCommit,
  readWidth,
}: UseResizableSidebarOptions) {
  const [sidebarWidth, setSidebarWidth] = useState(readWidth);

  const resizeSidebar = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) {
        return;
      }

      event.preventDefault();

      const handle = event.currentTarget;
      const shell = handle.parentElement;
      if (!shell) {
        return;
      }

      const shellRect = shell.getBoundingClientRect();
      handle.setPointerCapture(event.pointerId);
      handle.classList.add('dragging');
      document.body.style.cursor = 'col-resize';

      const cleanup = () => {
        if (handle.hasPointerCapture(event.pointerId)) {
          handle.releasePointerCapture(event.pointerId);
        }
        handle.removeEventListener('pointermove', handleMove);
        handle.removeEventListener('pointerup', handleEnd);
        handle.removeEventListener('pointercancel', handleEnd);
        handle.classList.remove('dragging');
        document.body.style.cursor = '';
      };

      const handleMove = (moveEvent: PointerEvent) => {
        setSidebarWidth(
          clampSidebarWidth(moveEvent.clientX - shellRect.left),
        );
      };

      const handleEnd = () => {
        cleanup();
        setSidebarWidth((width) => {
          onWidthCommit(width);
          return width;
        });
      };

      handle.addEventListener('pointermove', handleMove);
      handle.addEventListener('pointerup', handleEnd);
      handle.addEventListener('pointercancel', handleEnd);
    },
    [onWidthCommit],
  );

  return { resizeSidebar, sidebarWidth };
}
