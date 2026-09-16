export const reconcileDeletedDocumentNavigation = (
  deletedPath: string | null,
  activePath: string | null,
) =>
  deletedPath === null
    ? { abandonedPath: null, activeDeletedPath: null }
    : deletedPath === activePath
      ? { abandonedPath: null, activeDeletedPath: deletedPath }
      : { abandonedPath: deletedPath, activeDeletedPath: null };
