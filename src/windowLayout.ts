import { readSidebarCollapsed, writeSidebarCollapsed } from './sidebarVisibility.ts';
import { readSidebarWidth, writeSidebarWidth } from './sidebarWidth.ts';

export const collapsibleGroups = [
  'Reports',
  'Interviews',
  'Meetings Overview',
  'Upcoming Meetings',
  'People',
  'Archive',
] as const;

export type CollapsibleGroup = (typeof collapsibleGroups)[number];
export type WindowLayout = {
  sectionExpanded: Partial<Record<CollapsibleGroup, boolean>>;
  sidebarCollapsed: boolean;
  sidebarWidth: number;
};

const sectionStorageKey = (group: CollapsibleGroup) =>
  `notes.sidebar.${group.toLocaleLowerCase().replaceAll(' ', '-')}.expanded`;

export const readWindowLayout = (): WindowLayout => {
  const saved = window.meetings?.initialWindowLayout;
  if (saved) {
    return { ...saved, sectionExpanded: { ...saved.sectionExpanded } };
  }
  // Migrate existing global preferences the first time a desktop window is opened.
  const sectionExpanded: WindowLayout['sectionExpanded'] = {};
  for (const group of collapsibleGroups) {
    try {
      const value = window.localStorage.getItem(sectionStorageKey(group));
      if (value !== null) {
        sectionExpanded[group] = value === 'true';
      }
    } catch {
      // Fall back to the default section state when local storage is unavailable.
    }
  }
  let sidebarWidth = 310;
  let sidebarCollapsed = false;
  try {
    sidebarWidth = readSidebarWidth();
    sidebarCollapsed = readSidebarCollapsed();
  } catch {
    // Keep default sidebar preferences when local storage is unavailable.
  }
  return { sectionExpanded, sidebarCollapsed, sidebarWidth };
};

export const persistWindowLayout = (layout: WindowLayout, activePath?: string | null) => {
  if (window.meetings?.updateWindowState) {
    window.meetings.updateWindowState({ activePath, layout });
    return;
  }
  // Browser previews keep their existing local preferences.
  try {
    writeSidebarCollapsed(layout.sidebarCollapsed);
    writeSidebarWidth(layout.sidebarWidth);
    for (const group of collapsibleGroups) {
      if (layout.sectionExpanded[group] !== undefined) {
        window.localStorage.setItem(
          sectionStorageKey(group),
          String(layout.sectionExpanded[group]),
        );
      }
    }
  } catch {
    // Browser layout persistence is best effort when storage is unavailable or full.
  }
};
