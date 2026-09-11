# Notes

Notes is a local-first Markdown desktop app. Your documents live in a folder you control and are never bundled into the application.

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

## Privacy

Workspace Markdown and metadata are loaded at runtime and excluded from the application bundle. The repository contains only generic starter templates and fictional test data. Please do not include personal workspaces in issues or pull requests.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) © Nakazawa Tech
