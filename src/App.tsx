import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useLayoutEffect,
} from "react";
import type { EditableMarkdownHandle, SaveStatus } from "./EditableMarkdown.tsx";
import { DocumentPalette } from "./DocumentPalette.tsx";
import {
  applyStoredDocumentChanges,
  createMeetingDocuments,
  replaceDocument,
  resolveMarkdownPath,
  type MeetingDocument,
  type StoredDocument,
} from "./content.ts";
import {
  completeInterview,
  createDocument,
  deleteDocument as deleteStoredDocument,
  loadWorkspace,
  restoreDocument,
  subscribeToDocumentChanges,
  subscribeToWorkspaceMetadataChanges,
  type CreateDocumentRequest,
  type DocumentChangeEvent,
} from "./documentApi.ts";
import {
  clearRecoveryDraft,
  fromStorageContent,
  readRecoveryDraft,
  type RecoveryDraft,
} from "./draftRecovery.ts";
import { reconcileDeletedDocumentNavigation } from "./deletedDocumentState.ts";
import { ChevronIcon, MenuIcon, SearchIcon, SidebarSimpleIcon } from "./icons.tsx";
import { isSidebarToggleShortcut } from "./sidebarVisibility.ts";
import { useResizableSidebar } from "./useResizableSidebar.ts";
import {
  readWindowLayout,
  persistWindowLayout,
  type CollapsibleGroup,
} from "./windowLayout.ts";

const EditableMarkdown = lazy(() => import("./EditableMarkdown.tsx"));

