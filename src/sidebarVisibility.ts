const SIDEBAR_COLLAPSED_STORAGE_KEY = 'notes.sidebar.collapsed';

type SidebarVisibilityStorage = Pick<Storage, 'getItem' | 'setItem'>;

export const readSidebarCollapsed = (storage: SidebarVisibilityStorage = localStorage): boolean => {
  try {
    return storage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
};

export const writeSidebarCollapsed = (
  collapsed: boolean,
  storage: SidebarVisibilityStorage = localStorage,
) => {
  try {
    storage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(collapsed));
  } catch {
    // Sidebar visibility is non-critical when storage is unavailable.
  }
};

export const isSidebarToggleShortcut = (
  event: Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'key' | 'metaKey' | 'shiftKey'>,
) =>
  !event.altKey &&
  event.shiftKey &&
  (event.metaKey || event.ctrlKey) &&
  event.key.toLocaleLowerCase() === 'b';
