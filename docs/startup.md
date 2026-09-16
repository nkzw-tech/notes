# Startup

The desktop preload subscribes to document and metadata changes, starts the workspace read, and supplies layout, recovery identity, and system accent through one synchronous IPC call. Workspace data stays in memory and is never baked into renderer assets or cached across app runs.

The renderer loads the app and editor together while awaiting the workspace read. React's first commit receives the snapshot, selects the requested note or recovery draft, and mounts the editor. The window becomes visible after that commit. Workspace selection, an empty workspace, and read errors also produce a first screen. Document content has no entrance animation.

Changes received during module loading are buffered in the preload and delivered when React subscribes. Updates to the active document go through its persistence owner. Hash checks, atomic writes, serialized autosaves, conflict handling, and lifecycle flushes remain unchanged. Concurrent reads for windows restoring the same workspace share an in-flight promise; later reads always scan disk again.

## Measurement

Build and run:

```sh
pnpm exec vpr build
pnpm exec electron scripts/startup-benchmark.cjs 500 6
```

Arguments are the number of fictional documents and windows. An optional third argument points to a separately built checkout, allowing the same measurement script to compare revisions. The benchmark uses disposable workspace and user-data directories, suppresses window display, disables background throttling, waits for real editable content and animation completion, and quits normally. It does not access personal notes.

`requestToPaintMs` includes window creation, navigation, module loading, workspace IPC, React, editor initialization, and two animation frames. `firstEditorAt` and `paintedAt` are relative to renderer navigation. `showMs` records when the app requests native display. Warm results describe additional windows in the running process, not a retained spare renderer. Cold results include Electron app readiness but exclude launching the executable and benchmark fixture creation. These are local production-renderer measurements, not guarantees for every machine or workspace.

On the development Mac, the original 500-document benchmark took a median 425 ms per additional window, with a loading screen in every sample. The revised path took 135 ms, about 3.2× faster, with no loading screen in six measured windows. The first window improved from 546 ms to 241 ms in the paired runs. Workspace scans remained roughly 11–25 ms; the largest avoidable delay was loading the editor through a React Suspense boundary after the workspace had already loaded.

These changes do not achieve a tenfold end-to-end improvement. Renderer creation and editor initialization still cost time. Keeping an initialized renderer available could further reduce new-window latency at the cost of additional memory; this implementation does not keep a spare renderer.
