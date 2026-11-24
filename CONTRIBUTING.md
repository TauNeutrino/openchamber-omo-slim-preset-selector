# Contributing

Thanks for helping improve the oMo Slim Preset Selector. This is a small, reviewed project; focused pull requests are welcome.

## Prerequisites

- Node.js 22 and npm
- OpenChamber 2.3.3 or later for manual testing (web or desktop client)

## Setup

```bash
git clone https://github.com/TauNeutrino/openchamber-omo-slim-preset-selector.git
cd openchamber-omo-slim-preset-selector
npm ci
```

## Checks before a pull request

Run both locally:

```bash
npm run check        # build + IIFE check + manifest check + tests
npm run type-check
```

`npm test` is the optional focused command when you only want the test files; `npm run check` already includes it.

CI runs the same checks on Linux and Windows, and additionally verifies that the committed bundles match a fresh build. A stale bundle fails CI.

## Generated bundles

OpenChamber installs the extension as-is and never builds it, so `panel/main.js` and `service/main.js` are committed. After changing anything under `src/`, run `npm run build` and commit the regenerated bundles with the source change. Do not edit the bundles by hand.

## Pull requests

- Keep a pull request focused, and describe the behavior change and how you tested it.
- Pull requests are reviewed manually by a maintainer; that is deliberate. Do not request automated AI review or triage.
- Link the related issue when one exists.

## Versioning

Versions follow SemVer:

- **patch** — backwards-compatible fixes
- **minor** — backwards-compatible features
- **major** — breaking changes
- **prerelease** — add `-rc.N` to a version, for example `1.10.0-rc.1`

`version` in `package.json` is the single version source. OpenChamber's update check compares package SemVer, so the bump is what makes an update visible; Git tags exist for pinning and rollback, and GitHub Releases carry the notes.

## Maintainer release runbook

The release workflow lives in `.github/workflows/release.yml` and is started manually from `main`.

1. Make sure the version bump PR is merged and CI is green on `main`.
2. Create a release candidate first if the change is substantial: use a `-rc.N` version, merge that PR, and run the workflow with the same `-rc.N` value.
3. Check out up-to-date `main` locally and run the full checks:
   ```bash
   git switch main
   git pull --ff-only
   npm ci
   npm run check
   npm run type-check
   ```
4. Run the workflow with the exact version already in `package.json`:
   ```bash
   gh workflow run release.yml -f version=1.9.1
   ```
5. The workflow validates the SemVer input, requires it to match `package.json`, refuses an existing tag, reruns `npm run check`, `npm run type-check` and the bundle/README drift check, then creates the annotated tag `vX.Y.Z` and a GitHub Release with generated notes. Versions containing `-` are published as prereleases.
6. Confirm the run succeeded, the tag points at the release commit, and the release notes are readable. Do not create or move tags by hand, and do not reuse a version.

There is no separate `CHANGELOG.md`; the GitHub Releases are the changelog.
