// @vitest-environment jsdom

import { afterEach, beforeEach, expect, test, vi } from 'vite-plus/test';
import { persistWindowLayout, readWindowLayout, type WindowLayout } from './windowLayout.ts';

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  delete window.meetings;
  vi.restoreAllMocks();
});

const hiddenLayout: WindowLayout = {
  sectionExpanded: { Reports: false },
  sidebarCollapsed: true,
  sidebarWidth: 270,
};

test('migrates legacy global sidebar preferences when no window state exists', () => {
  window.localStorage.setItem('notes.sidebar.collapsed', 'true');
  window.localStorage.setItem('notes.sidebar.width', '390');
  window.localStorage.setItem('notes.sidebar.people.expanded', 'false');
  expect(readWindowLayout()).toEqual({
    sectionExpanded: { People: false },
    sidebarCollapsed: true,
    sidebarWidth: 390,
  });
});

test('uses restored window preferences and persists through IPC without changing shared defaults', () => {
  const updateWindowState = vi.fn();
  window.meetings = {
    initialWindowLayout: hiddenLayout,
    updateWindowState,
  } as unknown as Window['meetings'];
  window.localStorage.setItem('notes.sidebar.collapsed', 'false');
  window.localStorage.setItem('notes.sidebar.width', '420');
  const layout = readWindowLayout();
  expect(layout).toEqual(hiddenLayout);
  layout.sectionExpanded.Reports = true;
  expect(hiddenLayout.sectionExpanded.Reports).toBe(false);
  persistWindowLayout(layout, 'docs/example.md');
  expect(updateWindowState).toHaveBeenCalledWith({ activePath: 'docs/example.md', layout });
  expect(window.localStorage.getItem('notes.sidebar.collapsed')).toBe('false');
  expect(window.localStorage.getItem('notes.sidebar.width')).toBe('420');
});

test('browser previews continue to remember their preferences', () => {
  persistWindowLayout(hiddenLayout);
  expect(readWindowLayout()).toEqual(hiddenLayout);
});

test('unavailable browser storage falls back to usable defaults', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('unavailable');
  });
  expect(readWindowLayout()).toEqual({
    sectionExpanded: {},
    sidebarCollapsed: false,
    sidebarWidth: 310,
  });
});
