# Contributing to Notes

## AI assistance notice

> [!IMPORTANT]
>
> If you use any kind of AI assistance to contribute to Notes, disclose it in the pull request.

Include the extent of the assistance, such as research, documentation, tests, or code generation. Disclose AI-generated pull request responses as well. Trivial tab completion limited to a keyword or short phrase does not need disclosure.

Contributors are expected to understand submitted code and be able to explain its behavior and tradeoffs.

Thanks to [Ghostty's contribution guidelines](https://github.com/ghostty-org/ghostty/blob/main/CONTRIBUTING.md) for inspiring this policy.

## Requirements

Notes uses Node.js 23 or newer and pnpm 12. The native application requires a platform supported by Electron.

## Development

Install dependencies and run the checks:

```bash
pnpm install
pnpm exec vp check --fix
pnpm test
pnpm exec vpr build
```

Vite+ configuration lives in `vite.config.ts`. `vp check` runs formatting, the shared `@nkzw/oxlint-config` rules, and type checks; `vp test` runs the test suite. Use `pnpm exec` to run these commands without a global Vite+ installation. The dependency catalog in `pnpm-workspace.yaml` keeps Vite and Vitest aligned with Vite+. The pre-commit hook runs `vp staged` after `pnpm install` configures it.

Point the development server at a workspace containing no private information:

```bash
NOTES_WORKSPACE=/absolute/path/to/workspace pnpm dev
```

In another terminal, launch Electron against the development renderer:

```bash
pnpm dev:app
```

Build the application and distributable for your current platform with:

```bash
pnpm make
```

Use `pnpm package:app` to create only the unpacked application.

Changes should include focused tests. Never add personal notes or a real workspace to fixtures, snapshots, or the repository.
