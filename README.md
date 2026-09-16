# Notes

Notes is a local-first Markdown desktop app. Your documents live in a folder you control and are never bundled into the application.

Use <kbd>⌘</kbd><kbd>P</kbd> to search and switch between files. Use <kbd>⌘</kbd><kbd>K</kbd> for the full command palette, including file navigation and document actions. On Windows/Linux, use <kbd>Ctrl</kbd> instead of <kbd>⌘</kbd>.

Open another window with **File → New Window** or <kbd>⌘</kbd><kbd>N</kbd> (<kbd>Ctrl</kbd><kbd>N</kbd> on Windows/Linux) to view notes side by side. Each window navigates independently, and saved edits update other windows on the same workspace. Concurrent edits require resolving a conflict before saving. Each window keeps its own crash recovery draft.

New windows inherit the focused window's sidebar layout. Quitting the app restores all open windows on the next launch, including their notes, sidebar visibility and width, expanded sections, and window positions. Closing a window with <kbd>⌘</kbd><kbd>W</kbd> removes it from that session. If you close every window, the next window uses the last closed window's layout.

## Workspaces

On first launch, choose an existing workspace or an empty folder. Notes remembers the selection in `~/.config/nkzw-notes/config.json`. Switch workspaces at any time with **File → Open Workspace…** or <kbd>⌘</kbd><kbd>O</kbd>.

An empty folder is initialized with privacy-safe templates and this structure:

```text
AGENTS.md
config/
  people.json
  workspace.json
docs/
interviews/
meetings/
people/
reports/
```

The command menu can create regular documents, interviews, people, and reports. Markdown files remain the source of truth and can be edited with any other editor.

You can also select a workspace when starting the app from a terminal:

```sh
NOTES_WORKSPACE=/absolute/path/to/workspace pnpm dev
pnpm electron -- --workspace=/absolute/path/to/workspace
```

## Development

Notes requires Node.js 23 or newer and pnpm 12.

```sh
pnpm install
pnpm test
NOTES_WORKSPACE=/absolute/path/to/workspace pnpm dev
```

In another terminal, launch Electron against the development renderer:

```sh
pnpm dev:app
```

Create the standalone macOS application with:

```sh
pnpm package:app
```

The packaged app is written to `out/Notes-darwin-arm64/Notes.app`. Signing and notarization are enabled when the corresponding Apple environment variables are provided.

Persistence changes must preserve the [save ownership rules and stress tests](docs/persistence.md). After building, `pnpm test:soak` exercises six real minutes of typing and a save-aware quit in a disposable Electron workspace.

## Releases

Pushing a version tag such as `v0.1.0` builds Linux x64 DEB/RPM packages and a Windows x64 portable ZIP, attaches them to a GitHub Release, and publishes it after both builds succeed. The tag must match the version in `package.json`.

See [Distribution](docs/distribution.md) for the release commands, rebuilding existing release assets, and signing and uploading the macOS app.

## Privacy

Workspace Markdown and metadata are loaded at runtime and excluded from the application bundle. The repository contains only generic starter templates and fictional test data. Please do not include personal workspaces in issues or pull requests.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) © Nakazawa Tech
