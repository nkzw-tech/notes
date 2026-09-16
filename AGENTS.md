# Notes App Development

This repository contains application code only. Never copy personal Markdown, workspace metadata, candidate details, meeting notes, or real people data into this repository, including fixtures and tests. Use clearly fictional example data in tests.

The private workspace is external to this repository. The app must support arbitrary workspaces through `NOTES_WORKSPACE` and `--workspace`; do not couple runtime behavior to bundled content. `workspace-starter/` contains privacy-safe product templates for initializing new workspaces and must remain generic.

After code changes, run:

```sh
pnpm exec vp check --fix
pnpm test
pnpm exec vpr build
pnpm package:app
```

Use Vite+ (`vp` / `vpr`) for development, builds, tests, linting, formatting, and type checks. Keep its configuration in `vite.config.ts` and its dependency catalog in `pnpm-workspace.yaml`, aligned with the Codiff repository. The `oxfmt` production dependency formats workspace Markdown at runtime and must remain available in the packaged app.

For the packaged development bundle, quit Notes through its normal save-aware lifecycle and reopen:

```text
out/Notes-darwin-arm64/Notes.app
```

Preserve workspace safety guarantees: visible Markdown paths only, hash-checked writes, atomic replacement, serialized autosaves, crash-draft recovery, and conflict prompts. Never package workspace directories or secrets.