const getPathFromHash = () => decodeURIComponent(window.location.hash.replace(/^#\/?/, ""));

const navigateTo = (path: string, replace = false) => {
  const hash = `#/${encodeURI(path)}`;
  if (replace) {
    window.history.replaceState(null, "", hash);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  } else {
    window.location.hash = hash;
  }
};

const normalizeSearchText = (value: string) => value.toLocaleLowerCase();

type SaveIssue = Extract<SaveStatus, "conflict" | "error">;

const saveIssueLabel: Record<SaveIssue, string> = {
  conflict: "Conflict",
  error: "Save failed",
};

function NavigationItem({
  active,
  document,
  onNavigate,
}: {
  active: boolean;
  document: MeetingDocument;
  onNavigate: () => void;
}) {
  const title = document.title.replace(/^\d+\.\s*/, "");

  return (
    <button
      aria-current={active ? "page" : undefined}
      className={`navigation-item${active ? " active" : ""}`}
      onClick={onNavigate}
      type="button"
    >
      {document.number !== null ? (
        <span className="navigation-number">{String(document.number).padStart(2, "0")}</span>
      ) : (
        <span className="navigation-dot" />
      )}
      <span className="navigation-copy">
        <strong>{title}</strong>
        {document.cue ? <span>{document.cue}</span> : null}
      </span>
      <ChevronIcon size={14} />
    </button>
  );
}

function CollapsibleNavigationSection({
  activeDocument,
  documents,
  expanded,
  forceExpanded,
  label,
  onExpandedChange,
  onNavigate,
}: {
  activeDocument: MeetingDocument;
  documents: ReadonlyArray<MeetingDocument>;
  expanded: boolean;
  forceExpanded: boolean;
  label: CollapsibleGroup;
  onExpandedChange: (expanded: boolean) => void;
  onNavigate: (path: string) => void;
}) {
  if (documents.length === 0) {
    return null;
  }

  return (
    <details
      className="collapsible-section"
      onToggle={(event) => {
        if (!forceExpanded) {
          onExpandedChange(event.currentTarget.open);
        }
      }}
      open={forceExpanded || expanded || undefined}
    >
      <summary onClick={forceExpanded ? (event) => event.preventDefault() : undefined}>
        <span>{label}</span>
        <span className="collapsible-count">{documents.length}</span>
        <ChevronIcon size={13} />
      </summary>
      <div className="collapsible-list">
        {documents.map((document) => (
          <NavigationItem
            active={document.path === activeDocument.path}
            document={document}
            key={document.id}
            onNavigate={() => onNavigate(document.path)}
          />
        ))}
      </div>
    </details>
  );
}

function App() {
  const [activePath, setActivePath] = useState(getPathFromHash);
  const [documents, setDocuments] = useState<MeetingDocument[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deletedActivePath, setDeletedActivePath] = useState<string | null>(null);
  const [closeBlockedError, setCloseBlockedError] = useState<string | null>(null);
  const [documentPaletteScope, setDocumentPaletteScope] = useState<"all" | "files" | null>(null);
  const [workspaceMetadataError, setWorkspaceMetadataError] = useState<string | null>(null);
  const [workspacePath, setWorkspacePath] = useState<string | null | undefined>(undefined);
  const [workspaceSelectionPending, setWorkspaceSelectionPending] = useState(false);
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const [orphanedRecoveryDraft, setOrphanedRecoveryDraft] = useState<RecoveryDraft | null>(null);
  const [query, setQuery] = useState("");
  const [saveIssue, setSaveIssue] = useState<SaveIssue | null>(null);
  const [initialLayout] = useState(readWindowLayout);
  const [sectionExpanded, setSectionExpanded] = useState(initialLayout.sectionExpanded);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(initialLayout.sidebarCollapsed);
  const activePathRef = useRef(activePath);
  const documentsRef = useRef(documents);
  const editorRef = useRef<EditableMarkdownHandle>(null);
  const initialDocumentChangesRef = useRef(new Map<string, DocumentChangeEvent>());
  const initialLoadPendingRef = useRef(true);
  const intentionalDocumentDeletionsRef = useRef(new Set<string>());
  const metadataRevisionRef = useRef(0);
  const peoplePathsRef = useRef<ReadonlySet<string>>(new Set());
  const searchRef = useRef<HTMLInputElement>(null);
  const { resizeSidebar, sidebarWidth } = useResizableSidebar({
    readWidth: () => initialLayout.sidebarWidth,
  });

  const documentByPath = useMemo(
    () => new Map(documents.map((document) => [document.path, document])),
    [documents],
  );
  const activeDocument = documentByPath.get(activePath) ?? documents[0];
  const { abandonedPath: abandonedDeletedPath, activeDeletedPath } =
    reconcileDeletedDocumentNavigation(deletedActivePath, activePath);

  useLayoutEffect(() => {
    persistWindowLayout({ sidebarCollapsed, sidebarWidth, sectionExpanded }, activeDocument?.path);
  }, [sidebarCollapsed, sidebarWidth, sectionExpanded, activeDocument?.path]);

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((current) => !current);
  }, []);

  const filteredDocuments = useMemo(() => {
    const normalizedQuery = normalizeSearchText(query.trim());
    if (!normalizedQuery) {
      return documents;
    }

    return documents.filter((document) =>
      normalizeSearchText(`${document.title}\n${document.cue ?? ""}\n${document.content}`).includes(
        normalizedQuery,
      ),
    );
  }, [documents, query]);

  const navigateAfterDocumentDeletion = useCallback((path: string) => {
    const fallback =
      documentsRef.current.find(
        (document) => document.path === "docs/todo.md" && document.path !== path,
      ) ?? documentsRef.current.find((document) => document.path !== path);
    if (fallback) {
      navigateTo(fallback.path);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const metadataRevision = metadataRevisionRef.current;
    void loadWorkspace()
      .then((workspace) => {
        if (cancelled) {
          return;
        }
        if (metadataRevision === metadataRevisionRef.current) {
          peoplePathsRef.current = new Set(workspace.peoplePaths);
          setWorkspaceMetadataError(workspace.metadataError);
        }
        setWorkspacePath(workspace.workspacePath);
        const storedDocuments = applyStoredDocumentChanges(
          workspace.documents,
          initialDocumentChangesRef.current.values(),
        );
        initialLoadPendingRef.current = false;
        initialDocumentChangesRef.current.clear();
        setDocuments(createMeetingDocuments(storedDocuments, peoplePathsRef.current));
        const recoveryDraft = readRecoveryDraft();
        if (recoveryDraft) {
          const diskDocument = storedDocuments.find(({ path }) => path === recoveryDraft.path);
          if (!diskDocument) {
            setOrphanedRecoveryDraft(recoveryDraft);
          } else if (fromStorageContent(diskDocument.content) === recoveryDraft.content) {
            clearRecoveryDraft(recoveryDraft.path);
          } else if (activePathRef.current !== recoveryDraft.path) {
            navigateTo(recoveryDraft.path, true);
          }
        }
        setLoadError(null);
      })
      .catch((error: unknown) => {
        initialLoadPendingRef.current = false;
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : "Failed to load documents.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!window.meetings) {
      return;
    }
    return window.meetings.onCloseBlocked(setCloseBlockedError);
  }, []);

  const handleChooseWorkspace = useCallback(async () => {
    if (!window.meetings || workspaceSelectionPending) {
      return;
    }
    if (orphanedRecoveryDraft) {
      setLoadError("Restore or discard the recovered text before switching workspaces.");
      return;
    }
    const canNavigate = await (editorRef.current?.flush() ?? Promise.resolve(true));
    if (!canNavigate) {
      setLoadError("Resolve the current save issue before switching workspaces.");
      return;
    }
    setWorkspaceSelectionPending(true);
    setLoadError(null);
    try {
      const result = await window.meetings.chooseWorkspace();
      if (!result.canceled) {
        window.location.reload();
      }
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Failed to open the workspace.");
    } finally {
      setWorkspaceSelectionPending(false);
    }
  }, [orphanedRecoveryDraft, workspaceSelectionPending]);

  useEffect(() => {
    if (!orphanedRecoveryDraft) {
      return;
    }
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
      window.meetings?.cancelClose?.();
      setCloseBlockedError("Restore or discard the recovered text before closing this window.");
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [orphanedRecoveryDraft]);

  useEffect(() => {
    if (!window.meetings) {
      return;
    }
    return window.meetings.onChooseWorkspaceRequested(() => {
      void handleChooseWorkspace();
    });
  }, [handleChooseWorkspace]);

  useEffect(() => {
    const onDocumentChange = (change: DocumentChangeEvent) => {
      if (initialLoadPendingRef.current) {
        initialDocumentChangesRef.current.set(change.path, change);
      }
      if (change.deleted) {
        const intentionalDeletion = intentionalDocumentDeletionsRef.current.has(change.path);
        if (change.path === activePathRef.current && !intentionalDeletion) {
          setDeletedActivePath(change.path);
          return;
        }
        setDocuments((current) => current.filter((document) => document.path !== change.path));
        if (change.path === activePathRef.current) {
          navigateAfterDocumentDeletion(change.path);
        }
        return;
      }

      if (change.path === activePathRef.current && editorRef.current) {
        setDeletedActivePath(null);
        editorRef.current.applyExternalChange(change.document);
        return;
      }

      setDocuments((current) => replaceDocument(current, change.document, peoplePathsRef.current));
    };

    return subscribeToDocumentChanges(onDocumentChange);
  }, [navigateAfterDocumentDeletion]);

  useEffect(
    () =>
      subscribeToWorkspaceMetadataChanges((change) => {
        metadataRevisionRef.current += 1;
        if (!change.metadata) {
          setWorkspaceMetadataError(change.error ?? "Failed to load workspace metadata.");
          return;
        }

        const peoplePaths = new Set(change.metadata.peoplePaths);
        peoplePathsRef.current = peoplePaths;
        setDocuments((current) => createMeetingDocuments(current, peoplePaths));
        setWorkspaceMetadataError(change.error ?? null);
      }),
    [],
  );

  useEffect(() => {
    documentsRef.current = documents;
  }, [documents]);

  useEffect(() => {
    activePathRef.current = activePath;
  }, [activePath]);

  useEffect(() => {
    if (!abandonedDeletedPath) {
      return;
    }
    setDocuments((current) => current.filter((document) => document.path !== abandonedDeletedPath));
    setDeletedActivePath((current) => (current === abandonedDeletedPath ? null : current));
  }, [abandonedDeletedPath]);

  useEffect(() => {
    const updatePath = () => {
      setActivePath(getPathFromHash());
      setDocumentPaletteScope(null);
      setMobileNavigationOpen(false);
    };

    window.addEventListener("hashchange", updatePath);
    return () => window.removeEventListener("hashchange", updatePath);
  }, []);

  useEffect(() => {
    if (!activeDocument) {
      return;
    }
    if (activeDocument.path !== activePath) {
      navigateTo(activeDocument.path, true);
    }
  }, [activeDocument, activePath]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const commandKey = event.metaKey || event.ctrlKey;
      const key = event.key.toLocaleLowerCase();

      if (commandKey && key === "s") {
        event.preventDefault();
        event.stopPropagation();
        void editorRef.current?.formatAndSave();
        return;
      }

      if (isSidebarToggleShortcut(event)) {
        event.preventDefault();
        event.stopPropagation();
        toggleSidebar();
        return;
      }

      if (commandKey && !event.altKey && !event.shiftKey && (key === "k" || key === "p")) {
        event.preventDefault();
        event.stopImmediatePropagation();
        setMobileNavigationOpen(false);
        const scope = key === "p" ? "files" : "all";
        setDocumentPaletteScope((current) => (current === scope ? null : scope));
        return;
      }

      const target = event.target as HTMLElement | null;
      const editorHasFocus = Boolean(
        target?.isContentEditable ||
        target?.closest(".mdxeditor, .cm-editor, input, textarea, select"),
      );

      if (event.key === "Escape") {
        setDocumentPaletteScope(null);
        setMobileNavigationOpen(false);
        if (!editorHasFocus) {
          searchRef.current?.blur();
        }
      }
    };

    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [toggleSidebar]);

  const handleStoredChange = (storedDocument: StoredDocument) => {
    setDocuments((current) => replaceDocument(current, storedDocument, peoplePathsRef.current));
  };

  const handleLocalChange = (path: string, content: string) => {
    setDocuments((current) => {
      const existing = current.find((document) => document.path === path);
      if (!existing) {
        return current;
      }
      return replaceDocument(
        current,
        {
          content,
          hash: existing.hash,
          mtimeMs: existing.mtimeMs,
          path,
        },
        peoplePathsRef.current,
      );
    });
  };

  const handleSectionExpandedChange = (group: CollapsibleGroup, expanded: boolean) => {
    setSectionExpanded((current) => {
      if (current[group] === expanded) {
        return current;
      }
      return { ...current, [group]: expanded };
    });
  };

  const handleNavigate = async (path: string) => {
    if (path === activePathRef.current) {
      setMobileNavigationOpen(false);
      return;
    }

    const canNavigate = await (editorRef.current?.flush() ?? Promise.resolve(true));
    if (canNavigate) {
      navigateTo(path);
    }
  };

  const handleCreateDocument = async (request: CreateDocumentRequest) => {
    const canNavigate = await (editorRef.current?.flush() ?? Promise.resolve(true));
    if (!canNavigate) {
      throw new Error("Resolve the current save issue before creating another document.");
    }
    const storedDocument = await createDocument(request);
    setDocuments((current) => replaceDocument(current, storedDocument, peoplePathsRef.current));
    setDeletedActivePath(null);
    navigateTo(storedDocument.path);
  };

  const performDocumentDeletion = async (
    path: string,
    removeFromDisk: () => Promise<{ path: string }>,
  ) => {
    const canNavigate = await (editorRef.current?.flush() ?? Promise.resolve(true));
    if (!canNavigate) {
      throw new Error("Resolve the current save issue before deleting this document.");
    }
    intentionalDocumentDeletionsRef.current.add(path);
    try {
      await removeFromDisk();
    } catch (error) {
      intentionalDocumentDeletionsRef.current.delete(path);
      throw error;
    }
    clearRecoveryDraft(path);
    setDocuments((current) => current.filter((document) => document.path !== path));
    setDeletedActivePath((current) => (current === path ? null : current));
    if (activePathRef.current === path) {
      navigateAfterDocumentDeletion(path);
    }
    window.setTimeout(() => intentionalDocumentDeletionsRef.current.delete(path), 2_000);
  };

  const handleDeleteDocument = async (path: string) => {
    if (!documentsRef.current.some((document) => document.path === path)) {
      throw new Error("This document is no longer available.");
    }
    await performDocumentDeletion(path, () => deleteStoredDocument(path));
  };

  const handleCompleteInterview = async (path: string) => {
    const interview = documentsRef.current.find((document) => document.path === path);
    if (interview?.group !== "Interviews") {
      throw new Error("Only an active interview can be completed here.");
    }
    await performDocumentDeletion(path, () => completeInterview(path));
  };

  if (!activeDocument) {
    if (workspacePath === null) {
      return (
        <main className="app-state workspace-guide">
          <div className="workspace-guide-card">
            <h1>Choose your notes workspace</h1>
            <p>
              Notes creates a markdown workspace for you. Choose an existing workspace or start
              with an empty folder.
            </p>
            {loadError ? <p className="workspace-guide-error">{loadError}</p> : null}
            <button
              className="workspace-guide-button"
              disabled={workspaceSelectionPending}
              onClick={() => void handleChooseWorkspace()}
              type="button"
            >
              {workspaceSelectionPending ? "Opening…" : "Choose Workspace…"}
            </button>
            <small>You can switch later with File → Open Workspace… or ⌘O.</small>
          </div>
        </main>
      );
    }
    if (workspacePath && !loadError) {
      return (
        <main className="app-state workspace-guide">
          <div className="workspace-guide-card">
            <span className="workspace-guide-eyebrow">Workspace ready</span>
            <h1>Create your first document</h1>
            <p>This workspace is empty. Start with a regular Markdown document.</p>
            <button
              className="workspace-guide-button"
              onClick={() => void handleCreateDocument({ kind: "doc", title: "Notes" })}
              type="button"
            >
              Create Notes
            </button>
          </div>
        </main>
      );
    }
    return (
      <main className="app-state">
        <h1>{loadError ? "Could not load notes" : "Loading notes"}</h1>
        {loadError ? <p>{loadError}</p> : null}
      </main>
    );
  }

  const docsDocuments = filteredDocuments.filter((document) => document.group === "Docs");
  const groups = ["Interviews", "Meetings Overview", "Upcoming Meetings", "People"] as const;
  const forceSectionsExpanded = Boolean(query.trim());
  const reportDocuments = filteredDocuments.filter((document) => document.group === "Reports");
  const archivedDocuments = filteredDocuments.filter((document) => document.group === "Archive");

  const resolveLink = (href: string) => {
    const resolved = resolveMarkdownPath(activeDocument.path, href);
    return resolved && documentByPath.has(resolved) ? resolved : null;
  };

  return (
    <div
      className={`app-shell${sidebarCollapsed ? " sidebar-collapsed" : ""}${mobileNavigationOpen ? " mobile-navigation-open" : ""}${documentPaletteScope ? " document-palette-open" : ""}`}
      style={
        sidebarCollapsed
          ? undefined
          : {
              gridTemplateColumns: `${sidebarWidth}px 0 minmax(0, 1fr)`,
            }
      }
    >
      <aside className={`sidebar${mobileNavigationOpen ? " mobile-open" : ""}`}>
        <header className="sidebar-header" />

        <label className="search">
          <SearchIcon />
          <input
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search people and notes"
            ref={searchRef}
            type="search"
            value={query}
          />
        </label>

        <nav className="navigation">
          {docsDocuments.length > 0 ? (
            <section className="navigation-group docs-group">
              {docsDocuments.map((document) => (
                <NavigationItem
                  active={document.path === activeDocument.path}
                  document={document}
                  key={document.id}
                  onNavigate={() => void handleNavigate(document.path)}
                />
              ))}
            </section>
          ) : null}
          <CollapsibleNavigationSection
            activeDocument={activeDocument}
            documents={reportDocuments}
            expanded={sectionExpanded.Reports ?? activeDocument.group === "Reports"}
            forceExpanded={forceSectionsExpanded}
            label="Reports"
            onExpandedChange={(expanded) => handleSectionExpandedChange("Reports", expanded)}
            onNavigate={(path) => void handleNavigate(path)}
          />
          {groups.map((group) => (
            <CollapsibleNavigationSection
              activeDocument={activeDocument}
              documents={filteredDocuments.filter((document) => document.group === group)}
              expanded={sectionExpanded[group] ?? activeDocument.group === group}
              forceExpanded={forceSectionsExpanded}
              key={group}
              label={group}
              onExpandedChange={(expanded) => handleSectionExpandedChange(group, expanded)}
              onNavigate={(path) => void handleNavigate(path)}
            />
          ))}
          <CollapsibleNavigationSection
            activeDocument={activeDocument}
            documents={archivedDocuments}
            expanded={sectionExpanded.Archive ?? activeDocument.group === "Archive"}
            forceExpanded={forceSectionsExpanded}
            label="Archive"
            onExpandedChange={(expanded) => handleSectionExpandedChange("Archive", expanded)}
            onNavigate={(path) => void handleNavigate(path)}
          />
          {filteredDocuments.length === 0 ? (
            <p className="empty-search">No matching notes.</p>
          ) : null}
        </nav>

        <footer className="sidebar-footer">
          <span>
            {documents.filter(({ group }) => group === "Upcoming Meetings").length} Upcoming
          </span>
        </footer>
      </aside>

      <div aria-hidden className="sidebar-resizer" onPointerDown={resizeSidebar} />

      {mobileNavigationOpen ? (
        <>
          <button
            aria-label="Close navigation"
            className="sidebar-backdrop"
            onClick={() => setMobileNavigationOpen(false)}
            type="button"
          />
          <button
            aria-label="Close navigation"
            className="mobile-close"
            onClick={() => setMobileNavigationOpen(false)}
            onPointerDown={() => setMobileNavigationOpen(false)}
            type="button"
          >
            ×
          </button>
        </>
      ) : null}

      <main className="main">
        <header className="toolbar">
          <button
            aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            className="sidebar-toggle-button"
            onClick={toggleSidebar}
            title={`${sidebarCollapsed ? "Expand" : "Collapse"} sidebar (⌘⇧B)`}
            type="button"
          >
            <SidebarSimpleIcon />
          </button>
          <button
            aria-label="Open navigation"
            className="toolbar-button mobile-menu"
            onClick={() => setMobileNavigationOpen(true)}
            type="button"
          >
            <MenuIcon />
          </button>
          <div className="document-path">
            <span>{activeDocument.group}</span>
            <ChevronIcon size={12} />
            <strong>{activeDocument.path}</strong>
          </div>
          <div className="toolbar-actions">
            {saveIssue ? (
              <span className={`save-status ${saveIssue}`} role="status">
                {saveIssueLabel[saveIssue]}
              </span>
            ) : null}
          </div>
        </header>

        {loadError || workspaceMetadataError || closeBlockedError || activeDeletedPath ? (
          <div className="load-error" role="alert">
            {loadError ??
              workspaceMetadataError ??
              closeBlockedError ??
              (activeDeletedPath ? (
                <>
                  The active file was deleted. Your current text is preserved.{" "}
                  <button
                    onClick={() => {
                      void editorRef.current?.restoreDeletedDocument().then((restored) => {
                        if (restored) {
                          setDeletedActivePath((current) =>
                            current === activeDeletedPath ? null : current,
                          );
                        }
                      });
                    }}
                    type="button"
                  >
                    Restore deleted file
                  </button>
                </>
              ) : null)}
          </div>
        ) : null}

        {orphanedRecoveryDraft ? (
          <div className="load-error" role="alert">
            Recovered unsaved text for a file that no longer exists: {orphanedRecoveryDraft.path}.{" "}
            <button
              onClick={() => {
                void restoreDocument({
                  content: `${orphanedRecoveryDraft.content}\n`,
                  path: orphanedRecoveryDraft.path,
                })
                  .then((document) => {
                    clearRecoveryDraft(document.path);
                    setDocuments((current) =>
                      replaceDocument(current, document, peoplePathsRef.current),
                    );
                    setOrphanedRecoveryDraft(null);
                    navigateTo(document.path);
                  })
                  .catch((error: unknown) => {
                    setLoadError(
                      error instanceof Error ? error.message : "Failed to restore recovered text.",
                    );
                  });
              }}
              type="button"
            >
              Restore recovered file
            </button>{" "}
            <button
              onClick={() => {
                clearRecoveryDraft(orphanedRecoveryDraft.path);
                setOrphanedRecoveryDraft(null);
              }}
              type="button"
            >
              Discard recovered text
            </button>
          </div>
        ) : null}

        <div className="document-scroll" key={activeDocument.id}>
          <Suspense fallback={<div className="editor-loading">Loading…</div>}>
            <EditableMarkdown
              document={activeDocument}
              key={activeDocument.path}
              onLocalChange={handleLocalChange}
              onNavigate={(path) => void handleNavigate(path)}
              onStatusChange={(status) => {
                if (status === "saved") {
                  setCloseBlockedError(null);
                }
                setSaveIssue(status === "conflict" || status === "error" ? status : null);
              }}
              onStoredChange={handleStoredChange}
              ref={editorRef}
              resolveLink={resolveLink}
            />
          </Suspense>
        </div>
      </main>

      {documentPaletteScope ? (
        <DocumentPalette
          activeDocument={activeDocument}
          documents={documents}
          filesOnly={documentPaletteScope === "files"}
          key={documentPaletteScope}
          onClose={() => setDocumentPaletteScope(null)}
          onCompleteInterview={handleCompleteInterview}
          onCreate={handleCreateDocument}
          onDeleteDocument={handleDeleteDocument}
          onNavigate={(path) => void handleNavigate(path)}
        />
      ) : null}
    </div>
  );
}

export default App;
