# Distribution

Notes uses Electron Forge. The app bundle ID is `dev.nkzw-tech.notes` and the product name is `Notes`.

## Linux and Windows releases

The `build-app.yml` GitHub Actions workflow runs when a `v*` tag is pushed. It requires a tag in the form `vX.Y.Z` that exactly matches `package.json`.

The workflow creates a draft release with generated release notes, builds on native runners, and uploads:

| Platform | Runner              | Architecture | Release assets                         |
| -------- | ------------------- | ------------ | -------------------------------------- |
| Linux    | Ubuntu 22.04        | x64          | `.deb` and `.rpm`                      |
| Windows  | Windows Server 2022 | x64          | Portable `.zip` containing `Notes.exe` |

After both builds and uploads succeed, the workflow publishes the release and marks it latest. A failed build leaves a newly created release as a draft. Windows users extract the ZIP and run `Notes.exe`; there is no installer or automatic updater.

GitHub Actions uses the repository's `GITHUB_TOKEN` with `contents: write`; no separate release token is required. Dependencies are installed from the frozen pnpm lockfile with Node.js 24.15.0 and the pnpm version declared in `package.json`. Workspaces and Apple credentials are not needed by CI.

### Ship a version

Commit and push the release setup before creating the first tag. For each release, update `package.json` to the intended version, then validate and commit the changes:

```sh
pnpm test
pnpm package:app
git add package.json
git commit -m "Release v0.1.0"
git push origin main
git tag v0.1.0
git push origin v0.1.0
```

Replace `0.1.0` with the version being shipped. For the first release, if the committed version is already `0.1.0`, skip the version edit and its commit. Tag the commit you intend to ship.

Monitor `build-app` in GitHub Actions and confirm the assets are available:

```sh
gh run list --workflow build-app.yml
gh run watch <run-id>
gh release view v0.1.0 --repo nkzw-tech/notes
```

Releases are available at <https://github.com/nkzw-tech/notes/releases>.

### Rebuild assets for an existing release

Push any fixes first, then dispatch the workflow using a ref that contains those fixes:

```sh
gh workflow run build-app.yml --ref main \
  -f release_tag=v0.1.0 \
  -f platform=windows
```

`platform` accepts `windows`, `linux`, or `all`. `--ref` selects the code to build; `release_tag` selects the existing release that receives the assets. That tag must match `v` plus the selected ref's `package.json` version.

Manual runs replace matching assets for the selected platforms. They do not create or publish a release. If a tag-triggered build failed and a manual rebuild completes the draft's assets, review them and publish explicitly:

```sh
gh release edit v0.1.0 --repo nkzw-tech/notes --draft=false --latest
```

## Local builds

Run the matching command on the target operating system:

```sh
pnpm make:linux
pnpm make:windows
pnpm make:mac
```

Linux requires `fakeroot` and `rpm` (`sudo apt install fakeroot rpm` on Ubuntu). Linux and Windows commands target x64; the macOS command targets Apple Silicon. The artifacts are written under `out/make/`.

`pnpm package:app` creates an unpacked app for the current platform and architecture. On Apple Silicon it writes `out/Notes-darwin-arm64/Notes.app`. Quit a running development bundle through Notes' normal Quit command before replacing it, then reopen the rebuilt app.

## Signed macOS release

As in Codiff, macOS builds are made locally with a Developer ID certificate installed in the keychain. Set all four variables in your local shell before building:

```sh
export APPLE_ID='developer@example.com'
export APPLE_PASSWORD='<app-specific-password>'
export APPLE_TEAM_ID='<team-id>'
export APPLE_SIGNING_IDENTITY='Developer ID Application: Example Company (<team-id>)'
pnpm make:mac
```

Keep credentials outside the repository. `APPLE_SIGNING_IDENTITY` enables signing; `APPLE_ID`, `APPLE_PASSWORD`, and `APPLE_TEAM_ID` enable notarization. Without these variables the command produces a local development build.

Build from the same release commit, then upload the matching signed ZIP to the existing release:

```sh
gh release upload v0.1.0 \
  out/make/zip/darwin/arm64/Notes-darwin-arm64-0.1.0.zip \
  --repo nkzw-tech/notes --clobber
```

The Linux/Windows workflow publishes independently of this upload. The macOS ZIP becomes available at `https://github.com/nkzw-tech/notes/releases/download/v0.1.0/Notes-darwin-arm64-0.1.0.zip` once it is attached to a published release. Homebrew tap updates are separate from this workflow.
