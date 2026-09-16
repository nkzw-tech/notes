// @ts-check

const SECTION_NAMES = [
  'Reports',
  'Interviews',
  'Meetings Overview',
  'Upcoming Meetings',
  'People',
  'Archive',
];

const normalizeWindowLayout = (value) => {
  if (
    !value ||
    typeof value.sidebarCollapsed !== 'boolean' ||
    typeof value.sidebarWidth !== 'number' ||
    !Number.isFinite(value.sidebarWidth)
  ) {
    return null;
  }
  return {
    sidebarCollapsed: value.sidebarCollapsed,
    sidebarWidth: Math.min(640, Math.max(220, Math.round(value.sidebarWidth))),
    sectionExpanded: Object.fromEntries(
      SECTION_NAMES.flatMap((name) =>
        typeof value.sectionExpanded?.[name] === 'boolean'
          ? [[name, value.sectionExpanded[name]]]
          : [],
      ),
    ),
  };
};

module.exports = { normalizeWindowLayout };
