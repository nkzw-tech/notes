import {
  useCallback,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import type { MeetingDocument } from "./content.ts";
import type { CreateDocumentKind, CreateDocumentRequest } from "./documentApi.ts";
import { filterPaletteDocuments, getPaletteDocumentTitle } from "./documentPalette.ts";

type PaletteMode = "browse" | "complete-interview" | "delete-document" | "kind" | "name";

const documentKinds: ReadonlyArray<{
  description: string;
  kind: CreateDocumentKind;
  label: string;
  marker: string;
}> = [
  {
    description: "Create a Markdown file in Docs",
    kind: "doc",
    label: "Regular doc",
    marker: "D",
  },
  {
    description: "Use the next interview number and append the questionnaire",
    kind: "interview",
    label: "Interview",
    marker: "I",
  },
  {
    description: "Create an unnumbered direct-report profile",
    kind: "report",
    label: "Report",
    marker: "R",
  },
  {
    description: "Use the next person number and add to Upcoming Meetings",
    kind: "person",
    label: "Person",
    marker: "P",
  },
];

const getNamePlaceholder = (kind: CreateDocumentKind | null) =>
  kind === "doc" ? "Document title…" : kind === "interview" ? "Candidate name…" : "Full name…";

export function DocumentPalette({
  activeDocument,
  documents,
  filesOnly = false,
  onClose,
  onCompleteInterview,
  onCreate,
  onDeleteDocument,
  onNavigate,
}: {
  activeDocument: MeetingDocument;
  documents: ReadonlyArray<MeetingDocument>;
  filesOnly?: boolean;
  onClose: () => void;
  onCompleteInterview: (path: string) => Promise<void>;
  onCreate: (request: CreateDocumentRequest) => Promise<void>;
  onDeleteDocument: (path: string) => Promise<void>;
  onNavigate: (path: string) => void;
}) {
  const [creationKind, setCreationKind] = useState<CreateDocumentKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [mode, setMode] = useState<PaletteMode>("browse");
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const filteredDocuments = filterPaletteDocuments(documents, query);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const showCreateAction =
    !filesOnly &&
    mode === "browse" && (!normalizedQuery || "create document new".includes(normalizedQuery));
  const destructiveMode =
    activeDocument.group === "Interviews" ? "complete-interview" : "delete-document";
  const destructiveSearchText =
    destructiveMode === "complete-interview"
      ? "complete interview delete"
      : "delete document remove";
  const showDestructiveAction =
    !filesOnly &&
    mode === "browse" &&
    (!normalizedQuery || destructiveSearchText.includes(normalizedQuery));
  const browseActionCount = Number(showCreateAction) + Number(showDestructiveAction);
  const filteredKinds = documentKinds.filter(
    ({ description, label }) =>
      !normalizedQuery || `${label} ${description}`.toLocaleLowerCase().includes(normalizedQuery),
  );
  const itemCount =
    mode === "browse"
      ? filteredDocuments.length + browseActionCount
      : mode === "kind"
        ? filteredKinds.length
        : mode === "name" && !query.trim()
          ? 0
          : 1;
  const clampedIndex = itemCount === 0 ? -1 : Math.min(selectedIndex, itemCount - 1);

  const resetStep = useCallback((nextMode: PaletteMode) => {
    itemRefs.current = [];
    setError(null);
    setMode(nextMode);
    setQuery("");
    setSelectedIndex(0);
  }, []);

  const navigateAndClose = useCallback(
    (document: MeetingDocument) => {
      onClose();
      onNavigate(document.path);
    },
    [onClose, onNavigate],
  );

  const chooseKind = useCallback(
    (kind: CreateDocumentKind) => {
      setCreationKind(kind);
      resetStep("name");
    },
    [resetStep],
  );

  const createAndClose = useCallback(async () => {
    const title = query.trim();
    if (!creationKind || !title || isCreating) {
      return;
    }
    setError(null);
    setIsCreating(true);
    try {
      await onCreate({ kind: creationKind, title });
      onClose();
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Could not create document.");
      setIsCreating(false);
    }
  }, [creationKind, isCreating, onClose, onCreate, query]);

  const completeInterviewAndClose = useCallback(async () => {
    if (activeDocument.group !== "Interviews" || isCreating) {
      return;
    }
    setError(null);
    setIsCreating(true);
    try {
      await onCompleteInterview(activeDocument.path);
      onClose();
    } catch (completionError) {
      setError(
        completionError instanceof Error
          ? completionError.message
          : "Could not complete interview.",
      );
      setIsCreating(false);
    }
  }, [activeDocument, isCreating, onClose, onCompleteInterview]);

  const deleteDocumentAndClose = useCallback(async () => {
    if (isCreating) {
      return;
    }
    setError(null);
    setIsCreating(true);
    try {
      await onDeleteDocument(activeDocument.path);
      onClose();
    } catch (deletionError) {
      setError(
        deletionError instanceof Error ? deletionError.message : "Could not delete document.",
      );
      setIsCreating(false);
    }
  }, [activeDocument.path, isCreating, onClose, onDeleteDocument]);

  const activateIndex = useCallback(
    (index: number) => {
      if (mode === "browse") {
        if (showCreateAction && index === 0) {
          resetStep("kind");
          return;
        }
        const destructiveIndex = showCreateAction ? 1 : 0;
        if (showDestructiveAction && index === destructiveIndex) {
          resetStep(destructiveMode);
          return;
        }
        const document = filteredDocuments[index - browseActionCount];
        if (document) {
          navigateAndClose(document);
        }
        return;
      }
      if (mode === "kind") {
        const documentKind = filteredKinds[index];
        if (documentKind) {
          chooseKind(documentKind.kind);
        }
        return;
      }
      if (mode === "name" && index === 0) {
        void createAndClose();
      } else if (mode === "complete-interview" && index === 0) {
        void completeInterviewAndClose();
      } else if (mode === "delete-document" && index === 0) {
        void deleteDocumentAndClose();
      }
    },
    [
      chooseKind,
      browseActionCount,
      completeInterviewAndClose,
      createAndClose,
      deleteDocumentAndClose,
      destructiveMode,
      filteredDocuments,
      filteredKinds,
      mode,
      navigateAndClose,
      resetStep,
      showCreateAction,
      showDestructiveAction,
    ],
  );

  const scrollIndexIntoView = useCallback((index: number) => {
    itemRefs.current[index]?.scrollIntoView({ block: "nearest" });
  }, []);

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key === "Backspace" && query === "" && mode !== "browse") {
        event.preventDefault();
        if (mode === "name") {
          setCreationKind(null);
          resetStep("kind");
        } else {
          resetStep("browse");
        }
        return;
      }

      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelectedIndex((current) => {
          const next = current + 1 >= itemCount ? 0 : current + 1;
          scrollIndexIntoView(next);
          return next;
        });
        return;
      }

      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelectedIndex((current) => {
          const next = current - 1 < 0 ? Math.max(itemCount - 1, 0) : current - 1;
          scrollIndexIntoView(next);
          return next;
        });
        return;
      }

      if (event.key === "Enter" && clampedIndex >= 0) {
        event.preventDefault();
        activateIndex(clampedIndex);
      }
    },
    [activateIndex, clampedIndex, itemCount, mode, onClose, query, resetStep, scrollIndexIntoView],
  );

  const handleOverlayClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (event.target === event.currentTarget) {
        onClose();
      }
    },
    [onClose],
  );

  const placeholder =
    mode === "browse"
      ? "Search people and documents…"
      : mode === "kind"
        ? "Choose a document type…"
        : mode === "name"
          ? getNamePlaceholder(creationKind)
          : mode === "complete-interview"
            ? `Complete ${getPaletteDocumentTitle(activeDocument)}?`
            : `Delete ${getPaletteDocumentTitle(activeDocument)}?`;

  return (
    <div className="document-palette-overlay" onClick={handleOverlayClick}>
      <section aria-label="Quick open" aria-modal="true" className="document-palette" role="dialog">
        <input
          aria-controls="document-palette-results"
          aria-label={placeholder.replace("…", "")}
          autoComplete="off"
          autoFocus
          className="document-palette-input"
          disabled={isCreating}
          onChange={(event) => {
            setError(null);
            setQuery(event.currentTarget.value);
            setSelectedIndex(0);
          }}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          readOnly={mode === "complete-interview" || mode === "delete-document"}
          spellCheck={false}
          type="text"
          value={query}
        />
        <div className="document-palette-list" id="document-palette-results">
          {mode === "browse" ? (
            <>
              {showCreateAction ? (
                <button
                  className={`document-palette-item document-palette-create${clampedIndex === 0 ? " selected" : ""}`}
                  onClick={() => resetStep("kind")}
                  onPointerEnter={() => setSelectedIndex(0)}
                  ref={(element) => {
                    itemRefs.current[0] = element;
                  }}
                  type="button"
                >
                  <span className="document-palette-marker">+</span>
                  <span className="document-palette-copy">
                    <strong>Create document…</strong>
                    <span>Doc, interview, report, or person</span>
                  </span>
                  <span className="document-palette-group">New</span>
                </button>
              ) : null}
              {showDestructiveAction ? (
                <button
                  className={`document-palette-item document-palette-danger${clampedIndex === (showCreateAction ? 1 : 0) ? " selected" : ""}`}
                  onClick={() => resetStep(destructiveMode)}
                  onPointerEnter={() => setSelectedIndex(showCreateAction ? 1 : 0)}
                  ref={(element) => {
                    itemRefs.current[showCreateAction ? 1 : 0] = element;
                  }}
                  type="button"
                >
                  <span className="document-palette-marker">×</span>
                  <span className="document-palette-copy">
                    <strong>
                      {destructiveMode === "complete-interview"
                        ? "Complete Interview"
                        : "Delete document…"}
                    </strong>
                    <span>Permanently delete {activeDocument.path}</span>
                  </span>
                  <span className="document-palette-group">
                    {destructiveMode === "complete-interview" ? "Interview" : "Delete"}
                  </span>
                </button>
              ) : null}
              {filteredDocuments.map((document, documentIndex) => {
                const index = documentIndex + browseActionCount;
                return (
                  <button
                    className={`document-palette-item${index === clampedIndex ? " selected" : ""}`}
                    key={document.id}
                    onClick={() => navigateAndClose(document)}
                    onPointerEnter={() => setSelectedIndex(index)}
                    ref={(element) => {
                      itemRefs.current[index] = element;
                    }}
                    type="button"
                  >
                    <span className="document-palette-marker">
                      {document.number === null ? "•" : String(document.number).padStart(2, "0")}
                    </span>
                    <span className="document-palette-copy">
                      <strong>{getPaletteDocumentTitle(document)}</strong>
                      <span>{document.cue ?? document.path}</span>
                    </span>
                    <span className="document-palette-group">{document.group}</span>
                  </button>
                );
              })}
              {itemCount === 0 ? (
                <div className="document-palette-empty">No matching documents</div>
              ) : null}
            </>
          ) : mode === "kind" ? (
            <>
              {filteredKinds.map((documentKind, index) => (
                <button
                  className={`document-palette-item${index === clampedIndex ? " selected" : ""}`}
                  key={documentKind.kind}
                  onClick={() => chooseKind(documentKind.kind)}
                  onPointerEnter={() => setSelectedIndex(index)}
                  ref={(element) => {
                    itemRefs.current[index] = element;
                  }}
                  type="button"
                >
                  <span className="document-palette-marker">{documentKind.marker}</span>
                  <span className="document-palette-copy">
                    <strong>{documentKind.label}</strong>
                    <span>{documentKind.description}</span>
                  </span>
                  <span className="document-palette-group">Type</span>
                </button>
              ))}
              {filteredKinds.length === 0 ? (
                <div className="document-palette-empty">No matching document types</div>
              ) : null}
            </>
          ) : mode === "name" ? (
            query.trim() ? (
              <button
                className="document-palette-item document-palette-create selected"
                disabled={isCreating}
                onClick={() => void createAndClose()}
                ref={(element) => {
                  itemRefs.current[0] = element;
                }}
                type="button"
              >
                <span className="document-palette-marker">+</span>
                <span className="document-palette-copy">
                  <strong>{isCreating ? "Creating…" : `Create “${query.trim()}”`}</strong>
                  <span>{documentKinds.find(({ kind }) => kind === creationKind)?.description}</span>
                </span>
                <span className="document-palette-group">Create</span>
              </button>
            ) : (
              <div className="document-palette-empty">
                Type a title or name · Backspace to go back
              </div>
            )
          ) : (
            <button
              className="document-palette-item document-palette-danger selected"
              disabled={isCreating}
              onClick={() =>
                void (mode === "complete-interview"
                  ? completeInterviewAndClose()
                  : deleteDocumentAndClose())
              }
              ref={(element) => {
                itemRefs.current[0] = element;
              }}
              type="button"
            >
              <span className="document-palette-marker">×</span>
              <span className="document-palette-copy">
                <strong>
                  {mode === "complete-interview"
                    ? isCreating
                      ? "Completing…"
                      : "Complete Interview"
                    : isCreating
                      ? "Deleting…"
                      : "Delete document"}
                </strong>
                <span>Permanently delete {activeDocument.path}</span>
              </span>
              <span className="document-palette-group">Delete</span>
            </button>
          )}
          {error ? (
            <div className="document-palette-error" role="alert">
              {error}
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}
