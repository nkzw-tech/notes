# Persistence ownership and regression tests

The keyed `EditableMarkdown` instance opens one document and owns its save session until navigation. Its initial document is stable. Parent React state contains sidebar and title previews, including live unsaved content, and must never be fed back into the save session. A delayed render is not a disk edit.

The persistence adapter sends the session's current base hash with each write. The editor serializes saves and drains newer text after an in-flight save acknowledges. Save acknowledgements update the recovery base and publish presentation state to the parent. Actual filesystem changes enter the active editor only through `applyExternalChange`; real concurrent edits still require an explicit choice.

`EditableMarkdown` owns lifecycle flushing and close acknowledgement. The underlying persistence component has its lifecycle listeners disabled. Two `beforeunload` listeners can race: one finishes a synchronous save and prevents unloading, while the other sees a clean editor and never acknowledges the blocked close. The wrapper handles visibility changes, page hiding, unmounting, and closing through the same save queue, including edits that arrive just after a flush completes.

Crash recovery runs once when opening a document. It must not reread the live recovery record in response to changing document props or autosave acknowledgements. Every local edit updates the current draft; acknowledgements rebase a newer draft or clear it when its text matches the saved document. Recovery records are isolated per window.

The desktop workspace session remembers committed hashes for its lifetime. A watcher notification is only a hint to read disk. Reads that overlap writes or newer notifications are discarded and reconciled again. An unchanged committed hash produces no notification to the writer. Other windows receive committed saves directly. There are no expiring self-write tokens.

Hash checks, atomic replacement, serialized file writes, and save-aware close handling remain in place. Never fix a false conflict by dropping a hash check, automatically overwriting another version, or disabling crash recovery.

## Deterministic tests

`pnpm test` includes:

- A reproduction in which an old parent render arrives after two successful saves while newer text is being typed. This previously displayed the recovered-draft conflict without any external writer.
- Four seeded six-minute virtual typing sessions using the real editor and persistence queue, with delayed acknowledgements, stale parent renders, replacements, and lifecycle flushes. Every retained token must survive on disk, there must be at most one active save, and no conflict or error may occur.
- Eight seeded desktop watcher schedules with 300 saves each, including delayed and reordered reads, duplicate events, missing filenames, and notifications racing write acknowledgements. Self-writes must remain silent, and a subsequent external edit must still be delivered.
- Positive controls for clean external reloads, dirty external conflicts, crash recovery, multiple windows, and closing while a save is pending.

To run just the stress suites:

```sh
pnpm test src/EditableMarkdownPersistence.test.tsx electron/persistence-safety.test.ts
```

## Real Electron soak test

After building, run:

```sh
pnpm test:soak 360 2026
pnpm test:soak 1 2026 idle
```

The arguments are duration in seconds, random seed, and optional quit mode (`in-flight` or `idle`). The default is six real minutes followed by quitting during a pending save. The idle mode waits for existing saves to finish, then types new text and quits immediately; this reproduces the synchronous lifecycle race. The test runs the built React app, real preload and main process, real filesystem watcher, and atomic writer in a hidden Electron window. It starts with a substantial fictional document, injects randomized delays around asynchronous saves, and types through Chromium's editing input path. It records any transient conflict/error banner and finally quits with unsaved text through the normal close lifecycle, checking that every token reached disk.

The workspace and Electron user-data directory are temporary and contain only fictional text. The test does not open or edit a personal workspace. It removes its temporary data on completion and prints a replayable seed and result summary. Scripts are excluded from the packaged app.
